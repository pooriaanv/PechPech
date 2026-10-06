/**
 * popup.js — PechPech Standalone
 *
 * Flow:
 *   idle → recording → [saving] → idle (recording in list with Process button)
 *   idle → click Process on list item → processing → result
 *
 * State (processing / result / error) is persisted in chrome.storage.session
 * so reopening the popup restores exactly where the user left off.
 *
 * Adapted from extension/popup.js — no local server. Recordings live in
 * IndexedDB (store.js); processing is triggered via a fire-and-forget
 * message to background.js, then popup.js polls store.js directly instead
 * of polling an HTTP endpoint.
 */

import { listRecordings, getRecording, updateRecording, deleteRecording } from './store.js';
import { t, tFor, getLanguage, setLanguage, applyTranslations, bootLanguage } from './i18n.js';

// Wraps chrome.runtime.sendMessage in a Promise. background.js's
// PROCESS_RECORDING/CORRECT_TRANSCRIPT/CANCEL_PROCESSING handlers hold the
// channel open until their first (async, IndexedDB) status write lands —
// awaiting this before polling/refreshing avoids reading a stale prior
// status for one tick.
function sendMessage(msg) {
  return new Promise(resolve => chrome.runtime.sendMessage(msg, resolve));
}

// ── DOM ───────────────────────────────────────────────────────────

const $  = id => document.getElementById(id);
const el = {
  states: {
    idle:       $('state-idle'),
    recording:  $('state-recording'),
    processing: $('state-processing'),
    result:     $('state-result'),
    error:      $('state-error'),
  },
  btnStart:     $('btn-start'),
  btnStop:      $('btn-stop'),
  btnSave:      $('btn-save'),
  btnNew:       $('btn-new'),
  btnRetry:     $('btn-retry'),
  btnRefresh:   $('btn-refresh'),
  langToggle:   $('lang-toggle-btn'),
  elapsed:      $('elapsed-time'),
  procMsg:      $('processing-message'),
  errorMsg:     $('error-message'),
  summary:            $('result-summary'),
  decisions:          $('result-decisions'),
  actions:            $('result-actions'),
  transcript:          $('result-transcript'),
  transcriptSection:   $('transcript-section'),
  transcriptChevron:   $('transcript-chevron'),
  btnTranscript:       $('btn-transcript-toggle'),
  transcriptRequest:   $('transcript-request'),
  transcriptLoading:   $('transcript-loading'),
  transcriptDone:      $('transcript-done'),
  btnCorrect:          $('btn-correct'),
  recList:            $('recordings-list'),
  stepTrans:    $('step-transcribe'),
  stepSum:      $('step-summarize'),
  heroLabel:        $('hero-label'),
  momCard:          $('mom-card'),
  notesCard:        $('notes-card'),
  resultNotesList:  $('result-notes-list'),
  resultNotesEmpty: $('result-notes-empty'),
  recModeLabel:     $('rec-mode-label'),
  btnCancelProcessing: $('btn-cancel-processing'),
};

// ── Runtime state ─────────────────────────────────────────────────

let elapsedTimer  = null;
let elapsedStart  = null;
let pollingTimer  = null;
let currentMOM    = null;
let currentMode   = 'mom'; // 'mom' | 'notes'
let currentProcessingId = null;

// ── Session state helpers ─────────────────────────────────────────

const SESSION_KEYS = ['popupState', 'recordingId', 'currentMOM', 'errorMsg', 'currentMode'];

function saveSession(patch) {
  return new Promise(r =>
    chrome.storage.session.get(SESSION_KEYS, existing =>
      chrome.storage.session.set({ ...existing, ...patch }, r)
    )
  );
}

function loadSession() {
  return new Promise(r => chrome.storage.session.get(SESSION_KEYS, r));
}

function clearSession() {
  return new Promise(r => chrome.storage.session.remove(SESSION_KEYS, r));
}

// ── Mic Permission ────────────────────────────────────────────────

async function checkMicPermission() {
  try {
    const status = await navigator.permissions.query({ name: 'microphone' });
    return status.state; // 'granted' | 'denied' | 'prompt'
  } catch {
    return 'unsupported';
  }
}

function openMicPermissionTab() {
  chrome.tabs.create({ url: chrome.runtime.getURL('permission.html') });
}

