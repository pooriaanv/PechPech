'use strict';

import { t, getLanguage, bootLanguage } from './i18n.js';

const TOTAL = 5;

let current = 0;

function stepNum(n) {
  const s = String(n);
  return getLanguage() === 'fa' ? s.replace(/\d/g, d => '۰۱۲۳۴۵۶۷۸۹'[d]) : s;
}

// ── Navigation ────────────────────────────────────────────────────

function goTo(n) {
  if (n < 0 || n >= TOTAL) return;

  document.getElementById('panel-' + current).classList.remove('active');
  document.getElementById('panel-' + n).classList.add('active');

  for (let i = 0; i < TOTAL; i++) {
    const pip = document.getElementById('pip-' + i);
    const lbl = document.getElementById('lbl-' + i);
    pip.className = 'step-pip' + (i < n ? ' done' : i === n ? ' active' : '');
    pip.textContent = i < n ? '✓' : stepNum(i + 1);
    lbl.className = 'step-lbl' + (i < n ? ' done' : i === n ? ' active' : '');
  }
  for (let i = 0; i < TOTAL - 1; i++) {
    const seg = document.getElementById('seg-' + i);
    seg.className = 'step-seg' + (i < n ? ' done' : '');
  }

  current = n;

  document.getElementById('btn-back').classList.toggle('hidden', n === 0);
  document.getElementById('btn-next').classList.toggle('hidden', n === TOTAL - 1);
  document.getElementById('btn-done').classList.toggle('hidden', n !== TOTAL - 1);
  document.getElementById('nav-progress').textContent =
    t('stepProgress', { n: stepNum(n + 1), total: stepNum(TOTAL) });

  if (n === 3) checkConfigured();
}

document.getElementById('btn-back').addEventListener('click', () => goTo(current - 1));
document.getElementById('btn-next').addEventListener('click', () => goTo(current + 1));
document.getElementById('btn-done').addEventListener('click', () => window.close());

// ── Config presence check ─────────────────────────────────────────
// No server to probe in this variant — instead, check that at least one
// STT credential and one LLM credential are present in chrome.storage.local.

async function checkConfigured() {
  const status = document.getElementById('conn-status');
  const dot    = document.getElementById('conn-dot');
  const text   = document.getElementById('conn-text');
  const info   = document.getElementById('conn-info');

  status.className  = 'conn-status checking';
  dot.className     = 'conn-dot pulse';
  text.textContent  = t('checkingConfig');

  const cfg = await new Promise(r =>
    chrome.storage.local.get(['sttProvider', 'sttKey', 'llmCli', 'llmApiKey'], r)
  );

  // "custom" STT provider doesn't require a key (local/self-hosted server)
  const sttOk = cfg.sttProvider === 'custom' || !!cfg.sttKey;
  const llmOk = !!cfg.llmApiKey;

  if (sttOk && llmOk) {
    status.className  = 'conn-status ok';
    dot.className     = 'conn-dot';
    text.textContent  = t('bothConfigured');
    info.innerHTML     = t('allReadyBody');
  } else {
    status.className  = 'conn-status fail';
    dot.className     = 'conn-dot';
    const missingParts = [!sttOk && 'STT', !llmOk && 'LLM'].filter(Boolean);
    const sep = getLanguage() === 'fa' ? ' و ' : ' and ';
    text.textContent  = t('missingKeyText', { missing: missingParts.join(sep) });
    info.innerHTML     = t('noKeysBody');
  }
}

document.getElementById('btn-recheck').addEventListener('click', checkConfigured);
document.getElementById('btn-settings').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

(async () => {
  await bootLanguage();
  goTo(0);
})();
