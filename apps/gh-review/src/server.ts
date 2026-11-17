// A small local server: serves the page, returns the queue, and does the two things a browser
// page can't do on its own, which are opening your browser and running Claude (actions and reviews).
import { join } from 'node:path';
import { listRuns, loadActions, startAction } from './actions';
import { ask, chatState, reset, stop } from './chat';
import { addImported, cachePR, cachedMine, cachedPR, cachedQueue, getMineAside, getMineDone, getOverrides, getSkipped, listDone, listImported, markDone, recordOutcome, calibration, agrees, rateFinding, findingRatings, findingStats, reviewSummaries, saveMine, saveQueue, setMineAside, setMineDone, typicalStepSeconds, liveReviews, markInterrupted, saveReviewed, setOverride, setSkipped, unmarkDone, viewer } from './db';
import { findingsReview, loadFindings, saveFindings } from './findings';
import { createIssue, fetchComments, fetchDiff, fetchFile, fetchImported, fetchMine, fetchPR, fetchViewer, reviewPayload, submitReview, fetchQueue, parsePRRef, type MyPR } from './github';
import { CONFIG, configFile, EXAMPLE, loadConfig, pageConfig } from './config';
import { allChecks, listReviews, optionalChecks, startReview, stopReview } from './review';
import { stagesFor } from './stage';
import { buildToday } from './today';

const PORT = Number(process.env.PORT ?? 4790);
/** A lane earns bulk approval at this agreement over at least this many PRs. Tune it to taste. */
const GATE = { agreement: 0.95, prs: 50 };
const PUBLIC = join(import.meta.dir, '..', 'public');

async function openInBrowser(url: string) {
  const { browser } = await loadConfig();
  const open = process.platform === 'darwin' ? 'open' : 'xdg-open';
  // If the browser from your config isn't there, the default browser is a fine fallback.
  if (browser && process.platform === 'darwin' && (await Bun.spawn(['open', '-a', browser, url]).exited) === 0) return;
  await Bun.spawn([open, url]).exited;
}

/** A findings run for a PR's review step, or null. The URL must be a PR link. */
function findingsRun(url: string, review: number, key: string) {
  if (!/^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+$/.test(url) || !key) return null;
  const run = loadFindings(review, key);
  return run && listReviews(url).some((r) => r.id === review) ? run : null;
}

const json = (body: unknown, status = 200) => Response.json(body, { status });
/** Your login, from the last fetch of either list or, before any fetch, from GitHub. */
const me = async () => viewer() ?? (await fetchViewer());

/** The review queue, fresh from GitHub and saved, or the last good copy with the error when GitHub fails. */
async function freshQueue() {
  try {
    const q = await fetchQueue(listImported());
    saveQueue(q);
    saveReviewed(q.reviewed);
    return q;
  } catch (e) {
    const cached = cachedQueue();
    if (!cached) throw e;
    return { ...cached, error: (e as Error).message };
  }
}

/** Your own open PRs, the same way. */
async function freshMine() {
  try {
    const q = await fetchMine();
    saveMine(q);
    return q;
  } catch (e) {
    const cached = cachedMine();
    if (!cached) throw e;
    return { ...cached, error: (e as Error).message };
  }
}

markInterrupted();

