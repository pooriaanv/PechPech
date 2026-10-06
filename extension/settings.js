'use strict';

// helperPort is the only setting stored in chrome.storage — it's needed to
// reach the server, so it must be available before any network call.
// All other config (STT, LLM) lives in src/backend-server/config.json,
// read and written via GET /config and POST /config.
//
// NOTE on prompt defaults (see i18n conversion report): unlike
// extension-standalone/settings.js, this file has no prompt textareas or
// "reset to default" button at all — there is no prompts UI here to make
// language-reactive. Default prompt text (if any) lives entirely on the
// server side (GET/POST /config), which is out of scope for this pass.

import { t, getLanguage, bootLanguage } from './i18n.js';

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
      <button class="domain-chip-remove" data-idx="${i}" title="${t('deleteTitle')}">×</button>
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
    keyHintKey:       'keyHintOpenAI',
    keyLinkUrl:       'https://platform.openai.com/api-keys',
  },
  'gemini-api': {
    modelPlaceholder: 'gemini-3.6-flash',
    keyHintKey:       'keyHintGemini',
    keyLinkUrl:       'https://aistudio.google.com/apikey',
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
  API_MODEL_HINT.innerHTML  = t('defaultModelHint', { model: preset?.modelPlaceholder || 'gpt-4o' });
  API_KEY_HINT.textContent  = preset ? t(preset.keyHintKey) : '';

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
  modelHintKey: 'sttModelHintDefault',
  keyHintKey:   'sttKeyHintDefault',
  keyOptional: true,
};

// Presets: only need a model + API key from the user — base URL is fixed.
const STT_PRESETS = {
  openai: {
    modelPlaceholder: 'whisper-1',
    modelHintKey: 'defaultModelHint',
    modelHintVars: { model: 'whisper-1' },
    keyHintKey:   'sttKeyHintOpenAIRequired',
    keyOptional: false,
    keyLinkUrl: 'https://platform.openai.com/api-keys',
  },
  gemini: {
    modelPlaceholder: 'gemini-3.6-flash',
    modelHintKey: 'defaultModelHint',
    modelHintVars: { model: 'gemini-3.6-flash' },
    keyHintKey:   'sttKeyHintGeminiRequired',
    keyOptional: false,
    keyLinkUrl: 'https://aistudio.google.com/apikey',
  },
};

function updateSTTFields() {
  const v = sttProviderEl.value;
  STT_URL_FIELD.classList.toggle('hidden', v !== 'custom');

  const preset = STT_PRESETS[v] || STT_DEFAULT_HINT;
  sttModelEl.placeholder = preset.modelPlaceholder;
  STT_MODEL_HINT.innerHTML = t(preset.modelHintKey, preset.modelHintVars);
  STT_KEY_HINT.textContent = t(preset.keyHintKey);
  STT_KEY_OPTIONAL_LBL.classList.toggle('hidden', !preset.keyOptional);

  if (preset.keyLinkUrl) {
    STT_KEY_LINK.href = preset.keyLinkUrl;
    STT_KEY_LINK.classList.remove('hidden');
  } else {
    STT_KEY_LINK.classList.add('hidden');
  }
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
    showServerError(t('settingsServerUnreachable', { port }));
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
    showServerError(t('settingsSaveFailed', { message: err.message }));
  }
}

// ── Reset to defaults ─────────────────────────────────────────────
async function resetSettings() {
  if (!confirm(t('confirmReset'))) return;
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
    showToast(t('resetToast'));
  } catch (err) {
    showServerError(t('settingsResetFailed', { message: err.message }));
  }
}

// ── Toast notification ────────────────────────────────────────────
let toastTimeout = null;
function showToast(message) {
  toastSaved.textContent = message ? ('✓ ' + message) : t('savedToast');
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

(async () => {
  await bootLanguage();
  await loadSettings();
})();
