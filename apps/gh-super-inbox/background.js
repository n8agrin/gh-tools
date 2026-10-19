// Service worker: owns the token, talks to the GitHub GraphQL API, caches results.
importScripts('shared.js');

var GRAPHQL_URL = 'https://api.github.com/graphql';
var CACHE_PREFIX = 'pr:';
var CHUNK_SIZE = 50;
var NAME_RE = /^[A-Za-z0-9_.-]+$/;
var TTL_MS = {
  merged: 7 * 24 * 60 * 60 * 1000,
  closed: 60 * 60 * 1000,
  open: 2 * 60 * 1000
};
var PRUNE_EVERY_MS = 60 * 60 * 1000;

// Each PR is fetched with only the viewer's own reviews, so the cache never
// holds anyone else's review data.
var PR_FRAGMENT =
  'fragment PR on PullRequest { number state isDraft merged mergedAt ' +
  'reviewRequests(first: 100) { nodes { requestedReviewer { __typename ... on User { login } } } } ' +
  'myReviews: reviews(author: $login, last: 50) { nodes { state submittedAt } } }';

function GSIError(code, message) {
  this.code = code;
  this.message = message;
}

chrome.action.onClicked.addListener(function () {
  chrome.runtime.openOptionsPage();
});

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  handle(msg).then(sendResponse, function (err) {
    sendResponse({ error: { code: err.code || 'unknown', message: err.message || String(err) } });
  });
  return true;
});

async function handle(msg) {
  switch (msg && msg.type) {
    case 'getStatuses':
      return getStatuses(msg.prs || [], !!msg.force);
    case 'verifyToken':
      return verifyToken(msg.token);
    case 'clearCache':
      await clearCache();
      return { ok: true };
    case 'openOptions':
      await chrome.runtime.openOptionsPage();
      return { ok: true };
    default:
      throw new GSIError('bad-message', 'Unknown message type');
  }
}

async function getToken() {
  var stored = await chrome.storage.local.get('token');
  return (stored.token || '').trim();
}

async function getLogin(token) {
  var stored = await chrome.storage.local.get('viewerLogin');
  if (stored.viewerLogin) return stored.viewerLogin;
  var login = await fetchLogin(token);
  await chrome.storage.local.set({ viewerLogin: login });
  return login;
}

async function fetchLogin(token) {
  var result = await graphql(token, 'query { viewer { login } }', {});
  if (!result.data.viewer) throw new GSIError('graphql', 'Could not read the viewer login');
  return result.data.viewer.login;
}

async function verifyToken(token) {
  token = (token || '').trim();
  if (!token) throw new GSIError('no-token', 'No token given');
  return { login: await fetchLogin(token) };
}

async function graphql(token, query, variables) {
  var res;
  try {
    res = await fetch(GRAPHQL_URL, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + token,
        'Content-Type': 'application/json',
        Accept: 'application/json'
      },
      body: JSON.stringify({ query: query, variables: variables })
    });
  } catch (e) {
    throw new GSIError('network', 'Could not reach api.github.com: ' + e.message);
  }

  if (res.status === 401) throw new GSIError('bad-token', 'GitHub rejected the token (401)');
  if (res.status === 403 || res.status === 429) {
    var detail = '';
    try { detail = (await res.json()).message || ''; } catch (e) { /* no body */ }
    if (res.headers.get('x-ratelimit-remaining') === '0' || res.status === 429) {
      throw new GSIError('rate-limited', 'GitHub rate limit hit. ' + detail);
    }
    throw new GSIError('forbidden', detail || 'GitHub returned 403');
  }
  if (!res.ok) throw new GSIError('http', 'GitHub API returned ' + res.status);

  var json = await res.json();
  var errors = json.errors || [];
  var rateLimited = errors.find(function (e) { return e.type === 'RATE_LIMITED'; });
  if (rateLimited) throw new GSIError('rate-limited', rateLimited.message);
  if (!json.data) throw new GSIError('graphql', errors.length ? errors[0].message : 'Empty response from GitHub');
  // Partial errors (a repo this token can't see, SAML, etc.) leave nulls in
  // data. Callers mark those PRs unavailable and surface the first message.
  return { data: json.data, warning: errors.length ? errors[0].message : null };
}

