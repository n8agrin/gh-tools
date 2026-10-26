// Everything that talks to GitHub lives here, so the UI, the CLI, and Claude commands all read the
// queue the same way. It shells out to `gh` so it rides on your existing gh login.

export interface ReviewPR {
  id: string;
  repo: string;
  number: number;
  title: string;
  url: string;
  author: string;
  isDraft: boolean;
  additions: number;
  deletions: number;
  changedFiles: number;
  labels: string[];
  ci: 'success' | 'failure' | 'pending' | null;
  /** APPROVED, CHANGES_REQUESTED, REVIEW_REQUIRED, or null when the repo doesn't require reviews. */
  reviewDecision: string | null;
  /** "direct" when you were asked by name, otherwise the team slugs that pulled you in. */
  requestedVia: 'direct' | string[];
  /** When the request that put this in front of you was made; falls back to when the PR opened. */
  requestedAt: string;
  createdAt: string;
  updatedAt: string;
  comments: number;
  /** Branch names, used to spot stacks: a PR whose base is another PR's head sits on top of it. */
  baseRef: string;
  headRef: string;
  /** The head commit, so a review run on an older one can show as stale. */
  headSha: string;
  defaultBranch: string;
  /** GitHub's own stack, when the author made one. Holds every layer, not just the ones asking you. */
  stack: NativeStack | null;
  /** Your latest review, e.g. COMMENTED. A PR you only commented on still waits on you. */
  myReview: string | null;
  state: 'OPEN' | 'MERGED' | 'CLOSED';
  /** You pulled it in yourself (say, it merged before you got to it) rather than being asked. */
  imported?: boolean;
}

/** A PR you approved or asked changes on, which goes to Done. */
export interface ReviewedPR {
  pr: ReviewPR;
  review: 'APPROVED' | 'CHANGES_REQUESTED';
  at: string;
}

export interface StackEntry {
  position: number;
  number: number;
  title: string;
  url: string;
  state: 'OPEN' | 'MERGED' | 'CLOSED';
  isDraft: boolean;
  /** Your latest review on that layer, e.g. COMMENTED or APPROVED. */
  myReview: string | null;
}

export interface NativeStack {
  id: string;
  size: number;
  base: string;
  position: number;
  entries: StackEntry[];
}

export interface Queue {
  viewer: string;
  fetchedAt: string;
  prs: ReviewPR[];
  /** PRs your latest review approved or asked changes on, including merged and closed ones. */
  reviewed: ReviewedPR[];
}

const PR_FIELDS = `
  id number title url isDraft createdAt updatedAt state
  additions deletions changedFiles reviewDecision
  author { login }
  viewerLatestReview { state submittedAt }
  baseRefName headRefName headRefOid
  repository { nameWithOwner defaultBranchRef { name } }
  labels(first: 10) { nodes { name } }
  comments { totalCount }
  stackEntry { position }
  stack {
    id size baseRefName
    entries(first: 50) { nodes { position pullRequest { number title url state isDraft viewerLatestReview { state } } } }
  }
  commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
  reviewRequests(first: 30) {
    nodes { requestedReviewer { __typename ... on User { login } ... on Team { slug } } }
  }
  timelineItems(itemTypes: [REVIEW_REQUESTED_EVENT], last: 30) {
    nodes { ... on ReviewRequestedEvent { createdAt requestedReviewer { __typename ... on User { login } ... on Team { slug } } } }
  }
`;

const QUERY = `
query($q: String!, $n: Int!) {
  viewer { login }
  search(type: ISSUE, query: $q, first: $n) {
    nodes {
      ... on PullRequest { ${PR_FIELDS} }
    }
  }
}`;

const SEARCH = 'is:pr is:open archived:false review-requested:@me';
// GitHub clears your request once you leave any review, even comments only. Those still need you.
// Merged and closed ones too, so a PR you approved lands in Done even if it merged before the next fetch.
const REVIEWED = 'is:pr archived:false reviewed-by:@me -review-requested:@me -author:@me sort:updated-desc';

async function gh(args: string[]): Promise<string> {
  const proc = Bun.spawn(['gh', ...args], { stdout: 'pipe', stderr: 'pipe' });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(err.trim() || `gh exited ${code}`);
  return out;
}

