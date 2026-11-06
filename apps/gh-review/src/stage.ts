// Which pipeline stage one of your own PRs is in. Everything comes from GitHub plus the review
// runs kept here, so nothing has to be moved by hand: when the PR changes, the stage changes.
import { listReviews, type Review } from './db';
import { loadFindings } from './findings';
import type { MyPR } from './github';
import { loadConfig } from './config';

export type StageKey = 'ship' | 'undraft' | 'fix' | 'blocked' | 'hunt' | 'waiting';

/** What to do about a PR in its stage. Merge and undraft happen on GitHub; the app only opens the page. */
export type Next = 'merge' | 'undraft' | 'findings' | 'unblock' | 'hunt' | 'nudge';

export interface Stage {
  key: StageKey;
  /** One sentence on why it's here. */
  why: string;
  next: Next;
  /** Open findings from the newest bug pass on this head. */
  findings: number;
  /** A bug pass happened, but on an older head. */
  stalePass: boolean;
}

/** In the order a PR moves, which is how the board lays them out. Blocked is off the line, so it goes last. */
export const STAGES: { key: StageKey; label: string; rule: string }[] = [
  { key: 'hunt', label: 'Hunt', rule: 'no bug pass on the current head' },
  { key: 'fix', label: 'Fix findings', rule: 'a bug pass ran, findings still open' },
  { key: 'undraft', label: 'Undraft', rule: 'bug pass on this head, CI green, still a draft' },
  { key: 'waiting', label: 'Waiting', rule: 'on someone else' },
  { key: 'ship', label: 'Ship', rule: 'approved, CI green, nothing in the way' },
  { key: 'blocked', label: 'Blocked', rule: 'red CI, a conflict, or changes requested' },
];

/** What the review runs kept here say about one PR's bug passes. */
export interface HuntEvidence {
  /** A findings check finished on the PR's current head. */
  passOnHead: boolean;
  /** A findings check finished on an older head. */
  passBefore: boolean;
  /** Findings from the newest pass on the current head. */
  findings: number;
  /** The reviewed label is on the PR: somebody's bug pass, whatever the head. */
  labelled: boolean;
}

type StagePR = Pick<MyPR, 'isDraft' | 'ci' | 'reviewDecision' | 'mergeable' | 'waitingOn'>;

const ciWord = (ci: StagePR['ci']) => (ci === 'success' ? 'CI green' : ci === 'pending' ? 'CI still running' : ci === 'failure' ? 'CI red' : 'no CI');

/** The stage, from the PR as GitHub shows it and the bug passes kept here. Pure, so the rules are easy to test. */
export function stageOf(pr: StagePR, ev: HuntEvidence): Stage {
  const base = { findings: ev.passOnHead ? ev.findings : 0, stalePass: !ev.passOnHead && !ev.labelled && ev.passBefore };
  const passed = ev.labelled || ev.passOnHead;
  const blocked = pr.ci === 'failure' ? 'CI is failing' : pr.mergeable === 'CONFLICTING' ? 'It conflicts with its base' : pr.reviewDecision === 'CHANGES_REQUESTED' ? 'Changes were requested' : null;
  if (blocked) return { ...base, key: 'blocked', next: 'unblock', why: `${blocked}. Nothing moves until that's sorted.` };
  if (!pr.isDraft && pr.reviewDecision === 'APPROVED') return { ...base, key: 'ship', next: 'merge', why: `Approved, ${ciWord(pr.ci)}${passed ? ', bug pass done' : ''}. It can merge now.` };
  if (ev.passOnHead && ev.findings > 0) return { ...base, key: 'fix', next: 'findings', why: `${ev.findings === 1 ? '1 finding' : `${ev.findings} findings`} open from the last bug pass on this head.` };
  if (pr.isDraft && passed && pr.ci !== 'pending') return { ...base, key: 'undraft', next: 'undraft', why: `Bug pass clean on this head, ${ciWord(pr.ci)}. Still a draft.` };
  if (!passed) return { ...base, key: 'hunt', next: 'hunt', why: ev.passBefore ? 'The last bug pass was on an older head.' : 'No bug pass yet.' };
  if (pr.waitingOn.length) return { ...base, key: 'waiting', next: 'nudge', why: `Waiting on ${pr.waitingOn.join(', ')}.` };
  if (pr.isDraft) return { ...base, key: 'waiting', next: 'nudge', why: 'Draft with a clean bug pass, waiting on CI.' };
  return { ...base, key: 'waiting', next: 'nudge', why: 'Bug pass clean, nobody asked to review it yet.' };
}

/** Steps that count as a bug pass: checks that write findings, and the toolkit's own Check. */
export function huntEvidence(pr: Pick<MyPR, 'headSha' | 'labels'>, reviews: Review[], findingsKeys: string[], reviewedLabel: string | null, findingsOf: (reviewId: number, key: string) => number): HuntEvidence {
  const keys = new Set([...findingsKeys, 'check']);
  const ev: HuntEvidence = { passOnHead: false, passBefore: false, findings: 0, labelled: !!reviewedLabel && pr.labels.includes(reviewedLabel) };
  // Newest first, so the first pass on the current head is the one whose findings count.
  for (const r of reviews) {
    const done = r.steps.filter((s) => keys.has(s.key) && s.status === 'done');
    if (!done.length) continue;
    if (r.headSha !== pr.headSha) {
      ev.passBefore = true;
      continue;
    }
    if (ev.passOnHead) continue;
    ev.passOnHead = true;
    ev.findings = done.reduce((n, s) => n + findingsOf(r.id, s.key), 0);
  }
  return ev;
}

/** How many findings one finished step left. Check keeps them in its output; findings checks write a file. */
function countFindings(review: Review, key: string): number {
  if (key === 'check') {
    const step = review.steps.find((s) => s.key === key);
    try {
      const out = JSON.parse(step?.output ?? '');
      return Array.isArray(out.findings) ? out.findings.length : 0;
    } catch {
      return 0;
    }
  }
  return loadFindings(review.id, key)?.findings.length ?? 0;
}

/** A stage per PR url, for the board. */
export async function stagesFor(prs: MyPR[]): Promise<Record<string, Stage>> {
  const config = await loadConfig();
  const findingsKeys = config.checks.filter((c) => c.findings).map((c) => c.key);
  const out: Record<string, Stage> = {};
  for (const pr of prs) {
    const reviews = listReviews(pr.url);
    const ev = huntEvidence(pr, reviews, findingsKeys, config.reviewedLabel ?? null, (id, key) => countFindings(reviews.find((r) => r.id === id)!, key));
    out[pr.url] = stageOf(pr, ev);
  }
  return out;
}
