'use strict';

// permission.js — runs in a full tab (chrome-extension://<id>/permission.html).
// Unlike the popup, a real tab doesn't auto-close when the native mic
// permission bubble steals focus, so this is the reliable place to grant
// the extension's microphone permission for the first time.

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
    showStatus('granted', '✓ دسترسی داده شد. می‌توانید این تب را ببندید و به افزونه برگردید.');
    btnGrant.classList.add('hidden');
    btnSettings.classList.add('hidden');
  } catch (err) {
    if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
      showStatus('denied', 'دسترسی رد شد. برای فعال‌سازی دستی، روی دکمه زیر بزنید و «Microphone» را روی Allow بگذارید.');
      btnSettings.classList.remove('hidden');
    } else {
      showStatus('denied', `خطا: ${err.message}`);
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
  try {
    const status = await navigator.permissions.query({ name: 'microphone' });

    if (status.state === 'granted') {
      showStatus('granted', '✓ دسترسی از قبل فعال است. می‌توانید این تب را ببندید.');
      btnGrant.classList.add('hidden');
      return;
    }

    if (status.state === 'denied') {
      showStatus('denied', 'دسترسی میکروفون قبلاً رد شده است. برای فعال‌سازی، روی دکمه زیر بزنید.');
      btnGrant.classList.add('hidden');
      btnSettings.classList.remove('hidden');
      return;
    }

    requestMic(); // state === 'prompt' → ask immediately
  } catch {
    // Permissions API unsupported for 'microphone' — fall back to manual button only
  }
})();
