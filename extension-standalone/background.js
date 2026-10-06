/**
 * background.js — PechPech Standalone Service Worker (MV3)
 *
 * MV3 service workers are killed after ~30s of inactivity and restart fresh,
 * losing all in-memory state. Recording state is persisted in
 * chrome.storage.session so it survives service worker restarts.
 *
 * Adapted from extension/background.js — no local server. The offscreen
 * document writes the recorded audio directly into IndexedDB (via store.js)
 * instead of POSTing it to a server; only a small {id} comes back here.
 * Processing (STT+LLM) is centralized here too, mirroring the shape of
 * server/src/pipeline.js's run()/correct() — never throw to the caller,
 * always write { status: 'error', error } to the record on failure.
 */

import { getRecording, updateRecording, listRecordings } from './store.js';
import { createSTTProvider, createLLMProvider } from './providers.js';
import {
  buildMOMPrompt, buildNotesPrompt, buildCorrectionPrompt,
  parseMOMOutput, parseNotesOutput, parseCorrectionOutput,
} from './prompts.js';
import { t, initLanguage, setLanguageLocal, getLanguage } from './i18n.js';

// Keeps this service worker's copy of the language dictionary in sync with
// whatever the popup/settings last saved — a service worker has no DOM to
// re-read on demand, so notification/tooltip strings need a live cache
// rather than an async storage read per call. Mirrors the existing
// _customMeetingDomains cache pattern below.
initLanguage();
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.language) {
    setLanguageLocal(changes.language.newValue);
  }
});

const OFFSCREEN_URL   = chrome.runtime.getURL('offscreen.html');
const ONBOARDING_URL  = chrome.runtime.getURL('onboarding.html');

const CONFIG_DEFAULTS = {
  sttProvider: 'custom',
  sttUrl:      'http://localhost:8080/v1',
  sttKey:      '',
  sttModel:    'whisper-1',
  llmCli:      'openai',
  llmApiUrl:   '',
  llmApiKey:   '',
  llmApiModel: '',
  promptMom:        '',
  promptNotes:      '',
  promptCorrection: '',
};

async function loadConfig() {
  const stored = await chrome.storage.local.get(Object.keys(CONFIG_DEFAULTS));
  return { ...CONFIG_DEFAULTS, ...stored };
}

// Tracks in-flight processing/correction jobs in THIS service worker instance
// (id → AbortController), so a Cancel click can actually interrupt a live
// fetch. If the SW was killed and restarted, this map is empty again — that's
// fine, there's nothing left to abort in that case anyway; the watchdog
// alarm below is what recovers a record left stuck by a dead SW instance.
const _activeJobs = new Map();

// ── Stuck-job watchdog ────────────────────────────────────────────
// If the service worker is killed mid-fetch during a long STT/LLM call, the
// entire execution context (including the try/catch that would normally
// write status:'error') is destroyed at once — the record is left frozen
// forever with nothing left alive to recover it. chrome.alarms is the fix:
// Chrome wakes a terminated service worker specifically to run alarm
// handlers, independent of whether any fetch survived.

const WATCHDOG_ALARM      = 'processing-watchdog';
// Must stay comfortably above the worst-case legitimate duration of a single
// run (STT timeout 15 min + LLM timeout 15 min = 30 min sequential worst case),
// or this would flag a slow-but-still-alive job as stuck and overwrite it
// with a false error right as the real result is about to land.
// (STT_TIMEOUT_MS lives in providers.js; keep this above it plus the LLM's.)
const STUCK_THRESHOLD_MS  = 35 * 60 * 1000; // 35 minutes

