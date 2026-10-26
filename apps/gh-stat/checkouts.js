// Which branch each local checkout is on. Read-only: GIT_OPTIONAL_LOCKS=0 keeps
// `git status` from taking the index lock, so it can't trip up work in that checkout.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const ROOT = process.env.GH_STAT_CHECKOUTS_DIR || path.join(os.homedir(), 'src');
const PREFIX = process.env.GH_STAT_CHECKOUTS_PREFIX || '';

function git(dir, args) {
  return new Promise((resolve) => {
    execFile('git', ['-C', dir, ...args], { env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }, timeout: 10000 },
      (err, stdout) => resolve(err ? null : stdout.trim()));
  });
}

// "git@github.com:owner/repo.git" or "https://github.com/owner/repo" -> "owner/repo"
function repoName(url) {
  const m = url && url.match(/github\.com[:/](.+?)(?:\.git)?$/);
  return m ? m[1] : null;
}

async function readCheckout(name) {
  const dir = path.join(ROOT, name);
  const [status, lastCommit, remote] = await Promise.all([
    git(dir, ['status', '--porcelain=v2', '--branch']),
    git(dir, ['log', '-1', '--format=%ct%x09%s']),
    git(dir, ['remote', 'get-url', 'origin']),
  ]);
  if (status == null) return { name, error: 'not a git checkout' };
  const out = { name, branch: null, sha: null, ahead: 0, behind: 0, upstream: null, changes: 0, repo: repoName(remote) };
  for (const line of status.split('\n')) {
    if (line.startsWith('# branch.oid ')) out.sha = line.slice(13, 20);
    else if (line.startsWith('# branch.head ')) out.branch = line.slice(14) === '(detached)' ? null : line.slice(14);
    else if (line.startsWith('# branch.upstream ')) out.upstream = line.slice(18);
    else if (line.startsWith('# branch.ab ')) {
      const [a, b] = line.slice(12).split(' ');
      out.ahead = Math.abs(Number(a));
      out.behind = Math.abs(Number(b));
    } else if (line && !line.startsWith('#')) out.changes++;
  }
  if (lastCommit) {
    const [ts, ...subject] = lastCommit.split('\t');
    out.committedAt = new Date(Number(ts) * 1000).toISOString();
    out.subject = subject.join('\t');
  }
  return out;
}

async function readCheckouts() {
  let names;
  try {
    names = fs.readdirSync(ROOT, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name.startsWith(PREFIX))
      .map((d) => d.name)
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  } catch {
    return [];
  }
  return Promise.all(names.map(readCheckout));
}

// Git rewrites HEAD on checkout, the index on add/reset, and refs on commit/fetch/push,
// so watching those catches branch changes without touching the working tree.
const GIT_EVENT = /^(HEAD|index|packed-refs|FETCH_HEAD)$|^refs[\\/]/;

function watchCheckouts(onChange) {
  let watchers = [];
  let timer = null;
  const fire = () => {
    clearTimeout(timer);
    timer = setTimeout(onChange, 300);
  };
  const setup = () => {
    for (const w of watchers) w.close();
    watchers = [];
    let names = [];
    try {
      names = fs.readdirSync(ROOT, { withFileTypes: true }).filter((d) => d.isDirectory() && d.name.startsWith(PREFIX)).map((d) => d.name);
    } catch {}
    for (const name of names) {
      try {
        watchers.push(fs.watch(path.join(ROOT, name, '.git'), { recursive: true }, (_, file) => {
          if (file && GIT_EVENT.test(file)) fire();
        }));
      } catch {} // not a git checkout, or a worktree whose .git is a file
    }
  };
  setup();
  // A new or removed oN folder re-arms the watchers.
  try {
    fs.watch(ROOT, () => { setup(); fire(); });
  } catch {}
}

module.exports = { readCheckouts, watchCheckouts, CHECKOUTS_DIR: ROOT };