function validPR(pr) {
  return !!pr && NAME_RE.test(String(pr.owner)) && NAME_RE.test(String(pr.repo)) &&
    Number.isInteger(pr.number) && pr.number > 0;
}

function ttlFor(pr) {
  if (pr.merged) return TTL_MS.merged;
  if (pr.state === 'CLOSED') return TTL_MS.closed;
  return TTL_MS.open;
}

async function getStatuses(prs, force) {
  var token = await getToken();
  if (!token) throw new GSIError('no-token', 'No GitHub token set');
  var login = await getLogin(token);

  var seen = {};
  var wanted = prs.filter(function (pr) {
    if (!validPR(pr)) return false;
    var key = GSI.cacheKey(pr);
    if (seen[key]) return false;
    seen[key] = true;
    return true;
  });

  var now = Date.now();
  var results = {};
  var missing = [];
  var cached = force || !wanted.length ? {} : await chrome.storage.local.get(wanted.map(GSI.cacheKey));
  wanted.forEach(function (pr) {
    var key = GSI.cacheKey(pr);
    var hit = cached[key];
    if (hit && hit.login === login && hit.expiresAt > now) results[key] = hit.pr;
    else missing.push(pr);
  });

  var warning = null;
  for (var i = 0; i < missing.length; i += CHUNK_SIZE) {
    var fetched = await fetchChunk(token, login, missing.slice(i, i + CHUNK_SIZE));
    if (fetched.warning && !warning) warning = fetched.warning;
    var toStore = {};
    Object.keys(fetched.byKey).forEach(function (key) {
      var pr = fetched.byKey[key];
      results[key] = pr;
      if (!pr.unavailable) toStore[key] = { pr: pr, login: login, expiresAt: now + ttlFor(pr) };
    });
    if (Object.keys(toStore).length) await chrome.storage.local.set(toStore);
  }

  pruneExpired().catch(function () { /* best effort */ });
  return { login: login, results: results, warning: warning };
}

async function fetchChunk(token, login, prs) {
  var groups = {};
  prs.forEach(function (pr) {
    var k = pr.owner + '/' + pr.repo;
    if (!groups[k]) groups[k] = { owner: pr.owner, repo: pr.repo, numbers: [] };
    groups[k].numbers.push(pr.number);
  });

  var parts = [];
  var aliases = [];
  Object.keys(groups).forEach(function (k, i) {
    var g = groups[k];
    var alias = 'r' + i;
    var fields = g.numbers.map(function (n) {
      return 'p' + n + ': pullRequest(number: ' + n + ') { ...PR }';
    }).join(' ');
    parts.push(alias + ': repository(owner: ' + JSON.stringify(g.owner) + ', name: ' + JSON.stringify(g.repo) + ') { ' + fields + ' }');
    aliases.push({ alias: alias, owner: g.owner, repo: g.repo, numbers: g.numbers });
  });

  var query = 'query($login: String!) { ' + parts.join(' ') + ' } ' + PR_FRAGMENT;
  var result = await graphql(token, query, { login: login });

  var byKey = {};
  aliases.forEach(function (g) {
    var repo = result.data[g.alias];
    g.numbers.forEach(function (n) {
      var node = repo && repo['p' + n];
      var key = GSI.cacheKey({ owner: g.owner, repo: g.repo, number: n });
      byKey[key] = node ? GSI.summarizePR(node, login) : { unavailable: true };
    });
  });
  return { byKey: byKey, warning: result.warning };
}

async function clearCache() {
  var all = await chrome.storage.local.get(null);
  var keys = Object.keys(all).filter(function (k) { return k.indexOf(CACHE_PREFIX) === 0; });
  if (keys.length) await chrome.storage.local.remove(keys);
}

// Drops expired entries at most once an hour so the cache doesn't grow forever.
async function pruneExpired() {
  var stored = await chrome.storage.local.get('lastPrune');
  var now = Date.now();
  if (stored.lastPrune && now - stored.lastPrune < PRUNE_EVERY_MS) return;
  await chrome.storage.local.set({ lastPrune: now });
  var all = await chrome.storage.local.get(null);
  var stale = Object.keys(all).filter(function (k) {
    return k.indexOf(CACHE_PREFIX) === 0 && !(all[k] && all[k].expiresAt > now);
  });
  if (stale.length) await chrome.storage.local.remove(stale);
}