chrome.alarms.create(WATCHDOG_ALARM, { periodInMinutes: 1 });

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== WATCHDOG_ALARM) return;

  const all   = await listRecordings();
  const stuck = all.filter(r =>
    ['transcribing', 'summarizing', 'correcting'].includes(r.status) &&
    r.processingStartedAt &&
    (Date.now() - r.processingStartedAt) > STUCK_THRESHOLD_MS
  );

  for (const rec of stuck) {
    console.warn(`[background] Watchdog: recovering stuck recording ${rec.id} (status=${rec.status})`);
    if (rec.status === 'correcting') {
      await updateRecording(rec.id, {
        correction_status: 'error',
        correction_error:  t('bgWatchdogRecovered'),
      }).catch(() => {});
    } else {
      await updateRecording(rec.id, {
        status: 'error',
        error:  t('bgWatchdogRecovered'),
      }).catch(() => {});
    }
  }
});

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

    case 'RECORDING_SAVED':
      if (stopResolver) {
        stopResolver({ success: true, id: msg.id });
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

    case 'PROCESS_RECORDING':
      // IndexedDB writes are async, so a fire-and-forget message here leaves
      // a real race: the popup would start polling/listing again before the
      // initial status flip below even lands, and could read a stale prior
      // status (e.g. an old 'error' from a previous cancel) for one tick.
      // Holding the channel open until that first write completes closes
      // the race — the actual STT/LLM work still continues afterward
      // without being awaited by this response.
      beginProcessing(msg.id, msg.mode, msg.language).then(sendResponse);
      return true;

    case 'CORRECT_TRANSCRIPT':
      beginCorrection(msg.id).then(sendResponse);
      return true;

    case 'CANCEL_PROCESSING':
      cancelJob(msg.id).then(() => sendResponse({ success: true }));
      return true;
  }
});

// Aborts a live in-flight fetch if this SW instance still has it registered,
// then unconditionally resets the record — this works whether the job was
// actually still running or had already silently died (dead SW, no entry in
// _activeJobs), since either way the record needs to come out of the busy
// state. The transcript (if STT had already finished) is left untouched, so
// re-processing skips straight to the LLM step.
async function cancelJob(id) {
  _activeJobs.get(id)?.abort();
  _activeJobs.delete(id);

  const rec = await getRecording(id);
  if (rec?.correction_status === 'correcting') {
    await updateRecording(id, { correction_status: 'error', correction_error: t('bgCancelledByUser') }).catch(() => {});
  } else {
    await updateRecording(id, { status: 'error', error: t('bgCancelledByUser') }).catch(() => {});
  }
}

// ── Processing (STT + LLM) ────────────────────────────────────────
// Mirrors server/src/pipeline.js's run(): never throws to the caller,
// always writes { status: 'error', error } on failure. The popup polls
// the record's status via store.js — no response is sent here.

// Does just the up-front validation + first status write, and is awaited by
// the message handler before it responds — so by the time the popup acts on
// that response (start polling, refresh the list), the record has *already*
// left any prior terminal status (e.g. a leftover 'error' from a previous
// cancel). The actual STT/LLM work is handed off to continueProcessing()
// without being awaited here, so this resolves quickly.
//
// `language` is pinned onto the record the first time processing actually
// runs (from whatever the popup's UI language was at that instant) and
// reused on any later re-process/correct — a UI language toggle after this
// point must not retroactively change what this recording was generated in.
async function beginProcessing(id, mode = 'mom', language) {
  const rec = await getRecording(id);
  if (!rec) {
    console.error(`[background] ${id} STEP=begin failed: recording not found`);
    return { success: false, error: `Recording not found: ${id}` };
  }

  // Guard against re-entrancy (e.g. a duplicate click) — already running,
  // just let the popup poll the existing job instead of starting another.
  if (['transcribing', 'summarizing'].includes(rec.status)) return { success: true };

  const lang = rec.language || (language === 'fa' ? 'fa' : 'en');
  const hasTranscript = !!rec.transcript;
  await updateRecording(id, {
    status:              hasTranscript ? 'summarizing' : 'transcribing',
    error:               null,
    language:            lang,
    processingStartedAt: Date.now(),
  });

  continueProcessing(id, mode, rec, hasTranscript, lang); // fire-and-forget
  return { success: true };
}

