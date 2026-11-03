// Runs on every github.com page but only does anything on /notifications.
// GitHub navigates with Turbo, so the page can change without a reload.
(function () {
  'use strict';

  var GSI = self.GSI;
  var ROW = 'li.notifications-list-item';
  var CHECKBOX = 'input.js-notification-bulk-action-check-item';
  var PR_HREF = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:[/?#]|$)/;

  var scheduled = null;
  var inFlight = 0;
  var lastError = null;

  function onNotificationsPage() {
    return location.pathname === '/notifications' || location.pathname.indexOf('/notifications/') === 0;
  }

  function schedule() {
    if (scheduled) clearTimeout(scheduled);
    scheduled = setTimeout(function () {
      scheduled = null;
      run(false);
    }, 150);
  }

  function checkboxOf(li) {
    return li.querySelector(CHECKBOX);
  }

  async function run(force) {
    if (!onNotificationsPage()) return;

    var targets = [];
    document.querySelectorAll(ROW).forEach(function (li) {
      if (li.dataset.gsi && !force) return;
      var link = li.querySelector('a.js-navigation-open[href]') || li.querySelector('a[href*="/pull/"]');
      var m = link && PR_HREF.exec(link.href);
      if (!m) {
        li.dataset.gsi = 'skip';
        return;
      }
      li.dataset.gsi = 'loading';
      targets.push({ li: li, owner: m[1], repo: m[2], number: parseInt(m[3], 10) });
    });

    if (!targets.length) {
      refreshToolbar();
      return;
    }

    inFlight += 1;
    refreshToolbar();
    var resp;
    try {
      resp = await chrome.runtime.sendMessage({
        type: 'getStatuses',
        force: !!force,
        prs: targets.map(function (t) { return { owner: t.owner, repo: t.repo, number: t.number }; })
      });
    } catch (e) {
      resp = { error: { code: 'disconnected', message: 'Extension was reloaded. Refresh the page.' } };
    }
    inFlight -= 1;

    if (!resp || resp.error) {
      lastError = (resp && resp.error) || { code: 'unknown', message: 'No response from the extension' };
      targets.forEach(function (t) {
        if (!t.li.isConnected) return;
        t.li.dataset.gsi = 'error';
        t.li.classList.remove('gsi-merged-approved');
        setBadge(t.li, errorBadgeLabel(lastError), 'muted', lastError.message);
      });
      refreshToolbar();
      return;
    }

    lastError = resp.warning ? { code: 'partial', message: resp.warning } : null;
    targets.forEach(function (t) {
      if (!t.li.isConnected) return;
      var pr = resp.results[GSI.cacheKey(t)];
      if (!pr || pr.unavailable) {
        t.li.dataset.gsi = 'unavailable';
        t.li.classList.remove('gsi-merged-approved');
        setBadge(t.li, 'PR not readable with this token', 'muted', resp.warning || '');
        return;
      }
      var c = GSI.classify(pr);
      t.li.dataset.gsi = c.kind;
      t.li.classList.toggle('gsi-merged-approved', c.qualifies);
      setBadge(t.li, c.label, c.tone, c.qualifies ? 'Merged after you approved it. Safe to mark done.' : '');
    });
    refreshToolbar();
  }

  function setBadge(li, label, tone, title) {
    var badge = li.querySelector('.gsi-badge');
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'gsi-badge';
      // The right-hand column (time, avatars, reason) sits outside the row's
      // link. It is row-reversed on desktop, so appending puts the badge just
      // left of the "review requested" text.
      var slot = li.querySelector(':scope > div > div.flex-md-row-reverse');
      if (slot) slot.appendChild(badge);
      else (li.querySelector('p.markdown-title') || li).appendChild(badge);
    }
    badge.dataset.tone = tone;
    badge.textContent = label;
    badge.title = title || '';
  }

  function errorBadgeLabel(err) {
    switch (err.code) {
      case 'no-token': return 'Add a GitHub token';
      case 'bad-token': return 'Token rejected';
      case 'rate-limited': return 'Rate limited';
      default: return 'Couldn’t load';
    }
  }

  function errorStatusText(err) {
    switch (err.code) {
      case 'no-token': return 'Add a GitHub token to see PR status.';
      case 'bad-token': return 'GitHub rejected the token. Update it.';
      case 'rate-limited': return 'GitHub rate limit hit. Try again in a bit.';
      case 'network': return 'Couldn’t reach api.github.com.';
      case 'disconnected': return 'Extension reloaded. Refresh the page.';
      case 'partial': return 'Some PRs couldn’t be read: ' + err.message;
      default: return err.message || 'Something went wrong.';
    }
  }

  // --- toolbar -------------------------------------------------------------

  function ensureToolbar() {
    var existing = document.querySelector('.gsi-toolbar');
    if (existing && existing.isConnected) return existing;

    var selectAll = document.querySelector('.js-notifications-list [data-check-all], .notifications-list [data-check-all]');
    var header = selectAll && selectAll.closest('.Box-header');
    if (!header) return null;

    var bar = document.createElement('div');
    bar.className = 'gsi-toolbar';

    var select = document.createElement('button');
    select.type = 'button';
    select.className = 'btn btn-sm gsi-select';
    select.appendChild(document.createTextNode('Select merged with your approval '));
    var counter = document.createElement('span');
    counter.className = 'Counter gsi-count';
    counter.textContent = '0';
    select.appendChild(counter);
    select.disabled = true;
    select.addEventListener('click', toggleSelection);

    var status = document.createElement('span');
    status.className = 'gsi-status';

    var tokenBtn = document.createElement('button');
    tokenBtn.type = 'button';
    tokenBtn.className = 'btn btn-sm btn-primary gsi-token';
    tokenBtn.textContent = 'Add GitHub token';
    tokenBtn.hidden = true;
    tokenBtn.addEventListener('click', function () {
      chrome.runtime.sendMessage({ type: 'openOptions' }).catch(function () {});
    });

    var refresh = document.createElement('button');
    refresh.type = 'button';
    refresh.className = 'btn btn-sm gsi-refresh';
    refresh.textContent = '↻';
    refresh.title = 'Re-check the PRs on this page (ignores the cache)';
    refresh.addEventListener('click', function () {
      lastError = null;
      run(true);
    });

    bar.appendChild(status);
    bar.appendChild(tokenBtn);
    bar.appendChild(select);
    bar.appendChild(refresh);
    header.appendChild(bar);
    return bar;
  }

  function refreshToolbar() {
    var bar = ensureToolbar();
    if (!bar) return;
    var select = bar.querySelector('.gsi-select');
    var counter = bar.querySelector('.gsi-count');
    var status = bar.querySelector('.gsi-status');
    var tokenBtn = bar.querySelector('.gsi-token');

    var qualifying = Array.prototype.slice.call(document.querySelectorAll(ROW + '.gsi-merged-approved'));
    var boxes = qualifying.map(checkboxOf).filter(Boolean);
    var allChecked = boxes.length > 0 && boxes.every(function (cb) { return cb.checked; });

    counter.textContent = String(qualifying.length);
    select.disabled = qualifying.length === 0;
    select.firstChild.textContent = (allChecked ? 'Unselect' : 'Select') + ' merged with your approval ';

    if (inFlight > 0) status.textContent = 'Checking PRs…';
    else if (lastError) status.textContent = errorStatusText(lastError);
    else if (qualifying.length === 0) status.textContent = 'Nothing on this page merged with your approval.';
    else status.textContent = '';
    status.classList.toggle('gsi-status--error', !!lastError && inFlight === 0);

    tokenBtn.hidden = !(lastError && (lastError.code === 'no-token' || lastError.code === 'bad-token'));
  }

  // Clicks the real GitHub checkboxes so GitHub's own bulk-action bar
  // (Done, Unsubscribe, ...) lights up exactly as if you ticked them by hand.
  function toggleSelection() {
    var qualifying = Array.prototype.slice.call(document.querySelectorAll(ROW + '.gsi-merged-approved'));
    var boxes = qualifying.map(checkboxOf).filter(Boolean);
    var allChecked = boxes.length > 0 && boxes.every(function (cb) { return cb.checked; });
    boxes.forEach(function (cb) {
      if (cb.checked === allChecked) cb.click();
    });
    refreshToolbar();
  }

  // --- wiring --------------------------------------------------------------

  document.addEventListener('turbo:load', schedule);
  document.addEventListener('turbo:render', schedule);
  document.addEventListener('pjax:end', schedule);

  document.addEventListener('change', function (e) {
    var t = e.target;
    if (t && t.matches && (t.matches(CHECKBOX) || t.matches('[data-check-all]'))) {
      setTimeout(refreshToolbar, 0);
    }
  }, true);

  var observer = new MutationObserver(function (records) {
    for (var i = 0; i < records.length; i++) {
      var added = records[i].addedNodes;
      for (var j = 0; j < added.length; j++) {
        var n = added[j];
        if (n.nodeType !== 1) continue;
        if (n.matches(ROW) || n.matches('.js-notifications-list') || n.querySelector(ROW)) {
          schedule();
          return;
        }
      }
    }
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });

  schedule();
})();
