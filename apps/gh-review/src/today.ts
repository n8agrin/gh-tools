// Today: one list of everything where you hold the ball, most-waited-on first, one button per row.
// It reads only what the review queue and My PRs already fetch, and sets nothing on GitHub.
import type { ReviewSummary } from './db';
import type { Mention, MyPR, ReviewPR } from './github';
import { LANE_NAME, type Lane } from './lane';
import type { Stage } from './stage';

/** What a row's main button does. The page maps each one to a click or a key. */
export type Next = 'brief' | 'approve' | 'merge' | 'undraft' | 'findings' | 'unblock' | 'thread';

export interface TodayRow {
  url: string;
  repo: string;
  /** The PR or issue number, or null for a notification about something else, like a release. */
  number: number | null;
  title: string;
  /** Short label shown before the title: REVIEW, SHIP, BLOCKED and so on. */
  tag: string;
  /** When the ball landed with you: the review request, or the last change to your PR. */
  since: string;
  /** One sentence on why it's here. */
  why: string;
  next: Next;
  /** Your own PR, which sets aside through My PRs rather than the review queue. */
  mine: boolean;
  updatedAt: string;
  headSha: string;
  /** The brief's lane on this head, and what's left for you to decide. */
  lane: string | null;
  decisions: string[];
  /** Open findings from the last bug pass on this head. */
  findings: number;
  /** The PR's labels as of the last fetch, so the page can tell which have a test box on. */
  labels: string[];
  /** The notification behind a mention row, which opening it or setting it aside marks read. */
  thread?: string;
}

export interface Band {
  key: 'review' | 'move' | 'mentions';
  label: string;
  rows: TodayRow[];
}

export interface Today {
  bands: Band[];
  /** Not rows, just counts: your PRs waiting on others, ones with no bug pass yet, and rows you set aside or marked done. */
  counts: { waiting: number; hunt: number; hidden: number };
}

export interface TodayInput {
  viewer: string;
  queue: ReviewPR[];
  /** Review requests you already answered, by url. */
  done: Set<string>;
  /** Review requests you set aside, by url, with the updatedAt they were set aside at. */
  skipped: Record<string, string>;
  summaries: Record<string, ReviewSummary>;
  mine: MyPR[];
  stages: Record<string, Stage>;
  mineAside: Record<string, string>;
  mineDone: Record<string, { headSha: string }>;
  /** Unread notifications that want you. */
  mentions?: Mention[];
}

/** Your own PRs that need you, in the order to take them: the closest to landing first. */
const MOVE: Record<string, { tag: string; order: number }> = {
  ship: { tag: 'SHIP', order: 0 },
  undraft: { tag: 'UNDRAFT', order: 1 },
  fix: { tag: 'FINDINGS', order: 2 },
  blocked: { tag: 'BLOCKED', order: 3 },
};

/** What the brief says about a review request, if it was written for the PR's current head. */
function briefOn(pr: ReviewPR, s: ReviewSummary | undefined): { lane: string | null; decisions: string[]; why: string } {
  if (!s?.lane) return { lane: null, decisions: [], why: 'No brief yet.' };
  if (s.headSha !== pr.headSha) return { lane: null, decisions: [], why: 'The brief is from an older commit.' };
  const name = LANE_NAME[s.lane as Lane] ?? s.lane;
  const detail = s.decisions[0] ?? s.intent;
  return { lane: s.lane, decisions: s.decisions, why: detail ? `${name}: ${detail}` : `${name}.` };
}

const WHY: Record<string, string> = {
  mention: 'You were @-mentioned.',
  team_mention: 'A team of yours was @-mentioned.',
  comment: "New comments on a thread you're in.",
  assign: 'You were assigned.',
};

export function buildToday(i: TodayInput): Today {
  const review: TodayRow[] = i.queue
    .filter((p) => !i.done.has(p.url) && !(i.skipped[p.url] && i.skipped[p.url] >= p.updatedAt))
    .map((p) => {
      const b = briefOn(p, i.summaries[p.url]);
      // Approving from here only makes sense when the brief cleared it on this exact head.
      const next: Next = b.lane === 'approve' && p.author !== i.viewer ? 'approve' : 'brief';
      return { url: p.url, repo: p.repo, number: p.number, title: p.title, tag: 'REVIEW', since: p.requestedAt, why: b.why, next, mine: false, updatedAt: p.updatedAt, headSha: p.headSha, lane: b.lane, decisions: b.decisions, findings: 0, labels: p.labels };
    })
    .sort((a, b) => a.since.localeCompare(b.since));

  const open = i.mine.filter((p) => !(i.mineAside[p.url] && i.mineAside[p.url] >= p.updatedAt) && i.mineDone[p.url]?.headSha !== p.headSha);
  const stage = (p: MyPR) => i.stages[p.url];
  const move: TodayRow[] = open
    .flatMap((p) => {
      const s = stage(p);
      const m = s && MOVE[s.key];
      if (!m) return [];
      const row: TodayRow = { url: p.url, repo: p.repo, number: p.number, title: p.title, tag: m.tag, since: p.updatedAt, why: s.why, next: s.next as Next, mine: true, updatedAt: p.updatedAt, headSha: p.headSha, lane: null, decisions: [], findings: s.findings, labels: p.labels };
      return [{ row, order: m.order }];
    })
    .sort((a, b) => a.order - b.order || a.row.since.localeCompare(b.row.since))
    .map((x) => x.row);

  // A mention on a PR that already has a row above is the same thing to do, so it doesn't get a second row.
  const shown = new Set([...review, ...move].map((r) => r.url));
  const mentions: TodayRow[] = (i.mentions ?? [])
    .filter((m) => !shown.has(m.url))
    .map((m) => {
      const n = m.url.match(/\/(?:pull|issues)\/(\d+)$/);
      return { url: m.url, repo: m.repo, number: n ? Number(n[1]) : null, title: m.title, tag: m.reason === 'assign' ? 'ASSIGNED' : 'MENTION', since: m.updatedAt, why: WHY[m.reason] ?? '', next: 'thread' as Next, mine: false, updatedAt: m.updatedAt, headSha: '', lane: null, decisions: [], findings: 0, labels: [], thread: m.id };
    })
    .sort((a, b) => a.since.localeCompare(b.since));

  return {
    bands: [
      { key: 'review', label: 'Someone is waiting on you', rows: review },
      { key: 'move', label: 'Your PRs, ready to move', rows: move },
      { key: 'mentions', label: 'Mentions and replies', rows: mentions },
    ],
    counts: {
      waiting: open.filter((p) => stage(p)?.key === 'waiting').length,
      hunt: open.filter((p) => stage(p)?.key === 'hunt').length,
      hidden: i.mine.length - open.length + i.queue.filter((p) => !i.done.has(p.url) && i.skipped[p.url] && i.skipped[p.url] >= p.updatedAt).length,
    },
  };
}
