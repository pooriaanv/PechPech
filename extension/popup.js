/**
 * popup.js — PechPech
 *
 * Flow:
 *   idle → recording → [uploading] → idle (recording in list with Process button)
 *   idle → click Process on list item → processing → result
 *
 * State (processing / result / error) is persisted in chrome.storage.session
 * so reopening the popup restores exactly where the user left off.
 */

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
};

// ── Runtime state ─────────────────────────────────────────────────

let elapsedTimer  = null;
let elapsedStart  = null;
let pollingTimer  = null;
let currentMOM    = null;
let currentMode   = 'mom'; // 'mom' | 'notes'

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
  el.heroLabel.textContent = mode === 'notes' ? 'شروع یادداشت صوتی' : 'شروع ضبط جلسه';
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
  const tick = () =>
    (el.elapsed.textContent = toFarsi(fmtElapsed(Date.now() - elapsedStart)));
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
    uploading:    'در حال آپلود صدا…',
    processing:   'در حال رونویسی…',
    transcribing: 'در حال رونویسی…',
    summarizing:  currentMode === 'notes' ? 'در حال استخراج یادداشت‌ها…' : 'در حال تولید صورت‌جلسه…',
  };
  el.procMsg.textContent = msgs[status] || 'در حال پردازش…';

  if (status === 'uploading') {
    // No step highlighted during upload
  } else if (status === 'processing' || status === 'transcribing') {
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

function loadSettings() {
  return new Promise(r =>
    chrome.storage.local.get(['helperPort'], r)
  );
}

// ── Polling ───────────────────────────────────────────────────────

function stopPolling() {
  if (pollingTimer) { clearInterval(pollingTimer); pollingTimer = null; }
}

function startPolling(recordingId) {
  stopPolling();

  async function poll() {
    try {
      const { helperPort } = await loadSettings();
      const port = helperPort || 3456;
      const res  = await fetch(`http://localhost:${port}/recordings/${recordingId}`, {
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) return;

      const rec = await res.json();

      if (rec.status === 'done') {
        stopPolling();
        const mom = {
          id:                   rec.id,
          title:                rec.title                 || null,
          mode:                 rec.mode                  || 'mom',
          notes:                rec.notes                 || '',
          summary:              rec.summary               || '',
          decisions:            rec.decisions             || '',
          action_items:         rec.action_items          || '',
          transcript:           rec.transcript            || '',
          corrected_transcript: rec.corrected_transcript  || '',
          correction_status:    rec.correction_status     || null,
        };
        currentMOM = mom;
        await saveSession({ popupState: 'result', currentMOM: mom });
        displayResult(mom);

      } else if (rec.status === 'error') {
        stopPolling();
        const msg = rec.error || 'پردازش با خطا مواجه شد.';
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

class AudioPlayer {
  constructor() {
    this._audio = new Audio();
    this._id    = null;
    this._port  = 3456;

    this._audio.addEventListener('timeupdate',      () => this._sync());
    this._audio.addEventListener('ended',           () => this._onEnd());
    this._audio.addEventListener('loadedmetadata',  () => this._onLoad());
  }

  setPort(p) { this._port = p; }

  toggle(id) {
    if (this._id === id && !this._audio.paused) {
      this._audio.pause();
      this._setBtn(id, false);
      return;
    }
    if (this._id && this._id !== id) this._setBtn(this._id, false);

    this._id = id;
    this._audio.src = `http://localhost:${this._port}/recordings/${id}/audio`;
    this._audio.play().catch(e => console.warn('[player]', e.message));
    this._setBtn(id, true);
  }

  seekTo(id, fraction) {
    if (this._id === id && this._audio.duration) {
      this._audio.currentTime = fraction * this._audio.duration;
    }
  }

  _card()  { return document.querySelector(`[data-rec-id="${this._id}"]`); }

  _setBtn(id, playing) {
    const card = document.querySelector(`[data-rec-id="${id}"]`);
    const btn  = card?.querySelector('.play-btn');
    if (btn) btn.innerHTML = playing ? PAUSE_ICON : PLAY_ICON;
  }

  _fmt(s) {
    if (!s || isNaN(s) || !isFinite(s)) return '0:00';
    return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  }

  _sync() {
    const card = this._card();
    if (!card) return;
    const fill = card.querySelector('.progress-fill');
    const time = card.querySelector('.player-time');
    const pct  = this._audio.duration
      ? (this._audio.currentTime / this._audio.duration) * 100 : 0;
    if (fill) fill.style.width = `${pct}%`;
    if (time) time.textContent =
      `${this._fmt(this._audio.currentTime)} / ${this._fmt(this._audio.duration)}`;
  }

  _onEnd() {
    this._setBtn(this._id, false);
    const card = this._card();
    const fill = card?.querySelector('.progress-fill');
    const time = card?.querySelector('.player-time');
    if (fill) fill.style.width = '0%';
    if (time) time.textContent = `0:00 / ${this._fmt(this._audio.duration)}`;
    this._id = null;
  }

  _onLoad() {
    const time = this._card()?.querySelector('.player-time');
    if (time) time.textContent = `0:00 / ${this._fmt(this._audio.duration)}`;
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
  const d = new Date(createdAt);
  return d.toLocaleDateString('fa-IR') + ' ' +
         d.toLocaleTimeString('fa-IR', { hour: '2-digit', minute: '2-digit' });
}

function buildMeta(r) {
  const date = fmtDate(r.createdAt);
  return `
    <div class="rec-title-row">
      <span class="rec-title-text${r.title ? ' has-title' : ''}">${r.title ? escapeHtml(r.title) : date}</span>
      <button class="rec-edit-btn" title="ویرایش نام" aria-label="ویرایش نام">${PENCIL_SVG}</button>
    </div>
    ${r.title ? `<span class="rec-date-sub" dir="ltr">${date}</span>` : ''}
  `;
}

function wireMeta(meta, rec, port) {
  if (!meta) return;
  const editBtn   = meta.querySelector('.rec-edit-btn');
  const titleText = meta.querySelector('.rec-title-text');
  if (editBtn)   editBtn.addEventListener('click',   e => { e.stopPropagation(); enterTitleEdit(meta, rec, port); });
  if (titleText) titleText.addEventListener('click', e => { e.stopPropagation(); enterTitleEdit(meta, rec, port); });
}

function enterTitleEdit(meta, rec, port) {
  if (meta.dataset.editing) return;
  meta.dataset.editing = '1';

  meta.innerHTML = `
    <div class="rec-title-edit-row">
      <input class="rec-title-input" type="text" value="${escapeHtml(rec.title || '')}"
             placeholder="نام جلسه..." maxlength="80" dir="rtl">
      <button class="title-action-btn title-save-btn"   title="ذخیره (Enter)">${CHECK_SVG}</button>
      <button class="title-action-btn title-cancel-btn" title="انصراف (Esc)">${CLOSE_SVG}</button>
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
      await fetch(`http://localhost:${port}/recordings/${rec.id}`, {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ title: newTitle }),
      });
      rec.title = newTitle;
    } catch (_) { /* silently revert to old title */ }
    meta.innerHTML = buildMeta(rec);
    wireMeta(meta, rec, port);
  }

  function doCancel() {
    if (!meta.dataset.editing) return;
    delete meta.dataset.editing;
    meta.innerHTML = buildMeta(rec);
    wireMeta(meta, rec, port);
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

async function loadRecordingsList() {
  el.recList.innerHTML = '<div class="rec-empty">در حال بارگذاری…</div>';
  try {
    const settings = await loadSettings();
    const port = settings.helperPort || 3456;
    player.setPort(port);

    const res      = await fetch(`http://localhost:${port}/recordings`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) throw new Error();
    const list = await res.json();

    if (!list.length) {
      el.recList.innerHTML = '<div class="rec-empty">هنوز ضبطی وجود ندارد.</div>';
      return;
    }

    el.recList.innerHTML = list.slice(0, 40).map(r => buildCard(r)).join('');
    wireCardEvents(list, port, settings);

  } catch (_) {
    el.recList.innerHTML = '<div class="rec-empty">سرور در دسترس نیست.</div>';
  }
}

function buildCard(r) {
  const labels = {
    saved:        'ذخیره شده',
    done:         '✓ آماده',
    processing:   'پردازش…',
    transcribing: 'رونویسی…',
    summarizing:  'خلاصه‌سازی…',
    error:        'خطا',
  };
  const badge  = labels[r.status] || r.status;
  const hasAudio = ['saved', 'done', 'error', 'processing', 'transcribing', 'summarizing'].includes(r.status);
  const busy     = ['processing', 'transcribing', 'summarizing'].includes(r.status);

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
        <span class="spacer"></span>
        <button class="btn-delete" data-del="${r.id}" title="حذف">×</button>
      </div>`;
  } else if (r.status === 'saved' || r.status === 'error') {
    actionsHTML = `
      <div class="rec-actions">
        <button class="btn btn-sm btn-violet-outline" data-process="${r.id}">پردازش</button>
        <span class="spacer"></span>
        <button class="btn-delete" data-del="${r.id}" title="حذف">×</button>
      </div>`;
  } else if (r.status === 'done') {
    actionsHTML = `
      <div class="rec-actions">
        <button class="btn btn-sm btn-green-outline" data-view="${r.id}">مشاهده نتیجه</button>
        <span class="spacer"></span>
        <button class="btn-delete" data-del="${r.id}" title="حذف">×</button>
      </div>`;
  }

  const badgeHTML = r.status === 'done'
    ? `<div class="rec-badge-stack">
        <span class="badge badge-done">${badge}</span>
        ${r.mode ? `<span class="badge rec-mode-badge rec-mode-badge--${r.mode}">${r.mode === 'mom' ? 'جلسه' : 'یادداشت'}</span>` : ''}
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

function wireCardEvents(list, port, settings) {
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
      currentMOM = {
        id:                   r.id,
        title:                r.title                 || null,
        mode:                 r.mode                  || 'mom',
        notes:                r.notes                 || '',
        summary:              r.summary               || '',
        decisions:            r.decisions             || '',
        action_items:         r.action_items          || '',
        transcript:           r.transcript            || '',
        corrected_transcript: r.corrected_transcript  || '',
        correction_status:    r.correction_status     || null,
      };
      displayResult(currentMOM);
    });
  });

  // Process
  el.recList.querySelectorAll('[data-process]').forEach(btn => {
    btn.addEventListener('click', () => triggerProcess(btn.dataset.process, port, settings, currentMode));
  });

  // Delete
  el.recList.querySelectorAll('[data-del]').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      await fetch(`http://localhost:${port}/recordings/${btn.dataset.del}`, {
        method: 'DELETE',
      }).catch(() => {});
      loadRecordingsList();
    });
  });

  // Title editing
  el.recList.querySelectorAll('.rec-card').forEach(card => {
    const rec = list.find(x => x.id === card.dataset.recId);
    if (rec) wireMeta(card.querySelector('.rec-meta'), rec, port);
  });
}

