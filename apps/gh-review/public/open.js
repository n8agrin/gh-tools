// Opening a link. On the machine that runs gh-review, the server opens it in the browser your config
// names. From any other device (a phone reaching a home box), the page opens it in a new tab here.
const LOCAL = ['localhost', '127.0.0.1', '[::1]'];

export const isRemote = (hostname) => !LOCAL.includes(hostname);

/** Open a GitHub link where you are. `post` is the page's own JSON POST helper. */
export function openLink(url, post, hostname = location.hostname) {
  if (isRemote(hostname)) return void window.open(url, '_blank', 'noopener');
  return post('/api/open', { url });
}
