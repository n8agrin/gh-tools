// Findings from a bug-finding check, so the PR page can offer them as a pick list. Any tool works:
// a check with "findings": true writes them as JSON to the file in $GH_REVIEW_FINDINGS, and this
// keeps a copy after the worktree is gone.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { HOME } from './db';

export interface Finding {
  id: number;
  file: string;
  /** A line in the PR's version of the file. */
  line: number;
  title: string;
  body?: string;
  severity?: string;
  /** False when GitHub can't anchor it to a diff line, so it goes in the review body instead. */
  inline: boolean;
}

export interface FindingsRun {
  reviewId: number;
  key: string;
  headSha: string;
  findings: Finding[];
  posted: { url: string | null; at: string; ids: number[] }[];
}

/** What the tool is told to write. Kept short so any agent or script can follow it. */
export const FORMAT = `{"findings": [{"file": "path/in/repo.ts", "line": 42, "title": "one line", "body": "what goes wrong and when", "severity": "blocker | important | suggestion"}]}`;

export const findingsNote = (path: string) =>
  `When you are done, also write every finding you would post on the PR to ${path} as JSON in this shape: ${FORMAT}. "line" is a line number in the PR's version of the file. Write {"findings": []} when there are none. That file is the only thing you may write.`;

const file = (reviewId: number, key: string) => join(HOME, 'findings', `${reviewId}-${key.replace(/[^\w-]/g, '_')}.json`);

/** Lines on the new side of each file's diff, which are the only ones GitHub can anchor a comment to. */
export function rightLines(diff: string): Map<string, Set<number>> {
  const out = new Map<string, Set<number>>();
  let lines: Set<number> | null = null;
  let n = 0;
  for (const l of diff.split('\n')) {
    if (l.startsWith('+++ ')) {
      const path = l.slice(4).replace(/^b\//, '');
      lines = path === '/dev/null' ? null : new Set();
      if (lines) out.set(path, lines);
      continue;
    }
    const h = l.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (h) {
      n = Number(h[1]);
      continue;
    }
    if (!lines || l.startsWith('--- ') || l.startsWith('\\')) continue;
    if (l.startsWith('+') || l.startsWith(' ')) lines.add(n++);
  }
  return out;
}

/** Turns what the tool wrote into findings, dropping any without a file, a line and a title. */
export function parseFindings(raw: unknown, diff: string): Finding[] {
  const list = Array.isArray((raw as any)?.findings) ? (raw as any).findings : [];
  const anchors = rightLines(diff);
  return list
    .filter((f: any) => f && typeof f.file === 'string' && Number.isInteger(Number(f.line)) && String(f.title ?? '').trim())
    .map((f: any, i: number) => ({
      id: i + 1,
      file: f.file,
      line: Number(f.line),
      title: String(f.title).trim(),
      body: f.body ? String(f.body) : undefined,
      severity: f.severity ? String(f.severity) : undefined,
      inline: !!anchors.get(f.file)?.has(Number(f.line)),
    }));
}

export function saveFindings(run: FindingsRun) {
  mkdirSync(join(HOME, 'findings'), { recursive: true });
  writeFileSync(file(run.reviewId, run.key), JSON.stringify(run, null, 2));
}

export function loadFindings(reviewId: number, key: string): FindingsRun | null {
  const f = file(reviewId, key);
  return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null;
}

/** The review to post: picked findings as line comments, and the ones GitHub can't anchor in the body. */
export function findingsReview(run: FindingsRun, ids: number[], label: string) {
  const picked = run.findings.filter((f) => ids.includes(f.id));
  const text = (f: Finding) => `**${f.severity ? `${f.severity}: ` : ''}${f.title}**${f.body ? `\n\n${f.body.trim()}` : ''}`;
  const loose = picked.filter((f) => !f.inline).map((f) => `- \`${f.file}:${f.line}\` ${text(f)}`);
  const body = [`Findings from ${label}, picked by hand.`, ...(loose.length ? ['', ...loose] : [])].join('\n');
  const comments = picked.filter((f) => f.inline).map((f) => ({ path: f.file, line: f.line, side: 'RIGHT' as const, body: text(f) }));
  return { body, comments };
}
