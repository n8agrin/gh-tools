// The brief's lane: what this PR needs from you. Agent approves (nothing), answer (the decisions
// listed, then approve), read (a full read), or block (it's broken). Code moves the AI's answer both
// ways: a raise needs quoted diff lines and a lane above approve needs a decision for you, or the
// lane comes down; a red path or a red Check finding puts it at least at answer.
export type Lane = 'approve' | 'answer' | 'read' | 'block';

export interface Decision {
  question: string;
  stake: string;
  why_you: string;
  where: string;
}

export type ClaimStatus = 'verified' | 'deliberate' | 'author_data' | 'unverified' | 'not_done' | 'contradicted';

export interface Claim {
  claim: string;
  source: string;
  status: ClaimStatus;
  evidence: string;
  where: string;
  proof: boolean;
}

export interface Group {
  kind: 'core' | 'pattern' | 'tests' | 'other';
  title: string;
  note: string;
  files: string[];
  /** For a pattern: files that don't follow it. */
  outliers: string[];
}

export interface Reason {
  why: string;
  /** The diff lines the reason rests on, verbatim. A raise without one doesn't count. */
  quote: string;
  where: string;
}

export interface Fix {
  fix: string;
  where: string;
}

export interface Brief {
  lane: Lane;
  /** What changes for a user or caller, in one line. */
  intent: string;
  kind: string;
  behavior_change: string;
  decisions: Decision[];
  claims: Claim[];
  groups: Group[];
  raises: Reason[];
  lowers: Reason[];
  fixes: Fix[];
  /** The AI's own lane when code moved it, and why. */
  movedFrom?: Lane;
  movedBy?: string[];
  /** The AI's answer as it came, so a rerun of Check can redo the moves from scratch. */
  ai?: any;
}

export const LANES: Lane[] = ['approve', 'answer', 'read', 'block'];
const RANK: Record<Lane, number> = { approve: 0, answer: 1, read: 2, block: 3 };
export const LANE_NAME: Record<Lane, string> = { approve: 'Agent approves', answer: 'Answer questions', read: 'Read it', block: 'Do not merge' };
/** The queue's old color for each lane, so rows and the board keep one scale. */
export const LANE_COLOR: Record<Lane, 'green' | 'yellow' | 'red'> = { approve: 'green', answer: 'yellow', read: 'red', block: 'red' };

const STATUSES: ClaimStatus[] = ['verified', 'deliberate', 'author_data', 'unverified', 'not_done', 'contradicted'];
const KINDS: Group['kind'][] = ['core', 'pattern', 'tests', 'other'];
const str = (x: unknown) => (typeof x === 'string' ? x.trim() : '');
const arr = (x: unknown): any[] => (Array.isArray(x) ? x : []);
const strs = (x: unknown) => arr(x).map(str).filter(Boolean);

/** Cleans up the AI's answer. An unknown lane reads as answer, since nobody checked it. */
export function readBrief(ai: any): Brief {
  const lane: Lane = RANK[ai?.lane as Lane] === undefined ? 'answer' : ai.lane;
  const reason = (r: any): Reason => ({ why: str(r?.why), quote: str(r?.quote), where: str(r?.where) });
  return {
    lane,
    intent: str(ai?.intent),
    kind: str(ai?.kind),
    behavior_change: str(ai?.behavior_change),
    decisions: arr(ai?.decisions)
      .filter((d) => str(d?.question))
      .slice(0, 3)
      .map((d) => ({ question: str(d.question), stake: str(d.stake), why_you: str(d.why_you), where: str(d.where) })),
    claims: arr(ai?.claims)
      .filter((c) => str(c?.claim))
      .map((c) => ({ claim: str(c.claim), source: str(c.source), status: STATUSES.includes(c.status) ? c.status : 'unverified', evidence: str(c.evidence), where: str(c.where), proof: c.proof === true })),
    groups: arr(ai?.groups)
      .filter((g) => str(g?.title) && strs(g?.files).length)
      .map((g) => ({ kind: KINDS.includes(g.kind) ? g.kind : 'other', title: str(g.title), note: str(g.note), files: strs(g.files), outliers: strs(g.outliers) })),
    raises: arr(ai?.raises).map(reason).filter((r) => r.why),
    lowers: arr(ai?.lowers).map(reason).filter((r) => r.why),
    fixes: arr(ai?.fixes)
      .filter((f) => str(f?.fix))
      .map((f) => ({ fix: str(f.fix), where: str(f.where) })),
  };
}

function move(b: Brief, lane: Lane, by: string): Brief {
  if (lane === b.lane) return b;
  return { ...b, lane, movedFrom: b.movedFrom ?? b.lane, movedBy: [...(b.movedBy ?? []), by] };
}

/**
 * Hold the AI to its own evidence. Read needs a raise that quotes the diff, or it comes down to answer.
 * Answer needs at least one decision for you, or there is nothing to answer and it comes down to approve.
 */
export function evidenceRules(b: Brief): Brief {
  let out = b;
  if (out.lane === 'read' && !out.raises.some((r) => r.quote)) out = move(out, 'answer', 'no raise quoted the diff');
  if (out.lane === 'answer' && !out.decisions.length) out = move(out, 'approve', 'no decision was left for you');
  return out;
}

/** A changed file on a red path from your config always puts at least one question in front of you. */
export function pathRaise(b: Brief, floor: { file: string; why: string }[]): Brief {
  if (!floor.length || RANK[b.lane] >= RANK.answer) return b;
  const whys = [...new Set(floor.map((f) => f.why))];
  const out = move(b, 'answer', `changes ${whys.slice(0, 2).join(' and ')}, which your config marks red`);
  if (out.decisions.length) return out;
  return { ...out, decisions: [{ question: `This touches ${whys[0]}. Is the change there what you'd expect?`, stake: 'Your config says changes here always get a person\'s eyes.', why_you: 'A red path is your rule, not something the code can settle.', where: floor[0].file }] };
}

/** A red Check finding would break users if merged, so it needs at least a decision, and its fix is listed. */
export function findingsRaise(b: Brief, findings: any[]): Brief {
  const red = (findings ?? []).filter((f) => f?.color === 'red');
  if (!red.length) return b;
  const fixes = [...b.fixes, ...red.filter((f) => !b.fixes.some((x) => x.where.startsWith(f.file))).map((f) => ({ fix: str(f.note), where: `${f.file}:${String(f.lines).split('-')[0]}` }))].slice(0, 6);
  if (RANK[b.lane] >= RANK.answer) return { ...b, fixes };
  const out = move(b, 'answer', `Check found ${red.length === 1 ? 'a problem' : `${red.length} problems`} that would break users`);
  const decisions = out.decisions.length ? out.decisions : red.slice(0, 3).map((f) => ({ question: `Does this need fixing before it merges: ${str(f.note).replace(/\.$/, '')}?`, stake: str(f.scenario), why_you: 'Check flagged it; you decide whether it blocks.', where: `${f.file}:${String(f.lines).split('-')[0]}` }));
  return { ...out, decisions, fixes };
}

/** The whole lane from the AI's answer, your red paths and Check's findings. */
export function decideLane(ai: any, floor: { file: string; why: string }[], findings: any[] = []): Brief {
  return { ...findingsRaise(pathRaise(evidenceRules(readBrief(ai)), floor), findings), ai };
}
