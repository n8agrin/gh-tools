// Shared by the service worker (via importScripts) and the content script.
// Pure functions only: no DOM access and no chrome.* calls.
(function (root) {
  'use strict';

  var OPINIONATED = { APPROVED: true, CHANGES_REQUESTED: true, DISMISSED: true };

  function cacheKey(pr) {
    return 'pr:' + String(pr.owner).toLowerCase() + '/' + String(pr.repo).toLowerCase() + '#' + pr.number;
  }

  // Boil a GraphQL pullRequest node down to what classify() needs. Keeps the
  // cache small and keeps other reviewers' data out of it.
  function summarizePR(node, login) {
    var reviews = (node.myReviews && node.myReviews.nodes) || [];
    var requests = (node.reviewRequests && node.reviewRequests.nodes) || [];
    return {
      number: node.number,
      state: node.state,
      isDraft: !!node.isDraft,
      merged: !!node.merged,
      mergedAt: node.mergedAt || null,
      myReviews: reviews
        .filter(function (r) { return r && r.submittedAt; })
        .map(function (r) { return { state: r.state, submittedAt: r.submittedAt }; }),
      reviewRequestedFromMe: requests.some(function (r) {
        var who = r && r.requestedReviewer;
        return !!who && who.__typename === 'User' && who.login === login;
      })
    };
  }

  // The viewer's standing review. The latest approve / request-changes /
  // dismissal wins; a plain comment only counts when nothing else exists.
  function myLatestReview(reviews) {
    var sorted = reviews.slice().sort(function (a, b) {
      return a.submittedAt < b.submittedAt ? -1 : a.submittedAt > b.submittedAt ? 1 : 0;
    });
    var result = { state: 'NONE', at: null };
    var commentedAt = null;
    sorted.forEach(function (r) {
      if (OPINIONATED[r.state]) result = { state: r.state, at: r.submittedAt };
      else if (r.state === 'COMMENTED') commentedAt = r.submittedAt;
    });
    if (result.state === 'NONE' && commentedAt) result = { state: 'COMMENTED', at: commentedAt };
    return result;
  }

  // Returns { kind, label, tone, qualifies }. `qualifies` is true only when the
  // PR merged after the viewer's own approval and that approval still stands.
  function classify(pr) {
    var mine = myLatestReview(pr.myReviews || []);
    var phase = pr.merged ? 'merged' : pr.state === 'CLOSED' ? 'closed' : pr.isDraft ? 'draft' : 'open';
    var Phase = phase.charAt(0).toUpperCase() + phase.slice(1);
    var out = { kind: phase + '-' + mine.state.toLowerCase(), label: '', tone: 'muted', qualifies: false };

    if (phase === 'merged') {
      if (mine.state === 'APPROVED') {
        if (!pr.mergedAt || mine.at <= pr.mergedAt) {
          out.label = 'Merged · you approved';
          out.tone = 'done';
          out.qualifies = true;
        } else {
          out.label = 'Merged · you approved after the merge';
          out.kind = 'merged-approved-late';
        }
      } else if (mine.state === 'CHANGES_REQUESTED') {
        out.label = 'Merged · you requested changes';
        out.tone = 'danger';
      } else if (mine.state === 'DISMISSED') {
        out.label = 'Merged · your review was dismissed';
      } else if (mine.state === 'COMMENTED') {
        out.label = 'Merged · you commented, never approved';
      } else {
        out.label = 'Merged · no review from you';
      }
    } else if (phase === 'closed') {
      if (mine.state === 'APPROVED') out.label = 'Closed · you approved';
      else if (mine.state === 'CHANGES_REQUESTED') out.label = 'Closed · you requested changes';
      else if (mine.state === 'DISMISSED') out.label = 'Closed · your review was dismissed';
      else if (mine.state === 'COMMENTED') out.label = 'Closed · you commented, never approved';
      else out.label = 'Closed · no review from you';
    } else {
      if (mine.state === 'APPROVED' && pr.reviewRequestedFromMe) {
        out.label = Phase + ' · re-review requested';
        out.tone = 'attention';
        out.kind = phase + '-rereview';
      } else if (mine.state === 'APPROVED') {
        out.label = Phase + ' · you approved';
        out.tone = 'success';
      } else if (mine.state === 'CHANGES_REQUESTED') {
        out.label = Phase + ' · you requested changes';
        out.tone = 'danger';
      } else if (mine.state === 'DISMISSED') {
        out.label = Phase + ' · your review was dismissed';
        out.tone = 'attention';
      } else if (mine.state === 'COMMENTED') {
        out.label = Phase + ' · you commented, no approval yet';
        out.tone = 'attention';
      } else {
        out.label = Phase + ' · awaiting your review';
        out.tone = 'attention';
      }
    }
    return out;
  }

  // Test files: anything under a test-ish folder (tests/, __tests__/,
  // playwright-tests/, route-tests/, e2e/, ...) or with a test-ish file name
  // (foo.test.ts, foo.spec.js, foo_test.go, test_foo.py, FooTest.java, .snap).
  var TEST_DIR = /(^|[-_.])(tests?|testing|testdata|__tests__|specs?|e2e|__mocks__|__snapshots__|__fixtures__|cypress)([-_.]|$)/i;
  var TEST_FILES = [
    /(^|[._-])(tests?|specs?|e2e|cy)\.[^/]+$/i,
    /^test_[^/]*\.py$/i,
    /[A-Za-z0-9](Test|Tests|Spec|IT)\.(java|kt|kts|scala|cs|swift|groovy)$/,
    /\.snap$/i
  ];

  function isTestPath(path) {
    var parts = String(path || '').split('/');
    var name = parts.pop();
    if (parts.some(function (dir) { return TEST_DIR.test(dir); })) return true;
    return TEST_FILES.some(function (re) { return re.test(name); });
  }

  root.GSI = {
    cacheKey: cacheKey,
    summarizePR: summarizePR,
    myLatestReview: myLatestReview,
    classify: classify,
    isTestPath: isTestPath
  };
})(typeof self !== 'undefined' ? self : this);
