// Adds a "Mark tests viewed" button to PR Files changed pages. It marks every
// test file in the PR as Viewed through the GitHub API (the new diff view only
// renders the files on screen, so clicking checkboxes can't reach them all),
// then reloads so GitHub's own Viewed boxes and counter catch up.
// Also adds a second +/- total (lines outside test files) next to GitHub's
// PR total, using counts from the same API call.
(function () {
  'use strict';

  var GSI = self.GSI;
  var PAGE = /^\/([^/]+)\/([^/]+)\/pull\/(\d+)\/(files|changes)(\/|$)/;
  var PROGRESS = /^\s*\d+\s*\/\s*\d+\s*(files\s+)?viewed\s*$/i;

  var btn = null;
  var prKey = null;
  var state = { phase: 'idle' }; // idle | loading | ready | busy | done | error
  var lastProgress = null;
  var refetchTimer = null;
  var tickTimer = null;
  var stats = null; // { list: [{ path, additions, deletions }] } for the current PR

  function currentPR() {
    var m = PAGE.exec(location.pathname);
    return m ? { owner: m[1], repo: m[2], number: parseInt(m[3], 10) } : null;
  }

  function send(msg) {
    return chrome.runtime.sendMessage(msg).catch(function () {
      return { error: { code: 'disconnected', message: 'Extension was reloaded. Refresh the page.' } };
    });
  }

  // GitHub's "0 / 36 viewed" (new UI) or "0 / 36 files viewed" (classic UI).
  // Returns the outermost element whose whole text is that counter.
  function findProgress() {
    var hits = document.evaluate(
      '//*[not(self::script)][contains(text(), "viewed")]',
      document.body, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
    for (var i = 0; i < hits.snapshotLength; i++) {
      var el = hits.snapshotItem(i);
      if (btn && btn.contains(el)) continue;
      var best = null;
      for (var up = 0; el && el !== document.body && up < 6; up++, el = el.parentElement) {
        if (btn && el.contains(btn)) break;
        if (PROGRESS.test(el.textContent)) best = el;
        else if (best) break;
      }
      if (best && best.getClientRects().length) return best;
    }
    return null;
  }

  // GitHub draws a progress ring just before the "x / y viewed" text. Put the
  // button before that ring so the two stay together.
  function insertionPoint(anchor) {
    var prev = anchor.previousElementSibling;
    var isRing = prev && prev !== btn && !prev.textContent.trim() &&
      (prev.matches('svg, [role="progressbar"]') || prev.querySelector('svg, [role="progressbar"]'));
    return isRing ? prev : anchor;
  }

  // Octicons (16px), so the button looks like the rest of GitHub's toolbar.
  var ICONS = {
    beaker: 'M5 5.782V2.5h-.25a.75.75 0 0 1 0-1.5h6.5a.75.75 0 0 1 0 1.5H11v3.282l3.666 5.76C15.619 13.04 14.543 15 12.767 15H3.233c-1.776 0-2.852-1.96-1.899-3.458Zm-2.4 6.565a.75.75 0 0 0 .633 1.153h9.534a.75.75 0 0 0 .633-1.153L12.225 10.5h-8.45ZM9.5 2.5h-3V6c0 .143-.04.283-.117.403L4.73 9h6.54L9.617 6.403A.746.746 0 0 1 9.5 6Z',
    check: 'M8 16A8 8 0 1 1 8 0a8 8 0 0 1 0 16Zm3.78-9.72a.751.751 0 0 0-.018-1.042.751.751 0 0 0-1.042-.018L6.75 9.19 5.28 7.72a.751.751 0 0 0-1.042.018.751.751 0 0 0-.018 1.042l2 2a.75.75 0 0 0 1.06 0Z',
    alert: 'M6.457 1.047c.659-1.234 2.427-1.234 3.086 0l6.082 11.378A1.75 1.75 0 0 1 14.082 15H1.918a1.75 1.75 0 0 1-1.543-2.575Zm1.763.707a.25.25 0 0 0-.44 0L1.698 13.132a.25.25 0 0 0 .22.368h12.164a.25.25 0 0 0 .22-.368Zm.53 3.996v2.5a.75.75 0 0 1-1.5 0v-2.5a.75.75 0 0 1 1.5 0ZM9 11a1 1 0 1 1-2 0 1 1 0 0 1 2 0Z'
  };
  var SVG_NS = 'http://www.w3.org/2000/svg';

  function icon(name) {
    if (name === 'spinner') {
      var spin = document.createElement('span');
      spin.className = 'gsi-mt-spinner';
      return spin;
    }
    var svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('width', '16');
    svg.setAttribute('height', '16');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('class', 'gsi-mt-icon gsi-mt-icon--' + name);
    var path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', ICONS[name]);
    svg.appendChild(path);
    return svg;
  }

  function ensureButton() {
    if (btn) return btn;
    btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'gsi-mark-tests';
    btn.addEventListener('click', onClick);
    return btn;
  }

  function place() {
    var b = ensureButton();
    var anchor = findProgress();
    if (anchor) {
      var at = insertionPoint(anchor);
      if (b.nextSibling !== at) at.parentNode.insertBefore(b, at);
      b.classList.remove('gsi-mark-tests--floating');
      var text = anchor.textContent.trim();
      if (lastProgress !== null && text !== lastProgress && state.phase === 'ready') scheduleRefetch();
      lastProgress = text;
    } else if (!b.isConnected) {
      // Header not found (GitHub changed its markup, or it hasn't rendered yet).
      b.classList.add('gsi-mark-tests--floating');
      document.body.appendChild(b);
    }
  }

  // look: 'action' is a real button; 'quiet' is plain status text in the toolbar.
  function draw(look, iconName, label, count, opts) {
    opts = opts || {};
    btn.className = 'gsi-mark-tests gsi-mark-tests--' + look +
      (opts.tone ? ' gsi-mark-tests--' + opts.tone : '') +
      (btn.classList.contains('gsi-mark-tests--floating') ? ' gsi-mark-tests--floating' : '');
    btn.disabled = !!opts.disabled;
    btn.hidden = !!opts.hidden;
    btn.title = opts.title || '';
    btn.textContent = '';
    if (iconName) btn.appendChild(icon(iconName));
    var text = document.createElement('span');
    text.textContent = label;
    btn.appendChild(text);
    if (count != null) {
      var c = document.createElement('span');
      c.className = 'gsi-mt-count';
      c.textContent = String(count);
      btn.appendChild(c);
    }
  }

  function render() {
    if (!btn) return;
    var s = state;
    switch (s.phase) {
      case 'loading':
        draw('quiet', 'spinner', 'Checking tests', null, { disabled: true });
        break;
      case 'busy':
        draw('action', 'spinner', 'Marking tests viewed', s.count, { disabled: true });
        break;
      case 'done':
        draw('quiet', 'check', 'Marked ' + s.marked + ' viewed, reloading', null, { disabled: true, tone: 'success' });
        break;
      case 'error':
        var auth = s.error.code === 'no-token' || s.error.code === 'bad-token';
        draw('action', 'alert', auth ? 'Add token to mark tests' : 'Retry marking tests', null,
          { tone: 'danger', title: s.error.message || '' });
        break;
      case 'ready':
        if (!s.total) {
          draw('quiet', null, '', null, { hidden: true, disabled: true });
        } else if (!s.unviewed.length) {
          draw('quiet', 'check', s.total === 1 ? 'Test viewed' : 'All ' + s.total + ' tests viewed', null,
            { disabled: true, tone: 'success' });
        } else {
          draw('action', 'beaker', 'Mark tests viewed', s.unviewed.length, {
            title: 'Marks these as Viewed:\n' + s.unviewed.slice(0, 25).join('\n') +
              (s.unviewed.length > 25 ? '\n… and ' + (s.unviewed.length - 25) + ' more' : '')
          });
        }
        break;
      default:
        draw('quiet', null, '', null, { hidden: true, disabled: true });
    }
  }

  async function load() {
    var pr = currentPR();
    if (!pr) return;
    var key = GSI.cacheKey(pr);
    state = { phase: 'loading' };
    render();
    var resp = await send({ type: 'getPrTests', pr: pr });
    if (prKey !== key) return; // navigated away meanwhile
    if (resp && !resp.error && resp.stats) {
      stats = { list: resp.stats };
      placeTotal();
    }
    state = !resp || resp.error
      ? { phase: 'error', error: (resp && resp.error) || { code: 'unknown', message: 'No response from the extension' } }
      : { phase: 'ready', total: resp.total, unviewed: resp.unviewed };
    render();
  }

  // --- Second +/- total next to GitHub's PR total --------------------------

  // Which files the extra total counts. 'noTests' = everything but test files.
  var TOTAL_MODE = 'noTests';
  var TOTALS = {
    noTests: { label: 'w/o tests', title: 'Lines changed outside test files', keep: function (f) { return !GSI.isTestPath(f.path); } }
  };
  var PLUS = /^\+\s*[\d,]+$/;
  var MINUS = /^[-\u2212\u2013]\s*[\d,]+$/;
  var totalEl = null;

  function fmt(n) { return n.toLocaleString('en-US'); }

  // GitHub's "+3,726 -53" next to the tabs: the first element in the page whose
  // text is "+N" and whose next sibling is "-N".
  function findPrTotal() {
    var hits = document.evaluate('//*[not(self::script)][starts-with(normalize-space(text()), "+")]',
      document.body, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
    for (var i = 0; i < hits.snapshotLength; i++) {
      var el = hits.snapshotItem(i);
      if (el.closest('.gsi-total') || !PLUS.test(el.textContent.trim())) continue;
      var next = el.nextElementSibling;
      if (next && MINUS.test(next.textContent.trim()) && el.getClientRects().length) return el;
    }
    return null;
  }

  function placeTotal() {
    if (!stats) {
      if (totalEl && totalEl.isConnected) totalEl.remove();
      return;
    }
    var plus = findPrTotal();
    if (!plus) return;
    var mode = TOTALS[TOTAL_MODE];
    var add = 0;
    var del = 0;
    stats.list.forEach(function (f) {
      if (mode.keep(f)) { add += f.additions; del += f.deletions; }
    });
    if (!totalEl) {
      totalEl = document.createElement('span');
      totalEl.className = 'gsi-total';
      ['gsi-total-label', 'gsi-total-add', 'gsi-total-del'].forEach(function (c) {
        var part = document.createElement('span');
        part.className = c;
        totalEl.appendChild(part);
      });
    }
    var key = TOTAL_MODE + ':' + add + '/' + del;
    if (totalEl.dataset.key !== key) {
      totalEl.dataset.key = key;
      totalEl.title = mode.title;
      totalEl.children[0].textContent = mode.label;
      totalEl.children[1].textContent = '+' + fmt(add);
      totalEl.children[2].textContent = '\u2212' + fmt(del);
    }
    if (totalEl.nextSibling !== plus) plus.parentNode.insertBefore(totalEl, plus);
  }

  function scheduleRefetch() {
    clearTimeout(refetchTimer);
    refetchTimer = setTimeout(load, 1500);
  }

  async function onClick() {
    if (state.phase === 'error' && (state.error.code === 'no-token' || state.error.code === 'bad-token')) {
      send({ type: 'openOptions' });
      return;
    }
    if (state.phase === 'error') {
      load();
      return;
    }
    if (state.phase !== 'ready' || !state.unviewed.length) return;
    var pr = currentPR();
    state = { phase: 'busy', count: state.unviewed.length };
    render();
    var resp = await send({ type: 'markTestsViewed', pr: pr });
    if (!resp || resp.error) {
      state = { phase: 'error', error: (resp && resp.error) || { code: 'unknown', message: 'No response from the extension' } };
      render();
      return;
    }
    state = { phase: 'done', marked: resp.marked };
    render();
    setTimeout(function () { location.reload(); }, 600);
  }

  function tick() {
    tickTimer = null;
    var pr = currentPR();
    if (!pr) {
      if (btn && btn.isConnected) btn.remove();
      prKey = null;
      stats = null;
      placeTotal();
      return;
    }
    var key = GSI.cacheKey(pr);
    place();
    if (key !== prKey) {
      prKey = key;
      lastProgress = null;
      stats = null;
      load();
    }
    placeTotal();
  }

  function schedule() {
    if (!tickTimer) tickTimer = setTimeout(tick, 250);
  }

  // GitHub's PR view is a React app with client-side routing, so watch the DOM
  // for both navigation and our button being wiped by a re-render.
  new MutationObserver(function () {
    if (currentPR() || (btn && btn.isConnected)) schedule();
  }).observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  window.addEventListener('popstate', schedule);
  document.addEventListener('turbo:load', schedule);
  document.addEventListener('pjax:end', schedule);
  schedule();
})();
