// The bug hunt's second pass, and what it's told was already said. Check runs on every PR, so its
// findings have to earn their place: a skeptic tries to disprove each one against the code and drops
// or downgrades what doesn't hold, and anything people or other AI reviewers already raised on the PR
// goes into the prompt so the hunt doesn't repeat it. Dropped findings stay visible with a reason.
import type { LineThreadComment, PRComment, ReviewSummary } from './github';
import { excerpt } from './taste';

export type Verdict = 'safe' | 'careful' | 'dangerous';
export const VERDICTS: Verdict[] = ['safe', 'careful', 'dangerous'];

export interface Finding {
  file: string;
  lines: string;
  kind: 'check';
  category: string;
  color: 'yellow' | 'red';
  note: string;
  scenario: string;
  /** Set when the skeptic took a red finding down to yellow, with its reason. */
  downgraded?: string;
}

export interface HuntVerdict {
  id: string;
  verdict: 'keep' | 'yellow' | 'drop';
  reason: string;
}

const start = (lines: string) => Number(String(lines).split('-')[0]) || 1;
const end = (lines: string) => Number(String(lines).split('-')[1]) || start(lines);

/** Apply the skeptic's verdicts by position ("1", "2", ...). No verdict means keep, so a short answer hides nothing. */
export function applyHuntVerdicts(out: { findings: Finding[] } & Record<string, any>, verdicts: HuntVerdict[]) {
  const byId = new Map(verdicts.map((v) => [String(v.id), v]));
  const dropped: { note: string; file: string; lines: string; reason: string }[] = [];
  const findings = out.findings.flatMap((f, i) => {
    const v = byId.get(String(i + 1));
    if (v?.verdict === 'drop') return dropped.push({ note: f.note, file: f.file, lines: f.lines, reason: v.reason }), [];
    if (v?.verdict === 'yellow' && f.color === 'red') return [{ ...f, color: 'yellow' as const, downgraded: v.reason }];
    return [f];
  });
  // A dangerous call that rested on red findings the skeptic took away comes down to careful.
  const verdict = out.verdict === 'dangerous' && out.findings.some((f) => f.color === 'red') && !findings.some((f) => f.color === 'red') ? 'careful' : out.verdict;
  return { ...out, verdict, ...(verdict !== out.verdict ? { verdict_moved: 'the red findings it rested on did not hold up' } : {}), findings, dropped };
}

interface Deps {
  /** A file at the PR head, or null when it can't be read. */
  read: (path: string) => Promise<string | null>;
  /** The skeptic: gets the findings with their code and returns { verdicts }. */
  ask: (text: string) => Promise<{ verdicts: HuntVerdict[] }>;
}

export async function verifyHunt(out: { findings: Finding[] } & Record<string, any>, { read, ask }: Deps) {
  if (!out.findings.length) return { ...out, dropped: [] };
  const blocks: string[] = [];
  for (const [i, f] of out.findings.entries()) {
    const text = await read(f.file);
    blocks.push(
      [`## ${i + 1}`, `${f.color}, ${f.category}: ${f.note}`, `Scenario: ${f.scenario}`, `### ${f.file}:${f.lines}`, text ? '```\n' + excerpt(text, start(f.lines), end(f.lines), 20) + '\n```' : '(could not read this file)'].join('\n\n'),
    );
  }
  const { verdicts } = await ask(`\n\n---\n\n${blocks.join('\n\n---\n\n')}`);
  return applyHuntVerdicts(out, verdicts ?? []);
}

const clip = (s: string, n: number) => {
  const one = s.replace(/<details>[\s\S]*?<\/details>/g, ' ').replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n)}…` : one;
};

/**
 * What's already been said on the PR, for the prompt: line comments with where they sit, review
 * summaries and the conversation. Bots are marked, since other AI reviewers are what the hunt most
 * often repeats. Capped so a long thread doesn't crowd out the diff.
 */
// Bots that post build and deploy reports, not review: their comments only crowd the prompt.
const REPORTER = /^(github-actions|codecov|vercel|netlify|dependabot|renovate|sonarcloud|changeset-bot)(\[bot\])?$/i;

export function saidLines(c: { lines: LineThreadComment[]; conversation: PRComment[]; reviews: ReviewSummary[] }, cap = 12_000): string {
  const who = (x: PRComment) => `@${x.user}${x.bot ? ' (bot)' : ''}`;
  const said = (x: PRComment) => !REPORTER.test(x.user);
  const rows = [
    ...c.lines.filter(said).map((x) => ({ at: x.at, s: `${who(x)} on ${x.path}:${x.line ?? x.originalLine ?? '?'}${x.line === null ? ' (outdated)' : ''}${x.replyTo ? ' (reply)' : ''}: ${clip(x.body, 600)}` })),
    ...c.reviews.filter((x) => said(x) && x.body.trim()).map((x) => ({ at: x.at, s: `${who(x)} review (${x.state.toLowerCase()}): ${clip(x.body, 1200)}` })),
    ...c.conversation.filter((x) => said(x) && x.body.trim()).map((x) => ({ at: x.at, s: `${who(x)}: ${clip(x.body, 800)}` })),
  ].sort((a, b) => a.at.localeCompare(b.at));
  if (!rows.length) return 'Nothing yet.';
  let out = '';
  for (const [i, r] of rows.entries()) {
    if (out.length + r.s.length > cap) return `${out}- …and ${rows.length - i} more, cut for length.`;
    out += `- ${r.s}\n`;
  }
  return out.trimEnd();
}