async function continueProcessing(id, mode, rec, hasTranscript, language) {
  const controller = new AbortController();
  _activeJobs.set(id, controller);

  try {
    const config = await loadConfig();
    let transcript = rec.transcript || null;

    if (hasTranscript) {
      console.log(`[background] ${id} transcript already exists — skipping STT`);
    } else {
      try {
        const sttProvider = createSTTProvider(config);
        transcript = await sttProvider.transcribe({
          audioBlob: rec.audioBlob,
          mimeType:  rec.mimeType,
          signal:    controller.signal,
        });
        await updateRecording(id, { transcript, status: 'summarizing' });
      } catch (err) {
        console.error(`[background] ${id} STEP=transcribe (provider=${config.sttProvider}) failed:`, err.message, err);
        throw err;
      }
    }

    const llmProvider = createLLMProvider(config);

    try {
      if (mode === 'notes') {
        const llmOutput = await llmProvider.invoke(buildNotesPrompt(transcript, language, config.promptNotes), { signal: controller.signal });
        const notes     = parseNotesOutput(llmOutput, language);
        await updateRecording(id, { status: 'done', mode: 'notes', notes });
      } else {
        const llmOutput = await llmProvider.invoke(buildMOMPrompt(transcript, language, config.promptMom), { signal: controller.signal });
        const mom       = parseMOMOutput(llmOutput, language);
        await updateRecording(id, {
          status:       'done',
          mode:         'mom',
          summary:      mom.summary      || '',
          decisions:    mom.decisions    || '',
          action_items: mom.action_items || '',
          ...(mom._parse_warning ? { warning: mom._parse_warning } : {}),
        });
      }
    } catch (err) {
      console.error(`[background] ${id} STEP=summarize (provider=${config.llmCli}, mode=${mode}) failed:`, err.message, err);
      throw err;
    }
    console.log(`[background] ${id} done (mode: ${mode}, language: ${language})`);

  } catch (err) {
    console.error(`[background] ${id} processing failed:`, err.message);
    await updateRecording(id, { status: 'error', error: err.message }).catch(() => {});
  } finally {
    _activeJobs.delete(id);
  }
}

// Same up-front-write-before-responding pattern as beginProcessing(), for
// the same reason: avoids the popup reading a stale correction_status left
// over from a previous cancel/error before this job's own write lands.
async function beginCorrection(id) {
  const rec = await getRecording(id);
  if (!rec?.transcript) {
    console.error(`[background] ${id} STEP=begin-correct failed: no transcript available`);
    await updateRecording(id, {
      correction_status: 'error',
      correction_error:  'No transcript available to correct.',
    });
    return { success: false, error: 'No transcript available to correct.' };
  }

  await updateRecording(id, {
    correction_status:   'correcting',
    correction_error:    null,
    processingStartedAt: Date.now(),
  });

  // Reuse the recording's own pinned generation language (not the live UI
  // language) so the correction pass matches what the transcript/MOM were
  // actually generated in — falls back to the current UI language only for
  // recordings created before this field existed.
  const lang = rec.language || getLanguage();
  continueCorrection(id, rec, lang); // fire-and-forget
  return { success: true };
}

