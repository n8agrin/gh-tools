// "Run review": a local, read-only review of one PR. It checks out the PR head in a throwaway git
// worktree of your own clone, runs each check in your config through `claude -p` there, and saves
// every step to SQLite as it goes. Nothing here writes to GitHub, and the readonly gh and git
// wrappers in bin/readonly make sure nothing the checks start can either.
import { existsSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { HOME, cachedPR, createReview, finishReview, listReviews, saveStep, viewer, type Review, type ReviewStep } from './db';
import { fetchDiff, fetchPR, type PRDetail } from './github';
import { findingsNote, parseFindings, saveFindings } from './findings';
import { appPath, DANGER, expand, loadConfig, noCheckout, ROOT, type Check } from './config';
import { decide, floorSignal, keepFindings, pathFloor, raise, type RedPath } from './signal';
import { verifyTaste } from './taste';

export const READONLY_BIN = join(ROOT, 'bin', 'readonly');

export { expand, loadConfig, type Check, type Config as ReviewConfig } from './config';

/** Why an optional check can't run on this machine, or null when it can. */
function unavailable(check: Check): string | null {
  if (check.needs && !existsSync(expand(check.needs))) return `${check.label} needs ${check.needs}, which isn't on this machine.`;
  return null;
}

export async function optionalChecks() {
  return (await loadConfig()).checks.filter((c) => c.optional).map((c) => ({ key: c.key, label: c.label, hint: c.hint, unavailable: unavailable(c) }));
}

/** Every check, so the page can offer to rerun any one of them on its own. */
export async function allChecks() {
  return (await loadConfig()).checks.map((c) => ({ key: c.key, label: c.label, optional: !!c.optional, hint: c.hint, unavailable: c.optional ? unavailable(c) : null, skipOnMine: !!c.skipOnMine, findings: !!c.findings }));
}

// Belt and braces on top of the wrappers: the claude runs never get these tools at all.
export const DENY = [
  'Bash(gh pr edit:*)', 'Bash(gh pr review:*)', 'Bash(gh pr comment:*)', 'Bash(gh pr merge:*)', 'Bash(gh pr close:*)',
  'Bash(gh pr ready:*)', 'Bash(gh issue comment:*)', 'Bash(gh issue edit:*)', 'Bash(gh label:*)', 'Bash(gh api -X:*)',
  'Bash(gh api --method:*)', 'Bash(git push:*)', 'Bash(*/bin/gh *)', 'Bash(*/bin/git *)',
];
// The core checks only read, so they don't get file edits either.
export const DENY_EDITS = ['Edit', 'Write', 'NotebookEdit'];

type Proc = ReturnType<typeof Bun.spawn>;

/** Runs a command. Pass `procs` to keep hold of it while it runs, so Stop can kill it. */
export async function run(cmd: string[], cwd: string, env?: Record<string, string | undefined>, timeoutMs = 0, procs?: Set<Proc>) {
  const proc = Bun.spawn(cmd, { cwd, env, stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' });
  procs?.add(proc);
  const timer = timeoutMs ? setTimeout(() => proc.kill(), timeoutMs) : null;
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  procs?.delete(proc);
  if (timer) clearTimeout(timer);
  return { out, err, code, timedOut: proc.signalCode === 'SIGTERM' };
}

export async function git(cwd: string, args: string[]) {
  const r = await run(['git', ...args], cwd);
  if (r.code !== 0) throw new Error(`git ${args.join(' ')}: ${r.err.trim() || `exited ${r.code}`}`);
  return r.out.trim();
}

/** The PR's stack from GitHub's own stack data, as the queue last saw it. */
function stackLines(pr: PRDetail): string {
  const stack = cachedPR(pr.url)?.stack;
  if (!stack) return 'Not in a GitHub stack that gh-review knows of. The description may still list related PRs.';
  return [...stack.entries]
    .sort((a, b) => a.position - b.position)
    .map((e) => `${e.position}. #${e.number} ${e.title}${e.number === pr.number ? '  <- this PR' : ''} (${e.state.toLowerCase()})`)
    .join('\n');
}

export function context(pr: PRDetail): string {
  const base = `https://github.com/${pr.repo}/blob/${pr.baseSha}`;
  const head = `https://github.com/${pr.repo}/blob/${pr.headSha}`;
  return `

---
PR: ${pr.url} by @${pr.author}
Title: ${pr.title}
Labels: ${pr.labels.join(', ') || 'none'}
Base: ${pr.baseRef} at ${pr.baseSha}. Head: ${pr.headSha}.

Your working directory is a throwaway git worktree of the PR head. See the change with \`git diff ${pr.baseSha}...HEAD\` (add --stat for an overview).
Link to code on the base branch as ${base}/<path>#L<line> and to the PR's own code as ${head}/<path>#L<line>.

Stack, bottom first:
${stackLines(pr)}

Changed files:
${pr.files.map((f) => `- ${f.path} (+${f.additions} -${f.deletions})`).join('\n')}

Description:
<<<
${pr.body.trim() || '(empty)'}
>>>

This review is read-only. Never write to GitHub: no comments, reviews, labels, reactions or edits, and never push.`;
}

interface ClaudeOptions {
  cwd: string;
  worktrees: string;
  procs?: Set<Proc>;
  model?: string;
  schema?: string;
  edits?: boolean;
  note?: string;
  minutes: number;
}

/** One `claude -p` run with the read-only setup. Returns the parsed --output-format json result. */
async function claude(prompt: string, o: ClaudeOptions): Promise<any> {
  const args = ['claude', '-p', prompt, '--output-format', 'json', '--permission-mode', 'auto', '--strict-mcp-config', '--disallowedTools', ...DENY, ...(o.edits ? [] : DENY_EDITS)];
  if (o.schema) args.push('--json-schema', o.schema);
  if (o.note) args.push('--append-system-prompt', o.note);
  if (o.model) args.push('--model', o.model);
  const env = { ...process.env, PATH: `${READONLY_BIN}:${process.env.PATH}`, GH_REVIEW_WORKTREES: o.worktrees, CLAUDECODE: undefined };
  const r = await run(args, o.cwd, env, o.minutes * 60_000, o.procs);
  if (r.timedOut) throw new Error(`timed out after ${o.minutes} minutes`);
  let res: any;
  try {
    res = JSON.parse(r.out);
  } catch {
    throw new Error((r.err || r.out).trim().slice(-2000) || `claude exited ${r.code}`);
  }
  if (res.is_error) throw new Error(String(res.result ?? res.subtype ?? 'claude reported an error'));
  return res;
}

async function runCheck(check: Check, pr: PRDetail, cwd: string, worktrees: string, red: RedPath[], reviewId: number, procs?: Set<Proc>): Promise<string> {
  // A red path decides the signal on its own, so there's nothing for the AI to add.
  const floor = check.key === 'signal' ? pathFloor(pr.files.map((f) => f.path), red) : [];
  if (floor.length) return JSON.stringify(floorSignal(floor));
  const fill = (s: string) => s.replace(/\{url\}/g, pr.url).replace(/\{repo\}/g, pr.repo).replace(/\{number\}/g, String(pr.number));
  const minutes = check.optional ? 45 : 20;
  // The findings file sits in the worktree, the one place a read-only check is allowed to write.
  const findingsFile = check.findings ? join(cwd, '.gh-review-findings.json') : '';
  if (check.command) {
    const env = { ...process.env, PATH: `${READONLY_BIN}:${process.env.PATH}`, GH_REVIEW_WORKTREES: worktrees, GH_REVIEW_FINDINGS: findingsFile || undefined };
    const r = await run(check.command.map(fill).map(expand), cwd, env, minutes * 60_000, procs);
    if (r.timedOut) throw new Error(`timed out after ${minutes} minutes`);
    if (r.code !== 0) throw new Error((r.err || r.out).trim().slice(-2000) || `${check.command[0]} exited ${r.code}`);
    return r.out.trim() + (await saveToolFindings(check, pr, findingsFile, reviewId));
  }
  if (!check.prompt) throw new Error(`${check.label} has neither a prompt nor a command in your config.`);
  const isFile = !check.prompt.startsWith('/');
  // Prompt files can name {{danger}}, the areas your config says need a careful read.
  const danger = ((await loadConfig()).danger ?? DANGER).join(', ');
  const prompt = isFile ? (await Bun.file(appPath(check.prompt)).text()).replace(/\{\{danger\}\}/g, danger) + context(pr) : fill(check.prompt);
  const schema = check.schema ? await Bun.file(appPath(check.schema)).text() : undefined;
  const note = [check.note, findingsFile && findingsNote(findingsFile)].filter(Boolean).join('\n\n') || undefined;
  const opts = { cwd, worktrees, procs, schema, edits: check.optional || check.findings, note, model: check.model, minutes };
  const res = await claude(prompt, opts);
  if (check.findings) return String(res.result ?? '') + (await saveToolFindings(check, pr, findingsFile, reviewId));
  if (!schema) return String(res.result ?? '');
  const out = res.structured_output ?? JSON.parse(res.result);
  if (check.key === 'signal') return JSON.stringify(decide(out, floor));
  if (check.key === 'check') return JSON.stringify({ findings: keepFindings(out.findings, pr.files.map((f) => f.path)) });
  if (check.key !== 'taste') return JSON.stringify(out);

  // A second, skeptical pass drops comparisons where the prior art doesn't do the same job.
  const verifyPrompt = await Bun.file(join(ROOT, 'prompts/taste-verify.md')).text();
  const verifySchema = await Bun.file(join(ROOT, 'prompts/taste-verify.schema.json')).text();
  const read = async (sha: string, path: string) => {
    const r = await run(['git', 'show', `${sha}:${path}`], cwd);
    return r.code === 0 ? r.out : null;
  };
  const ask = async (findings: string) => {
    const v = await claude(verifyPrompt + findings, { cwd, worktrees, procs, schema: verifySchema, minutes: 15 });
    return v.structured_output ?? JSON.parse(v.result);
  };
  try {
    return JSON.stringify(await verifyTaste(out, { read, ask }));
  } catch (e) {
    return JSON.stringify({ ...out, verify_error: (e as Error).message });
  }
}

/** Saves what a findings check wrote, so the page can offer it after the worktree is gone. Returns a line for the output when that fails. */
async function saveToolFindings(check: Check, pr: PRDetail, path: string, reviewId: number): Promise<string> {
  if (!check.findings) return '';
  if (!existsSync(path)) return `\n\n_${check.label} wrote no findings file, so there's nothing to post from here._`;
  try {
    const findings = parseFindings(JSON.parse(await Bun.file(path).text()), await fetchDiff(pr.url));
    saveFindings({ reviewId, key: check.key, headSha: pr.headSha, findings, posted: [] });
    return '';
  } catch (e) {
    return `\n\n_Couldn't read ${check.label}'s findings file: ${(e as Error).message}_`;
  }
}

// Runs going on in this server, so Stop can reach their Claude processes.
interface Live {
  stopped: boolean;
  steps: Map<string, { stopped: boolean; procs: Set<Proc> }>;
  mark: (key: string) => void;
}
const live = new Map<number, Live>();
export const STOPPED = 'Stopped by you';

/** Stops a running review, or just one of its steps. Kills the step's Claude processes; the worktree is cleaned up as usual. */
export function stopReview(url: string, key?: string): boolean {
  const r = listReviews(url).find((x) => x.status === 'running');
  const ctl = r && live.get(r.id);
  if (!ctl) return false;
  if (!key) ctl.stopped = true;
  for (const [k, sc] of ctl.steps) {
    if (key && k !== key) continue;
    sc.stopped = true;
    for (const p of sc.procs) p.kill();
    ctl.mark(k);
  }
  return true;
}

/**
 * Start a review in the background and return its id. One review per PR runs at a time.
 * With `only`, just those checks run and every other step is copied from run `from`, so adding
 * an optional check or redoing one section doesn't redo the rest.
 */
export async function startReview(url: string, extras: string[], only: string[] = [], from?: number): Promise<number> {
  const past = listReviews(url);
  const running = past.find((r) => r.status === 'running');
  if (running) return running.id;
  const [pr, config] = await Promise.all([fetchPR(url), loadConfig()]);
  const base = only.length ? past.find((r) => r.id === from) : undefined;
  if (only.length && !base) throw new Error('There is no earlier run to keep the other steps from, so run everything instead.');
  // Mixing results from two different heads would hide that some of them are stale.
  if (base && base.headSha !== pr.headSha) throw new Error(`The PR has new commits since run ${base.id}, so run everything instead.`);
  const mine = !!viewer() && pr.author === viewer();
  const wanted = config.checks.filter((c) => !(mine && c.skipOnMine));
  const checks = base ? wanted.filter((c) => only.includes(c.key)) : wanted.filter((c) => !c.optional || extras.includes(c.key));
  const fresh = (c: Check): ReviewStep => ({ key: c.key, label: c.label, status: 'queued' });
  const kept = (base?.steps ?? []).filter((x) => x.key !== 'gate' && x.key !== 'worktree').map((x) => (only.includes(x.key) ? { ...x, status: 'queued' as const, output: undefined, startedAt: undefined, endedAt: undefined } : { ...x }));
  const steps: ReviewStep[] = [
    { key: 'gate', label: 'Bug pass', status: 'queued' },
    { key: 'worktree', label: 'Worktree', status: 'queued' },
    ...(base ? [...kept, ...checks.filter((c) => !kept.some((x) => x.key === c.key)).map(fresh)] : checks.map(fresh)),
  ];
  const id = createReview(url, pr.headSha, steps);
  const now = () => new Date().toISOString();
  const set = (key: string, patch: Partial<ReviewStep>) => {
    const s = steps.find((x) => x.key === key)!;
    Object.assign(s, patch);
    saveStep(id, s);
  };

  // The gate only needs the label or a Copilot review, so it answers right away. It never stops the rest.
  const labelled = !!config.reviewedLabel && pr.labels.includes(config.reviewedLabel);
  const reviewed = labelled || pr.copilotReviewed;
  const via = labelled ? 'label' : pr.copilotReviewed ? 'copilot' : null;
  set('gate', { status: 'done', startedAt: now(), endedAt: now(), output: JSON.stringify({ reviewed, via, label: config.reviewedLabel ?? null }) });

  // A stopped step shows as skipped straight away, before its process has finished dying.
  const ctl: Live = {
    stopped: false,
    steps: new Map(checks.map((c) => [c.key, { stopped: false, procs: new Set<Proc>() }])),
    mark: (key) => {
      const st = steps.find((x) => x.key === key);
      if (st && (st.status === 'running' || st.status === 'queued')) set(key, { status: 'skipped', endedAt: now(), output: STOPPED });
    },
  };
  live.set(id, ctl);
  const finish = (status: 'done' | 'failed', error?: string) => {
    live.delete(id);
    finishReview(id, ctl.stopped ? 'failed' : status, ctl.stopped ? STOPPED : error);
  };

  (async () => {
    const checkout = config.checkouts[pr.repo] && expand(config.checkouts[pr.repo]);
    if (!checkout || !existsSync(checkout)) {
      const msg = noCheckout(pr.repo);
      for (const s of steps) if (s.status === 'queued') set(s.key, { status: 'failed', output: msg });
      return finish('failed', msg);
    }
    mkdirSync(join(HOME, 'worktrees'), { recursive: true });
    const worktrees = realpathSync(join(HOME, 'worktrees'));
    const dir = join(worktrees, `${pr.repo.replace('/', '-')}-${pr.number}-${id}`);
    try {
      set('worktree', { status: 'running', startedAt: now() });
      // Fetching only moves remote refs; the clone's own checked-out branch and files stay as they are.
      await git(checkout, ['fetch', '--quiet', 'origin', `pull/${pr.number}/head`, pr.baseRef]);
      await git(checkout, ['worktree', 'add', '--detach', '--quiet', dir, pr.headSha]);
      set('worktree', { status: 'done', endedAt: now(), output: `${dir} at ${pr.headSha.slice(0, 10)}, from ${checkout}` });
    } catch (e) {
      const msg = (e as Error).message;
      set('worktree', { status: 'failed', endedAt: now(), output: msg });
      for (const s of steps) if (s.status === 'queued') set(s.key, { status: 'skipped', output: 'no worktree' });
      return finish('failed', msg);
    }

    await Promise.all(
      checks.map(async (c) => {
        const why = c.optional ? unavailable(c) : null;
        const sc = ctl.steps.get(c.key)!;
        if (sc.stopped || ctl.stopped) return ctl.mark(c.key);
        if (why) return set(c.key, { status: 'skipped', output: why });
        if (c.needsInPR && !existsSync(join(dir, c.needsInPR)))
          return set(c.key, { status: 'skipped', output: `This PR's branch doesn't have ${c.needsInPR} yet. Rebasing it on its base branch may bring it in.` });
        set(c.key, { status: 'running', startedAt: now() });
        try {
          const output = await runCheck(c, pr, dir, worktrees, config.red ?? [], id, sc.procs);
          if (sc.stopped) return ctl.mark(c.key);
          set(c.key, { status: 'done', endedAt: now(), output });
        } catch (e) {
          if (sc.stopped) return ctl.mark(c.key);
          set(c.key, { status: 'failed', endedAt: now(), output: (e as Error).message });
        }
      }),
    );

    // Signal and Check run side by side, so a finding raises the color once both are in.
    const sig = steps.find((s) => s.key === 'signal');
    const chk = steps.find((s) => s.key === 'check');
    const redid = (k: string) => checks.some((c) => c.key === k);
    if (sig?.status === 'done' && chk?.status === 'done' && (redid('signal') || redid('check'))) {
      const raised = raise(JSON.parse(sig.output!), JSON.parse(chk.output!).findings);
      set('signal', { output: JSON.stringify(raised) });
    }

    // Throw the worktree away. --force because checks may leave scratch files behind.
    await run(['git', 'worktree', 'remove', '--force', dir], checkout);
    rmSync(dir, { recursive: true, force: true });
    await run(['git', 'worktree', 'prune'], checkout);
    finish(steps.some((s) => s.status === 'failed') ? 'failed' : 'done');
  })().catch((e) => finish('failed', (e as Error).message));

  return id;
}

export { listReviews, type Review };
