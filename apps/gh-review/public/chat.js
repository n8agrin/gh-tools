// The chat panel on the PR page: ask Claude about this PR. The server keeps the thread and the
// claude session; this only draws it, sends messages, and polls while an answer is being written.
import { markdown } from './md.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const post = (body) => fetch('/api/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());

const STARTERS = ['What should I read first, and why?', "What's most likely to break?", 'What would you ask the author?'];

export function initChat(url) {
  const box = $('#chat');
  const list = $('#chat-log');
  const input = $('#chat-input');
  const chat = { messages: [], running: false, error: null };
  let poll = null;

  function draw() {
    const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 60;
    const msgs = chat.messages.map((m) => {
      if (m.role === 'user') return `<div class="msg me">${markdown(m.text)}</div>`;
      const busy = m.status === 'running' ? `<div class="activity">${esc(m.activity ?? 'Thinking')}…</div>` : '';
      return `<div class="msg bot ${m.status}">${m.text ? `<div class="md">${markdown(m.text)}</div>` : ''}${busy}</div>`;
    });
    list.innerHTML = msgs.length
      ? msgs.join('')
      : `<div class="chat-empty"><p>Ask about any part of this PR. Claude has the diff, the description and the review results, and reads the code in its own worktree. Nothing is posted to GitHub.</p>${STARTERS.map((s) => `<button class="starter" type="button">${esc(s)}</button>`).join('')}<p class="faint">Select text on the page, then press <kbd>c</kbd>, to ask about it.</p></div>`;
    if (chat.error) list.insertAdjacentHTML('beforeend', `<pre class="err">${esc(chat.error)}</pre>`);
    if (nearBottom) list.scrollTop = list.scrollHeight;
    $('#chat-stop').hidden = !chat.running;
    $('#chat-clear').hidden = chat.running || !chat.messages.length;
    input.placeholder = chat.running ? 'Claude is answering…' : 'Ask about this PR';
  }

  function apply(res) {
    if (res.error) chat.error = res.error;
    else Object.assign(chat, res, { error: null });
    draw();
    clearInterval(poll);
    if (chat.running) poll = setInterval(refresh, 700);
  }

  const refresh = () => fetch(`/api/chat?url=${encodeURIComponent(url)}`).then((r) => r.json()).then(apply).catch(() => {});

  async function send(text) {
    text = text.trim();
    if (!text || chat.running) return;
    input.value = '';
    // Show the question straight away; the server's copy replaces it on the next draw.
    chat.messages.push({ role: 'user', text }, { role: 'assistant', text: '', status: 'running', activity: 'Starting' });
    chat.running = true;
    draw();
    list.scrollTop = list.scrollHeight;
    apply(await post({ url, text }));
  }

  function setOpen(open) {
    box.hidden = !open;
    document.body.classList.toggle('chat-open', open);
    localStorage.setItem('chatOpen', open ? '1' : '');
  }

  /** Open the panel and focus the box, starting with `prefill` or else quoting what's selected on the page. */
  function open(prefill = '') {
    setOpen(true);
    const sel = (window.getSelection()?.toString() ?? '').trim();
    if (prefill) input.value = `${prefill}${input.value}`;
    else if (sel && !box.contains(window.getSelection()?.anchorNode)) input.value = `${sel.split('\n').map((l) => `> ${l}`).join('\n')}\n\n${input.value}`;
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) return e.preventDefault(), send(input.value);
    if (e.key === 'Escape') return e.preventDefault(), input.blur();
  });
  box.addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.classList.contains('starter')) return send(b.textContent);
    if (b.id === 'chat-close') return setOpen(false), input.blur();
    if (b.id === 'chat-stop') return apply(await post({ url, stop: true }));
    if (b.id === 'chat-clear' && confirm('Clear this chat and start over?')) return apply(await post({ url, reset: true }));
  });

  setOpen(!!localStorage.getItem('chatOpen'));
  refresh();
  return { open, toggle: () => (box.hidden ? open() : setOpen(false)) };
}