async function continueCorrection(id, rec, language) {
  const controller = new AbortController();
  _activeJobs.set(id, controller);

  try {
    const config      = await loadConfig();
    const llmProvider  = createLLMProvider(config);

    let llmOutput;
    try {
      llmOutput = await llmProvider.invoke(buildCorrectionPrompt(rec.transcript, language, config.promptCorrection), { signal: controller.signal });
    } catch (err) {
      console.error(`[background] ${id} STEP=correct (provider=${config.llmCli}) failed:`, err.message, err);
      throw err;
    }

    const corrected = parseCorrectionOutput(llmOutput, language);

    await updateRecording(id, {
      correction_status:    'done',
      corrected_transcript: corrected,
    });
    console.log(`[background] correct ${id} done`);

  } catch (err) {
    console.error(`[background] correct ${id} failed:`, err.message);
    await updateRecording(id, { correction_status: 'error', correction_error: err.message }).catch(() => {});
  } finally {
    _activeJobs.delete(id);
  }
}

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
      sendResponse({ success: false, error: t('bgAlreadyRecording') });
      return;
    }
  }

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) {
      sendResponse({ success: false, error: t('bgNoActiveTab') });
      return;
    }

    // Read before the tabCapture stream id is minted: that id expires quickly,
    // so nothing slow should sit between getting it and using it. The recorder
    // lives in an offscreen document, which has no chrome.storage access, so
    // the chosen quality travels in the start message.
    const { audioQuality } = await chrome.storage.local.get('audioQuality');

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
    clearMeetingBadge(tab.id);

    chrome.runtime.sendMessage({ type: 'START_CAPTURE', streamId, tabId: tab.id, audioQuality });

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
    sendResponse({ success: false, error: t('bgNoRecordingInProgress') });
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
      error:   t('bgRecordingLost'),
    });
    return;
  }

  try {
    stopResolver = sendResponse;

    chrome.runtime.sendMessage({ type: 'STOP_CAPTURE' });

    // Safety timeout: encoding + IndexedDB write is a fast, local operation
    // (no network round trip in this variant), but give a generous margin.
    setTimeout(async () => {
      if (stopResolver) {
        stopResolver({ success: false, error: t('bgSaveTimedOut') });
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
  _notifiedTabs.delete(tabId);
  _badgedTabs.delete(tabId);
  const state = await readState();
  if (tabId === state.recordingTabId && state.isRecording) {
    console.warn('[background] Recording tab closed during recording.');
    if (stopResolver) return;
    chrome.runtime.sendMessage({ type: 'STOP_CAPTURE' });
  }
});

// ── Meeting URL Detection ─────────────────────────────────────────

const DEFAULT_MEETING_PATTERNS = [
  /^https:\/\/meet\.google\.com\/[a-z]+-[a-z]+-[a-z]+/,  // Google Meet room
  /^https:\/\/[\w.-]+\.zoom\.us\/j\//,                     // Zoom web meeting
  /^https:\/\/teams\.microsoft\.com\/l\/meetup-join\//,    // Teams meeting
  /^https:\/\/teams\.live\.com\/meet\//,                   // Teams personal
  /^https:\/\/web\.skype\.com\//,                          // Skype web
];

// Custom domains from chrome.storage.local — kept in sync via onChanged
let _customMeetingDomains = [];
chrome.storage.local.get(['customMeetingDomains'], ({ customMeetingDomains }) => {
  _customMeetingDomains = customMeetingDomains || [];
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.customMeetingDomains) {
    _customMeetingDomains = changes.customMeetingDomains.newValue || [];
  }
});

function isMeetingUrl(url) {
  if (!url) return false;
  if (DEFAULT_MEETING_PATTERNS.some(p => p.test(url))) return true;
  try {
    const hostname = new URL(url).hostname;
    return _customMeetingDomains.some(d => hostname === d || hostname.endsWith(`.${d}`));
  } catch { return false; }
}

// In-memory cooldown: avoid re-notifying the same tab within 30 min
const _notifiedTabs = new Map();

// Tabs currently showing the toolbar-badge reminder — independent of the
// notification cooldown above, since the badge is passive (not spammy) and
// should stay visible for as long as the tab is on a meeting URL.
const _badgedTabs = new Set();

function setMeetingBadge(tabId) {
  chrome.action.setBadgeText({ text: '●', tabId });
  chrome.action.setBadgeBackgroundColor({ color: '#dc2626', tabId });
  chrome.action.setTitle({ tabId, title: t('bgMeetingDetectedTooltip') });
  _badgedTabs.add(tabId);
}

function clearMeetingBadge(tabId) {
  if (!_badgedTabs.has(tabId)) return;
  chrome.action.setBadgeText({ text: '', tabId });
  chrome.action.setTitle({ tabId, title: '' });
  _badgedTabs.delete(tabId);
}

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  // Full navigations fire with status:'complete' (tab.url is final).
  // SPA route changes (e.g. Meet's "New meeting" while already on the
  // site) use history.pushState — Chrome reports only changeInfo.url,
  // with no status field at all. Handle both.
  const url = changeInfo.url || (changeInfo.status === 'complete' ? tab.url : null);
  if (url === null) return;

  if (!isMeetingUrl(url)) {
    clearMeetingBadge(tabId);
    return;
  }

  const state = await readState();
  if (state.isRecording) return;

  setMeetingBadge(tabId);

  const last = _notifiedTabs.get(tabId);
  if (last && Date.now() - last < 30 * 60 * 1000) return;
  _notifiedTabs.set(tabId, Date.now());

  console.log(`[background] Meeting URL detected on tab ${tabId}: ${url}`);

  chrome.notifications.create('meeting-detected', {
    type:    'basic',
    iconUrl: 'icons/icon128.png',
    title:   t('bgNotifTitle'),
    message: t('bgNotifBody'),
  });
});

chrome.notifications.onClicked.addListener(id => {
  if (id !== 'meeting-detected') return;
  chrome.notifications.clear(id);
  chrome.action.openPopup().catch(() => {});
});
