// How often the brief's lane matched what you did with the PR, per lane. A lane earns bulk approve
// once it agrees often enough over enough PRs; the misses are where the prompts need work.
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const LANE = { approve: 'Agent approves', answer: 'Answer questions', read: 'Read it', block: 'Do not merge' };
const OUT = { clean: 'approved clean', commented: 'commented', changes: 'asked for changes' };
const pct = (x) => `${Math.round(x * 100)}%`;
const prPath = (url) => url.replace(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)$/, '/pr/$1/$2');

function draw({ rows, gate }) {
  const lanes = Object.keys(LANE).map((lane) => {
    const rs = rows.filter((r) => r.lane === lane);
    const n = (o) => rs.filter((r) => r.outcome === o).length;
    const agree = rs.length ? rs.filter((r) => r.agrees).length / rs.length : null;
    const earned = lane === 'approve' && rs.length >= gate.prs && agree >= gate.agreement;
    return { lane, total: rs.length, clean: n('clean'), commented: n('commented'), changes: n('changes'), agree, earned };
  });
  const table = `<table class="lanes"><thead><tr><th>Lane called</th><th class="r">PRs</th><th class="r">Approved clean</th><th class="r">Commented</th><th class="r">Changes asked</th><th>Agreement</th></tr></thead><tbody>${lanes
    .filter((l) => l.total || l.lane !== 'block')
    .map(
      (l) =>
        `<tr><td><b>${LANE[l.lane]}</b></td><td class="r">${l.total}</td><td class="r">${l.clean}</td><td class="r">${l.commented}</td><td class="r">${l.changes}</td><td>${l.agree === null ? '<span class="faint">no PRs yet</span>' : pct(l.agree)}${l.lane === 'approve' ? (l.earned ? ' · <span class="ok">bulk approve earned</span>' : ` · <span class="faint">gate ${pct(gate.agreement)} over ${gate.prs}</span>`) : ''}</td></tr>`,
    )
    .join('')}</tbody></table>`;
  const miss = (title, sub, list) =>
    `<section class="miss"><h2>${title}</h2><p class="faint">${sub}</p>${list.length ? list.map((r) => `<a href="${esc(prPath(r.url))}"><span>${esc(r.title)}</span><span class="faint">${esc(LANE[r.lane])} · you ${esc(OUT[r.outcome])}${r.aiLane ? ` · AI said ${esc(LANE[r.aiLane])}` : ''}</span></a>`).join('') : '<p class="faint">None yet.</p>'}</section>`;
  const wrong = rows.filter((r) => (r.lane === 'approve' || r.lane === 'answer') && r.outcome === 'changes');
  const careful = rows.filter((r) => (r.lane === 'read' || r.lane === 'block') && r.outcome === 'clean');
  $('#calib').innerHTML = `<p class="lede">Each brief's lane next to what you did with the PR: your reviews from the PR page and the queue, plus approvals and change requests on GitHub. Reverts aren't tracked yet.</p>${table}<div class="misses">${miss('Where it was wrong', 'Agent approves or Answer questions, and you asked for changes. Each is a prompt fix.', wrong)}${miss('Where it was too careful', 'Read it or Do not merge, and you approved with no comments. Each is a lane that could be lower.', careful)}</div>`;
}

fetch('/api/calibration')
  .then((r) => r.json())
  .then(draw)
  .catch((e) => ($('#calib').textContent = `Couldn't load: ${e.message}`));
