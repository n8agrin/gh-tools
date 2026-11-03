// Adds a "Mark tests viewed" button to PR Files changed pages. It marks every
// test file in the PR as Viewed through the GitHub API (the new diff view only
// renders the files on screen, so clicking checkboxes can't reach them all),
// then reloads so GitHub's own Viewed boxes and counter catch up.
// Also shows each file's +additions / -deletions in the file tree sidebar,
// using counts from the same API call.
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
  var stats = null; // { byHash, byPath, list } for the current PR

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
      var built = await buildStats(resp.stats);
      if (prKey !== key) return;
      stats = built;
      decorateTree();
    }
    state = !resp || resp.error
      ? { phase: 'error', error: (resp && resp.error) || { code: 'unknown', message: 'No response from the extension' } }
      : { phase: 'ready', total: resp.total, unviewed: resp.unviewed };
    render();
  }

  // --- Line counts in the file tree --------------------------------------

  async function sha256(text) {
    var buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return Array.from(new Uint8Array(buf), function (b) { return b.toString(16).padStart(2, '0'); }).join('');
  }

  // GitHub links each tree entry to "#diff-<sha256 of the path>", so the hash
  // is the most reliable way to tie a tree row to its file.
  async function buildStats(list) {
    var byHash = {};
    var byPath = {};
    await Promise.all(list.map(async function (f) {
      byPath[f.path] = f;
      try { byHash[await sha256(f.path)] = f; } catch (e) { /* fall back to paths */ }
    }));
    return { byHash: byHash, byPath: byPath, list: list };
  }

  function isDirectory(li) {
    return li.getAttribute('data-tree-entry-type') === 'directory' ||
      li.hasAttribute('aria-expanded') || !!li.querySelector('[role="group"], [aria-expanded]');
  }

  // The element holding a tree row's own name: the first visible text in the
  // row (skipping nested rows, hidden text and our badge), widened to the
  // outermost wrapper that holds only that name.
  function ownLabel(li) {
    var walker = document.createTreeWalker(li, NodeFilter.SHOW_TEXT, {
      acceptNode: function (node) {
        if (!node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
        var el = node.parentElement;
        if (el.closest('[hidden], .gsi-lines, .sr-only, [class*="VisuallyHidden"]')) return NodeFilter.FILTER_REJECT;
        var group = el.closest('[role="group"]');
        if (group && li.contains(group)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    var node = walker.nextNode();
    if (!node) return null;
    var text = node.nodeValue.trim();
    var el = node.parentElement;
    while (el.parentElement && el.parentElement !== li && el.parentElement.textContent.trim() === text) {
      el = el.parentElement;
    }
    return { el: el, text: text };
  }

  function statFor(li) {
    var ids = [li.id].concat(Array.from(li.querySelectorAll('[href*="diff-"], [id*="diff-"]'), function (el) {
      return (el.getAttribute('href') || '') + ' ' + el.id;
    }));
    for (var i = 0; i < ids.length; i++) {
      var m = /diff-([0-9a-f]{64})/.exec(ids[i] || '');
      if (m && stats.byHash[m[1]]) return stats.byHash[m[1]];
    }
    if (li.id && stats.byPath[li.id]) return stats.byPath[li.id];
    var hidden = li.querySelector('[data-filterable-item-text]');
    if (hidden && stats.byPath[hidden.textContent.trim()]) return stats.byPath[hidden.textContent.trim()];

    // Last resort: rebuild the path from the folder rows above this one.
    var own = ownLabel(li);
    if (!own) return null;
    var parts = [own.text];
    for (var up = li.parentElement && li.parentElement.closest('[role="treeitem"]'); up;
      up = up.parentElement && up.parentElement.closest('[role="treeitem"]')) {
      var dir = ownLabel(up);
      if (dir) parts.unshift(dir.text);
    }
    var full = parts.join('/');
    if (stats.byPath[full]) return stats.byPath[full];
    var hits = stats.list.filter(function (f) { return f.path === full || f.path.endsWith('/' + full); });
    return hits.length === 1 ? hits[0] : null;
  }

  function makeBadge() {
    var badge = document.createElement('span');
    badge.className = 'gsi-lines';
    var add = document.createElement('span');
    add.className = 'gsi-lines-add';
    var del = document.createElement('span');
    del.className = 'gsi-lines-del';
    badge.appendChild(add);
    badge.appendChild(del);
    return badge;
  }

  function decorateTree() {
    var items = document.querySelectorAll('[role="tree"] [role="treeitem"]');
    for (var i = 0; i < items.length; i++) {
      var li = items[i];
      var badge = li.querySelector('.gsi-lines');
      if (badge && badge.closest('[role="treeitem"]') !== li) badge = null;
      var stat = stats && !isDirectory(li) ? statFor(li) : null;
      if (!stat) {
        if (badge) badge.remove();
        continue;
      }
      var key = stat.additions + '/' + stat.deletions;
      if (badge && badge.dataset.key === key) continue;
      if (!badge) {
        var own = ownLabel(li);
        if (!own) continue;
        badge = makeBadge();
        own.el.insertAdjacentElement('afterend', badge);
      }
      badge.dataset.key = key;
      badge.title = stat.additions + ' added, ' + stat.deletions + ' removed';
      badge.firstChild.textContent = '+' + stat.additions;
      badge.lastChild.textContent = '\u2212' + stat.deletions;
      badge.firstChild.hidden = !stat.additions && !!stat.deletions;
      badge.lastChild.hidden = !stat.deletions && !!stat.additions;
    }
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
    decorateTree();
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
