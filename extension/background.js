/**
 * background.js — PechPech Service Worker (MV3)
 *
 * MV3 service workers are killed after ~30s of inactivity and restart fresh,
 * losing all in-memory state. Recording state is persisted in
 * chrome.storage.session so it survives service worker restarts.
 */

const OFFSCREEN_URL   = chrome.runtime.getURL('offscreen.html');
const ONBOARDING_URL  = chrome.runtime.getURL('onboarding.html');

// ── Onboarding ────────────────────────────────────────────────────
// Opens on first install and on every extension reload (useful during
// development; also surfaces setup steps after an update).

chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === 'install' || reason === 'update') {
    chrome.tabs.create({ url: ONBOARDING_URL });
  }
});

// In-memory cache of session state — always read from storage first
let _state = { isRecording: false, recordingTabId: null, startedAt: null };

// Pending resolve for the STOP_RECORDING flow (cannot survive SW restart —
// popup must handle a restart-during-stop gracefully)
let stopResolver = null;

// Resolves when the offscreen doc signals it is ready to receive messages
let offscreenReadyResolver = null;
let offscreenReadyPromise  = null;

// ── State helpers ─────────────────────────────────────────────────

async function readState() {
  const data = await chrome.storage.session.get(['isRecording', 'recordingTabId', 'startedAt']);
  _state = {
    isRecording:    data.isRecording    ?? false,
    recordingTabId: data.recordingTabId ?? null,
    startedAt:      data.startedAt      ?? null,
  };
  return _state;
}

async function saveState(patch) {
  Object.assign(_state, patch);
  await chrome.storage.session.set(_state);
}

async function clearState() {
  _state = { isRecording: false, recordingTabId: null, startedAt: null };
  await chrome.storage.session.set(_state);
}

// ── Message Router ────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg.type) {
    case 'START_RECORDING':
      handleStart(sendResponse);
      return true;

    case 'STOP_RECORDING':
      handleStop(sendResponse);
      return true;

    case 'GET_STATE':
      // Always read from storage so popup gets the real state even after SW restart
      readState().then((s) => sendResponse({ isRecording: s.isRecording, startedAt: s.startedAt }));
      return true;

    case 'OFFSCREEN_READY':
      if (offscreenReadyResolver) {
        offscreenReadyResolver();
        offscreenReadyResolver = null;
      }
      break;

    case 'AUDIO_DATA':
      if (stopResolver) {
        stopResolver({ success: true, audioData: msg.audioData, mimeType: msg.mimeType });
        stopResolver = null;
      }
      clearState();
      closeOffscreenDocument();
      break;

    case 'OFFSCREEN_ERROR':
      if (stopResolver) {
        stopResolver({ success: false, error: msg.error });
        stopResolver = null;
      }
      clearState();
      closeOffscreenDocument();
      break;
  }
});

// ── Start Recording ───────────────────────────────────────────────

async function handleStart(sendResponse) {
  const state = await readState();

  if (state.isRecording) {
    // Check if the offscreen doc is actually still alive — if not, the previous
    // recording was silently lost (SW was killed). Clean up and allow a fresh start.
    const docAlive = await chrome.offscreen.hasDocument().catch(() => false);
    if (!docAlive) {
      await clearState();
    } else {
      sendResponse({ success: false, error: 'در حال حاضر ضبط در جریان است.' });
      return;
    }
  }

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) {
      sendResponse({ success: false, error: 'تب فعالی یافت نشد.' });
      return;
    }

    const streamId = await new Promise((resolve, reject) => {
      chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id }, (id) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve(id);
        }
      });
    });

    await ensureOffscreenDocument();

    // Save state BEFORE telling offscreen to start, so if SW dies between
    // these two lines the state is already persisted.
    await saveState({ isRecording: true, recordingTabId: tab.id, startedAt: Date.now() });

    chrome.runtime.sendMessage({ type: 'START_CAPTURE', streamId, tabId: tab.id });

    sendResponse({ success: true, startedAt: _state.startedAt });

  } catch (err) {
    console.error('[background] Start error:', err);
    await clearState();
    sendResponse({ success: false, error: err.message });
  }
}

// ── Stop Recording ────────────────────────────────────────────────

async function handleStop(sendResponse) {
  const state = await readState();

  if (!state.isRecording) {
    sendResponse({ success: false, error: 'ضبطی در جریان نیست.' });
    return;
  }

  // Check if the offscreen document (and thus the actual recording) is still alive.
  // If the service worker was killed and restarted, the offscreen doc is gone too —
  // the recording was lost. Inform the user clearly instead of hanging.
  const docAlive = await chrome.offscreen.hasDocument().catch(() => false);
  if (!docAlive) {
    await clearState();
    sendResponse({
      success: false,
      error:   'ضبط به دلیل ری‌استارت مرورگر از دست رفت. لطفاً دوباره شروع کنید.',
    });
    return;
  }

  try {
    stopResolver = sendResponse;

    chrome.runtime.sendMessage({ type: 'STOP_CAPTURE' });

    // Safety timeout: if offscreen doesn't respond in 30s, give up
    setTimeout(async () => {
      if (stopResolver) {
        stopResolver({ success: false, error: 'زمان انتظار برای دریافت صدا به پایان رسید.' });
        stopResolver = null;
        await clearState();
        closeOffscreenDocument();
      }
    }, 30_000);

  } catch (err) {
    console.error('[background] Stop error:', err);
    stopResolver = null;
    await clearState();
    sendResponse({ success: false, error: err.message });
  }
}

// ── Offscreen Document Management ─────────────────────────────────

async function ensureOffscreenDocument() {
  const existing = await chrome.offscreen.hasDocument().catch(() => false);
  if (existing) {
    // Doc already running — no need to wait for READY again
    offscreenReadyPromise = Promise.resolve();
    return;
  }

  // Set up a promise that resolves when offscreen.js sends OFFSCREEN_READY
  offscreenReadyPromise = new Promise((resolve) => {
    offscreenReadyResolver = resolve;
  });

  await chrome.offscreen.createDocument({
    url:           OFFSCREEN_URL,
    reasons:       [chrome.offscreen.Reason.USER_MEDIA],
    justification: 'Mix tab audio and microphone for meeting recording',
  });

  // Wait up to 5s for the offscreen doc to signal it's ready
  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('Offscreen document took too long to load.')), 5000)
  );
  await Promise.race([offscreenReadyPromise, timeout]);
}

async function closeOffscreenDocument() {
  const existing = await chrome.offscreen.hasDocument().catch(() => false);
  if (existing) {
    await chrome.offscreen.closeDocument().catch(console.error);
  }
}

// ── Tab close guard ───────────────────────────────────────────────

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const state = await readState();
  if (tabId === state.recordingTabId && state.isRecording) {
    console.warn('[background] Recording tab closed during recording.');
    if (stopResolver) return;
    chrome.runtime.sendMessage({ type: 'STOP_CAPTURE' });
  }
});