const CI: Record<string, ReviewPR['ci']> = { SUCCESS: 'success', FAILURE: 'failure', ERROR: 'failure', PENDING: 'pending', EXPECTED: 'pending' };

type Reviewer = { __typename: string; login?: string; slug?: string } | null;
const who = (r: Reviewer) => (r?.__typename === 'User' ? `@${r.login}` : r?.__typename === 'Team' ? r.slug! : '');

// Exported for tests: turns one search node into the row the app shows.
export function toPR(n: any, viewer: string): ReviewPR {
  const pending: string[] = n.reviewRequests.nodes.map((x: any) => who(x.requestedReviewer)).filter(Boolean);
  const events: { createdAt: string; requestedReviewer: Reviewer }[] = n.timelineItems.nodes;
  // A comment-only review clears the pending request, so the request event is what shows you were asked.
  const direct = pending.includes(`@${viewer}`) || commentedOnly(n, viewer);
  // review-requested:@me matched, so if you aren't named directly a team of yours was. We can't
  // tell which of the requested teams you're on without an extra call, so show all of them.
  const teams = pending.filter((p) => !p.startsWith('@'));
  const mine = direct ? [`@${viewer}`] : teams;
  const asked = events.filter((e) => mine.includes(who(e.requestedReviewer))).at(-1);
  return {
    id: n.id,
    repo: n.repository.nameWithOwner,
    number: n.number,
    title: n.title,
    url: n.url,
    author: n.author?.login ?? 'ghost',
    isDraft: n.isDraft,
    additions: n.additions,
    deletions: n.deletions,
    changedFiles: n.changedFiles,
    labels: n.labels.nodes.map((l: any) => l.name),
    ci: CI[n.commits.nodes[0]?.commit.statusCheckRollup?.state ?? ''] ?? null,
    reviewDecision: n.reviewDecision ?? null,
    requestedVia: direct ? 'direct' : teams,
    requestedAt: asked?.createdAt ?? n.createdAt,
    createdAt: n.createdAt,
    updatedAt: n.updatedAt,
    comments: n.comments.totalCount,
    baseRef: n.baseRefName ?? '',
    headRef: n.headRefName ?? '',
    headSha: n.headRefOid ?? '',
    defaultBranch: n.repository.defaultBranchRef?.name ?? '',
    stack: n.stack
      ? {
          id: n.stack.id,
          size: n.stack.size,
          base: n.stack.baseRefName,
          position: n.stackEntry?.position ?? 0,
          entries: n.stack.entries.nodes.map((e: any) => ({
            position: e.position,
            number: e.pullRequest.number,
            title: e.pullRequest.title,
            url: e.pullRequest.url,
            state: e.pullRequest.state,
            isDraft: e.pullRequest.isDraft,
            myReview: e.pullRequest.viewerLatestReview?.state ?? null,
          })),
        }
      : null,
    myReview: n.viewerLatestReview?.state ?? null,
    state: n.state ?? 'OPEN',
  };
}

/** You were asked by name and your latest review only commented, so GitHub's search dropped it. */
export function commentedOnly(n: any, viewer: string): boolean {
  return (n.state ?? 'OPEN') === 'OPEN' && n.viewerLatestReview?.state === 'COMMENTED' && n.timelineItems.nodes.some((e: any) => e.requestedReviewer?.login === viewer);
}

/** One of your own open PRs, for the separate My PRs page. */
export interface MyPR extends ReviewPR {
  /** Reviewers still asked and not yet answered: @logins and team slugs. */
  waitingOn: string[];
}

export interface MyQueue {
  viewer: string;
  fetchedAt: string;
  prs: MyPR[];
}

// Merged and closed PRs drop out on their own, which is what "done" means for your own PRs.
const MINE = 'is:pr is:open archived:false author:@me sort:updated-desc';

// GitHub answers a 100-PR search with these fields with a 502 after about 10 seconds, so ask in pages.
const MINE_PAGE = 25;
const MINE_MAX = 100;
const PAGED = `
query($q: String!, $n: Int!, $after: String) {
  viewer { login }
  search(type: ISSUE, query: $q, first: $n, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes { ... on PullRequest { ${PR_FIELDS} } }
  }
}`;