async function triggerProcess(id, port, settings, mode = 'mom') {
  showState('processing');
  setProcessingStep('processing');
  await saveSession({ popupState: 'processing', recordingId: id, currentMode: mode });

  try {
    const res = await fetch(`http://localhost:${port}/recordings/${id}/process`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ mode }),
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Server error ${res.status}`);

    startPolling(data.id || id);

  } catch (err) {
    await saveSession({ popupState: 'error', errorMsg: err.message });
    showError(err.message);
  }
}

// ── Correct transcript ────────────────────────────────────────────

el.btnCorrect.addEventListener('click', async () => {
  if (!currentMOM?.id) return;
  const settings = await loadSettings();
  const port     = settings.helperPort || 3456;

  currentMOM.correction_status = 'correcting';
  updateTranscriptSection(currentMOM);

  try {
    await fetch(`http://localhost:${port}/recordings/${currentMOM.id}/correct`, {
      method: 'POST',
    });
  } catch (err) {
    currentMOM.correction_status = null;
    updateTranscriptSection(currentMOM);
    return;
  }

  pollCorrection(currentMOM.id, port);
});

function pollCorrection(id, port) {
  const timer = setInterval(async () => {
    try {
      const res = await fetch(`http://localhost:${port}/recordings/${id}`, {
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) return;
      const rec = await res.json();

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
    showError('دسترسی میکروفون قبلاً رد شده است.\nیک تب جدید باز شد — طبق راهنما دسترسی را فعال کنید، سپس به اینجا برگردید و دوباره «شروع ضبط» را بزنید.');
    return;
  }

  if (micState === 'prompt') {
    openMicPermissionTab();
    showError('یک تب جدید برای دسترسی میکروفون باز شد.\nپس از تایید دسترسی، به این پنجره برگردید و دوباره «شروع ضبط» را بزنید.');
    return;
  }

  if (micState === 'unsupported') {
    // Fallback for browsers without permissions.query('microphone') support
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      s.getTracks().forEach(t => t.stop());
    } catch (err) {
      if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
        showError('دسترسی به میکروفون رد شد.\nلطفاً در تنظیمات Chrome دسترسی میکروفون را فعال کنید.');
        return;
      }
    }
  }

  // Health check
  try {
    const { helperPort } = await loadSettings();
    const probe = await fetch(`http://localhost:${helperPort || 3456}/health`, {
      signal: AbortSignal.timeout(2000),
    }).catch(() => null);
    if (!probe?.ok) {
      showError('سرور محلی در دسترس نیست.\nلطفاً local helper را اجرا کنید:\ncd local-helper && node server.js');
      return;
    }
  } catch (_) {}

  el.recModeLabel.textContent = currentMode === 'notes' ? 'یادداشت' : 'جلسه';
  showState('recording');
  startTimer();

  chrome.runtime.sendMessage({ type: 'START_RECORDING' }, response => {
    if (chrome.runtime.lastError || !response?.success) {
      stopTimer();
      showState('idle');
      loadRecordingsList();
      showError(`ضبط شروع نشد: ${response?.error || chrome.runtime.lastError?.message || 'خطا'}`);
      return;
    }
    if (response.startedAt) elapsedStart = response.startedAt;
  });
});

