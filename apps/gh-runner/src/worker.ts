// One issue, start to finish: a worktree on a fresh branch, one `claude -p` run in it, then the
// result back on GitHub as a label and a comment.
import { existsSync, mkdirSync, openSync, writeSync, closeSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { HOME, type Settings } from './config';
import { comment, moveLabel, type Issue } from './github';
import { parseResult, RESULT_INSTRUCTIONS, type Result } from './result';
import { runDir, runKey, saveRun, type Run } from './runs';

/** Exported for tests: the branch an issue's work goes on. */
export const branchFor = (prefix: string, i: Pick<Issue, 'number' | 'title'>) => {
  const slug = i.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40).replace(/-$/, '');
  return `${prefix}${i.number}${slug ? `-${slug}` : ''}`;
};

/** Exported for tests: {name} placeholders filled from vars. */
export const fill = (s: string, vars: Record<string, string | number>) => s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));

async function run(cmd: string[], cwd: string): Promise<string> {
  const p = Bun.spawn(cmd, { cwd, stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (code !== 0) throw new Error(`${cmd.slice(0, 3).join(' ')}: ${(err || out).trim().slice(-500) || `exit ${code}`}`);
  return out;
}

// Git locks the clone while it fetches or adds a worktree, so worktrees for one clone are made one at a time.
const queue = new Map<string, Promise<unknown>>();
function makeWorktree(s: Settings, issue: Issue, branch: string, path: string): Promise<void> {
  const key = s.repos[issue.repo].checkout;
  const next = (queue.get(key) ?? Promise.resolve()).catch(() => {}).then(() => addWorktree(s, issue, branch, path));
  queue.set(key, next);
  return next;
}

async function addWorktree(s: Settings, issue: Issue, branch: string, path: string) {
  if (existsSync(path)) return;
  const repo = s.repos[issue.repo];
  mkdirSync(join(HOME, 'worktrees'), { recursive: true });
  await run(['git', 'fetch', 'origin', repo.base], repo.checkout);
  const cmd = repo.worktree ? repo.worktree.map((a) => fill(a, { path, branch, base: repo.base })) : ['git', 'worktree', 'add', '-b', branch, path, `origin/${repo.base}`];
  await run(cmd, repo.checkout);
}

/** The claude command for a run, with the runner's own guard rails: it never pushes or opens PRs itself. */
export function claudeArgs(s: Settings, prompt: string, sessionId: string): string[] {
  return [
    'claude', '-p', prompt,
    '--session-id', sessionId,
    ...(s.model ? ['--model', s.model] : []),
    '--permission-mode', s.permissionMode,
    '--output-format', 'stream-json', '--verbose',
    '--disallowedTools', 'Bash(git push:*)', 'Bash(gh pr create:*)', 'Bash(gh pr merge:*)',
  ];
}

/** Runs claude, copying its output to the transcript and stopping it after `silenceMinutes` with no output. */
async function runClaude(s: Settings, args: string[], cwd: string, dir: string, onStart: (pid: number) => void): Promise<{ code: number; quiet: boolean }> {
  const result = join(dir, 'result.json');
  rmSync(result, { force: true });
  const proc = Bun.spawn(args, { cwd, stdin: 'ignore', stdout: 'pipe', stderr: Bun.file(join(dir, 'stderr.log')), env: { ...process.env, GH_RUNNER_RESULT: result } });
  onStart(proc.pid);
  const out = openSync(join(dir, 'transcript.jsonl'), 'a');
  let last = Date.now();
  let quiet = false;
  const watch = setInterval(() => {
    if (Date.now() - last > s.silenceMinutes * 60_000) {
      quiet = true;
      proc.kill();
    }
  }, 30_000);
  try {
    for await (const chunk of proc.stdout) {
      last = Date.now();
      writeSync(out, chunk);
    }
    return { code: await proc.exited, quiet };
  } finally {
    clearInterval(watch);
    closeSync(out);
  }
}

/** The comment for a finished run. The first line is what Today shows. */
export function resultComment(r: Result, branch: string): string {
  if (r.status === 'blocked') return `**Question:** ${r.question}\n\n${r.summary}\n\nReply here to answer. Branch: \`${branch}\``;
  const lines = [`Done on \`${branch}\`. ${r.summary}`];
  if (r.assumptions?.length) lines.push('', '**Assumptions**', ...r.assumptions.map((a) => `- ${a}`));
  if (r.skipped?.length) lines.push('', '**Findings left**', ...r.skipped.map((f) => `- ${f.finding}: ${f.reason}`));
  if (r.unverified?.length) lines.push('', '**Not verified**', ...r.unverified.map((u) => `- ${u}`));
  return lines.join('\n');
}

/** Works one issue that the runner has already labeled working. Never throws: a failure becomes a blocked issue with the reason. */
export async function work(s: Settings, issue: Issue, log: (m: string) => void): Promise<Run> {
  const all = [s.ready, s.working, s.blocked];
  const dir = runDir(issue.repo, issue.number);
  mkdirSync(dir, { recursive: true });
  const branch = branchFor(s.branchPrefix, issue);
  let r: Run = saveRun({ url: issue.url, repo: issue.repo, number: issue.number, title: issue.title, state: 'working', branch, worktree: join(HOME, 'worktrees', runKey(issue.repo, issue.number)), sessionId: crypto.randomUUID(), pid: null, startedAt: new Date().toISOString(), updatedAt: '', note: 'Starting.' });
  const tag = `${issue.repo}#${issue.number}`;
  try {
    await makeWorktree(s, issue, branch, r.worktree);
    const prompt = fill(await Bun.file(s.repos[issue.repo].prompt).text(), { url: issue.url, repo: issue.repo, number: issue.number }) + RESULT_INSTRUCTIONS;
    log(`${tag}: working in ${r.worktree}`);
    const { code, quiet } = await runClaude(s, claudeArgs(s, prompt, r.sessionId), r.worktree, dir, (pid) => (r = saveRun({ ...r, pid, note: 'Working.' })));
    if (quiet) throw new Error(`no output for ${s.silenceMinutes} minutes, so it was stopped`);
    const file = join(dir, 'result.json');
    if (!existsSync(file)) {
      const err = (await Bun.file(join(dir, 'stderr.log')).text().catch(() => '')).trim().split('\n').pop();
      throw new Error(code === 0 ? 'it finished without writing a result' : `claude exited ${code}${err ? ` (${err.slice(0, 200)})` : ''}`);
    }
    const result = parseResult(await Bun.file(file).json());
    await comment(issue.url, resultComment(result, branch));
    await moveLabel(issue, s.working, result.status === 'blocked' ? s.blocked : null, all);
    r = saveRun({ ...r, pid: null, state: result.status, note: result.status === 'blocked' ? result.question! : result.summary });
    log(`${tag}: ${result.status}`);
  } catch (e) {
    const why = (e as Error).message;
    log(`${tag}: failed, ${why}`);
    r = saveRun({ ...r, pid: null, state: 'failed', note: why });
    // Blocked, so it shows on Today as something to look at rather than vanishing.
    await comment(issue.url, `**The agent stopped:** ${why}.\n\nIts log is in \`${dir}\` on the machine running gh-runner. Remove the \`${s.blocked}\` label and add \`${s.ready}\` to try again.`).catch(() => {});
    await moveLabel(issue, s.working, s.blocked, all).catch(() => {});
  }
  return r;
}
