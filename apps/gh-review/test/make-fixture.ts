// Builds test/fixture.json in the same shape GitHub's GraphQL search returns.
const now = Date.now();
const ago = (h: number) => new Date(now - h * 3600_000).toISOString();
const pr = (n: number, o: any) => ({
  id: `PR_${n}`, number: n, title: o.title, url: `https://github.com/${o.repo}/pull/${n}`, isDraft: !!o.draft,
  createdAt: ago(o.h + 2), updatedAt: ago(o.h / 2), additions: o.add, deletions: o.del, changedFiles: o.files,
  reviewDecision: o.decision ?? 'REVIEW_REQUIRED', author: { login: o.author }, repository: { nameWithOwner: o.repo },
  labels: { nodes: (o.labels ?? []).map((name: string) => ({ name })) }, comments: { totalCount: o.comments ?? 0 },
  commits: { nodes: [{ commit: { statusCheckRollup: o.ci ? { state: o.ci } : null } }] },
  reviewRequests: { nodes: [{ requestedReviewer: o.team ? { __typename: 'Team', slug: o.team } : { __typename: 'User', login: 'n8agrin' } }] },
  timelineItems: { nodes: [{ createdAt: ago(o.h), requestedReviewer: o.team ? { __typename: 'Team', slug: o.team } : { __typename: 'User', login: 'n8agrin' } }] },
});
const nodes = [
  pr(63901, { repo: 'acme/app', title: 'Fix pivot totals when a column is hidden', author: 'jamie', h: 50, add: 42, del: 8, files: 3, ci: 'SUCCESS', comments: 2 }),
  pr(63877, { repo: 'acme/app', title: 'Move workbook autosave onto the job queue', author: 'priya', h: 20, add: 812, del: 390, files: 27, ci: 'FAILURE', team: 'frontend', labels: ['perf'] }),
  pr(1204, { repo: 'acme/docs', title: 'Document the new embed SSO flow', author: 'sam', h: 3, add: 120, del: 4, files: 2, ci: 'PENDING', draft: true }),
  pr(63910, { repo: 'acme/app', title: 'Bump vitest to 3.2', author: 'dependabot', h: 1, add: 14, del: 14, files: 2, ci: 'SUCCESS', team: 'eng', decision: 'APPROVED' }),
];
await Bun.write(`${import.meta.dir}/fixture.json`, JSON.stringify({ data: { viewer: { login: 'n8agrin' }, search: { nodes } } }, null, 2));
