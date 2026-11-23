// Your settings live in ~/.gh-review/config.json, outside the repo, so each person keeps their own
// repos, checks and actions. Without one, the app runs on config.example.json.
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import type { Action } from './actions';
import { HOME } from './db';
import type { RedPath } from './signal';

export const ROOT = join(import.meta.dir, '..');
export const CONFIG = process.env.GH_REVIEW_CONFIG ?? join(HOME, 'config.json');
export const EXAMPLE = join(ROOT, 'config.example.json');

export interface Check {
  key: string;
  label: string;
  /** A prompt file under prompts/ (or your own path), or a slash command with {url} filled in. Not needed with `command`. */
  prompt?: string;
  /** JSON schema file; when set the check returns JSON instead of markdown. */
  schema?: string;
  /** Off unless you tick it for a run. */
  optional?: boolean;
  /** Shown next to an optional check's checkbox. */
  hint?: string;
  /** Extra system prompt, for slash commands written for an interactive session. */
  note?: string;
  /** Which Claude model runs it, like sonnet. Defaults to whatever claude -p uses. */
  model?: string;
  /** Left out on your own PRs, like Signal, which only answers whether to approve. */
  skipOnMine?: boolean;
  /** Run this program in the worktree instead of Claude, like ["my-reviewer", "{url}"]. Its output is the step's result. */
  command?: string[];
  /** The check writes findings you can pick and post, as JSON to the file in $GH_REVIEW_FINDINGS. */
  findings?: boolean;
  /** A file the check needs on this machine, like the skill it runs. Without it the check is skipped. */
  needs?: string;
  /** A file the check needs in the PR's own branch, like a repo command it runs. Without it the check is skipped. */
  needsInPR?: string;
}

/** A remote test box per PR that a label starts and a bot comment reports on, like a preview deploy. */
export interface Session {
  /** What the buttons call it, as in Test on Depot. Defaults to "a test box". */
  name?: string;
  /** The label that starts the box. Removing it stops the box. */
  label: string;
  /** Text in the bot's comment once the box is up, and once it has ended. */
  up: string;
  ended: string;
  /** How to reach a box that's up, run in your checkout, with {number} and {sandbox} filled in. Optional. */
  open?: string[];
  /** Minutes a box lives, for the "minutes left" hint. Optional. */
  ttl?: number;
}

/** The one checkout where Run locally puts a PR, and the command that serves it. */
export interface Local {
  /** A clone kept for this, apart from the one you work in, like "~/src/repo-local". */
  dir: string;
  /** Started in `dir` after the checkout, left running until the slot moves, like ["bin/dev"]. */
  start: string[];
}

/** Labels that hand issues to an agent runner, and how many it may work at once. */
export interface Agent {
  /** Repos whose issues assigned to you show as Ready to start. */
  repos: string[];
  /** Start adds this label; the runner picks the issue up from it. Default agent:ready. */
  ready?: string;
  /** The runner's label while it works. Default agent:working. */
  working?: string;
  /** The runner's label when it's waiting on an answer from you. Default agent:blocked. */
  blocked?: string;
  /** How many issues may be queued or in flight at once. Start refuses past it. Default 5. */
  cap?: number;
  /** Where gh-runner keeps its run status files. Default ~/.gh-runner/runs. */
  runs?: string;
}

/** The agent labels with their defaults filled in. */
export const agentLabels = (a: Agent) => ({ ready: a.ready ?? 'agent:ready', working: a.working ?? 'agent:working', blocked: a.blocked ?? 'agent:blocked', cap: a.cap ?? 5, runs: expand(a.runs ?? '~/.gh-runner/runs') });

export interface Config {
  /** Where your clone of each repo lives, like {"owner/repo": "~/src/repo"}. Reviews and chats check out worktrees from it. */
  checkouts: Record<string, string>;
  /** A label that means someone already ran a bug pass. */
  reviewedLabel?: string;
  /** The repo a bare PR number means when you import one. Defaults to the first repo under checkouts. */
  defaultRepo?: string;
  /** Areas where a change needs a careful read, like "billing" or "auth and roles". Check and Signal are told about them. */
  danger?: string[];
  /** The app to open GitHub links in, like "Google Chrome". Defaults to your default browser. */
  browser?: string;
  checks: Check[];
  /** Paths that make a PR red whatever the AI says. */
  red?: RedPath[];
  /** Per-PR commands bound to Shift plus a key. */
  actions?: Action[];
  /** Test boxes per repo, like {"owner/repo": {"label": "preview", ...}}. Adds Test on Depot to Today. */
  sessions?: Record<string, Session>;
  /** Run locally per repo, like {"owner/repo": {"dir": "~/src/repo-local", "start": ["bin/dev"]}}. One PR at a time. */
  local?: Record<string, Local>;
  /** Issues you hand to an agent from Today. */
  agent?: Agent;
}

export const expand = (p: string) => p.replace(/^~(?=\/|$)/, homedir());

/** Prompt and schema paths are relative to the app unless they start with ~ or /. */
export const appPath = (p: string) => (isAbsolute(expand(p)) ? expand(p) : join(ROOT, p));

/** Which file the settings come from. */
export const configFile = () => (existsSync(CONFIG) ? CONFIG : EXAMPLE);

/** The brief check, which took over from the merge call, Signal, Where you can help and Description vs change. */
export const BRIEF: Check = { key: 'brief', label: 'Brief', prompt: 'prompts/brief.md', schema: 'prompts/brief.schema.json' };
const REPLACED = new Set(['merge', 'signal', 'help', 'description']);

/** An older config's merge, signal, help and description checks become one brief, where the first of them was. */
export function upgradeChecks(checks: Check[]): Check[] {
  if (checks.some((c) => c.key === 'brief') || !checks.some((c) => REPLACED.has(c.key))) return checks.filter((c) => !REPLACED.has(c.key));
  const at = checks.findIndex((c) => REPLACED.has(c.key));
  const rest = checks.filter((c) => !REPLACED.has(c.key));
  return [...rest.slice(0, at), BRIEF, ...rest.slice(at)];
}

/** Read on every call, so edits to the file apply without a restart. */
export async function loadConfig(): Promise<Config> {
  const c: Config = await Bun.file(configFile()).json();
  return { ...c, checks: upgradeChecks(c.checks ?? []) };
}

/** What the pages need from your config. */
export async function pageConfig() {
  const c = await loadConfig();
  return { reviewedLabel: c.reviewedLabel ?? null, defaultRepo: c.defaultRepo ?? Object.keys(c.checkouts ?? {}).find((r) => r !== 'owner/repo') ?? null };
}

/** Used when your config doesn't list danger areas. */
export const DANGER = ['auth and permissions', 'billing and payments', 'data migrations and schema', 'the public API'];

/** The line to show when a PR's repo has no clone set up. */
export const noCheckout = (repo: string) => `No local checkout for ${repo}. Add its path under "checkouts" in ${CONFIG.replace(homedir(), '~')}.`;
