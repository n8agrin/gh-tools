// Settings live in ~/.gh-runner/config.json, outside the repo. Labels default to the ones gh-review's
// `agent` config uses, so Start agent on Today and this runner agree without saying so twice.
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

export const expand = (p: string) => p.replace(/^~(?=\/|$)/, homedir());

export const HOME = expand(process.env.GH_RUNNER_HOME ?? '~/.gh-runner');
export const ROOT = join(import.meta.dir, '..');
export const CONFIG = process.env.GH_RUNNER_CONFIG ?? join(HOME, 'config.json');

/** One repo the runner takes issues from. */
export interface Repo {
  /** Your clone of the repo. Worktrees branch from it. */
  checkout: string;
  /** Branch new work starts from. Default main. */
  base?: string;
  /** How to make the worktree, run in `checkout` with {path}, {branch} and {base} filled in, like
   * ["bin/worktree-new.mts", "{path}", "origin/{base}", "-b", "{branch}"]. Default: git worktree add. */
  worktree?: string[];
  /** The prompt file the agent gets, with {url}, {repo} and {number} filled in. Relative paths are
   * from this app's folder. Default prompts/fix.md. */
  prompt?: string;
}

export interface Config {
  /** Repos to take issues from, like {"owner/repo": {"checkout": "~/src/repo"}}. */
  repos: Record<string, Repo>;
  /** The label that queues an issue. Default agent:ready. */
  ready?: string;
  /** The label while an agent works on it. Default agent:working. */
  working?: string;
  /** The label while the agent waits on you. Default agent:blocked. */
  blocked?: string;
  /** How many issues may be working or blocked at once. Default 5. */
  cap?: number;
  /** Seconds between looks at GitHub. Default 60. */
  pollSeconds?: number;
  /** Prefix for the branches agents work on. Default agent/. */
  branchPrefix?: string;
  /** The Claude model, passed on every run and resume. Default: whatever claude picks. */
  model?: string;
  /** Claude Code's --permission-mode for the agent. Default auto. */
  permissionMode?: string;
  /** Minutes with no output before a run counts as stuck and is stopped. Default 30. */
  silenceMinutes?: number;
}

export type Settings = Required<Omit<Config, 'repos' | 'model'>> & { model: string | null; repos: Record<string, Required<Omit<Repo, 'worktree'>> & { worktree: string[] | null }> };

/** The config with every default filled in and every path expanded. */
export function settle(c: Config): Settings {
  if (!c.repos || !Object.keys(c.repos).length) throw new Error(`No repos in ${CONFIG}. Start from config.example.json.`);
  const repos = Object.fromEntries(
    Object.entries(c.repos).map(([name, r]) => {
      if (!/^[\w.-]+\/[\w.-]+$/.test(name)) throw new Error(`"${name}" is not owner/repo.`);
      if (!r?.checkout) throw new Error(`${name} has no checkout.`);
      const prompt = expand(r.prompt ?? 'prompts/fix.md');
      return [name, { checkout: expand(r.checkout), base: r.base ?? 'main', worktree: r.worktree ?? null, prompt: isAbsolute(prompt) ? prompt : join(ROOT, prompt) }];
    }),
  );
  return {
    repos,
    ready: c.ready ?? 'agent:ready',
    working: c.working ?? 'agent:working',
    blocked: c.blocked ?? 'agent:blocked',
    cap: c.cap ?? 5,
    pollSeconds: c.pollSeconds ?? 60,
    branchPrefix: c.branchPrefix ?? 'agent/',
    model: c.model ?? null,
    permissionMode: c.permissionMode ?? 'auto',
    silenceMinutes: c.silenceMinutes ?? 30,
  };
}

export async function loadConfig(): Promise<Settings> {
  if (!existsSync(CONFIG)) throw new Error(`No config at ${CONFIG}. Copy config.example.json there and list your repos.`);
  return settle(await Bun.file(CONFIG).json());
}
