import { expect, test } from 'bun:test';
import { huntEvidence, stageOf, type HuntEvidence } from '../src/stage';

const pr = (o: Partial<{ isDraft: boolean; ci: 'success' | 'failure' | 'pending' | null; reviewDecision: string | null; mergeable: 'MERGEABLE' | 'CONFLICTING' | null; waitingOn: string[] }> = {}) => ({
  isDraft: false,
  ci: 'success' as const,
  reviewDecision: null,
  mergeable: 'MERGEABLE' as const,
  waitingOn: [],
  ...o,
});
const ev = (o: Partial<HuntEvidence> = {}): HuntEvidence => ({ passOnHead: false, passBefore: false, findings: 0, labelled: false, ...o });
const clean = ev({ passOnHead: true });

test('blocked beats everything: red CI, a conflict, or changes requested', () => {
  expect(stageOf(pr({ ci: 'failure', reviewDecision: 'APPROVED' }), clean).key).toBe('blocked');
  expect(stageOf(pr({ mergeable: 'CONFLICTING' }), clean)).toMatchObject({ key: 'blocked', next: 'unblock' });
  expect(stageOf(pr({ reviewDecision: 'CHANGES_REQUESTED' }), clean).why).toStartWith('Changes were requested');
});

test('approved and open means ship, even with findings or no bug pass', () => {
  expect(stageOf(pr({ reviewDecision: 'APPROVED' }), ev())).toMatchObject({ key: 'ship', next: 'merge' });
  expect(stageOf(pr({ reviewDecision: 'APPROVED' }), ev({ passOnHead: true, findings: 2 })).key).toBe('ship');
  // An approved draft still has to be undrafted first.
  expect(stageOf(pr({ isDraft: true, reviewDecision: 'APPROVED' }), clean).key).toBe('undraft');
});

test('open findings from a pass on this head mean fix', () => {
  const s = stageOf(pr({ isDraft: true }), ev({ passOnHead: true, findings: 3 }));
  expect(s).toMatchObject({ key: 'fix', next: 'findings', findings: 3 });
  expect(s.why).toBe('3 findings open from the last bug pass on this head.');
  // Findings from an older head don't count against the new one.
  expect(stageOf(pr({ isDraft: true }), ev({ passBefore: true, findings: 3 })).findings).toBe(0);
});

test('a clean draft with green CI is ready to undraft; the reviewed label counts as a pass', () => {
  expect(stageOf(pr({ isDraft: true }), clean)).toMatchObject({ key: 'undraft', next: 'undraft' });
  expect(stageOf(pr({ isDraft: true }), ev({ labelled: true })).key).toBe('undraft');
  expect(stageOf(pr({ isDraft: true, ci: null }), clean).why).toContain('no CI');
  expect(stageOf(pr({ isDraft: true, ci: 'pending' }), clean).key).toBe('waiting');
});

test('no pass on the current head means hunt, and says when the pass is stale', () => {
  expect(stageOf(pr(), ev())).toMatchObject({ key: 'hunt', next: 'hunt', stalePass: false, why: 'No bug pass yet.' });
  expect(stageOf(pr({ isDraft: true }), ev({ passBefore: true }))).toMatchObject({ key: 'hunt', stalePass: true, why: 'The last bug pass was on an older head.' });
  // The label is a pass whatever the head, so a label plus an old run is not stale.
  expect(stageOf(pr(), ev({ passBefore: true, labelled: true })).stalePass).toBe(false);
});

test('a clean open PR waits on its reviewers, or on someone being asked', () => {
  expect(stageOf(pr({ waitingOn: ['@sam', 'frontend'] }), clean)).toMatchObject({ key: 'waiting', next: 'nudge', why: 'Waiting on @sam, frontend.' });
  expect(stageOf(pr(), clean).why).toBe('Bug pass clean, nobody asked to review it yet.');
});

test('evidence comes from the newest finished findings step on the current head', () => {
  const review = (id: number, headSha: string, steps: { key: string; status: string }[]) => ({ id, prUrl: 'u', headSha, status: 'done', startedAt: '', steps: steps.map((s) => ({ ...s, label: s.key })) }) as any;
  const reviews = [review(3, 'new', [{ key: 'guide', status: 'done' }]), review(2, 'new', [{ key: 'bughunt', status: 'done' }, { key: 'check', status: 'done' }]), review(1, 'old', [{ key: 'bughunt', status: 'done' }])];
  const counts: Record<string, number> = { '2:bughunt': 2, '2:check': 1, '1:bughunt': 9 };
  const e = huntEvidence({ headSha: 'new', labels: [] }, reviews, ['bughunt'], 'bug-pass', (id, key) => counts[`${id}:${key}`] ?? 0);
  expect(e).toEqual({ passOnHead: true, passBefore: true, findings: 3, labelled: false });
  // A run still going, or one that failed, is not a pass.
  expect(huntEvidence({ headSha: 'new', labels: ['bug-pass'] }, [review(4, 'new', [{ key: 'bughunt', status: 'running' }])], ['bughunt'], 'bug-pass', () => 0)).toEqual({ passOnHead: false, passBefore: false, findings: 0, labelled: true });
});
