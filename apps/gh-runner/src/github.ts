// Every GitHub call goes through `gh`, as you. Nothing else in the runner talks to GitHub.
export interface Issue {
  url: string;
  repo: string;
  number: number;
  title: string;
  labels: string[];
  createdAt: string;
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
    nodes { ... on Issue { url number title createdAt repository { nameWithOwner } labels(first: 20) { nodes { name } } } }
  }
}`;

/** Exported for tests: one search node as an Issue. */
export function toIssue(n: any): Issue {
  return { url: n.url, repo: n.repository?.nameWithOwner ?? '', number: n.number, title: n.title ?? '', labels: (n.labels?.nodes ?? []).map((l: any) => l.name), createdAt: n.createdAt };
}

/** The search for open issues assigned to you in these repos. Only your own issues are ever picked up: anyone with triage rights can label an issue, but only you put work on your machine. */
export const scope = (repos: string[]) => `is:issue is:open archived:false assignee:@me ${repos.map((r) => `repo:${r}`).join(' ')}`;

/** Issues waiting for an agent, oldest first, and how many already hold a working or blocked label. */
export async function fetchQueue(repos: string[], labels: { ready: string; working: string; blocked: string }): Promise<{ ready: Issue[]; inFlight: number }> {
  const fixture = process.env.GH_RUNNER_FIXTURE;
  if (fixture) return Bun.file(fixture).json();
  const q = async (extra: string) => JSON.parse(await gh(['api', 'graphql', '-f', `query=${SEARCH}`, '-f', `q=${scope(repos)} ${extra}`])).data.search;
  const [ready, flight] = await Promise.all([q(`label:"${labels.ready}" sort:created-asc`), q(`label:"${labels.working}","${labels.blocked}"`)]);
  return { ready: ready.nodes.filter((n: any) => n?.number).map(toIssue), inFlight: flight.issueCount };
}
