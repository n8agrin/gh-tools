import { expect, test } from 'bun:test';
import * as db from '../src/db';
import { chatState, reviewNotes } from '../src/chat';

const url = 'https://github.com/a/b/pull/42';

test('keeps the thread in order and clears it', () => {
  db.saveChat({ prUrl: url, sessionId: 's1', dir: '/tmp/x', headSha: 'abc' });
  db.addChatMessage(url, 'user', 'why?', 'done');
  const id = db.addChatMessage(url, 'assistant', '', 'running');
  db.updateChatMessage(id, 'because', 'done');
  expect(chatState(url)).toMatchObject({ running: false, messages: [{ role: 'user', text: 'why?' }, { role: 'assistant', text: 'because', status: 'done' }] });
  expect(db.getChat(url)?.sessionId).toBe('s1');
  db.clearChat(url);
  expect(chatState(url).messages).toEqual([]);
  expect(db.getChat(url)).toBeNull();
});

test('review notes carry finished checks and flag a stale run', () => {
  expect(reviewNotes(url, 'new')).toContain('No local review');
  const id = db.createReview(url, 'old', [
    { key: 'gate', label: 'Bug pass', status: 'done', output: '{}' },
    { key: 'risk', label: 'Risk', status: 'done', output: '{"level":"low"}' },
    { key: 'taste', label: 'Taste', status: 'failed', output: 'boom' },
  ]);
  db.finishReview(id, 'done');
  const notes = reviewNotes(url, 'new');
  expect(notes).toContain('### Risk\n{"level":"low"}');
  expect(notes).not.toContain('Bug pass');
  expect(notes).not.toContain('boom');
  expect(notes).toContain('moved on since');
  expect(reviewNotes(url, 'old')).not.toContain('moved on since');
});
