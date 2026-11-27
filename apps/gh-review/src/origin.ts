// The server listens on your machine and its POSTs write to GitHub, run Claude and start processes.
// A browser lets any website send a plain-text POST to localhost without asking, so only posts from
// gh-review's own pages are taken.

/** Why a POST is refused, or null when it came from one of gh-review's pages (or from outside a browser). */
export function refusePost(headers: Headers): string | null {
  const origin = headers.get('origin');
  // Browsers send Origin on every cross-site POST. A request without one came from a script or curl.
  if (origin) {
    let host = '';
    try {
      host = new URL(origin).host;
    } catch {}
    if (host !== headers.get('host')) return `refused a request from ${origin}`;
  }
  // A JSON content type makes a cross-site request ask first, which this server never answers yes to.
  if (!headers.get('content-type')?.startsWith('application/json')) return 'POST bodies must be application/json';
  return null;
}
