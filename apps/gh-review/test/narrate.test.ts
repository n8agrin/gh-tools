import { expect, test } from 'bun:test';
// @ts-ignore plain JS module shared with the page
import { pickVoice, segments, sentences, speakable } from '../public/narrate.js';

test('the whole-PR narration plays the overview, each file, then the routine files', () => {
  const n = {
    overview: 'This PR adds narration.',
    files: [
      { file: 'src/a.ts', importance: 'high', script: 'A changes.' },
      { file: 'src/b.ts', importance: 'low', script: '  ' },
    ],
    routine: 'There are also two tests.',
  };
  expect(segments(n).map((s) => s.id)).toEqual(['overview', 'src/a.ts', 'routine']);
  expect(segments(n)[1]).toMatchObject({ file: 'src/a.ts', importance: 'high' });
  expect(segments({ overview: '', files: [], routine: '' })).toEqual([]);
  expect(segments(null)).toEqual([]);
});

test('markdown and links never reach the voice', () => {
  expect(speakable('Calls `startReview` in **review**, see [the docs](https://x.y) or https://a.b/c today.')).toBe('Calls startReview in review, see the docs or today.');
});

test('each sentence is spoken on its own', () => {
  expect(sentences('It reads the diff. Then it writes a script! Does it work? Yes')).toEqual(['It reads the diff.', 'Then it writes a script!', 'Does it work?', 'Yes']);
  expect(sentences('Version 1.5 ships.')).toEqual(['Version 1.5 ships.']);
  expect(sentences('')).toEqual([]);
});

test('picks your voice, else a premium English one, else any English one', () => {
  const v = (name: string, lang = 'en-US', localService = true) => ({ name, lang, localService });
  const voices = [v('Thomas', 'fr-FR'), v('Fred'), v('Ava (Premium)'), v('Samantha')];
  expect(pickVoice(voices, 'Samantha')?.name).toBe('Samantha');
  expect(pickVoice(voices, 'Gone')?.name).toBe('Ava (Premium)');
  expect(pickVoice([v('Thomas', 'fr-FR'), v('Fred')], '')?.name).toBe('Fred');
  expect(pickVoice([], '')).toBeNull();
});
