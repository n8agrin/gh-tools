// One issue, start to finish: a worktree on a fresh branch, one `claude -p` run in it, then the
// result back on GitHub as a label and a comment.
import { existsSync, mkdirSync, openSync, writeSync, closeSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { HOME, type Settings } from './config';
import { comment, editBody, moveLabel, openDraft, type Issue } from './github';
import { encodeResult, parseResult, RESULT_INSTRUCTIONS, type Result } from './result';
import { BUG_RULES, kindOf, proofProblem } from './route';
import { loadRun, runDir, runKey, saveRun, type Run } from './runs';

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
  // A branch left from an earlier run (its worktree removed after the PR closed) is checked out again, not made anew.
  const had = await run(['git', 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], repo.checkout).then(() => true, () => false);
  const cmd = had ? ['git', 'worktree', 'add', path, branch] : repo.worktree ? repo.worktree.map((a) => fill(a, { path, branch, base: repo.base })) : ['git', 'worktree', 'add', '-b', branch, path, `origin/${repo.base}`];
  await run(cmd, repo.checkout);
}

/** Removes a finished run's worktree once its PR has merged or closed. Plain `git worktree remove`
 * refuses a worktree with uncommitted changes, so anything left behind stays. The branch stays too. */
export async function removeWorktree(s: Settings, r: Run): Promise<void> {
  const repo = s.repos[r.repo];
  if (!repo) return;
  await run(['git', 'worktree', 'remove', r.worktree], repo.checkout);
}

/** The claude command for a run, with the runner's own guard rails: it never pushes or opens PRs itself. */
export function claudeArgs(s: Settings, prompt: string, sessionId: string, resume = false): string[] {
  return [
    'claude', '-p', prompt,
    resume ? '--resume' : '--session-id', sessionId,
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

/** The last lines of a test run as a code block, with any fence in the output defused. */
const output = (text: string) => ['```', ...text.trim().split('\n').slice(-25).map((l) => l.replace(/```/g, "'''")), '```'];

/** A bug's proof for the PR description: the failing run, then the passing one, or why there is no test. */
function proofLines(r: Result): string[] {
  if (r.proof) return ['', '**Red, then green**', `\`${r.proof.test}\`, with \`${r.proof.command}\``, '', 'Before the fix:', ...output(r.proof.red), '', 'After the fix:', ...output(r.proof.green)];
  return r.noTest?.trim() ? ['', `**No failing test:** ${r.noTest.trim()}`] : [];
}

/** Exported for tests: the draft PR's description, with the result hidden at the end once there is one. */
export function prBody(issue: Pick<Issue, 'repo' | 'number'>, r: Result | null): string {
  const head = `Fixes ${issue.repo}#${issue.number}. Opened by gh-runner.`;
  if (!r) return `${head}\n\nThe agent is still working; this PR updates as it commits.`;
  const tests = r.tests?.length ? ['', '**Tests**', ...r.tests.map((t) => `- ${t.passed ? 'passed' : 'FAILED'}: \`${t.command}\``)] : [];
  return [head, '', r.summary, ...proofLines(r), ...tests, ...leftovers(r), '', encodeResult(r)].join('\n');
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

/** How a run begins: fresh from the repo's prompt, or the same Claude session carrying on with a message. */
export type Begin = { resume: false } | { resume: true; message: string };

/** The message a resumed session gets: your answer, or a note that the runner restarted. */
export const resumePrompt = (message: string) => `${message.trim()}\n${RESULT_INSTRUCTIONS}`;

/** Exported for tests: whether Claude ever started this session, read off the transcript's init lines. A run that
 * failed before that (a bad worktree, claude not found) has nothing to resume, and `--resume` would fail every time. */
export const sessionStarted = (transcript: string, sessionId: string) =>
  transcript.split('\n').some((l) => l.includes('"subtype":"init"') && l.includes(`"session_id":"${sessionId}"`));

/**
 * Works one issue that the runner has already labeled working. Never throws: a failure becomes a
 * blocked issue with the reason. A fresh start on an issue that ran before keeps its branch,
 * worktree and PR, with a new session.
 */
export async function work(s: Settings, issue: Issue, log: (m: string) => void, begin: Begin = { resume: false }): Promise<Run> {
  const all = [s.ready, s.working, s.blocked];
  const dir = runDir(issue.repo, issue.number);
  mkdirSync(dir, { recursive: true });
  const before = await loadRun(issue.repo, issue.number);
  if (begin.resume && !before) throw new Error(`no run to resume for ${issue.url}`);
  const branch = before?.branch ?? branchFor(s.branchPrefix, issue);
  let r: Run = saveRun({
    url: issue.url, repo: issue.repo, number: issue.number, title: issue.title, state: 'working', branch,
    worktree: before?.worktree ?? join(HOME, 'worktrees', runKey(issue.repo, issue.number)),
    sessionId: begin.resume ? before!.sessionId : crypto.randomUUID(),
    pid: null, pr: before?.pr ?? null, startedAt: before?.startedAt ?? new Date().toISOString(), updatedAt: '',
    kind: before?.kind ?? kindOf(issue.labels, s.repos[issue.repo].bugLabels),
    note: begin.resume ? 'Picking up again.' : 'Starting.',
  });
  const tag = `${issue.repo}#${issue.number}`;
  try {
    await makeWorktree(s, issue, branch, r.worktree);
    // With no session to go back to, it starts one with the repo's prompt and your message after it.
    const resume = begin.resume && sessionStarted(await Bun.file(join(dir, 'transcript.jsonl')).text().catch(() => ''), r.sessionId);
    const fresh = () => Bun.file(s.repos[issue.repo].prompt).text().then((t) => fill(t, { url: issue.url, repo: issue.repo, number: issue.number }));
    const prompt = resume ? resumePrompt(begin.message) : `${await fresh()}${begin.resume ? `\n\n${begin.message.trim()}\n` : ''}${r.kind === 'bug' ? BUG_RULES : ''}${RESULT_INSTRUCTIONS}`;
    log(`${tag}: ${resume ? 'resuming' : 'working'} as a ${r.kind} in ${r.worktree}`);
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
    const { code, quiet } = await runClaude(s, claudeArgs(s, prompt, r.sessionId, resume), r.worktree, dir, (pid) => (r = saveRun({ ...r, pid, note: 'Working.' }))).finally(() => clearInterval(timer));
    await push();
    if (quiet) throw new Error(`no output for ${s.silenceMinutes} minutes, so it was stopped`);
    const file = join(dir, 'result.json');
    if (!existsSync(file)) {
      const err = (await Bun.file(join(dir, 'stderr.log')).text().catch(() => '')).trim().split('\n').pop();
      throw new Error(code === 0 ? 'it finished without writing a result' : `claude exited ${code}${err ? ` (${err.slice(0, 200)})` : ''}`);
    }
    const result = parseResult(await Bun.file(file).json());
    if (r.kind === 'bug' && result.status === 'done') {
      const changed = (await run(['git', 'diff', '--name-only', `origin/${s.repos[issue.repo].base}...HEAD`], r.worktree)).split('\n').filter(Boolean);
      const problem = proofProblem(result, changed);
      if (problem) throw new Error(`it called the bug fixed without showing it: ${problem}`);
    }
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
    await comment(issue.url, `**The agent stopped:** ${why}.\n\nIts log is in \`${dir}\` on the machine running gh-runner. Reply here to have it pick up where it stopped, or swap \`${s.blocked}\` for \`${s.ready}\` to start over on the same branch.`).catch(() => {});
    await moveLabel(issue, s.working, s.blocked, all).catch(() => {});
  }
  return r;
}
