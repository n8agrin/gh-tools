// Reviews that start by themselves: with `auto` in your config, the server runs a review on each new
// review request as it arrives, so the queue already has a brief when you open it. Off without it.
import type { ReviewPR } from './github';

export interface Auto {
  /** Most reviews it may start in one day (default 20). The cap on what a busy day can cost. */
  perDay?: number;
  /** Most reviews running at once, counting ones you started (default 2). */
  atOnce?: number;
  /** How often it looks for new requests (default 10). */
  everyMinutes?: number;
}

export const autoLimits = (a: Auto) => ({ perDay: a.perDay ?? 20, atOnce: a.atOnce ?? 2, everyMinutes: a.everyMinutes ?? 10 });

export const headKey = (url: string, headSha: string) => `${url}@${headSha}`;

export interface AutoState {
  /** Repos with a checkout, since a run needs one. */
  repos: Set<string>;
  /** `headKey` of every head that already has a run, whatever came of it. A failed run isn't retried: it would fail the same way and spend again. */
  seen: Set<string>;
  /** PRs you set aside or marked done. */
  hidden: Set<string>;
  running: number;
  startedToday: number;
}

/** The PRs to review now: waiting longest first, within what the day and the machine have left. */
export function autoPick(prs: ReviewPR[], s: AutoState, limits: ReturnType<typeof autoLimits>): ReviewPR[] {
  const room = Math.min(limits.atOnce - s.running, limits.perDay - s.startedToday);
  if (room <= 0) return [];
  return prs
    .filter((p) => !p.isDraft && s.repos.has(p.repo) && !s.hidden.has(p.url) && !s.seen.has(headKey(p.url, p.headSha)))
    .sort((a, b) => a.requestedAt.localeCompare(b.requestedAt))
    .slice(0, room);
}

/** The day's count, kept as `{day, n}`; a count from another day reads as zero. */
export function startedOn(day: string, saved: string | null): number {
  try {
    const o = JSON.parse(saved ?? '');
    return o.day === day && Number.isInteger(o.n) ? o.n : 0;
  } catch {
    return 0;
  }
}