export function toMine(n: any, viewer: string): MyPR {
  const waitingOn: string[] = n.reviewRequests.nodes.map((x: any) => who(x.requestedReviewer)).filter(Boolean);
  return { ...toPR(n, viewer), waitingOn, requestedVia: 'direct', requestedAt: n.createdAt };
}

/** One search, a page at a time. A 5xx is GitHub timing out, so that page is tried once more. */
async function searchPages(q: string): Promise<{ viewer: string; nodes: any[] }> {
  const nodes: any[] = [];
  let viewer = '';
  let after: string | null = null;
  do {
    const args = ['api', 'graphql', '-f', `query=${PAGED}`, '-f', `q=${q}`, '-F', `n=${MINE_PAGE}`, ...(after ? ['-f', `after=${after}`] : [])];
    const data = JSON.parse(await gh(args).catch((e) => (/HTTP 5\d\d/.test(e.message) ? gh(args) : Promise.reject(e)))).data;
    viewer = data.viewer.login;
    nodes.push(...data.search.nodes);
    after = data.search.pageInfo.hasNextPage ? data.search.pageInfo.endCursor : null;
  } while (after && nodes.length < MINE_MAX);
  return { viewer, nodes };
}

/** Your own open PRs, drafts included. Kept apart from fetchQueue so the review queue never sees them. */
export async function fetchMine(): Promise<MyQueue> {
  const fixture = process.env.GH_REVIEW_MINE_FIXTURE;
  // Ready PRs and drafts are two searches side by side, which halves the wait.
  const data = fixture ? JSON.parse(await Bun.file(fixture).text()).data : null;
  const [ready, drafts] = data
    ? [{ viewer: data.viewer.login, nodes: data.search.nodes }, { nodes: [] }]
    : await Promise.all([searchPages(`${MINE} draft:false`), searchPages(`${MINE} draft:true`)]);
  const viewer = ready.viewer;
  const prs = [...ready.nodes, ...drafts.nodes].filter((n: any) => n?.number).map((n: any) => toMine(n, viewer));
  return { viewer, fetchedAt: new Date().toISOString(), prs };
}

/** Your GitHub login. */
export async function fetchViewer(): Promise<string> {
  return (await gh(['api', 'user', '--jq', '.login'])).trim();
}

/** A PR you pulled into the queue yourself, and when. */
export interface Imported {
  url: string;
  at: string;
}

export async function fetchQueue(imported: Imported[] = []): Promise<Queue> {
  // A fixture file lets the app run without GitHub, for demos and tests.
  const fixture = process.env.GH_REVIEW_FIXTURE;
  const search = (q: string, n: number) => gh(['api', 'graphql', '-f', `query=${QUERY}`, '-f', `q=${q}`, '-F', `n=${n}`]).then((r) => JSON.parse(r).data);
  const [data, byMe] = fixture ? [JSON.parse(await Bun.file(fixture).text()).data, null] : await Promise.all([search(SEARCH, 100), search(REVIEWED, 40).catch(() => null)]);
  const viewer: string = data.viewer.login;
  const nodes = [...data.search.nodes, ...(byMe?.search.nodes.filter((n: any) => n?.number && commentedOnly(n, viewer)) ?? [])];
  const prs = nodes.filter((n: any) => n?.number).map((n: any) => toPR(n, viewer));
  // An imported PR that someone has since asked you on shows as a normal request instead.
  const extra = fixture ? [] : await fetchImported(imported.filter((i) => !prs.some((p) => p.url === i.url)), viewer).catch(() => []);
  prs.push(...extra);
  const reviewed: ReviewedPR[] = (byMe?.search.nodes ?? [])
    .filter((n: any) => n?.number && ['APPROVED', 'CHANGES_REQUESTED'].includes(n.viewerLatestReview?.state))
    .map((n: any) => ({ pr: toPR(n, viewer), review: n.viewerLatestReview.state, at: n.viewerLatestReview.submittedAt }));
  return { viewer, fetchedAt: new Date().toISOString(), prs, reviewed };
}

const PR_URL = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/;

/**
 * What to import from text typed in the filter: a PR link, owner/repo#123, or a bare number,
 * which means a PR in `defaultRepo`. Returns the canonical PR URL, or null.
 */