const server = Bun.serve({
  port: PORT,
  hostname: '127.0.0.1',
  idleTimeout: 60,
  async fetch(req) {
    const { pathname } = new URL(req.url);
    try {
      if (pathname === '/api/queue') {
        // ?cached=1 answers from the local copy so the page draws before GitHub replies.
        const extra = () => ({ skipped: getSkipped(), actions: loadedActions, done: listDone(), reviews: reviewSummaries(), live: liveReviews(), ...page });
        const [loadedActions, page] = await Promise.all([loadActions(), pageConfig()]);
        if (new URL(req.url).searchParams.has('cached')) return json({ ...(cachedQueue() ?? { prs: [], viewer: '', fetchedAt: null }), ...extra() });
        // GitHub failed (rate limit, expired login): freshQueue shows the last good list and says why it's stale.
        return json({ ...(await freshQueue()), ...extra() });
      }
      if (pathname === '/api/mine') {
        // Your own PRs, on their own page with their own cache and set-aside list. The board reads the same answer, plus a stage per PR.
        const extra = async (prs: MyPR[]) => ({ aside: getMineAside(), done: getMineDone(), actions: await loadActions(), reviews: reviewSummaries(), live: liveReviews(), stages: await stagesFor(prs), ...(await pageConfig()) });
        if (new URL(req.url).searchParams.has('cached')) {
          const cached = cachedMine() ?? { prs: [], viewer: '', fetchedAt: null };
          return json({ ...cached, ...(await extra(cached.prs)) });
        }
        const q = await freshMine();
        return json({ ...q, ...(await extra(q.prs)) });
      }
      if (pathname === '/api/today') {
        // Both lists at once. ?cached=1 draws from the local copies before GitHub answers.
        const cached = new URL(req.url).searchParams.has('cached');
        const [queue, mine] = cached
          ? [cachedQueue() ?? { prs: [], viewer: '', fetchedAt: null }, cachedMine() ?? { prs: [], viewer: '', fetchedAt: null }]
          : await Promise.all([freshQueue(), freshMine()]);
        const today = buildToday({
          viewer: queue.viewer || mine.viewer,
          queue: queue.prs,
          done: new Set(listDone().map((d) => d.pr.url)),
          skipped: getSkipped(),
          summaries: reviewSummaries(),
          mine: mine.prs,
          stages: await stagesFor(mine.prs),
          mineAside: getMineAside(),
          mineDone: getMineDone(),
        });
        const error = ('error' in queue && queue.error) || ('error' in mine && mine.error) || null;
        const times = [queue.fetchedAt, mine.fetchedAt].filter((t): t is string => !!t).sort();
        return json({ ...today, fetchedAt: times[0] ?? null, error });
      }
      if (pathname === '/api/findings') {
        const q = new URL(req.url).searchParams;
        const run = findingsRun(q.get('url') ?? '', Number(q.get('review')), q.get('key') ?? '');
        return json({ run });
      }
      if (pathname === '/api/calibration') {
        const rows = calibration().map((r) => ({ ...r, agrees: agrees(r.lane, r.outcome) }));
        return json({ rows, gate: GATE, findings: findingStats() });
      }
      if (pathname === '/api/ratings') return json(findingRatings(new URL(req.url).searchParams.get('url') ?? ''));
      if (pathname === '/api/runs') return json(listRuns());
      if (pathname === '/api/live') return json(liveReviews());
      if (pathname === '/api/pr') {
        const pr = await fetchPR(new URL(req.url).searchParams.get('url') ?? '');
        // Your own PR gets the My PRs flavor of the page: no approve, and findings you can post.
        return json({ ...pr, mine: pr.author === (await me()), reviewedLabel: (await pageConfig()).reviewedLabel });
      }
      if (pathname === '/api/comments') return json(await fetchComments(new URL(req.url).searchParams.get('url') ?? ''));
      if (pathname === '/api/file') {
        const q = new URL(req.url).searchParams;
        return new Response(await fetchFile(q.get('url') ?? '', q.get('path') ?? '', q.get('sha') ?? ''), { headers: { 'content-type': 'text/plain; charset=utf-8' } });
      }
      if (pathname === '/api/diff') return new Response(await fetchDiff(new URL(req.url).searchParams.get('url') ?? ''), { headers: { 'content-type': 'text/plain; charset=utf-8' } });
      if (pathname === '/api/reviews') {
        const prUrl = new URL(req.url).searchParams.get('url') ?? '';
        return json({ reviews: listReviews(prUrl), optional: await optionalChecks(), override: getOverrides()[prUrl] ?? null, typical: typicalStepSeconds(), checks: await allChecks() });
      }
      if (pathname === '/api/chat' && req.method === 'GET') return json(chatState(new URL(req.url).searchParams.get('url') ?? ''));
      if (req.method === 'POST') {
        const body = await req.json();
        if (pathname === '/api/open') {
          if (!/^https:\/\/github\.com\//.test(body.url)) return json({ error: 'not a GitHub URL' }, 400);
          await openInBrowser(body.url);
          return json({ ok: true });
        }
        if (pathname === '/api/done') {
          const pr = cachedQueue()?.prs.find((p) => p.url === body.url) ?? listDone().find((d) => d.pr.url === body.url)?.pr;
          if (body.done && !pr) return json({ error: 'unknown PR' }, 400);
          if (body.done) markDone(pr!);
          else unmarkDone(body.url);
          return json({ ok: true, done: listDone() });
        }
        if (pathname === '/api/import') {
          // Pulls in a PR nobody asked you on, like one that merged before you got to it.
          const url = parsePRRef(String(body.ref ?? ''), (await pageConfig()).defaultRepo);
          if (!url) return json({ error: 'Type a GitHub PR link, owner/repo#123, or a PR number once your config has a repo' }, 400);
          const at = new Date().toISOString();
          const viewer = cachedQueue()?.viewer ?? '';
          const [pr] = await fetchImported([{ url, at }], viewer);
          if (!pr) return json({ error: `Couldn't find ${url}` }, 404);
          addImported(url, at);
          cachePR(pr);
          return json({ pr });
        }
        if (pathname === '/api/mine/aside') {
          setMineAside(body.url, body.updatedAt ?? null);
          return json({ ok: true });
        }
        if (pathname === '/api/mine/done') {
          // Local only: clears your own PR off My PRs until a new commit lands. Nothing goes to GitHub.
          setMineDone(String(body.url ?? ''), typeof body.headSha === 'string' ? body.headSha : null);
          return json({ ok: true });
        }
        if (pathname === '/api/findings/post') {
          // Posts only the findings you ticked, and only on your own PR. Nothing else here writes findings to GitHub.
          const ids: number[] = Array.isArray(body.ids) ? body.ids.map(Number) : [];
          if (!ids.length || ids.some((i) => !Number.isInteger(i))) return json({ error: 'Pick at least one finding to post.' }, 400);
          const run = findingsRun(String(body.url ?? ''), Number(body.review), String(body.key ?? ''));
          if (!run) return json({ error: "Couldn't find that run's findings." }, 404);
          const pr = await fetchPR(body.url);
          if (pr.author !== (await me())) return json({ error: 'Posting findings is only for your own PRs for now.' }, 403);
          const unknown = ids.filter((i) => !run.findings.some((f) => f.id === i));
          if (unknown.length) return json({ error: `Not in this run: ${unknown.join(', ')}` }, 400);
          const label = (await allChecks()).find((c) => c.key === run.key)?.label ?? run.key;
          const { body: text, comments } = findingsReview(run, ids, label);
          try {
            const res = await submitReview(body.url, reviewPayload('COMMENT', text, comments, run.headSha));
            run.posted.push({ url: res.url, at: new Date().toISOString(), ids });
            saveFindings(run);
          } catch (e) {
            return json({ error: (e as Error).message }, 400);
          }
          return json({ run });
        }
        if (pathname === '/api/followup') {
          // Files a follow-up issue in the PR's repo, only after you confirm the draft on the PR page.
          if (!/^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+$/.test(body.url)) return json({ error: 'not a PR URL' }, 400);
          if (!String(body.title ?? '').trim()) return json({ error: 'Give the issue a title.' }, 400);
          try {
            return json(await createIssue(body.url, String(body.title), String(body.body ?? '')));
          } catch (e) {
            return json({ error: (e as Error).message }, 400);
          }
        }
        if (pathname === '/api/skip') {
          setSkipped(body.url, body.updatedAt ?? null);
          return json({ ok: true });
        }
        if (pathname === '/api/override') {
          if (body.color && !['green', 'yellow', 'red'].includes(body.color)) return json({ error: 'not a color' }, 400);
          setOverride(body.url, body.color ?? null);
          return json({ ok: true });
        }
        if (pathname === '/api/rate') {
          // Local only: your useful-or-noise call on a note, for the hit rates on /calibration.
          if (!/^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+$/.test(body.url)) return json({ error: 'not a PR URL' }, 400);
          const rating = body.rating === 'useful' || body.rating === 'noise' ? body.rating : null;
          if (!body.key || !['check', 'taste'].includes(body.source)) return json({ error: 'missing the note' }, 400);
          rateFinding(body.url, String(body.key), body.source, String(body.category || 'other'), rating);
          return json({ ok: true });
        }
        if (pathname === '/api/review/stop') return json({ stopped: stopReview(String(body.url ?? ''), body.key || undefined) });
        if (pathname === '/api/review') {
          if (!/^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+$/.test(body.url)) return json({ error: 'not a PR URL' }, 400);
          return json({ id: await startReview(body.url, body.extras ?? [], body.only ?? [], body.from) });
        }
        if (pathname === '/api/submit') {
          // Your own review, sent only when you press Submit on the PR page.
          if (!/^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+$/.test(body.url)) return json({ error: 'not a PR URL' }, 400);
          let payload;
          try {
            payload = reviewPayload(String(body.event), String(body.body ?? ''), body.comments ?? [], String(body.commitId ?? ''));
          } catch (e) {
            return json({ error: (e as Error).message }, 400);
          }
          const res = await submitReview(body.url, payload);
          recordOutcome(body.url, payload.commit_id, payload.event, payload.comments.length);
          // Move it to Done now instead of waiting for the next fetch to see the review.
          const review = ({ APPROVE: 'APPROVED', REQUEST_CHANGES: 'CHANGES_REQUESTED' } as const)[payload.event as 'APPROVE'];
          const pr = cachedPR(body.url);
          if (review && pr) saveReviewed([{ pr: { ...pr, myReview: review }, review, at: new Date().toISOString() }]);
          return json(res);
        }
        if (pathname === '/api/approve') {
          // Bulk approve from the queue's Agent approves lane, only after the key press and a confirm there.
          // Each PR must still be in that lane on the head it was briefed on, or it's left alone.
          const urls: string[] = Array.isArray(body.urls) ? body.urls.map(String) : [];
          if (!urls.length) return json({ error: 'Pick at least one PR.' }, 400);
          const sums = reviewSummaries();
          const done: string[] = [];
          const skipped: { url: string; why: string }[] = [];
          for (const url of urls) {
            const pr = cachedPR(url);
            const s = sums[url];
            if (!pr) skipped.push({ url, why: 'not in the queue' });
            else if (s?.lane !== 'approve') skipped.push({ url, why: 'not in the Agent approves lane' });
            else if (s.headSha !== pr.headSha) skipped.push({ url, why: 'new commits since the brief' });
            else if (pr.author === (await me())) skipped.push({ url, why: 'your own PR' });
            else {
              try {
                await submitReview(url, reviewPayload('APPROVE', '', [], pr.headSha));
                recordOutcome(url, pr.headSha, 'APPROVE', 0);
                saveReviewed([{ pr: { ...pr, myReview: 'APPROVED' }, review: 'APPROVED', at: new Date().toISOString() }]);
                done.push(url);
              } catch (e) {
                skipped.push({ url, why: (e as Error).message });
              }
            }
          }
          return json({ done, skipped });
        }
        if (pathname === '/api/chat') {
          if (!/^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+$/.test(body.url)) return json({ error: 'not a PR URL' }, 400);
          if (body.stop) stop(body.url);
          else if (body.reset) await reset(body.url);
          else if (String(body.text ?? '').trim()) await ask(body.url, String(body.text).trim());
          return json(chatState(body.url));
        }
        if (pathname === '/api/action') {
          const action = (await loadActions()).find((a) => a.key === body.key);
          const pr = cachedPR(body.url);
          if (!action || !pr) return json({ error: 'unknown action or PR' }, 400);
          return json(await startAction(action, pr));
        }
      }
      // /pr/<owner>/<repo>/<number> is the in-app PR page; the page reads the rest from the URL.
      const page = pathname === '/' ? 'index.html' : pathname === '/mine' ? 'mine.html' : pathname === '/board' ? 'board.html' : pathname === '/today' ? 'today.html' : pathname === '/calibration' ? 'calibration.html' : /^\/pr\/[^/]+\/[^/]+\/\d+$/.test(pathname) ? 'pr.html' : pathname.replace(/^\/+/, '');
      const file = Bun.file(join(PUBLIC, page));
      if (!file.name!.startsWith(PUBLIC) || !(await file.exists())) return new Response('not found', { status: 404 });
      return new Response(file);
    } catch (e) {
      return json({ error: (e as Error).message }, 500);
    }
  },
});

console.log(`gh-review on http://localhost:${server.port}`);
if (configFile() === EXAMPLE) console.log(`No ${CONFIG}, so this runs on config.example.json. Copy it there and add your repos.`);