// ── Mode helpers ──────────────────────────────────────────────────

function applyModeToggle(mode) {
  document.querySelectorAll('.mode-toggle-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.mode === mode);
    btn.setAttribute('aria-pressed', btn.dataset.mode === mode);
  });
  el.heroLabel.textContent = mode === 'notes' ? t('heroLabelNotes') : t('heroLabelMom');
}

function renderNotesList(rawNotes, ulEl, emptyEl) {
  const lines = (rawNotes || '')
    .split('\n')
    .map(l => l.replace(/^[\s\-•*\d\.]+/, '').trim())
    .filter(Boolean);
  if (!lines.length) {
    ulEl.classList.add('hidden');
    emptyEl.classList.remove('hidden');
    return;
  }
  ulEl.innerHTML = lines.map(l => `<li class="notes-list-item">${escapeHtml(l)}</li>`).join('');
  ulEl.classList.remove('hidden');
  emptyEl.classList.add('hidden');
}

// ── UI helpers ────────────────────────────────────────────────────

function showState(name) {
  Object.entries(el.states).forEach(([k, node]) =>
    node.classList.toggle('hidden', k !== name)
  );
}

function toFarsi(str) {
  return str.replace(/\d/g, d => '۰۱۲۳۴۵۶۷۸۹'[d]);
}

function fmtElapsed(ms) {
  const s   = Math.floor(ms / 1000);
  const pad = n => String(n).padStart(2, '0');
  return `${pad(Math.floor(s / 60))}:${pad(s % 60)}`;
}

function startTimer(startedAt) {
  elapsedStart = startedAt || Date.now();
  const tick = () => {
    const raw = fmtElapsed(Date.now() - elapsedStart);
    el.elapsed.textContent = getLanguage() === 'fa' ? toFarsi(raw) : raw;
  };
  tick();
  elapsedTimer = setInterval(tick, 1000);
}

function stopTimer() {
  if (elapsedTimer) { clearInterval(elapsedTimer); elapsedTimer = null; }
}

function setProcessingStep(status) {
  el.stepTrans.className = 'step-item';
  el.stepSum.className   = 'step-item';

  const msgs = {
    saving:       t('processingSaving'),
    transcribing: t('processingTranscribing'),
    summarizing:  currentMode === 'notes' ? t('processingSummarizingNotes') : t('processingSummarizingMom'),
  };
  el.procMsg.textContent = msgs[status] || t('processingDefault');

  if (status === 'saving') {
    // No step highlighted while saving
  } else if (status === 'transcribing') {
    el.stepTrans.classList.add('active');
  } else if (status === 'summarizing') {
    el.stepTrans.classList.add('done');
    el.stepSum.classList.add('active');
  }
}

function showError(msg) {
  stopTimer();
  stopPolling();
  el.errorMsg.textContent = msg;
  showState('error');
}

function displayResult(mom) {
  const isNotes = mom.mode === 'notes';
  el.momCard.classList.toggle('hidden', isNotes);
  el.notesCard.classList.toggle('hidden', !isNotes);
  el.transcriptSection.classList.toggle('hidden', isNotes);

  // Generated content (summary/decisions/notes/transcript) follows the
  // recording's own generation language, not necessarily the live UI
  // language — e.g. viewing an English-generated recording while the UI
  // is currently toggled to Persian must still render that content LTR.
  const contentDir = (mom.language || getLanguage()) === 'fa' ? 'rtl' : 'ltr';
  el.momCard.setAttribute('dir', contentDir);
  el.resultNotesList.setAttribute('dir', contentDir);
  el.transcript.setAttribute('dir', contentDir);

  if (isNotes) {
    renderNotesList(mom.notes, el.resultNotesList, el.resultNotesEmpty);
  } else {
    el.summary.textContent   = mom.summary      || '—';
    el.decisions.textContent = mom.decisions    || '—';
    el.actions.textContent   = mom.action_items || '—';
  }

  updateTranscriptSection(mom);
  showState('result');
}

function updateTranscriptSection(mom) {
  const correctionDone = !!mom.corrected_transcript;
  const correcting     = mom.correction_status === 'correcting';

  el.transcriptRequest.classList.toggle('hidden', correctionDone || correcting);
  el.transcriptLoading.classList.toggle('hidden', !correcting);
  el.transcriptDone.classList.toggle('hidden',    !correctionDone);

  if (correctionDone) {
    el.transcript.textContent = mom.corrected_transcript;
    el.transcript.classList.add('hidden');
    el.transcriptChevron.classList.remove('open');
  }
}

