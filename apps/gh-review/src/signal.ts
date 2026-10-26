// The review signal: green means approve if CI passes, yellow means skim, red means read it all.
// Red comes from file paths first, so the AI can raise the color but never lower it below that floor.

export type Color = 'green' | 'yellow' | 'red';

export interface RedPath {
  /** A regex tested against each changed file's repo-relative path. */
  match: string;
  /** What the path is, for the reason line, e.g. "SQL generation in the query service". */
  why: string;
}

export interface Signal {
  color: Color;
  reason: string;
  /** Changed files that matched a red path. */
  floor: { file: string; why: string }[];
  /** The AI's own answer, before the floor and the green checks. Absent when the floor already made it red. */
  ai?: any;
  /** The reason before a Check finding raised the color. */
  raisedBy?: string;
}

const RANK: Record<Color, number> = { green: 0, yellow: 1, red: 2 };
const NAME: Record<Color, string> = { green: 'Green', yellow: 'Yellow', red: 'Red' };

// Tests under a critical path don't change what ships, so they don't set the floor. That includes the e2e page objects.
export const isTest = (f: string) => /(^|\/)(test|tests|__tests__|__mocks__|fixtures?|e2e|playwright-tests)\//.test(f) || /\.(test|spec)\.[^/]+$/.test(f) || /Tests?\.kt$/.test(f);

export function pathFloor(files: string[], red: RedPath[]): Signal['floor'] {
  const out: Signal['floor'] = [];
  for (const file of files) {
    if (isTest(file)) continue;
    const hit = red.find((r) => new RegExp(r.match).test(file));
    if (hit) out.push({ file, why: hit.why });
  }
  return out;
}

export function floorSignal(floor: Signal['floor']): Signal {
  const whys = [...new Set(floor.map((f) => f.why))];
  return { color: 'red', reason: `Red: changes ${whys.slice(0, 2).join(' and ')}${whys.length > 2 ? ` and ${whys.length - 2} more` : ''}`, floor };
}

/** Combine the AI's answer with the floor. Green only stands when the AI's own inert checks hold. */
export function decide(ai: any, floor: Signal['floor']): Signal {
  if (floor.length) return { ...floorSignal(floor), ai };
  let color: Color = RANK[ai.color as Color] === undefined ? 'yellow' : ai.color;
  let reason = String(ai.reason ?? '').replace(/^(green|yellow|red)\s*:\s*/i, '');
  if (color === 'green') {
    const flagged = ai.flag && ai.flag_defaults_off && ai.all_behind_flag;
    if (!flagged && !ai.no_runtime_change) {
      color = 'yellow';
      reason = ai.flag ? `${ai.flag} is ${ai.flag_defaults_off ? 'off by default, but some changed code runs outside it' : 'not off by default'}` : 'not behind a flag that defaults off';
    }
  }
  return { color, reason: `${NAME[color]}: ${reason}`, floor, ai };
}

/** Keep only Check findings that point at a changed file and a line range, so every one can be looked at. */
export function keepFindings(findings: any[], files: string[]): any[] {
  const changed = new Set(files);
  return (findings ?? []).filter((f) => changed.has(f.file) && /^\d+(-\d+)?$/.test(String(f.lines ?? '').trim()) && String(f.note ?? '').trim());
}

/** A Check finding can raise the signal to its own color, never lower it. */
export function raise(signal: Signal, findings: any[]): Signal {
  const worst = findings.filter((f) => RANK[f.color as Color] > RANK[signal.color]).sort((a, b) => RANK[b.color as Color] - RANK[a.color as Color])[0];
  if (!worst) return signal;
  const name = worst.file.split('/').pop();
  return { ...signal, color: worst.color, reason: `${NAME[worst.color as Color]}: ${worst.note.replace(/\.$/, '')} (${name})`, raisedBy: signal.reason };
}