export function parsePRRef(text: string, defaultRepo: string | null = null): string | null {
  const t = text.trim();
  const link = t.match(PR_URL);
  if (link) return `https://github.com/${link[1]}/${link[2]}/pull/${link[3]}`;
  const ref = t.match(/^([\w.-]+\/[\w.-]+)#(\d+)$/);
  if (ref) return `https://github.com/${ref[1]}/pull/${ref[2]}`;
  const num = t.match(/^#?(\d+)$/);
  return num && defaultRepo ? `https://github.com/${defaultRepo}/pull/${num[1]}` : null;
}

/** PRs you imported, fresh from GitHub in one call. Their age counts from when you imported them. */
export async function fetchImported(list: Imported[], viewer: string): Promise<ReviewPR[]> {
  if (!list.length) return [];
  const parts = list.map((i, k) => {
    const [, owner, name, number] = i.url.match(PR_URL)!;
    return `p${k}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { pullRequest(number: ${number}) { ${PR_FIELDS} } }`;
  });
  const data = JSON.parse(await gh(['api', 'graphql', '-f', `query=query { ${parts.join('\n')} }`])).data;
  return list
    .map((i, k) => {
      const n = data[`p${k}`]?.pullRequest;
      if (!n) return null;
      const pr = toPR(n, viewer);
      return { ...pr, requestedVia: 'direct' as const, requestedAt: i.at, imported: true };
    })
    .filter((p): p is ReviewPR => !!p);
}

export interface PRDetail {
  url: string;
  repo: string;
  number: number;
  title: string;
  body: string;
  author: string;
  isDraft: boolean;
  labels: string[];
  baseRef: string;
  baseSha: string;
  headSha: string;
  additions: number;
  deletions: number;
  files: { path: string; additions: number; deletions: number }[];
  /** Copilot has submitted a review. It counts the same as the bug-pass label. */
  copilotReviewed: boolean;
  state: 'OPEN' | 'MERGED' | 'CLOSED';
}

/** A submitted review by Copilot, whatever the exact bot login is. Pending requests don't count. */
export const hasCopilotReview = (reviews: { author?: { login?: string } | null; state?: string }[]) =>
  reviews.some((r) => /copilot/i.test(r.author?.login ?? '') && r.state !== 'PENDING');

export type ReviewEvent = 'COMMENT' | 'APPROVE' | 'REQUEST_CHANGES';
export interface LineComment {
  path: string;
  line: number;
  /** LEFT for a removed line, RIGHT for an added or unchanged one, as GitHub's review API wants. */
  side: 'LEFT' | 'RIGHT';
  body: string;
}

/** The body of GitHub's create-review call. Throws on anything GitHub would reject, so nothing half-posts. */
export function reviewPayload(event: string, body: string, comments: LineComment[], commitId: string) {
  if (!['COMMENT', 'APPROVE', 'REQUEST_CHANGES'].includes(event)) throw new Error(`unknown review type: ${event}`);
  if (!/^[0-9a-f]{40}$/.test(commitId)) throw new Error('missing the commit to review');
  const text = body.trim();
  if (event === 'REQUEST_CHANGES' && !text) throw new Error('Requesting changes needs a summary for the author.');
  if (event === 'COMMENT' && !text && !comments.length) throw new Error('Add a summary or at least one line comment.');
  for (const c of comments) {
    if (!c.path || !Number.isInteger(c.line) || c.line < 1 || (c.side !== 'LEFT' && c.side !== 'RIGHT') || !String(c.body ?? '').trim()) throw new Error(`bad line comment on ${c.path}:${c.line}`);
  }
  return { event, body: text, commit_id: commitId, comments: comments.map((c) => ({ path: c.path, line: c.line, side: c.side, body: c.body.trim() })) };
}

/** Posts your review to GitHub. Only the Submit button on the PR page calls this; review runs never do. */
export async function submitReview(url: string, payload: ReturnType<typeof reviewPayload>): Promise<{ url: string }> {
  const m = url.match(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)$/);
  if (!m) throw new Error(`not a PR URL: ${url}`);
  const proc = Bun.spawn(['gh', 'api', '-X', 'POST', `repos/${m[1]}/pulls/${m[2]}/reviews`, '--input', '-'], { stdin: new Blob([JSON.stringify(payload)]), stdout: 'pipe', stderr: 'pipe' });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(err.trim() || out.trim() || `gh exited ${code}`);
  return { url: JSON.parse(out).html_url ?? url };
}

export interface PRComment {
  id: number;
  user: string;
  bot: boolean;
  body: string;
  at: string;
  url: string;
}
export interface LineThreadComment extends PRComment {
  path: string;
  /** Null when the code moved on and GitHub marks the comment outdated. */
  line: number | null;
  originalLine: number | null;
  side: 'LEFT' | 'RIGHT';
  replyTo: number | null;
}
export interface ReviewSummary extends PRComment {
  state: string;
}

const isBot = (u: any) => u?.type === 'Bot' || /\[bot\]$/.test(u?.login ?? '');

/** Everyone's comments on a PR, read only: line comments, the conversation, and each review's summary. */
export async function fetchComments(url: string): Promise<{ lines: LineThreadComment[]; conversation: PRComment[]; reviews: ReviewSummary[] }> {
  const m = url.match(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)$/);
  if (!m) throw new Error(`not a PR URL: ${url}`);
  // --jq prints one object per line, which survives --paginate joining pages together.
  const list = async (path: string) =>
    (await gh(['api', '--paginate', `repos/${m[1]}/${path}?per_page=100`, '--jq', '.[] | tojson']))
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  const [lines, issue, reviews] = await Promise.all([list(`pulls/${m[2]}/comments`), list(`issues/${m[2]}/comments`), list(`pulls/${m[2]}/reviews`)]);
  const base = (c: any): PRComment => ({ id: c.id, user: c.user?.login ?? 'ghost', bot: isBot(c.user), body: c.body ?? '', at: c.submitted_at ?? c.created_at, url: c.html_url });
  return {
    lines: lines.map((c) => ({ ...base(c), path: c.path, line: c.line ?? null, originalLine: c.original_line ?? null, side: c.side === 'LEFT' ? 'LEFT' : 'RIGHT', replyTo: c.in_reply_to_id ?? null })),
    conversation: issue.map(base),
    // Pending reviews are someone's unsent draft, and a bare COMMENTED review is just the wrapper for line comments.
    reviews: reviews.filter((r) => r.state !== 'PENDING' && (r.body?.trim() || r.state !== 'COMMENTED')).map((r) => ({ ...base(r), state: r.state })),
  };
}