function momFromRecord(rec) {
  return {
    id:                   rec.id,
    title:                rec.title                || null,
    mode:                 rec.mode                 || 'mom',
    language:             rec.language              || null,
    notes:                rec.notes                || '',
    summary:              rec.summary              || '',
    decisions:            rec.decisions            || '',
    action_items:         rec.action_items         || '',
    transcript:           rec.transcript           || '',
    corrected_transcript: rec.corrected_transcript || '',
    correction_status:    rec.correction_status    || null,
  };
}

// ── Polling ───────────────────────────────────────────────────────

function stopPolling() {
  if (pollingTimer) { clearInterval(pollingTimer); pollingTimer = null; }
}

function startPolling(recordingId) {
  stopPolling();

  async function poll() {
    try {
      const rec = await getRecording(recordingId);
      if (!rec) return;

      if (rec.status === 'done') {
        stopPolling();
        const mom = momFromRecord(rec);
        currentMOM = mom;
        await saveSession({ popupState: 'result', currentMOM: mom });
        displayResult(mom);

      } else if (rec.status === 'error') {
        stopPolling();
        const msg = rec.error || t('processingFailed');
        await saveSession({ popupState: 'error', errorMsg: msg });
        showError(msg);

      } else {
        setProcessingStep(rec.status);
      }
    } catch (_) { /* transient — keep polling */ }
  }

  poll();
  pollingTimer = setInterval(poll, 3000);
}

// ── Audio Player ──────────────────────────────────────────────────

const PLAY_ICON  = `<svg width="9" height="11" viewBox="0 0 9 11" fill="currentColor"><path d="M0 0l9 5.5L0 11z"/></svg>`;
const PAUSE_ICON = `<svg width="9" height="11" viewBox="0 0 9 11" fill="currentColor"><rect x="0" y="0" width="3" height="11" rx="1"/><rect x="5.5" y="0" width="3" height="11" rx="1"/></svg>`;

