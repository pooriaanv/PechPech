'use strict';

// permission.js — runs in a full tab (chrome-extension://<id>/permission.html).
// Unlike the popup, a real tab doesn't auto-close when the native mic
// permission bubble steals focus, so this is the reliable place to grant
// the extension's microphone permission for the first time.

import { t, bootLanguage } from './i18n.js';

const statusEl    = document.getElementById('status');
const btnGrant    = document.getElementById('btn-grant');
const btnSettings = document.getElementById('btn-open-settings');

function showStatus(kind, text) {
  statusEl.className   = `status show ${kind}`;
  statusEl.textContent = text;
}

async function requestMic() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    stream.getTracks().forEach(t => t.stop());
    showStatus('granted', t('permGranted'));
    btnGrant.classList.add('hidden');
    btnSettings.classList.add('hidden');
  } catch (err) {
    if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
      showStatus('denied', t('permDeniedManual'));
      btnSettings.classList.remove('hidden');
    } else {
      showStatus('denied', t('permError', { message: err.message }));
    }
  }
}

btnGrant.addEventListener('click', requestMic);

btnSettings.addEventListener('click', () => {
  const origin = `chrome-extension://${chrome.runtime.id}`;
  chrome.tabs.create({ url: `chrome://settings/content/siteDetails?site=${encodeURIComponent(origin)}` });
});

// On load: check current state first so we don't ask again if already
// decided, and auto-trigger the native prompt if it's still undecided.
(async () => {
  await bootLanguage();

  try {
    const status = await navigator.permissions.query({ name: 'microphone' });

    if (status.state === 'granted') {
      showStatus('granted', t('permAlreadyGranted'));
      btnGrant.classList.add('hidden');
      return;
    }

    if (status.state === 'denied') {
      showStatus('denied', t('permAlreadyDenied'));
      btnGrant.classList.add('hidden');
      btnSettings.classList.remove('hidden');
      return;
    }

    requestMic(); // state === 'prompt' → ask immediately
  } catch {
    // Permissions API unsupported for 'microphone' — fall back to manual button only
  }
})();
