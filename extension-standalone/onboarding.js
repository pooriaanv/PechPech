'use strict';

const TOTAL   = 5;
const FA_NUMS = ['۱','۲','۳','۴','۵'];

let current = 0;

// ── Navigation ────────────────────────────────────────────────────

function goTo(n) {
  if (n < 0 || n >= TOTAL) return;

  document.getElementById('panel-' + current).classList.remove('active');
  document.getElementById('panel-' + n).classList.add('active');

  for (let i = 0; i < TOTAL; i++) {
    const pip = document.getElementById('pip-' + i);
    const lbl = document.getElementById('lbl-' + i);
    pip.className = 'step-pip' + (i < n ? ' done' : i === n ? ' active' : '');
    pip.textContent = i < n ? '✓' : FA_NUMS[i];
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
    'مرحله ' + FA_NUMS[n] + ' از ' + FA_NUMS[TOTAL - 1];

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
  text.textContent  = 'در حال بررسی تنظیمات…';

  const cfg = await new Promise(r =>
    chrome.storage.local.get(['sttProvider', 'sttKey', 'llmCli', 'llmApiKey'], r)
  );

  // "custom" STT provider doesn't require a key (local/self-hosted server)
  const sttOk = cfg.sttProvider === 'custom' || !!cfg.sttKey;
  const llmOk = !!cfg.llmApiKey;

  if (sttOk && llmOk) {
    status.className  = 'conn-status ok';
    dot.className     = 'conn-dot';
    text.textContent  = 'STT و LLM هر دو پیکربندی شده‌اند ✓';
    info.innerHTML     =
      '<strong>همه چیز آماده است!</strong><br/>' +
      'می‌توانید به مرحله بعد بروید و اولین جلسه را ضبط کنید.';
  } else {
    status.className  = 'conn-status fail';
    dot.className     = 'conn-dot';
    const missing = [!sttOk && 'STT', !llmOk && 'LLM'].filter(Boolean).join(' و ');
    text.textContent  = `کلید ${missing} هنوز تنظیم نشده است`;
    info.innerHTML     =
      '<strong>هنوز کلیدی وارد نکرده‌اید؟</strong><br/>' +
      'روی «باز کردن تنظیمات افزونه» بزنید، کلید STT و LLM را وارد و ذخیره کنید،<br/>' +
      'سپس دکمه «بررسی مجدد» را بزنید.';
  }
}

document.getElementById('btn-recheck').addEventListener('click', checkConfigured);
document.getElementById('btn-settings').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});
