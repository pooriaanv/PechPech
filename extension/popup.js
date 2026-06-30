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
};

// ── Runtime state ─────────────────────────────────────────────────

let elapsedTimer  = null;
let elapsedStart  = null;
let pollingTimer  = null;
let currentMOM    = null;

// ── Session state helpers ─────────────────────────────────────────

const SESSION_KEYS = ['popupState', 'recordingId', 'currentMOM', 'errorMsg'];

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
    summarizing:  'در حال تولید صورت‌جلسه…',
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
  el.summary.textContent   = mom.summary      || '—';
  el.decisions.textContent = mom.decisions    || '—';
  el.actions.textContent   = mom.action_items || '—';

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
  const d     = new Date(r.createdAt);
  const date  = d.toLocaleDateString('fa-IR') + '  ' +
                d.toLocaleTimeString('fa-IR', { hour: '2-digit', minute: '2-digit' });
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

  return `
    <div class="rec-card" data-rec-id="${r.id}">
      <div class="rec-top">
        <span class="rec-date">${date}</span>
        <span class="badge badge-${r.status}">${badge}</span>
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
    btn.addEventListener('click', () => triggerProcess(btn.dataset.process, port, settings));
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
}

async function triggerProcess(id, port, settings) {
  showState('processing');
  setProcessingStep('processing');
  await saveSession({ popupState: 'processing', recordingId: id });

  try {
    const res = await fetch(`http://localhost:${port}/recordings/${id}/process`, {
      method: 'POST',
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
  // Mic permission from visible popup context
  try {
    const s = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    s.getTracks().forEach(t => t.stop());
  } catch (err) {
    if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
      showError('دسترسی به میکروفون رد شد.\nلطفاً در تنظیمات Chrome دسترسی میکروفون را فعال کنید.');
      return;
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
    await uploadAudio(response.audioData, response.mimeType);
  });
});

async function uploadAudio(audioData, mimeType) {
  try {
    const settings = await loadSettings();
    const port     = settings.helperPort || 3456;

    const bytes    = Uint8Array.from(atob(audioData), c => c.charCodeAt(0));
    const blob     = new Blob([bytes], { type: mimeType || 'audio/webm' });
    const form     = new FormData();
    form.append('audio',       blob,                    'recording.webm');

    const res  = await fetch(`http://localhost:${port}/transcribe-and-summarize`, {
      method: 'POST', body: form,
    });
    const data = await res.json().catch(() => ({}));

    if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);

    // Recording saved — go back to idle and refresh list
    await clearSession();
    showState('idle');
    await loadRecordingsList();

  } catch (err) {
    let msg = err.message || 'خطای ناشناخته';
    if (msg.toLowerCase().includes('fetch') || msg.includes('Failed to fetch')) {
      msg = 'اتصال به سرور محلی برقرار نشد.';
    }
    await saveSession({ popupState: 'error', errorMsg: msg });
    showError(msg);
  }
}

// ── Save MOM ──────────────────────────────────────────────────────

el.btnSave.addEventListener('click', () => {
  if (!currentMOM) return;
  const now  = new Date();
  const date = now.toISOString().slice(0, 10);
  const time = now.toTimeString().slice(0, 5);
  const md   = [
    `# صورت‌جلسه — ${date} ${time}`, '',
    '## خلاصه', currentMOM.summary || '—', '',
    '## تصمیمات', currentMOM.decisions || '—', '',
    '## اقدامات', currentMOM.action_items || '—', '',
    ...(currentMOM.corrected_transcript ? [
      '---', '## متن اصلاح‌شده', currentMOM.corrected_transcript, '',
    ] : []),
    '---', '*تولید شده توسط PechPech*',
  ].join('\n');

  const a  = Object.assign(document.createElement('a'), {
    href:     URL.createObjectURL(new Blob([md], { type: 'text/markdown;charset=utf-8' })),
    download: `MOM_${date}_${time.replace(':', '-')}.md`,
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

  // Restore persisted popup state
  const saved = await loadSession();

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