// m:ss, or h:mm:ss from an hour up. 0:00 for anything unknown.
function fmtClock(s) {
  if (!s || isNaN(s) || !isFinite(s)) return '0:00';
  const total = Math.floor(s);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = String(total % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

// Length in seconds of a recording blob, or null if it can't be read.
// A WebM with no duration in its header (recordings made before the duration
// patch) loads with duration = Infinity; seeking far past the end makes Chrome
// scan to the real end and then report the true length.
function probeDuration(blob) {
  return new Promise((resolve) => {
    const audio = new Audio();
    const url   = URL.createObjectURL(blob);
    let settled = false;

    const finish = (value) => {
      if (settled) return;
      settled = true;
      audio.removeAttribute('src');
      audio.load();
      URL.revokeObjectURL(url);
      resolve(value);
    };
    const ifKnown = () => { if (isFinite(audio.duration) && audio.duration > 0) finish(audio.duration); };

    audio.preload = 'metadata';
    audio.onerror = () => finish(null);
    audio.ondurationchange = ifKnown;
    audio.onloadedmetadata = () => {
      ifKnown();
      if (!settled) audio.currentTime = 1e101;   // length unknown: force the scan
    };
    setTimeout(() => finish(null), 10_000);      // never hang the list on one bad file
    audio.src = url;
  });
}

class AudioPlayer {
  constructor() {
    this._audio     = new Audio();
    this._id        = null;
    this._objectUrl = null;
    this._hint      = 0;   // known length (s) of the loaded recording, for when <audio> can't report one

    this._audio.addEventListener('timeupdate',      () => this._sync());
    this._audio.addEventListener('ended',           () => this._onEnd());
    this._audio.addEventListener('loadedmetadata',  () => this._onLoad());
  }

  async toggle(id) {
    if (this._id === id && !this._audio.paused) {
      this._audio.pause();
      this._setBtn(id, false);
      return;
    }
    if (this._id && this._id !== id) this._setBtn(this._id, false);

    if (this._id !== id) {
      const rec = await getRecording(id);
      if (!rec?.audioBlob) return;
      if (this._objectUrl) URL.revokeObjectURL(this._objectUrl);
      this._hint = rec.durationMs > 0 ? rec.durationMs / 1000 : 0;
      this._objectUrl = URL.createObjectURL(rec.audioBlob);
      this._audio.src = this._objectUrl;
    }

    this._id = id;
    this._audio.play().catch(e => console.warn('[player]', e.message));
    this._setBtn(id, true);
  }

  seekTo(id, fraction) {
    const dur = this._dur();
    if (this._id === id && dur) {
      this._audio.currentTime = fraction * dur;
    }
  }

  // True for the recording that currently owns the player — playing, or paused
  // part-way through. Its card's time/progress are the player's to draw.
  owns(id) { return this._id === id; }

  // The list is rebuilt from scratch on every refresh (coming back from a
  // result, polling while something processes, a delete) and that puts every
  // card back to its idle look while the audio element carries on playing
  // underneath. Re-apply what is actually happening, and bring the card into
  // view so there is something to press to stop it.
  refreshUI() {
    if (!this._id) return;
    const card = this._card();
    if (!card) return;               // deleted, or past the 40 shown

    const playing = !this._audio.paused;
    this._setBtn(this._id, playing);
    this._sync();
    if (playing) card.scrollIntoView({ block: 'nearest' });
  }

  _card()  { return document.querySelector(`[data-rec-id="${this._id}"]`); }

  _setBtn(id, playing) {
    const card = document.querySelector(`[data-rec-id="${id}"]`);
    const btn  = card?.querySelector('.play-btn');
    if (btn) btn.innerHTML = playing ? PAUSE_ICON : PLAY_ICON;
    card?.classList.toggle('playing', playing);
  }

  // <audio> reports Infinity for a WebM with no duration in its header (every
  // recording made before the duration patch), so fall back to the length we
  // measured and stored.
  _dur() {
    const d = this._audio.duration;
    return isFinite(d) && d > 0 ? d : this._hint;
  }

  _fmt(s) { return fmtClock(s); }

  _sync() {
    const card = this._card();
    if (!card) return;
    const fill = card.querySelector('.progress-fill');
    const time = card.querySelector('.player-time');
    const dur  = this._dur();
    const pct  = dur ? Math.min(100, (this._audio.currentTime / dur) * 100) : 0;
    if (fill) fill.style.width = `${pct}%`;
    if (time) time.textContent =
      `${this._fmt(this._audio.currentTime)} / ${this._fmt(dur)}`;
  }

  _onEnd() {
    this._setBtn(this._id, false);
    const card = this._card();
    const fill = card?.querySelector('.progress-fill');
    const time = card?.querySelector('.player-time');
    if (fill) fill.style.width = '0%';
    if (time) time.textContent = `0:00 / ${this._fmt(this._dur())}`;
    this._id = null;
  }

  _onLoad() {
    const time = this._card()?.querySelector('.player-time');
    if (time) time.textContent = `0:00 / ${this._fmt(this._dur())}`;
  }
}

const player = new AudioPlayer();

// ── Recordings List ───────────────────────────────────────────────

const PENCIL_SVG = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`;
const CHECK_SVG  = `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
const CLOSE_SVG  = `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtDate(createdAt) {
  const d      = new Date(createdAt);
  const locale = getLanguage() === 'fa' ? 'fa-IR' : 'en-US';
  return d.toLocaleDateString(locale) + ' ' +
         d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
}

function buildMeta(r) {
  const date = fmtDate(r.createdAt);
  return `
    <div class="rec-title-row">
      <span class="rec-title-text${r.title ? ' has-title' : ''}">${r.title ? escapeHtml(r.title) : date}</span>
      <button class="rec-edit-btn" title="${t('editNameTitle')}" aria-label="${t('editNameTitle')}">${PENCIL_SVG}</button>
    </div>
    ${r.title ? `<span class="rec-date-sub" dir="ltr">${date}</span>` : ''}
  `;
}

function wireMeta(meta, rec) {
  if (!meta) return;
  const editBtn   = meta.querySelector('.rec-edit-btn');
  const titleText = meta.querySelector('.rec-title-text');
  if (editBtn)   editBtn.addEventListener('click',   e => { e.stopPropagation(); enterTitleEdit(meta, rec); });
  if (titleText) titleText.addEventListener('click', e => { e.stopPropagation(); enterTitleEdit(meta, rec); });
}

function enterTitleEdit(meta, rec) {
  if (meta.dataset.editing) return;
  meta.dataset.editing = '1';

  meta.innerHTML = `
    <div class="rec-title-edit-row">
      <input class="rec-title-input" type="text" value="${escapeHtml(rec.title || '')}"
             placeholder="${t('meetingNamePlaceholder')}" maxlength="80">
      <button class="title-action-btn title-save-btn"   title="${t('saveEnterTitle')}">${CHECK_SVG}</button>
      <button class="title-action-btn title-cancel-btn" title="${t('cancelEscTitle')}">${CLOSE_SVG}</button>
    </div>
  `;

  const input     = meta.querySelector('.rec-title-input');
  const saveBtn   = meta.querySelector('.title-save-btn');
  const cancelBtn = meta.querySelector('.title-cancel-btn');

  input.focus();

  async function doSave() {
    if (!meta.dataset.editing) return;
    delete meta.dataset.editing;
    const newTitle = input.value.trim().slice(0, 80) || null;
    try {
      await updateRecording(rec.id, { title: newTitle });
      rec.title = newTitle;
    } catch (_) { /* silently revert to old title */ }
    meta.innerHTML = buildMeta(rec);
    wireMeta(meta, rec);
  }

  function doCancel() {
    if (!meta.dataset.editing) return;
    delete meta.dataset.editing;
    meta.innerHTML = buildMeta(rec);
    wireMeta(meta, rec);
  }

  // Prevent input blur when clicking action buttons
  saveBtn.addEventListener('mousedown',   e => e.preventDefault());
  cancelBtn.addEventListener('mousedown', e => e.preventDefault());
  saveBtn.addEventListener('click',   doSave);
  cancelBtn.addEventListener('click',  doCancel);

  input.addEventListener('keydown', e => {
    if (e.key === 'Enter')  { e.preventDefault(); doSave();   }
    if (e.key === 'Escape') { e.preventDefault(); doCancel(); }
  });
  input.addEventListener('blur', doSave);
}

// Cards are drawn with a 0:00 length; this fills in the real one. Measured once
// per recording and stored on it, so later refreshes are just a text write.
let durationRun = 0;
async function fillDurations(recs) {
  const run = ++durationRun;
  for (const r of recs) {
    if (run !== durationRun) return;   // a newer render has taken over

    let seconds = r.durationMs > 0 ? r.durationMs / 1000 : 0;
    if (!seconds && r.audioBlob) {
      seconds = (await probeDuration(r.audioBlob)) || 0;
      if (seconds) {
        r.durationMs = Math.round(seconds * 1000);
        updateRecording(r.id, { durationMs: r.durationMs }).catch(() => {});
      }
    }
    if (!seconds || player.owns(r.id)) continue;   // the player draws its own card

    const time = document.querySelector(`[data-rec-id="${r.id}"] .player-time`);
    if (time) time.textContent = `0:00 / ${fmtClock(seconds)}`;
  }
}

async function loadRecordingsList() {
  el.recList.innerHTML = `<div class="rec-empty">${t('loading')}</div>`;
  try {
    const list = await listRecordings();

    if (!list.length) {
      el.recList.innerHTML = `<div class="rec-empty">${t('noRecordingsYet')}</div>`;
      return;
    }

    const shown = list.slice(0, 40);
    el.recList.innerHTML = shown.map(r => buildCard(r)).join('');
    wireCardEvents(list);
    player.refreshUI();
    fillDurations(shown).catch(err => console.warn('[popup] fillDurations:', err));

  } catch (err) {
    console.error('[popup] loadRecordingsList error:', err);
    el.recList.innerHTML = `<div class="rec-empty">${t('errorLoadingRecordings')}</div>`;
  }
}

function buildCard(r) {
  const labels = {
    saved:        t('badgeSaved'),
    done:         t('badgeDone'),
    transcribing: t('badgeTranscribing'),
    summarizing:  t('badgeSummarizing'),
    error:        t('badgeError'),
  };
  const badge  = labels[r.status] || r.status;
  const hasAudio = true; // every record has an inline audioBlob in this variant
  const busy     = ['transcribing', 'summarizing'].includes(r.status);

  const playerHTML = hasAudio ? `
    <div class="rec-player">
      <button class="play-btn" data-play="${r.id}">${PLAY_ICON}</button>
      <div class="progress-track" data-seek="${r.id}">
        <div class="progress-fill" style="width:0%"></div>
      </div>
      <span class="player-time">0:00 / 0:00</span>
    </div>` : '';

  let actionsHTML = '';
  if (busy) {
    actionsHTML = `
      <div class="rec-actions">
        <div class="rec-processing-row">
          <div class="mini-spinner"></div>
          <span>${badge}</span>
        </div>
        <button class="btn btn-sm btn-ghost" data-cancel="${r.id}">${t('cancel')}</button>
        <span class="spacer"></span>
        <button class="btn-delete" data-del="${r.id}" title="${t('deleteTitle')}">×</button>
      </div>`;
  } else if (r.status === 'saved' || r.status === 'error') {
    actionsHTML = `
      <div class="rec-actions">
        <button class="btn btn-sm btn-violet-outline" data-process="${r.id}">${t('process')}</button>
        <span class="spacer"></span>
        <button class="btn-delete" data-del="${r.id}" title="${t('deleteTitle')}">×</button>
      </div>`;
  } else if (r.status === 'done') {
    actionsHTML = `
      <div class="rec-actions">
        <button class="btn btn-sm btn-green-outline" data-view="${r.id}">${t('viewResult')}</button>
        <span class="spacer"></span>
        <button class="btn-delete" data-del="${r.id}" title="${t('deleteTitle')}">×</button>
      </div>`;
  }

  const badgeHTML = r.status === 'done'
    ? `<div class="rec-badge-stack">
        <span class="badge badge-done">${badge}</span>
        ${r.mode ? `<span class="badge rec-mode-badge rec-mode-badge--${r.mode}">${r.mode === 'mom' ? t('modeMeeting') : t('modeNotes')}</span>` : ''}
       </div>`
    : `<span class="badge badge-${r.status}">${badge}</span>`;

  return `
    <div class="rec-card" data-rec-id="${r.id}">
      <div class="rec-top">
        <div class="rec-meta">${buildMeta(r)}</div>
        ${badgeHTML}
      </div>
      ${playerHTML}
      ${actionsHTML}
    </div>`;
}

function wireCardEvents(list) {
  // Play buttons
  el.recList.querySelectorAll('[data-play]').forEach(btn => {
    btn.addEventListener('click', () => player.toggle(btn.dataset.play));
  });

  // Seek on progress bar click
  el.recList.querySelectorAll('[data-seek]').forEach(track => {
    track.addEventListener('click', e => {
      const rect = track.getBoundingClientRect();
      player.seekTo(track.dataset.seek, (e.clientX - rect.left) / rect.width);
    });
  });

  // View result
  el.recList.querySelectorAll('[data-view]').forEach(btn => {
    btn.addEventListener('click', () => {
      const r = list.find(x => x.id === btn.dataset.view);
      if (!r) return;
      currentMOM = momFromRecord(r);
      displayResult(currentMOM);
    });
  });

  // Process
  el.recList.querySelectorAll('[data-process]').forEach(btn => {
    btn.addEventListener('click', () => triggerProcess(btn.dataset.process, currentMode));
  });

  // Cancel (busy list cards)
  el.recList.querySelectorAll('[data-cancel]').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      await sendMessage({ type: 'CANCEL_PROCESSING', id: btn.dataset.cancel });
      loadRecordingsList();
    });
  });

  // Delete
  el.recList.querySelectorAll('[data-del]').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      await deleteRecording(btn.dataset.del).catch(() => {});
      loadRecordingsList();
    });
  });

  // Title editing
  el.recList.querySelectorAll('.rec-card').forEach(card => {
    const rec = list.find(x => x.id === card.dataset.recId);
    if (rec) wireMeta(card.querySelector('.rec-meta'), rec);
  });
}

async function triggerProcess(id, mode = 'mom') {
  currentProcessingId = id;
  showState('processing');
  setProcessingStep('transcribing');
  await saveSession({ popupState: 'processing', recordingId: id, currentMode: mode });

  // The recording's generation language is pinned at process time (from
  // whatever the UI is currently set to) and stored on the record itself —
  // a later UI toggle must not retroactively change what this recording
  // was generated in. See background.js's beginProcessing().
  await sendMessage({ type: 'PROCESS_RECORDING', id, mode, language: getLanguage() });
  startPolling(id);
}

el.btnCancelProcessing.addEventListener('click', async () => {
  if (!currentProcessingId) return;
  const id = currentProcessingId;
  currentProcessingId = null;
  await sendMessage({ type: 'CANCEL_PROCESSING', id });
  resetToIdle();
});

// ── Correct transcript ────────────────────────────────────────────

el.btnCorrect.addEventListener('click', async () => {
  if (!currentMOM?.id) return;

  currentMOM.correction_status = 'correcting';
  updateTranscriptSection(currentMOM);

  await sendMessage({ type: 'CORRECT_TRANSCRIPT', id: currentMOM.id });
  pollCorrection(currentMOM.id);
});

function pollCorrection(id) {
  const timer = setInterval(async () => {
    try {
      const rec = await getRecording(id);
      if (!rec) return;

      if (rec.correction_status === 'done') {
        clearInterval(timer);
        currentMOM.corrected_transcript = rec.corrected_transcript || '';
        currentMOM.correction_status    = 'done';
        await saveSession({ currentMOM });
        updateTranscriptSection(currentMOM);
      } else if (rec.correction_status === 'error') {
        clearInterval(timer);
        currentMOM.correction_status = null;
        updateTranscriptSection(currentMOM);
      }
    } catch (_) {}
  }, 3000);
}

// ── Start ─────────────────────────────────────────────────────────

el.btnStart.addEventListener('click', async () => {
  // Mic permission: never request the initial grant from the popup itself —
  // the popup auto-closes on blur, which the native permission bubble
  // triggers, and Chrome then remembers the interrupted request as "denied"
  // with no way to re-prompt except via chrome://settings. Instead, check
  // state here and hand off to a stable full-tab page when not yet granted.
  const micState = await checkMicPermission();

  if (micState === 'denied') {
    openMicPermissionTab();
    showError(t('micDeniedRetry'));
    return;
  }

  if (micState === 'prompt') {
    openMicPermissionTab();
    showError(t('micPromptOpened'));
    return;
  }

  if (micState === 'unsupported') {
    // Fallback for browsers without permissions.query('microphone') support
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      s.getTracks().forEach(t => t.stop());
    } catch (err) {
      if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
        showError(t('micDenied'));
        return;
      }
    }
  }

  el.recModeLabel.textContent = currentMode === 'notes' ? t('modeNotes') : t('modeMeeting');
  showState('recording');
  startTimer();

  chrome.runtime.sendMessage({ type: 'START_RECORDING' }, response => {
    if (chrome.runtime.lastError || !response?.success) {
      stopTimer();
      showState('idle');
      loadRecordingsList();
      showError(t('recordingNotStarted', { error: response?.error || chrome.runtime.lastError?.message || t('badgeError') }));
      return;
    }
    if (response.startedAt) elapsedStart = response.startedAt;
  });
});

// ── Stop ──────────────────────────────────────────────────────────

el.btnStop.addEventListener('click', () => {
  stopTimer();
  showState('processing');
  setProcessingStep('saving');

  chrome.runtime.sendMessage({ type: 'STOP_RECORDING' }, async response => {
    if (chrome.runtime.lastError || !response?.success) {
      const msg = response?.error || chrome.runtime.lastError?.message || t('errorStoppingRecording');
      await saveSession({ popupState: 'error', errorMsg: msg });
      showError(msg);
      return;
    }
    // Offscreen doc already wrote the recording to IndexedDB
    await clearSession();
    showState('idle');
    await loadRecordingsList();
  });
});

// ── Save MOM ──────────────────────────────────────────────────────

el.btnSave.addEventListener('click', () => {
  if (!currentMOM) return;
  const now  = new Date();
  const date = now.toISOString().slice(0, 10);
  const time = now.toTimeString().slice(0, 5);
  const sanitize = str => str.replace(/[<>:"/\\|?*]/g, '').trim().replace(/\s+/g, '_').slice(0, 40);

  // Export headings follow the recording's own generation language, not
  // necessarily the live UI language (see displayResult()'s contentDir).
  const lang = currentMOM.language || getLanguage();

  let md, safeTitle;
  if (currentMOM.mode === 'notes') {
    const heading = currentMOM.title
      ? `# ${currentMOM.title}\n*${date} ${time}*`
      : `${tFor('exportNoteHeading', lang)}\n*${date} ${time}*`;
    md = [
      heading, '',
      tFor('exportNotesSection', lang), currentMOM.notes || '—', '',
      '---', tFor('exportGeneratedBy', lang),
    ].join('\n');
    safeTitle = currentMOM.title ? sanitize(currentMOM.title) : 'Notes';
  } else {
    const heading = currentMOM.title
      ? `# ${currentMOM.title} — ${date} ${time}`
      : `${tFor('exportMomHeading', lang)} — ${date} ${time}`;
    md = [
      heading, '',
      tFor('exportSummarySection', lang), currentMOM.summary || '—', '',
      tFor('exportDecisionsSection', lang), currentMOM.decisions || '—', '',
      tFor('exportActionsSection', lang), currentMOM.action_items || '—', '',
      ...(currentMOM.corrected_transcript ? [
        '---', tFor('exportCorrectedSection', lang), currentMOM.corrected_transcript, '',
      ] : []),
      '---', tFor('exportGeneratedBy', lang),
    ].join('\n');
    safeTitle = currentMOM.title ? sanitize(currentMOM.title) : 'MOM';
  }

  const a = Object.assign(document.createElement('a'), {
    href:     URL.createObjectURL(new Blob([md], { type: 'text/markdown;charset=utf-8' })),
    download: `${safeTitle}_${date}_${time.replace(':', '-')}.md`,
  });
  a.click();
  URL.revokeObjectURL(a.href);
});

