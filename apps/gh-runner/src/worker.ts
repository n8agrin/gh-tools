// One issue, start to finish: a worktree on a fresh branch, one `claude -p` run in it, then the
// result back on GitHub as a label and a comment.
import { existsSync, mkdirSync, openSync, writeSync, closeSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { HOME, type Settings } from './config';
import { comment, editBody, moveLabel, openDraft, type Issue } from './github';
import { encodeResult, parseResult, RESULT_INSTRUCTIONS, type Result } from './result';
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

/** What a done run left for you: its assumptions, the review findings it skipped, and what it couldn't verify. */
function leftovers(r: Result): string[] {
  const lines: string[] = [];
  const section = (title: string, items: string[] | undefined) => items?.length && lines.push('', `**${title}**`, ...items.map((x) => `- ${x}`));
  section('Assumptions', r.assumptions);
  section('Findings left', r.skipped?.map((f) => `${f.finding}: ${f.reason}`));
  section('Not verified', r.unverified);
  return lines;
}

/** The comment for a finished run. The first line is what Today shows. */
export function resultComment(r: Result, branch: string, pr: string | null): string {
  const where = pr ? `Draft PR: ${pr}` : `Branch: \`${branch}\``;
  if (r.status === 'blocked') return `**Question:** ${r.question}\n\n${r.summary}\n\nReply here to answer. ${where}`;
  return [pr ? `Done. ${where}` : 'Done, with nothing to commit.', '', r.summary, ...leftovers(r)].join('\n');
}

/** Exported for tests: the draft PR's description, with the result hidden at the end once there is one. */
export function prBody(issue: Pick<Issue, 'repo' | 'number'>, r: Result | null): string {
  const head = `Fixes ${issue.repo}#${issue.number}. Opened by gh-runner.`;
  if (!r) return `${head}\n\nThe agent is still working; this PR updates as it commits.`;
  const tests = r.tests?.length ? ['', '**Tests**', ...r.tests.map((t) => `- ${t.passed ? 'passed' : 'FAILED'}: \`${t.command}\``)] : [];
  return [head, '', r.summary, ...tests, ...leftovers(r), '', encodeResult(r)].join('\n');
}

/** Pushes new commits and opens the draft PR on the first one. Returns the PR, if there is one yet. */
async function sync(s: Settings, issue: Issue, r: Run, pushed: { sha: string }): Promise<string | null> {
  const base = s.repos[issue.repo].base;
  const ahead = Number((await run(['git', 'rev-list', '--count', `origin/${base}..HEAD`], r.worktree)).trim());
  if (!ahead) return r.pr;
  const sha = (await run(['git', 'rev-parse', 'HEAD'], r.worktree)).trim();
  if (sha !== pushed.sha) {
    await run(['git', 'push', '--force-with-lease', '-u', 'origin', `HEAD:refs/heads/${r.branch}`], r.worktree);
    pushed.sha = sha;
  }
  return r.pr ?? openDraft(issue.repo, r.branch, base, issue.title, prBody(issue, null));
}

/** Works one issue that the runner has already labeled working. Never throws: a failure becomes a blocked issue with the reason. */
export async function work(s: Settings, issue: Issue, log: (m: string) => void): Promise<Run> {
  const all = [s.ready, s.working, s.blocked];
  const dir = runDir(issue.repo, issue.number);
  mkdirSync(dir, { recursive: true });
  const branch = branchFor(s.branchPrefix, issue);
  let r: Run = saveRun({ url: issue.url, repo: issue.repo, number: issue.number, title: issue.title, state: 'working', branch, worktree: join(HOME, 'worktrees', runKey(issue.repo, issue.number)), sessionId: crypto.randomUUID(), pid: null, pr: null, startedAt: new Date().toISOString(), updatedAt: '', note: 'Starting.' });
  const tag = `${issue.repo}#${issue.number}`;
  try {
    await makeWorktree(s, issue, branch, r.worktree);
    const prompt = fill(await Bun.file(s.repos[issue.repo].prompt).text(), { url: issue.url, repo: issue.repo, number: issue.number }) + RESULT_INSTRUCTIONS;
    log(`${tag}: working in ${r.worktree}`);
    // While it works, each new commit goes up, and the first one opens the draft PR, so the work is on GitHub from minute one.
    const pushed = { sha: '' };
    let syncing: Promise<void> = Promise.resolve();
    const push = () =>
      (syncing = syncing.then(async () => {
        const pr = await sync(s, issue, r, pushed);
        if (pr !== r.pr) {
          r = saveRun({ ...r, pr });
          log(`${tag}: draft PR ${pr}`);
        }
      }).catch((e) => log(`${tag}: push failed, ${(e as Error).message}`)));
    const timer = setInterval(push, 60_000);
    const { code, quiet } = await runClaude(s, claudeArgs(s, prompt, r.sessionId), r.worktree, dir, (pid) => (r = saveRun({ ...r, pid, note: 'Working.' }))).finally(() => clearInterval(timer));
    await push();
    if (quiet) throw new Error(`no output for ${s.silenceMinutes} minutes, so it was stopped`);
    const file = join(dir, 'result.json');
    if (!existsSync(file)) {
      const err = (await Bun.file(join(dir, 'stderr.log')).text().catch(() => '')).trim().split('\n').pop();
      throw new Error(code === 0 ? 'it finished without writing a result' : `claude exited ${code}${err ? ` (${err.slice(0, 200)})` : ''}`);
    }
    const result = parseResult(await Bun.file(file).json());
    if (r.pr && result.status === 'done') await editBody(r.pr, prBody(issue, result));
    await comment(issue.url, resultComment(result, branch, r.pr));
    await moveLabel(issue, s.working, result.status === 'blocked' ? s.blocked : null, all);
    r = saveRun({ ...r, pid: null, state: result.status, note: result.status === 'blocked' ? result.question! : result.summary });
    log(`${tag}: ${result.status}`);
  } catch (e) {
    const why = (e as Error).message;
    log(`${tag}: failed, ${why}`);
    r = saveRun({ ...r, pid: null, state: 'failed', note: why });
    // Whatever it committed goes up anyway, so nothing is left only on this machine.
    await sync(s, issue, r, { sha: '' }).then((pr) => (r = saveRun({ ...r, pr }))).catch(() => {});
    // Blocked, so it shows on Today as something to look at rather than vanishing.
    await comment(issue.url, `**The agent stopped:** ${why}.\n\nIts log is in \`${dir}\` on the machine running gh-runner. Remove the \`${s.blocked}\` label and add \`${s.ready}\` to try again.`).catch(() => {});
    await moveLabel(issue, s.working, s.blocked, all).catch(() => {});
  }
  return r;
}
