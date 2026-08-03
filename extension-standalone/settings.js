'use strict';

// settings.js — adapted from extension/settings.js. No local server: all
// STT/LLM config lives directly in chrome.storage.local. The LLM CLI
// option is dropped entirely (child_process cannot run in a browser).

// ── DOM Refs ──────────────────────────────────────────────────────
const sttProviderEl = document.getElementById('stt-provider');
const sttUrlEl      = document.getElementById('stt-url');
const sttKeyEl      = document.getElementById('stt-key');
const sttModelEl    = document.getElementById('stt-model');
const llmCliEl      = document.getElementById('llm-cli');
const llmApiUrlEl   = document.getElementById('llm-api-url');
const llmApiKeyEl   = document.getElementById('llm-api-key');
const llmApiModelEl = document.getElementById('llm-api-model');
const apiFlds       = document.getElementById('api-fields');
const btnSave       = document.getElementById('btn-save');
const btnReset      = document.getElementById('btn-reset');
const toastSaved    = document.getElementById('toast-saved');
const domainInput   = document.getElementById('domain-input');
const btnAddDomain  = document.getElementById('btn-add-domain');
const customList    = document.getElementById('custom-domains-list');

const CONFIG_KEYS = [
  'sttProvider', 'sttUrl', 'sttKey', 'sttModel',
  'llmCli', 'llmApiUrl', 'llmApiKey', 'llmApiModel',
];

const CONFIG_DEFAULTS = {
  sttProvider: 'custom',
  sttUrl:      'http://localhost:8080/v1',
  sttKey:      '',
  sttModel:    'whisper-1',
  llmCli:      'openai',
  llmApiUrl:   '',
  llmApiKey:   '',
  llmApiModel: '',
};

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
const API_KEY_LINK   = document.getElementById('llm-api-key-link');

// Presets: only need a model + API key from the user — base URL is fixed.
const API_PRESETS = {
  openai: {
    modelPlaceholder: 'gpt-4o',
    keyHint:          'کلید API از platform.openai.com',
    keyLinkUrl:       'https://platform.openai.com/api-keys',
  },
  'gemini-api': {
    modelPlaceholder: 'gemini-3.6-flash',
    keyHint:          'کلید API از aistudio.google.com',
    keyLinkUrl:       'https://aistudio.google.com/apikey',
  },
};

function updateLLMFields() {
  const v = llmCliEl.value;

  const isApiBased = v === 'api' || v in API_PRESETS;
  apiFlds.classList.toggle('visible', isApiBased);
  API_URL_FIELD.classList.toggle('hidden', v !== 'api');

  const preset = API_PRESETS[v];
  llmApiModelEl.placeholder = preset?.modelPlaceholder || 'gpt-4o';
  API_MODEL_HINT.innerHTML  = `پیش‌فرض: <code>${preset?.modelPlaceholder || 'gpt-4o'}</code>`;
  API_KEY_HINT.textContent  = preset?.keyHint || '';

  if (preset?.keyLinkUrl) {
    API_KEY_LINK.href = preset.keyLinkUrl;
    API_KEY_LINK.classList.remove('hidden');
  } else {
    API_KEY_LINK.classList.add('hidden');
  }
}
llmCliEl.addEventListener('change', updateLLMFields);

// ── Toggle conditional STT fields ─────────────────────────────────

const STT_URL_FIELD       = document.getElementById('stt-url-field');
const STT_MODEL_HINT      = document.getElementById('stt-model-hint');
const STT_KEY_HINT        = document.getElementById('stt-key-hint');
const STT_KEY_OPTIONAL_LBL = document.getElementById('stt-key-optional-label');
const STT_KEY_LINK        = document.getElementById('stt-key-link');

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
    keyLinkUrl: 'https://platform.openai.com/api-keys',
  },
  gemini: {
    modelPlaceholder: 'gemini-3.6-flash',
    modelHint:  'پیش‌فرض: <code>gemini-3.6-flash</code>',
    keyHint:    'کلید API از aistudio.google.com — الزامی است.',
    keyOptional: false,
    keyLinkUrl: 'https://aistudio.google.com/apikey',
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

  if (preset.keyLinkUrl) {
    STT_KEY_LINK.href = preset.keyLinkUrl;
    STT_KEY_LINK.classList.remove('hidden');
  } else {
    STT_KEY_LINK.classList.add('hidden');
  }
}
sttProviderEl.addEventListener('change', updateSTTFields);

// ── Load settings ─────────────────────────────────────────────────
async function loadSettings() {
  const { customMeetingDomains } = await new Promise(r =>
    chrome.storage.local.get(['customMeetingDomains'], r)
  );
  customDomains = customMeetingDomains || [];
  renderCustomDomains();

  const stored = await new Promise(r => chrome.storage.local.get(CONFIG_KEYS, r));
  const cfg = { ...CONFIG_DEFAULTS, ...stored };

  sttProviderEl.value = cfg.sttProvider;
  sttUrlEl.value      = cfg.sttUrl;
  sttKeyEl.value      = cfg.sttKey;
  sttModelEl.value    = cfg.sttModel;
  llmCliEl.value      = cfg.llmCli;
  llmApiUrlEl.value   = cfg.llmApiUrl;
  llmApiKeyEl.value   = cfg.llmApiKey;
  llmApiModelEl.value = cfg.llmApiModel;

  updateSTTFields();
  updateLLMFields();
}

// ── Save settings ─────────────────────────────────────────────────
async function saveSettings() {
  const cfg = {
    sttProvider: sttProviderEl.value,
    sttUrl:      sttUrlEl.value.trim(),
    sttKey:      sttKeyEl.value.trim(),
    sttModel:    sttModelEl.value.trim() || 'whisper-1',
    llmCli:      llmCliEl.value,
    llmApiUrl:   llmApiUrlEl.value.trim(),
    llmApiKey:   llmApiKeyEl.value.trim(),
    llmApiModel: llmApiModelEl.value.trim(),
  };

  await new Promise(r => chrome.storage.local.set({
    ...cfg,
    customMeetingDomains: customDomains,
  }, r));

  showToast();
}

// ── Reset to defaults ─────────────────────────────────────────────
async function resetSettings() {
  if (!confirm('تنظیمات به حالت پیش‌فرض بازنشانی شود؟')) return;

  await new Promise(r => chrome.storage.local.set({ ...CONFIG_DEFAULTS }, r));
  await loadSettings();
  showToast('تنظیمات بازنشانی شد.');
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
