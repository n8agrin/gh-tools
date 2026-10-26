// The taste review compares the PR with prior art in the repo. A comparison is only worth asking
// about when both sides do the same job, so a second, skeptical pass reads the actual code on
// both sides and keeps, drops or rewords each finding. Dropped ones stay visible with a reason.

export interface Evidence {
  label: string;
  url: string;
}

export interface Verdict {
  id: string;
  verdict: 'keep' | 'drop' | 'reword';
  reason: string;
  /** The new question, for reword. */
  question?: string;
}

/** A github.com blob link with a line or range, as the taste prompt asks for. */
export function site(url: string): { sha: string; path: string; start: number; end: number } | null {
  const m = url.match(/^https:\/\/github\.com\/[^/]+\/[^/]+\/blob\/([0-9a-f]{7,40})\/([^#?]+)(?:#L(\d+)(?:-L(\d+))?)?/);
  if (!m) return null;
  const start = m[3] ? Number(m[3]) : 1;
  return { sha: m[1], path: decodeURIComponent(m[2]), start, end: m[4] ? Number(m[4]) : start };
}

/** The cited lines with some context either side, numbered, so the skeptic reads what was linked. */
export function excerpt(text: string, start: number, end: number, pad = 12): string {
  const lines = text.split('\n');
  const from = Math.max(1, start - pad);
  const to = Math.min(lines.length, Math.max(end, start) + pad, from + 80);
  return lines
    .slice(from - 1, to)
    .map((l, i) => `${String(from + i).padStart(5)}  ${l}`)
    .join('\n');
}

/** Give each question an id, e.g. "consistency.2", so verdicts can point back at it. */
export function findings(taste: any) {
  return (taste.lenses ?? []).flatMap((l: any) => (l.questions ?? []).map((q: any, i: number) => ({ id: `${l.lens}.${i + 1}`, lens: l.lens, q })));
}

/** Apply the skeptic's verdicts. No verdict means keep, so a short answer never hides a finding. */
export function applyVerdicts(taste: any, verdicts: Verdict[]) {
  const byId = new Map(verdicts.map((v) => [v.id, v]));
  const dropped: { question: string; reason: string }[] = [];
  const lenses = (taste.lenses ?? []).map((l: any) => ({
    ...l,
    questions: (l.questions ?? []).flatMap((q: any, i: number) => {
      const v = byId.get(`${l.lens}.${i + 1}`);
      if (v?.verdict === 'drop') return dropped.push({ question: q.question, reason: v.reason }), [];
      if (v?.verdict === 'reword' && v.question) return [{ ...q, question: v.question, reworded: v.reason }];
      return [q];
    }),
  }));
  return { ...taste, lenses, dropped };
}

interface Deps {
  /** File contents at a commit, or null when it can't be read. */
  read: (sha: string, path: string) => Promise<string | null>;
  /** The skeptic: gets the findings with their code and returns { verdicts }. */
  ask: (findingsText: string) => Promise<{ verdicts: Verdict[] }>;
}

export async function verifyTaste(taste: any, { read, ask }: Deps) {
  const list = findings(taste);
  if (!list.length) return { ...taste, dropped: [] };
  const blocks: string[] = [];
  for (const { id, q } of list) {
    const parts = [`## ${id}`, `Question: ${q.question}`, `Why: ${q.why}`];
    if (q.job) parts.push(`Claimed shared job: ${q.job}`);
    if (q.siblings) parts.push(`Claimed sibling count: ${q.siblings}`);
    if (q.author_reason) parts.push(`Author's stated reason: ${q.author_reason}`);
    for (const e of (q.evidence ?? []) as Evidence[]) {
      const s = site(e.url);
      const text = s && (await read(s.sha, s.path));
      parts.push(`### ${e.label}\n${e.url}\n${text ? '```\n' + excerpt(text, s!.start, s!.end) + '\n```' : '(could not read this link)'}`);
    }
    blocks.push(parts.join('\n\n'));
  }
  const { verdicts } = await ask(`\n\n---\n\n${blocks.join('\n\n---\n\n')}`);
  return applyVerdicts(taste, verdicts ?? []);
}
