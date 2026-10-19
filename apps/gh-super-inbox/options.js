(function () {
  'use strict';

  function $(id) { return document.getElementById(id); }
  var tokenInput = $('token');
  var statusEl = $('status');

  function show(msg, cls) {
    statusEl.textContent = msg;
    statusEl.className = 'status ' + (cls || '');
  }

  function send(msg) {
    return chrome.runtime.sendMessage(msg).catch(function (e) {
      return { error: { code: 'disconnected', message: e.message } };
    });
  }

  chrome.storage.local.get(['token', 'viewerLogin']).then(function (s) {
    if (s.token) tokenInput.value = s.token;
    if (s.token && s.viewerLogin) show('Saved. Signed in as ' + s.viewerLogin + '.', 'ok');
  });

  $('show').addEventListener('click', function () {
    var hidden = tokenInput.type === 'password';
    tokenInput.type = hidden ? 'text' : 'password';
    this.textContent = hidden ? 'Hide' : 'Show';
  });

  $('save').addEventListener('click', async function () {
    var token = tokenInput.value.trim();
    if (!token) {
      show('Paste a token first.', 'err');
      return;
    }
    show('Checking token…');
    var resp = await send({ type: 'verifyToken', token: token });
    if (!resp || resp.error) {
      show('GitHub rejected that token: ' + (resp && resp.error ? resp.error.message : 'no response'), 'err');
      return;
    }
    await chrome.storage.local.set({ token: token, viewerLogin: resp.login });
    await send({ type: 'clearCache' });
    show('Saved. Signed in as ' + resp.login + '. Reload the notifications page.', 'ok');
  });

  $('clear-cache').addEventListener('click', async function () {
    await send({ type: 'clearCache' });
    show('Cache cleared.', 'ok');
  });

  $('remove').addEventListener('click', async function () {
    await chrome.storage.local.remove(['token', 'viewerLogin']);
    await send({ type: 'clearCache' });
    tokenInput.value = '';
    show('Token removed.', 'ok');
  });
})();
