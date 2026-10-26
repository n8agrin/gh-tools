// Finds stacked PRs. GitHub's own stacks come with every layer, including ones not asking you.
// For PRs stacked the old way, a PR whose base branch is another PR's head branch sits on top of
// it; only PRs in the list can be linked then, and `base` names the branch the bottom sits on.

/** Returns Map<url, { id, index, size, base, entries }>; entries is null for branch-detected stacks. */
export function findStacks(prs) {
  const out = new Map();
  for (const p of prs) {
    if (p.stack && p.stack.size > 1) {
      out.set(p.url, { id: p.stack.id, index: p.stack.position - 1, size: p.stack.size, base: p.stack.base, entries: p.stack.entries });
    }
  }
  const loose = prs.filter((p) => !out.has(p.url));
  for (const [url, s] of branchStacks(loose)) out.set(url, s);
  return out;
}

function branchStacks(prs) {
  const byHead = new Map(prs.map((p) => [`${p.repo}:${p.headRef}`, p]));
  const parent = (p) => (p.baseRef && p.baseRef !== p.defaultBranch ? byHead.get(`${p.repo}:${p.baseRef}`) : undefined);
  const children = new Map();
  for (const p of prs) {
    const up = parent(p);
    if (up && up !== p) children.set(up.url, [...(children.get(up.url) ?? []), p]);
  }
  const out = new Map();
  for (const root of prs.filter((p) => !parent(p))) {
    // Walk bottom to top. A branch can have two PRs on it, so break ties by number.
    const order = [];
    const walk = (p) => {
      order.push(p);
      for (const c of (children.get(p.url) ?? []).sort((a, b) => a.number - b.number)) walk(c);
    };
    walk(root);
    if (order.length < 2) continue;
    const base = root.baseRef !== root.defaultBranch ? root.baseRef : null;
    order.forEach((p, index) => out.set(p.url, { id: root.url, index, size: order.length, base, entries: null }));
  }
  return out;
}

/**
 * Keeps the sorted order but pulls each stack together, bottom first, at the spot where its first
 * member would have landed. Returns sections of { stack, rows } with stack null for loose rows.
 */
export function groupStacks(rows, stacks) {
  const sections = [];
  const seen = new Set();
  for (const p of rows) {
    const s = stacks.get(p.url);
    if (!s) {
      sections.push({ stack: null, rows: [p] });
      continue;
    }
    if (seen.has(s.id)) continue;
    seen.add(s.id);
    const members = rows.filter((r) => stacks.get(r.url)?.id === s.id).sort((a, b) => stacks.get(a.url).index - stacks.get(b.url).index);
    sections.push({ stack: s, rows: members });
  }
  return sections;
}