// ── Stop ──────────────────────────────────────────────────────────

el.btnStop.addEventListener('click', () => {
  stopTimer();
  showState('processing');
  setProcessingStep('uploading');
  el.procMsg.textContent = 'در حال ذخیره‌سازی ضبط…';

  chrome.runtime.sendMessage({ type: 'STOP_RECORDING' }, async response => {
    if (chrome.runtime.lastError || !response?.success) {
      const msg = response?.error || chrome.runtime.lastError?.message || 'خطا در توقف ضبط';
      await saveSession({ popupState: 'error', errorMsg: msg });
      showError(msg);
      return;
    }
    // Offscreen doc uploaded directly to server — recording is already saved
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
  const sanitize = t => t.replace(/[<>:"/\\|?*]/g, '').trim().replace(/\s+/g, '_').slice(0, 40);

  let md, safeTitle;
  if (currentMOM.mode === 'notes') {
    const heading = currentMOM.title
      ? `# ${currentMOM.title}\n*${date} ${time}*`
      : `# یادداشت\n*${date} ${time}*`;
    md = [
      heading, '',
      '## یادداشت‌ها', currentMOM.notes || '—', '',
      '---', '*تولید شده توسط PechPech*',
    ].join('\n');
    safeTitle = currentMOM.title ? sanitize(currentMOM.title) : 'Notes';
  } else {
    const heading = currentMOM.title
      ? `# ${currentMOM.title} — ${date} ${time}`
      : `# صورت‌جلسه — ${date} ${time}`;
    md = [
      heading, '',
      '## خلاصه', currentMOM.summary || '—', '',
      '## تصمیمات', currentMOM.decisions || '—', '',
      '## اقدامات', currentMOM.action_items || '—', '',
      ...(currentMOM.corrected_transcript ? [
        '---', '## متن اصلاح‌شده', currentMOM.corrected_transcript, '',
      ] : []),
      '---', '*تولید شده توسط PechPech*',
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

// ── Init ──────────────────────────────────────────────────────────

async function init() {
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
    showState('processing');
    setProcessingStep('processing');
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
