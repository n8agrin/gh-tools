// Plays the Narration check out loud with the browser's own voices. The brief plays the overview and then
// every file; a file page plays just that file. Nothing here talks to the server.

/** The narration as one list of parts to play, overview first. */
export function segments(n) {
  if (!n) return [];
  const out = [];
  if (n.overview?.trim()) out.push({ id: 'overview', file: null, importance: null, text: n.overview });
  for (const f of n.files ?? []) if (f.script?.trim()) out.push({ id: f.file, file: f.file, importance: f.importance, text: f.script });
  if (n.routine?.trim()) out.push({ id: 'routine', file: null, importance: null, text: n.routine });
  return out;
}

/** Text a voice can read: no markdown marks, no links. */
export const speakable = (s) =>
  String(s ?? '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[`*_#>]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

/** Splits text into sentences. Chrome cuts off long utterances, so each sentence is spoken on its own. */
export const sentences = (s) => speakable(s).split(/(?<=[.!?])\s+/).filter(Boolean);

/** Picks a voice: the one you chose, else the best-sounding English one on this machine. */
export function pickVoice(voices, saved) {
  const en = voices.filter((v) => /^en/i.test(v.lang));
  return (
    voices.find((v) => v.name === saved) ??
    en.find((v) => /premium/i.test(v.name)) ??
    en.find((v) => /enhanced/i.test(v.name)) ??
    en.find((v) => /^(Ava|Samantha|Zoe|Evan|Daniel|Google US English)\b/.test(v.name)) ??
    en.find((v) => v.localService && /en-US/i.test(v.lang)) ??
    en[0] ??
    voices[0] ??
    null
  );
}

export const RATES = [1, 1.15, 1.3, 1.5, 1.75, 2];

const load = (k, d) => {
  try {
    return localStorage.getItem(k) ?? d;
  } catch {
    return d;
  }
};
const save = (k, v) => {
  try {
    localStorage.setItem(k, v);
  } catch {}
};

/**
 * One player for the page. `scope` names what's loaded ('all' for the whole PR, or a file path), so each
 * view can tell whether the player is playing its own part. `onChange` runs whenever that changes.
 */
export function createPlayer(onChange) {
  const synth = typeof window !== 'undefined' ? window.speechSynthesis : null;
  const p = {
    supported: !!synth,
    scope: null,
    list: [],
    seg: 0,
    sent: 0,
    playing: false,
    rate: Number(load('narrateRate', '1.15')) || 1.15,
    voiceName: load('narrateVoice', ''),
    follow: load('narrateFollow', '') === '1',
    voices: [],
  };
  // Cancelling fires the old utterance's end event, so each utterance checks it's still the current one.
  let gen = 0;

  const refreshVoices = () => {
    p.voices = synth?.getVoices() ?? [];
    onChange('voices');
  };
  if (synth) {
    refreshVoices();
    synth.addEventListener?.('voiceschanged', refreshVoices);
  }

  const parts = () => sentences(p.list[p.seg]?.text);

  function speak() {
    if (!synth) return;
    const mine = ++gen;
    synth.cancel();
    const lines = parts();
    if (p.sent >= lines.length) return advance(mine);
    const u = new SpeechSynthesisUtterance(lines[p.sent]);
    const voice = pickVoice(p.voices, p.voiceName);
    if (voice) (u.voice = voice), (u.lang = voice.lang);
    u.rate = p.rate;
    u.onend = () => {
      if (mine !== gen || !p.playing) return;
      p.sent++;
      speak();
    };
    u.onerror = (e) => {
      if (mine !== gen || e.error === 'interrupted' || e.error === 'canceled') return;
      p.playing = false;
      onChange('error');
    };
    synth.speak(u);
  }

  function advance(mine) {
    if (mine !== gen) return;
    if (p.seg + 1 >= p.list.length) {
      p.playing = false;
      p.seg = 0;
      p.sent = 0;
      p.scope = null;
      return onChange('end');
    }
    p.seg++;
    p.sent = 0;
    onChange('segment');
    speak();
  }

  return Object.assign(p, {
    /** Starts `list` from part `at`, replacing whatever was loaded. */
    play(scope, list, at = 0) {
      if (!list.length) return;
      Object.assign(p, { scope, list, seg: Math.max(0, Math.min(at, list.length - 1)), sent: 0, playing: true });
      onChange('segment');
      speak();
    },
    pause() {
      if (!p.playing) return;
      p.playing = false;
      gen++;
      synth?.cancel();
      onChange('pause');
    },
    /** Picks up at the start of the sentence it stopped in. */
    resume() {
      if (p.playing || !p.list.length) return;
      p.playing = true;
      onChange('play');
      speak();
    },
    toggle() {
      p.playing ? p.pause() : p.resume();
    },
    skip(d) {
      if (!p.list.length) return;
      const to = p.seg + d;
      if (to < 0 || to >= p.list.length) return;
      Object.assign(p, { seg: to, sent: 0 });
      onChange('segment');
      if (p.playing) speak();
    },
    stop() {
      gen++;
      synth?.cancel();
      Object.assign(p, { scope: null, list: [], seg: 0, sent: 0, playing: false });
      onChange('stop');
    },
    setRate(r) {
      p.rate = r;
      save('narrateRate', String(r));
      if (p.playing) speak();
      onChange('rate');
    },
    setVoice(name) {
      p.voiceName = name;
      save('narrateVoice', name);
      if (p.playing) speak();
      onChange('voice');
    },
    setFollow(on) {
      p.follow = on;
      save('narrateFollow', on ? '1' : '');
      onChange('follow');
    },
    /** The part being played or paused on, or null. */
    current() {
      return p.list.length ? p.list[p.seg] : null;
    },
  });
}
