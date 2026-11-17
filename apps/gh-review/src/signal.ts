// Path rules shared by the brief's lane: a red path from your config always puts a question in front
// of you, and Check findings only count when they point at a changed file and a line range.

export interface RedPath {
  /** A regex tested against each changed file's repo-relative path. */
  match: string;
  /** What the path is, for the reason line, e.g. "SQL generation in the query service". */
  why: string;
}

export type Floor = { file: string; why: string }[];

// Tests under a critical path don't change what ships, so they don't set the floor. That includes the e2e page objects.
export const isTest = (f: string) => /(^|\/)(test|tests|__tests__|__mocks__|fixtures?|e2e|playwright-tests)\//.test(f) || /\.(test|spec)\.[^/]+$/.test(f) || /Tests?\.kt$/.test(f);

export function pathFloor(files: string[], red: RedPath[]): Floor {
  const out: Floor = [];
  for (const file of files) {
    if (isTest(file)) continue;
    const hit = red.find((r) => new RegExp(r.match).test(file));
    if (hit) out.push({ file, why: hit.why });
  }
  return out;
}

/** Keep only Check findings that point at a changed file and a line range, so every one can be looked at. */
export function keepFindings(findings: any[], files: string[]): any[] {
  const changed = new Set(files);
  return (findings ?? []).filter((f) => changed.has(f.file) && /^\d+(-\d+)?$/.test(String(f.lines ?? '').trim()) && String(f.note ?? '').trim());
}