/** One file's text at a commit, read only, for previews like rendered markdown. */
export async function fetchFile(url: string, path: string, sha: string): Promise<string> {
  const m = url.match(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/\d+$/);
  if (!m) throw new Error(`not a PR URL: ${url}`);
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error('missing the commit to read');
  if (!path || path.split('/').some((p) => p === '..' || p === '')) throw new Error(`bad path: ${path}`);
  const enc = path.split('/').map(encodeURIComponent).join('/');
  return gh(['api', '-H', 'Accept: application/vnd.github.raw', `repos/${m[1]}/contents/${enc}?ref=${sha}`]);
}

/** The PR's unified diff, for the page's one-file-at-a-time view. */
export async function fetchDiff(url: string): Promise<string> {
  if (!/^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+$/.test(url)) throw new Error(`not a PR URL: ${url}`);
  return gh(['pr', 'diff', url]);
}

/** One PR, fresh from GitHub. The page and the review workflow both use it, so labels are never stale. */
export async function fetchPR(url: string): Promise<PRDetail> {
  const m = url.match(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)$/);
  if (!m) throw new Error(`not a PR URL: ${url}`);
  const fields = 'title,body,author,isDraft,labels,baseRefName,baseRefOid,headRefOid,additions,deletions,files,reviews,state';
  const n = JSON.parse(await gh(['pr', 'view', url, '--json', fields]));
  return {
    url,
    repo: m[1],
    number: Number(m[2]),
    title: n.title,
    body: n.body ?? '',
    author: n.author?.login ?? 'ghost',
    isDraft: n.isDraft,
    labels: n.labels.map((l: any) => l.name),
    baseRef: n.baseRefName,
    baseSha: n.baseRefOid,
    headSha: n.headRefOid,
    additions: n.additions,
    deletions: n.deletions,
    files: (n.files ?? []).map((f: any) => ({ path: f.path, additions: f.additions, deletions: f.deletions })),
    copilotReviewed: hasCopilotReview(n.reviews ?? []),
    state: n.state,
  };
}
