'use strict';

// settings.js — adapted from extension/settings.js. No local server: all
// STT/LLM config lives directly in chrome.storage.local. The LLM CLI
// option is dropped entirely (child_process cannot run in a browser).

import { MOM_PROMPT_EN, MOM_PROMPT_FA, NOTES_PROMPT_EN, NOTES_PROMPT_FA, CORRECTION_PROMPT_EN, CORRECTION_PROMPT_FA } from './prompts.js';
import { t, getLanguage, bootLanguage } from './i18n.js';

// ── DOM Refs ──────────────────────────────────────────────────────
const sttProviderEl = document.getElementById('stt-provider');
const sttUrlEl      = document.getElementById('stt-url');
const sttKeyEl      = document.getElementById('stt-key');
const sttModelEl    = document.getElementById('stt-model');
const llmCliEl      = document.getElementById('llm-cli');
const llmApiUrlEl   = document.getElementById('llm-api-url');
const llmApiKeyEl   = document.getElementById('llm-api-key');
const llmApiModelEl = document.getElementById('llm-api-model');
const audioQualityEl = document.getElementById('audio-quality');
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
  'audioQuality',
  'promptMom', 'promptNotes', 'promptCorrection',
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
  audioQuality: 'standard',   // 'standard' (64 kbps) | 'compact' (32 kbps) — see offscreen.js
  promptMom:        '',
  promptNotes:      '',
  promptCorrection: '',
};

// Maps each accordion's data-prompt key to its textarea + a getter for the
// current-language default text (the default prompt is language-reactive;
// a user's saved override, once set, is used as-is regardless of language —
// see promptOverrideHint in the UI).
const PROMPT_FIELDS = {
  mom:        { el: document.getElementById('prompt-mom'),        defaultFor: lang => (lang === 'fa' ? MOM_PROMPT_FA : MOM_PROMPT_EN) },
  notes:      { el: document.getElementById('prompt-notes'),      defaultFor: lang => (lang === 'fa' ? NOTES_PROMPT_FA : NOTES_PROMPT_EN) },
  correction: { el: document.getElementById('prompt-correction'), defaultFor: lang => (lang === 'fa' ? CORRECTION_PROMPT_FA : CORRECTION_PROMPT_EN) },
};

function defaultTextFor(key) {
  return PROMPT_FIELDS[key].defaultFor(getLanguage());
}

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

// ── Prompt accordion ──────────────────────────────────────────────

document.querySelectorAll('.prompt-header').forEach(header => {
  const body    = header.nextElementSibling;
  const chevron = header.querySelector('.prompt-chevron');
  header.addEventListener('click', () => {
    body.classList.toggle('hidden');
    chevron.classList.toggle('open');
  });
});

document.querySelectorAll('[data-reset-prompt]').forEach(btn => {
  btn.addEventListener('click', () => {
    const key = btn.dataset.resetPrompt;
    PROMPT_FIELDS[key].el.value = defaultTextFor(key);
  });
});

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

  // A stored value that isn't one of the options (stale or hand-edited) would
  // leave the <select> blank and then save '' — fall back to the default.
  audioQualityEl.value = [...audioQualityEl.options].some(o => o.value === cfg.audioQuality)
    ? cfg.audioQuality
    : CONFIG_DEFAULTS.audioQuality;

  PROMPT_FIELDS.mom.el.value       = cfg.promptMom        || defaultTextFor('mom');
  PROMPT_FIELDS.notes.el.value      = cfg.promptNotes      || defaultTextFor('notes');
  PROMPT_FIELDS.correction.el.value = cfg.promptCorrection || defaultTextFor('correction');

  updateSTTFields();
  updateLLMFields();
}

// ── Save settings ─────────────────────────────────────────────────
function savedPromptValue(key) {
  const { el } = PROMPT_FIELDS[key];
  const value = el.value.trim();
  return value === defaultTextFor(key).trim() ? '' : value;
}

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
    audioQuality: audioQualityEl.value,
    promptMom:        savedPromptValue('mom'),
    promptNotes:      savedPromptValue('notes'),
    promptCorrection: savedPromptValue('correction'),
  };

  await new Promise(r => chrome.storage.local.set({
    ...cfg,
    customMeetingDomains: customDomains,
  }, r));

  showToast();
}

// ── Reset to defaults ─────────────────────────────────────────────
async function resetSettings() {
  if (!confirm(t('confirmReset'))) return;

  await new Promise(r => chrome.storage.local.set({ ...CONFIG_DEFAULTS }, r));
  await loadSettings();
  showToast(t('resetToast'));
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
