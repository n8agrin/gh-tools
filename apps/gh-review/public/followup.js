// Spots comment threads that put work off until later ("fine for now, but ideally…", "a good follow-up")
// and drafts a GitHub issue from one. Plain JS so the PR page and the tests share it.

// Phrases that say the work is real but belongs somewhere other than this PR.
const CUES = [
  /\bfollow[- ]?ups?\b/,
  /\b(?:fine|ok|okay|good|works|alright)\s+for\s+now\b/,
  /\bfor\s+now,?\s+but\b/,
  /\b(?:in|as|for)\s+an?\s+(?:separate|later|future|follow[- ]?up|subsequent|next|different)\s+(?:pr|pull request|change|diff|commit|ticket|issue)\b/,
  /\b(?:separate|future|later|next)\s+(?:pr|pull request)\b/,
  /\bout\s+of\s+scope\b/,
  /\b(?:tech|technical)\s+debt\b/,
  /\bideally\b/,
  /\b(?:do|handle|address|fix|tackle|clean|revisit)\s+(?:this|that|it)(?:\s+up)?\s+later\b/,
  /\brevisit\b/,
  /\b(?:punt|defer)(?:ed|ing)?\b/,
  /\b(?:down the road|longer[- ]term|at some point)\b/,
  /\b(?:file|open|create|make)\s+an?\s+(?:issue|ticket)\b/,
  /\bTODO\b/i,
];

// Sentences that read like the thing to do, best first.
const ACTION = /\b(?:should|ideally|need to|needs to|we could|let'?s|follow[- ]?up|todo|would be (?:nice|good|better))\b/i;

/** Lines a tool adds under its comments, which don't belong in a quote or a title. */
const clean = (body) =>
  String(body ?? '')
    .split('\n')
    .filter((l) => !/^\s*_?generated (?:by|with) \[?claude code/i.test(l) && !/^\s*-{3,}\s*$/.test(l))
    .join('\n')
    .trim();

/** The phrase that makes a comment read as deferred work, or null. */
export function deferredWork(text) {
  const s = clean(text).replace(/`[^`]*`/g, '').replace(/^>.*$/gm, '');
  for (const re of CUES) {
    const m = s.match(new RegExp(re.source, re.flags.includes('i') ? re.flags : re.flags + 'i'));
    if (m) return m[0];
  }
  return null;
}

/** The first comment in a thread that defers work, with the phrase that does it, or null. */
export function threadDefers(comments) {
  for (const c of comments) {
    const cue = deferredWork(c.body);
    if (cue) return { id: c.id, cue };
  }
  return null;
}

const sentences = (text) =>
  clean(text)
    .replace(/^>.*$/gm, '')
    .replace(/```[\s\S]*?```/g, '')
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);

/** A short issue title from the sentence that names the work. */
export function followUpTitle(comments, fallback) {
  const all = comments.flatMap((c) => sentences(c.body));
  const pick = all.find((s) => ACTION.test(s) && deferredWork(s)) ?? all.find((s) => ACTION.test(s)) ?? all.find((s) => deferredWork(s));
  if (!pick) return fallback;
  let t = pick
    .replace(/^(?:claude says:\s*)/i, '')
    .replace(/^.*?\b(?:fine|ok|okay|good|works|alright)\s+for\s+now,?\s*(?:but\s+)?/i, '')
    .replace(/^(?:but|and|so|also|nit:?|hmm,?|i think|imo,?)\s+/gi, '')
    .replace(/^(?:ideally,?\s+)?(?:we|you|this|it)\s+(?:should|could|would|need to|needs to)\s+(?:probably\s+|eventually\s+|really\s+)?/i, '')
    .replace(/^(?:ideally,?\s+)/i, '')
    .replace(/^todo:?\s*/i, '')
    .replace(/\s*\([^)]*\)/g, '')
    .replace(/[\s.!?:;,]+$/, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!t) return fallback;
  t = t[0].toUpperCase() + t.slice(1);
  // Long enough to name the work; cut at a word so the issue title never ends mid-word.
  if (t.length > 110) t = t.slice(0, 111).replace(/\s+\S*$/, '').replace(/(?:[\s,;:]+|\s+(?:a|an|the|to|of|for|with|and|or|but|that|before|after|when|in|on))+$/i, '');
  return t;
}

/** Each comment as a quote with its author, so the issue reads on its own. */
const quote = (c) => `> **@${c.user}:** ${clean(c.body).split('\n').join('\n> ')}`;

/**
 * The issue to file: a title from the thread, and a body that links back to the PR and the comment
 * and quotes the discussion. `pr` is { number, title }, `thread` is { comments, path, line, url }.
 */
export function followUpDraft(pr, thread) {
  const where = thread.path ? ` on \`${thread.path}${thread.line ? `:${thread.line}` : ''}\`` : '';
  const title = followUpTitle(thread.comments, `Follow-up from #${pr.number}${thread.path ? `: ${thread.path.split('/').pop()}` : ''}`);
  const body = [
    `Follow-up from #${pr.number} (${pr.title}), from [this thread](${thread.url})${where}.`,
    '',
    thread.comments.map(quote).join('\n>\n'),
  ].join('\n');
  return { title, body };
}
