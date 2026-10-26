// Chat about one PR from its page. Each PR gets its own worktree at the PR head and one claude
// session, resumed for every follow-up so it remembers the thread. The first message carries the
// PR's context and the newest review's results. Same read-only setup as review runs: nothing posts.
import { existsSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { HOME, addChatMessage, clearChat, getChat, listChatMessages, listReviews, saveChat, updateChatMessage, type Chat } from './db';
import { fetchPR, type PRDetail } from './github';
import { expand, loadConfig, noCheckout } from './config';
import { DENY, DENY_EDITS, READONLY_BIN, context, git, run } from './review';

const ROOT = join(import.meta.dir, '..');
const MINUTES = 15;

interface Live {
  id: number;
  text: string;
  /** What claude is doing right now when it isn't writing, e.g. "Read src/db.ts". */
  activity: string | null;
  proc: ReturnType<typeof Bun.spawn> | null;
  stopped?: boolean;
}

// Answers in progress, by PR url. The text lands in SQLite when the answer ends.
const live = new Map<string, Live>();

export function chatState(prUrl: string) {
  const messages = listChatMessages(prUrl).map((m) => {
    const l = live.get(prUrl);
    return l && l.id === m.id ? { ...m, text: l.text, activity: l.activity } : m;
  });
  return { messages, running: live.has(prUrl) };
}

/** The saved review's answers, so the chat starts from what the page already shows. */
export function reviewNotes(prUrl: string, headSha: string): string {
  const r = listReviews(prUrl).find((x) => x.steps.some((s) => s.status === 'done' && !['gate', 'worktree'].includes(s.key)));
  if (!r) return 'No local review has run on this PR yet.';
  const stale = r.headSha !== headSha ? ` It ran at ${r.headSha.slice(0, 10)}; the PR has moved on since, so check anything that matters against the current code.` : '';
  const steps = r.steps
    .filter((s) => s.status === 'done' && !['gate', 'worktree'].includes(s.key))
    .map((s) => `### ${s.label}\n${String(s.output ?? '').slice(0, 8000)}`);
  return `The reviewer's page shows these results from a local review run.${stale}\n\n${steps.join('\n\n')}`;
}

async function worktree(pr: PRDetail, chat: Chat | null): Promise<{ dir: string; moved: boolean }> {
  const config = await loadConfig();
  const checkout = config.checkouts[pr.repo] && expand(config.checkouts[pr.repo]);
  if (!checkout || !existsSync(checkout)) throw new Error(noCheckout(pr.repo));
  if (chat && existsSync(chat.dir) && chat.headSha === pr.headSha) return { dir: chat.dir, moved: false };
  await git(checkout, ['fetch', '--quiet', 'origin', `pull/${pr.number}/head`, pr.baseRef]);
  if (chat && existsSync(chat.dir)) {
    await git(chat.dir, ['checkout', '--detach', '--quiet', '--force', pr.headSha]);
    return { dir: chat.dir, moved: true };
  }
  mkdirSync(join(HOME, 'worktrees'), { recursive: true });
  const dir = join(realpathSync(join(HOME, 'worktrees')), `chat-${pr.repo.replace('/', '-')}-${pr.number}`);
  // A leftover folder from an old chat would block `worktree add`, and resuming there would fail anyway.
  if (existsSync(dir)) await dropWorktree(checkout, dir);
  await git(checkout, ['worktree', 'add', '--detach', '--quiet', dir, pr.headSha]);
  return { dir, moved: false };
}

async function dropWorktree(checkout: string, dir: string) {
  await run(['git', 'worktree', 'remove', '--force', dir], checkout);
  rmSync(dir, { recursive: true, force: true });
  await run(['git', 'worktree', 'prune'], checkout);
}

function toolLine(block: any): string {
  const i = block.input ?? {};
  const arg = i.command ?? i.file_path ?? i.pattern ?? i.path ?? i.url ?? '';
  return `${block.name}${arg ? ` ${String(arg).split('\n')[0].slice(0, 80)}` : ''}`;
}

/** Start an answer in the background. One answer per PR at a time. */
export async function ask(prUrl: string, text: string) {
  if (live.has(prUrl)) throw new Error('Still answering the last message.');
  addChatMessage(prUrl, 'user', text, 'done');
  const id = addChatMessage(prUrl, 'assistant', '', 'running');
  const l: Live = { id, text: '', activity: 'Getting the PR ready', proc: null };
  live.set(prUrl, l);
  const fail = (msg: string) => updateChatMessage(id, `${l.text}${l.text ? '\n\n' : ''}**Failed:** ${msg}`, 'failed');

  (async () => {
    const pr = await fetchPR(prUrl);
    const chat = getChat(prUrl);
    const { dir, moved } = await worktree(pr, chat);
    const worktrees = realpathSync(join(HOME, 'worktrees'));
    // A new or restarted chat gets the whole context; a follow-up only hears what changed.
    const fresh = !chat?.sessionId || chat.dir !== dir;
    let prompt = text;
    if (fresh) {
      const intro = await Bun.file(join(ROOT, 'prompts/chat.md')).text();
      prompt = `${intro}${context(pr)}\n\n---\n${reviewNotes(prUrl, pr.headSha)}\n\n---\nThe reviewer's first message:\n\n${text}`;
    } else if (moved) {
      prompt = `(The PR has new commits. The worktree is now at ${pr.headSha}; see the change with \`git diff ${pr.baseSha}...HEAD\`.)\n\n${text}`;
    }
    saveChat({ prUrl, sessionId: fresh ? null : chat!.sessionId, dir, headSha: pr.headSha });

    const args = ['claude', '-p', prompt, '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--permission-mode', 'auto', '--strict-mcp-config', '--disallowedTools', ...DENY, ...DENY_EDITS];
    if (!fresh) args.push('--resume', chat!.sessionId!);
    const env = { ...process.env, PATH: `${READONLY_BIN}:${process.env.PATH}`, GH_REVIEW_WORKTREES: worktrees, CLAUDECODE: undefined };
    const proc = Bun.spawn(args, { cwd: dir, env, stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' });
    l.proc = proc;
    const timer = setTimeout(() => proc.kill(), MINUTES * 60_000);
    const stderr = new Response(proc.stderr).text();

    let result: any = null;
    let buf = '';
    let blockOpen = false;
    const decoder = new TextDecoder();
    for await (const chunk of proc.stdout) {
      buf += decoder.decode(chunk, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        let ev: any;
        try {
          ev = JSON.parse(line);
        } catch {
          continue;
        }
        if (ev.session_id && !getChat(prUrl)?.sessionId) saveChat({ prUrl, sessionId: ev.session_id, dir, headSha: pr.headSha });
        const e = ev.type === 'stream_event' ? ev.event : null;
        if (e?.type === 'content_block_start' && e.content_block?.type === 'text') {
          // Text before and after a tool call arrives as separate blocks; keep them as paragraphs.
          if (l.text && !blockOpen) l.text += '\n\n';
          blockOpen = true;
        }
        if (e?.type === 'content_block_delta' && e.delta?.type === 'text_delta') (l.text += e.delta.text), (l.activity = null);
        if (e?.type === 'content_block_stop') blockOpen = false;
        if (ev.type === 'assistant') for (const b of ev.message?.content ?? []) if (b.type === 'tool_use') l.activity = toolLine(b);
        if (ev.type === 'result') result = ev;
      }
    }
    clearTimeout(timer);
    await proc.exited;
    if (proc.signalCode) return fail(l.stopped ? 'stopped.' : `timed out after ${MINUTES} minutes.`);
    if (!result || result.is_error) return fail(String(result?.result ?? ((await stderr).trim().slice(-1500) || `claude exited ${proc.exitCode}`)));
    updateChatMessage(id, l.text.trim() || String(result.result ?? ''), 'done');
  })()
    .catch((e) => fail((e as Error).message))
    .finally(() => live.delete(prUrl));
}

export function stop(prUrl: string) {
  const l = live.get(prUrl);
  if (l?.proc) (l.stopped = true), l.proc.kill();
}

/** Forget the thread and throw its worktree away. */
export async function reset(prUrl: string) {
  if (live.has(prUrl)) throw new Error('Stop the answer first.');
  const chat = getChat(prUrl);
  clearChat(prUrl);
  if (!chat || !existsSync(chat.dir)) return;
  const pr = await fetchPR(prUrl).catch(() => null);
  const checkout = pr && (await loadConfig()).checkouts[pr.repo];
  if (checkout) await dropWorktree(expand(checkout), chat.dir);
  else rmSync(chat.dir, { recursive: true, force: true });
}
