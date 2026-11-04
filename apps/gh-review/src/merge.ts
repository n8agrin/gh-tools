// The merge call: the one answer at the top of the brief. Merge, merge with fixes, merge after a
// careful review, or don't merge. Most PRs should land on merge. A red path from your config means
// a careful review whatever the AI says, and a red Check finding means at least a fix.
export type Call = 'merge' | 'fixes' | 'review' | 'block';

export interface Fix {
  fix: string;
  where: string;
}

export interface MergeCall {
  call: Call;
  reason: string;
  /** What's off or what breaks, for review and block. */
  why: string;
  /** The sensitive area the PR touches, like payments. */
  domain: string;
  flag: string;
  fixes: Fix[];
  /** The AI's own call when a rule here raised it, and what raised it. */
  raisedFrom?: Call;
  raisedBy?: string;
  /** The AI's answer as it came, so a rerun of Check can redo the raise from scratch. */
  ai?: any;
}

const RANK: Record<Call, number> = { merge: 0, fixes: 1, review: 2, block: 3 };
export const CALL_NAME: Record<Call, string> = { merge: 'Merge', fixes: 'Merge with fixes', review: 'Merge with review', block: 'Do not merge' };

const str = (x: unknown) => (typeof x === 'string' ? x.trim() : '');

/** Cleans up the AI's answer. An unknown call reads as merge with review, since nobody checked it. */
export function readCall(ai: any): MergeCall {
  const call: Call = RANK[ai?.call as Call] === undefined ? 'review' : ai.call;
  const fixes = (Array.isArray(ai?.fixes) ? ai.fixes : []).filter((f: any) => str(f?.fix)).map((f: any) => ({ fix: str(f.fix), where: str(f.where) }));
  return { call, reason: str(ai?.reason).replace(/^(merge( with (fixes|review))?|do not merge)\s*:\s*/i, ''), why: str(ai?.why), domain: str(ai?.domain), flag: str(ai?.flag), fixes };
}

function raiseTo(m: MergeCall, call: Call, by: string): MergeCall {
  if (RANK[call] <= RANK[m.call]) return m;
  return { ...m, call, raisedFrom: m.raisedFrom ?? m.call, raisedBy: by };
}

/** A changed file on a red path from your config always gets a careful review. */
export function pathRaise(m: MergeCall, floor: { file: string; why: string }[]): MergeCall {
  if (!floor.length) return m;
  const whys = [...new Set(floor.map((f) => f.why))];
  const out = raiseTo(m, 'review', `changes ${whys.slice(0, 2).join(' and ')}, which your config marks red`);
  return out === m ? m : { ...out, domain: out.domain || whys[0] };
}

/** A red Check finding would break users if merged, so the PR needs at least that fix. */
export function findingsRaise(m: MergeCall, findings: any[]): MergeCall {
  const red = (findings ?? []).filter((f) => f?.color === 'red');
  if (!red.length || RANK[m.call] >= RANK.fixes) return m;
  const out = raiseTo(m, 'fixes', `Check found ${red.length === 1 ? 'a problem' : `${red.length} problems`} that would break users`);
  const fixes = [...out.fixes, ...red.filter((f) => !out.fixes.some((x) => x.where.startsWith(f.file))).map((f) => ({ fix: str(f.note), where: `${f.file}:${String(f.lines).split('-')[0]}` }))];
  return { ...out, fixes: fixes.slice(0, 6) };
}

/** The whole call from the AI's answer, your red paths and Check's findings. */
export function decideCall(ai: any, floor: { file: string; why: string }[], findings: any[] = []): MergeCall {
  return { ...findingsRaise(pathRaise(readCall(ai), floor), findings), ai };
}
