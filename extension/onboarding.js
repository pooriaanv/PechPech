'use strict';

const TOTAL       = 5;
const DEFAULT_PORT = 3456;
const FA_NUMS     = ['۱','۲','۳','۴','۵'];

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

  if (n === 3) checkServer();
}

document.getElementById('btn-back').addEventListener('click', () => goTo(current - 1));
document.getElementById('btn-next').addEventListener('click', () => goTo(current + 1));
document.getElementById('btn-done').addEventListener('click', () => window.close());

// ── Server health check ───────────────────────────────────────────

async function getPort() {
  return new Promise(r =>
    chrome.storage.local.get(['helperPort'], items =>
      r(parseInt(items.helperPort, 10) || DEFAULT_PORT)
    )
  );
}

async function checkServer() {
  const status = document.getElementById('conn-status');
  const dot    = document.getElementById('conn-dot');
  const text   = document.getElementById('conn-text');
  const info   = document.getElementById('conn-info');

  status.className   = 'conn-status checking';
  dot.className      = 'conn-dot pulse';
  text.textContent   = 'در حال بررسی ارتباط با سرور…';

  const port = await getPort();

  try {
    const controller = new AbortController();
    const abort = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(`http://localhost:${port}/health`, { signal: controller.signal });
    clearTimeout(abort);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    status.className  = 'conn-status ok';
    dot.className     = 'conn-dot';
    text.textContent  = `سرور در حال اجرا است — localhost:${port} ✓`;
    info.innerHTML    =
      '<strong>همه چیز آماده است!</strong><br/>' +
      'می‌توانید به مرحله بعد بروید و اولین جلسه را ضبط کنید.';

  } catch {
    status.className  = 'conn-status fail';
    dot.className     = 'conn-dot';
    text.textContent  = `سرور پاسخ نمی‌دهد روی localhost:${port}`;
    info.innerHTML    =
      '<strong>سرور هنوز راه‌اندازی نشده؟</strong><br/>' +
      'در ترمینال اجرا کنید:<br/>' +
      '<code>node src/launcher/index.js</code><br/><br/>' +
      'سپس دکمه «بررسی مجدد» را بزنید.';
  }
}

document.getElementById('btn-recheck').addEventListener('click', checkServer);
document.getElementById('btn-settings').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});
