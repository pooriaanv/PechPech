'use strict';

// helperPort is the only setting stored in chrome.storage — it's needed to
// reach the server, so it must be available before any network call.
// All other config (STT, LLM) lives in src/backend-server/config.json,
// read and written via GET /config and POST /config.

// ── DOM Refs ──────────────────────────────────────────────────────
const sttUrlEl      = document.getElementById('stt-url');
const sttKeyEl      = document.getElementById('stt-key');
const sttModelEl    = document.getElementById('stt-model');
const llmCliEl      = document.getElementById('llm-cli');
const llmCommandEl  = document.getElementById('llm-command');
const llmApiUrlEl   = document.getElementById('llm-api-url');
const llmApiKeyEl   = document.getElementById('llm-api-key');
const llmApiModelEl = document.getElementById('llm-api-model');
const helperPortEl  = document.getElementById('helper-port');
const customCmdFld  = document.getElementById('custom-command-field');
const apiFlds       = document.getElementById('api-fields');
const btnSave       = document.getElementById('btn-save');
const btnReset      = document.getElementById('btn-reset');
const toastSaved    = document.getElementById('toast-saved');
const serverError   = document.getElementById('server-error');

// ── Toggle conditional LLM fields ────────────────────────────────
function updateLLMFields() {
  const v = llmCliEl.value;
  customCmdFld.classList.toggle('visible', v === 'custom');
  apiFlds.classList.toggle('visible', v === 'api');
}
llmCliEl.addEventListener('change', updateLLMFields);

// ── Port helpers ──────────────────────────────────────────────────
function getStoredPort() {
  return new Promise(r => chrome.storage.local.get(['helperPort'], items => {
    r(parseInt(items.helperPort, 10) || 3456);
  }));
}

function serverBase(port) {
  return `http://localhost:${port}`;
}

// ── Server error banner ───────────────────────────────────────────
function showServerError(msg) {
  serverError.textContent = msg;
  serverError.classList.add('visible');
}
function hideServerError() {
  serverError.classList.remove('visible');
}

// ── Load settings ─────────────────────────────────────────────────
async function loadSettings() {
  const port = await getStoredPort();
  helperPortEl.value = port;

  try {
    const res = await fetch(`${serverBase(port)}/config`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) throw new Error(`Server error ${res.status}`);
    const cfg = await res.json();

    sttUrlEl.value      = cfg.sttUrl      ?? 'http://localhost:8080/v1';
    sttKeyEl.value      = cfg.sttKey      ?? '';
    sttModelEl.value    = cfg.sttModel    ?? 'whisper-1';
    llmCliEl.value      = cfg.llmCli      ?? 'claude';
    llmCommandEl.value  = cfg.llmCommand  ?? '';
    llmApiUrlEl.value   = cfg.llmApiUrl   ?? '';
    llmApiKeyEl.value   = cfg.llmApiKey   ?? '';
    llmApiModelEl.value = cfg.llmApiModel ?? '';

    hideServerError();
  } catch {
    showServerError(`Cannot reach PechPech server at localhost:${port}. Start it first, then reload this page.`);
  }

  updateLLMFields();
}

// ── Save settings ─────────────────────────────────────────────────
async function saveSettings() {
  const port = parseInt(helperPortEl.value, 10);
  if (isNaN(port) || port < 1024 || port > 65535) {
    helperPortEl.focus();
    helperPortEl.style.borderColor = '#dc2626';
    setTimeout(() => helperPortEl.style.borderColor = '', 2000);
    return;
  }

  // Port goes to chrome.storage — it's the bootstrap value
  await new Promise(r => chrome.storage.local.set({ helperPort: port }, r));

  const cfg = {
    sttUrl:      sttUrlEl.value.trim(),
    sttKey:      sttKeyEl.value.trim(),
    sttModel:    sttModelEl.value.trim() || 'whisper-1',
    llmCli:      llmCliEl.value,
    llmCommand:  llmCommandEl.value.trim(),
    llmApiUrl:   llmApiUrlEl.value.trim(),
    llmApiKey:   llmApiKeyEl.value.trim(),
    llmApiModel: llmApiModelEl.value.trim(),
  };

  try {
    const res = await fetch(`${serverBase(port)}/config`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(cfg),
      signal:  AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`Server error ${res.status}`);
    hideServerError();
    showToast();
  } catch (err) {
    showServerError(`Could not save to server: ${err.message}`);
  }
}

// ── Reset to defaults ─────────────────────────────────────────────
async function resetSettings() {
  if (!confirm('تنظیمات به حالت پیش‌فرض بازنشانی شود؟')) return;
  const port = await getStoredPort();

  try {
    const res = await fetch(`${serverBase(port)}/config`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        sttUrl: 'http://localhost:8080/v1', sttKey: '', sttModel: 'whisper-1',
        llmCli: 'claude', llmCommand: '', llmApiUrl: '', llmApiKey: '', llmApiModel: '',
      }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`Server error ${res.status}`);
    await loadSettings();
    showToast('تنظیمات بازنشانی شد.');
  } catch (err) {
    showServerError(`Could not reset: ${err.message}`);
  }
}

// ── Toast notification ────────────────────────────────────────────
let toastTimeout = null;
function showToast(message) {
  toastSaved.textContent = '✓ ' + (message || 'تنظیمات با موفقیت ذخیره شد.');
  toastSaved.classList.add('visible');
  if (toastTimeout) clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => toastSaved.classList.remove('visible'), 3000);
}

// ── Wire up ───────────────────────────────────────────────────────
btnSave.addEventListener('click', saveSettings);
btnReset.addEventListener('click', resetSettings);
document.addEventListener('keydown', e => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) saveSettings();
});

loadSettings();
