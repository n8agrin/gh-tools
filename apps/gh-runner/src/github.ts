// Every GitHub call goes through `gh`, as you. Nothing else in the runner talks to GitHub.
export interface Issue {
  url: string;
  repo: string;
  number: number;
  title: string;
  labels: string[];
  createdAt: string;
  /** The newest comment, which on a blocked issue may be your answer. */
  lastComment?: { author: string; body: string; at: string } | null;
}

export async function gh(args: string[], stdin?: string): Promise<string> {
  const proc = Bun.spawn(['gh', ...args], { stdout: 'pipe', stderr: 'pipe', stdin: stdin === undefined ? 'ignore' : new Blob([stdin]) });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(err.trim() || `gh ${args[0]} exited ${code}`);
  return out;
}

const SEARCH = `
query($q: String!) {
  search(type: ISSUE, query: $q, first: 50) {
    issueCount
    nodes { ... on Issue { url number title createdAt repository { nameWithOwner } labels(first: 20) { nodes { name } } comments(last: 1) { nodes { author { login } body createdAt } } } }
  }
}`;

/** Exported for tests: one search node as an Issue. */
export function toIssue(n: any): Issue {
  const c = n.comments?.nodes?.[0];
  return {
    url: n.url,
    repo: n.repository?.nameWithOwner ?? '',
    number: n.number,
    title: n.title ?? '',
    labels: (n.labels?.nodes ?? []).map((l: any) => l.name),
    createdAt: n.createdAt,
    lastComment: c ? { author: c.author?.login ?? 'ghost', body: c.body ?? '', at: c.createdAt } : null,
  };
}

/** The search for open issues assigned to you in these repos. Only your own issues are ever picked up: anyone with triage rights can label an issue, but only you put work on your machine. */
export const scope = (repos: string[]) => `is:issue is:open archived:false assignee:@me ${repos.map((r) => `repo:${r}`).join(' ')}`;

export interface Queue {
  /** Waiting for an agent, oldest first. */
  ready: Issue[];
  /** Labeled working: an agent holds them, or did before the runner stopped. */
  working: Issue[];
  /** Labeled blocked: waiting on your answer. */
  blocked: Issue[];
  /** How many hold a working or blocked label. */
  inFlight: number;
}

/** Your issues in each agent state. */
export async function fetchQueue(repos: string[], labels: { ready: string; working: string; blocked: string }): Promise<Queue> {
  const fixture = process.env.GH_RUNNER_FIXTURE;
  if (fixture) return { working: [], blocked: [], ...(await Bun.file(fixture).json()) };
  const q = async (extra: string) => JSON.parse(await gh(['api', 'graphql', '-f', `query=${SEARCH}`, '-f', `q=${scope(repos)} ${extra}`])).data.search;
  const [ready, working, blocked] = await Promise.all([q(`label:"${labels.ready}" sort:created-asc`), q(`label:"${labels.working}"`), q(`label:"${labels.blocked}"`)]);
  const list = (r: any): Issue[] => r.nodes.filter((n: any) => n?.number).map(toIssue);
  return { ready: list(ready), working: list(working), blocked: list(blocked), inFlight: working.issueCount + blocked.issueCount };
}

let me: Promise<string> | null = null;
/** Your GitHub login. Only your own comments ever reach an agent. A failed lookup isn't kept, so the next tick asks again. */
export const viewer = () =>
  (me ??= gh(['api', 'user', '--jq', '.login']).then(
    (o) => o.trim(),
    (e) => {
      me = null;
      throw e;
    },
  ));

/** Marks every comment the runner writes, so it can tell your replies from its own (both are you on GitHub). */
export const MARK = '<!-- gh-runner -->';

const made = new Set<string>();
/** Creates the labels in a repo the first time the runner touches it. */
async function ensureLabels(repo: string, labels: string[]) {
  if (made.has(repo)) return;
  for (const l of labels) await gh(['label', 'create', l, '--repo', repo, '--color', 'BFD4F2']).catch((e) => { if (!/already exists/i.test(e.message)) throw e; });
  made.add(repo);
}

/** Swaps one agent label for another on an issue. */
export async function moveLabel(issue: Pick<Issue, 'url' | 'repo'>, from: string | null, to: string | null, all: string[]) {
  await ensureLabels(issue.repo, all);
  const args = ['issue', 'edit', issue.url];
  if (from) args.push('--remove-label', from);
  if (to) args.push('--add-label', to);
  await gh(args);
}

/** Comments on an issue, with the runner's mark at the end so the first line stays readable on Today. */
export async function comment(url: string, body: string) {
  await gh(['issue', 'comment', url, '--body-file', '-'], `${body.trim()}\n\n${MARK}\n`);
}

/** Opens a draft PR for a branch already pushed, and returns its URL. */
export async function openDraft(repo: string, branch: string, base: string, title: string, body: string): Promise<string> {
  const out = await gh(['pr', 'create', '--repo', repo, '--head', branch, '--base', base, '--draft', '--title', title, '--body-file', '-'], body);
  const url = out.trim().split('\n').pop() ?? '';
  if (!/^https:\/\/github\.com\/.+\/pull\/\d+$/.test(url)) throw new Error(`gh pr create said: ${out.trim().slice(0, 200)}`);
  return url;
}

/** A PR's state: OPEN, MERGED or CLOSED. */
export async function prState(url: string): Promise<string> {
  return (await gh(['pr', 'view', url, '--json', 'state', '--jq', '.state'])).trim();
}

/** Replaces a PR's description. */
export async function editBody(url: string, body: string) {
  await gh(['pr', 'edit', url, '--body-file', '-'], body);
}