// ── Back / Reset ──────────────────────────────────────────────────

async function resetToIdle() {
  stopPolling();
  stopTimer();
  currentMOM = null;
  currentProcessingId = null;
  await clearSession();
  showState('idle');
  loadRecordingsList();
}

el.btnNew.addEventListener('click',     resetToIdle);
el.btnRetry.addEventListener('click',   resetToIdle);
el.btnRefresh?.addEventListener('click', loadRecordingsList);

el.btnTranscript.addEventListener('click', () => {
  const open = !el.transcript.classList.contains('hidden');
  el.transcript.classList.toggle('hidden', open);
  el.transcriptChevron.classList.toggle('open', !open);
});

// ── Language toggle ───────────────────────────────────────────────

el.langToggle.addEventListener('click', async () => {
  const next = getLanguage() === 'fa' ? 'en' : 'fa';
  await setLanguage(next);
  applyTranslations(document);
  applyModeToggle(currentMode);
  loadRecordingsList();
  if (currentMOM) displayResult(currentMOM);
});

// ── Init ──────────────────────────────────────────────────────────

async function init() {
  await bootLanguage();

  // Load persisted mode preference
  const { defaultMode } = await new Promise(r => chrome.storage.local.get(['defaultMode'], r));
  const saved = await loadSession();
  currentMode = saved.currentMode || defaultMode || 'mom';
  applyModeToggle(currentMode);

  // Wire mode toggle
  document.querySelectorAll('.mode-toggle-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      currentMode = btn.dataset.mode;
      applyModeToggle(currentMode);
      chrome.storage.local.set({ defaultMode: currentMode });
    });
  });

  // Check active recording in background first
  const bg = await new Promise(r =>
    chrome.runtime.sendMessage({ type: 'GET_STATE' }, res =>
      r(chrome.runtime.lastError ? {} : (res || {}))
    )
  );

  if (bg.isRecording) {
    showState('recording');
    startTimer(bg.startedAt);
    return;
  }

  if (saved.popupState === 'processing' && saved.recordingId) {
    currentProcessingId = saved.recordingId;
    showState('processing');
    setProcessingStep('transcribing');
    startPolling(saved.recordingId);
    return;
  }

  if (saved.popupState === 'result' && saved.currentMOM) {
    currentMOM = saved.currentMOM;
    displayResult(currentMOM);
    return;
  }

  if (saved.popupState === 'error' && saved.errorMsg) {
    showError(saved.errorMsg);
    return;
  }

  showState('idle');
  loadRecordingsList();
}

init();
