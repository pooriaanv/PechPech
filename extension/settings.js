'use strict';

// helperPort is the only setting stored in chrome.storage — it's needed to
// reach the server, so it must be available before any network call.
// All other config (STT, LLM) lives in src/backend-server/config.json,
// read and written via GET /config and POST /config.

// ── DOM Refs ──────────────────────────────────────────────────────
const sttProviderEl = document.getElementById('stt-provider');
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
const domainInput   = document.getElementById('domain-input');
const btnAddDomain  = document.getElementById('btn-add-domain');
const customList    = document.getElementById('custom-domains-list');

// ── Custom Meeting Domains ────────────────────────────────────────

let customDomains = [];

function normalizeDomain(raw) {
  return raw.trim().toLowerCase()
    .replace(/^https?:\/\//i, '')
    .replace(/\/.*$/, '');
}

function renderCustomDomains() {
  customList.innerHTML = customDomains.map((d, i) => `
    <span class="domain-chip domain-chip--custom">
      ${d}
      <button class="domain-chip-remove" data-idx="${i}" title="حذف">×</button>
    </span>`).join('');
  customList.querySelectorAll('.domain-chip-remove').forEach(btn => {
    btn.addEventListener('click', () => {
      customDomains.splice(parseInt(btn.dataset.idx, 10), 1);
      renderCustomDomains();
    });
  });
}

function addDomain() {
  const d = normalizeDomain(domainInput.value);
  if (!d || customDomains.includes(d)) { domainInput.focus(); return; }
  customDomains.push(d);
  domainInput.value = '';
  renderCustomDomains();
  domainInput.focus();
}

btnAddDomain.addEventListener('click', addDomain);
domainInput.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); addDomain(); } });

// ── Toggle conditional LLM fields ────────────────────────────────

const API_URL_FIELD  = document.getElementById('api-url-field');
const API_MODEL_HINT = document.getElementById('llm-api-model-hint');
const API_KEY_HINT   = document.getElementById('llm-api-key-hint');

// Presets: only need a model + API key from the user — base URL is fixed.
const API_PRESETS = {
  openai: {
    modelPlaceholder: 'gpt-4o',
    keyHint:          'کلید API از platform.openai.com',
  },
  'gemini-api': {
    modelPlaceholder: 'gemini-2.0-flash',
    keyHint:          'کلید API از aistudio.google.com',
  },
};

function updateLLMFields() {
  const v = llmCliEl.value;
  customCmdFld.classList.toggle('visible', v === 'custom');

  const isApiBased = v === 'api' || v in API_PRESETS;
  apiFlds.classList.toggle('visible', isApiBased);
  API_URL_FIELD.classList.toggle('hidden', v !== 'api');

  const preset = API_PRESETS[v];
  llmApiModelEl.placeholder = preset?.modelPlaceholder || 'gpt-4o';
  API_MODEL_HINT.innerHTML  = `پیش‌فرض: <code>${preset?.modelPlaceholder || 'gpt-4o'}</code>`;
  API_KEY_HINT.textContent  = preset?.keyHint || '';
}
llmCliEl.addEventListener('change', updateLLMFields);

// ── Toggle conditional STT fields ─────────────────────────────────

const STT_URL_FIELD       = document.getElementById('stt-url-field');
const STT_MODEL_HINT      = document.getElementById('stt-model-hint');
const STT_KEY_HINT        = document.getElementById('stt-key-hint');
const STT_KEY_OPTIONAL_LBL = document.getElementById('stt-key-optional-label');

const STT_DEFAULT_HINT = {
  modelPlaceholder: 'whisper-1',
  modelHint:  'پیش‌فرض: <code>whisper-1</code> (OpenAI) &nbsp;|&nbsp; GapGPT: <code>whisper-large-v3</code>',
  keyHint:    'برای سرور محلی خالی بگذارید. برای OpenAI / Groq وارد کنید.',
  keyOptional: true,
};

// Presets: only need a model + API key from the user — base URL is fixed.
const STT_PRESETS = {
  openai: {
    modelPlaceholder: 'whisper-1',
    modelHint:  'پیش‌فرض: <code>whisper-1</code>',
    keyHint:    'کلید API از platform.openai.com — الزامی است.',
    keyOptional: false,
  },
  gemini: {
    modelPlaceholder: 'gemini-2.0-flash',
    modelHint:  'پیش‌فرض: <code>gemini-2.0-flash</code>',
    keyHint:    'کلید API از aistudio.google.com — الزامی است.',
    keyOptional: false,
  },
};

function updateSTTFields() {
  const v = sttProviderEl.value;
  STT_URL_FIELD.classList.toggle('hidden', v !== 'custom');

  const preset = STT_PRESETS[v] || STT_DEFAULT_HINT;
  sttModelEl.placeholder = preset.modelPlaceholder;
  STT_MODEL_HINT.innerHTML = preset.modelHint;
  STT_KEY_HINT.textContent = preset.keyHint;
  STT_KEY_OPTIONAL_LBL.classList.toggle('hidden', !preset.keyOptional);
}
sttProviderEl.addEventListener('change', updateSTTFields);

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

  const { customMeetingDomains } = await new Promise(r =>
    chrome.storage.local.get(['customMeetingDomains'], r)
  );
  customDomains = customMeetingDomains || [];
  renderCustomDomains();

  try {
    const res = await fetch(`${serverBase(port)}/config`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) throw new Error(`Server error ${res.status}`);
    const cfg = await res.json();

    sttProviderEl.value = cfg.sttProvider ?? 'custom';
    sttUrlEl.value      = cfg.sttUrl      ?? 'http://localhost:8080/v1';
    sttKeyEl.value      = cfg.sttKey      ?? '';
    sttModelEl.value    = cfg.sttModel    ?? 'whisper-1';
    llmCliEl.value      = cfg.llmCli      ?? 'openai';
    llmCommandEl.value  = cfg.llmCommand  ?? '';
    llmApiUrlEl.value   = cfg.llmApiUrl   ?? '';
    llmApiKeyEl.value   = cfg.llmApiKey   ?? '';
    llmApiModelEl.value = cfg.llmApiModel ?? '';

    hideServerError();
  } catch {
    showServerError(`Cannot reach PechPech server at localhost:${port}. Start it first, then reload this page.`);
  }

  updateSTTFields();
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

  await new Promise(r => chrome.storage.local.set({
    helperPort: port,
    customMeetingDomains: customDomains,
  }, r));

  const cfg = {
    sttProvider: sttProviderEl.value,
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
        sttProvider: 'custom',
        sttUrl: 'http://localhost:8080/v1', sttKey: '', sttModel: 'whisper-1',
        llmCli: 'openai', llmCommand: '', llmApiUrl: '', llmApiKey: '', llmApiModel: '',
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
