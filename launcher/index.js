'use strict';

/**
 * launcher/index.js — PechPech Launcher
 * Zero npm dependencies — uses only Node built-ins + OS-native commands.
 *
 * Usage:
 *   node index.js              — start all services, open onboarding on first run
 *   node index.js --install    — register as a login item (auto-start on boot)
 *   node index.js --uninstall  — remove login item
 *   node index.js --stop       — stop a running launcher + services (via PID file)
 *   node index.js --status     — print whether the helper is reachable
 */

const path     = require('path');
const fs       = require('fs');
const os       = require('os');
const http     = require('http');
const { spawn, execSync, spawnSync } = require('child_process');

// ── Paths ─────────────────────────────────────────────────────────

const ROOT         = path.resolve(__dirname, '..');
const HELPER_DIR   = path.join(ROOT, 'server', 'src');
const COMPOSE_FILE = path.join(ROOT, 'docker-compose.yml');
const ENV_FILE     = path.join(ROOT, '.env');
const FLAG_FILE    = path.join(__dirname, '.launched');     // first-launch marker
const PID_FILE     = path.join(__dirname, '.launcher.pid'); // for --stop

const IS_MAC      = process.platform === 'darwin';
const IS_WIN      = process.platform === 'win32';
const HELPER_URL  = 'http://127.0.0.1:3456/health';

// Parse .env written by install.sh to determine run mode
function readDotEnv() {
  if (!fs.existsSync(ENV_FILE)) return {};
  return fs.readFileSync(ENV_FILE, 'utf8')
    .split('\n')
    .reduce((acc, line) => {
      const m = line.match(/^([^#=\s]+)\s*=\s*(.*)$/);
      if (m) acc[m[1]] = m[2].trim();
      return acc;
    }, {});
}

const envConfig   = readDotEnv();
const DOCKER_MODE = envConfig.MODE === 'docker';

// Find the right compose command (v2 plugin vs legacy standalone)
function composeCmd() {
  try { execSync('docker compose version', { stdio: 'ignore' }); return ['docker', 'compose']; }
  catch (_) { return ['docker-compose']; }
}

// ── CLI flags ─────────────────────────────────────────────────────

const args = process.argv.slice(2);
if (args.includes('--install'))   { installStartup();   process.exit(0); }
if (args.includes('--uninstall')) { uninstallStartup(); process.exit(0); }
if (args.includes('--stop'))      { stopRunning();      process.exit(0); }
if (args.includes('--status'))    { checkStatus();      return; }

// ── Logging ───────────────────────────────────────────────────────

const log  = msg => console.log(`[PechPech] ${msg}`);
const warn = msg => console.warn(`[PechPech] ⚠  ${msg}`);

// ── OS notification ───────────────────────────────────────────────

function notify(title, body) {
  try {
    if (IS_MAC) {
      spawnSync('osascript', [
        '-e', `display notification "${body}" with title "${title}" sound name "Submarine"`,
      ], { stdio: 'ignore', timeout: 3000 });
    } else if (IS_WIN) {
      // PowerShell toast notification
      const ps = [
        '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime] | Out-Null',
        '$t = [Windows.UI.Notifications.ToastTemplateType]::ToastText02',
        '$x = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent($t)',
        `$x.SelectSingleNode("//text()[1]").InnerText = "${title}"`,
        `$x.SelectSingleNode("//text()[2]").InnerText = "${body}"`,
        '$notif = [Windows.UI.Notifications.ToastNotification]::new($x)',
        '[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier("PechPech").Show($notif)',
      ].join('; ');
      spawnSync('powershell', ['-Command', ps], { stdio: 'ignore', timeout: 5000 });
    }
  } catch (_) { /* notifications are best-effort */ }
}

// ── Open browser ──────────────────────────────────────────────────

function openURL(url) {
  const [cmd, a] = IS_WIN    ? ['cmd',      ['/c', 'start', '', url]]
                 : IS_MAC    ? ['open',      [url]]
                 :             ['xdg-open',  [url]];
  spawn(cmd, a, { shell: false, detached: true, stdio: 'ignore' }).unref();
}

function openOnboarding() {
  const html = path.join(__dirname, 'onboarding', 'index.html');
  const url  = IS_WIN ? `file:///${html.replace(/\\/g, '/')}` : `file://${html}`;
  openURL(url);
}

// ── Service management ────────────────────────────────────────────

let helperProc = null;

function startHelper() {
  if (DOCKER_MODE) {
    startHelperDocker();
  } else {
    startHelperNative();
  }
}

function startHelperDocker() {
  log('Starting backend server container…');
  try {
    const cmd = composeCmd();
    execSync([...cmd, '-f', COMPOSE_FILE, 'up', '-d'].join(' '), {
      cwd: ROOT, stdio: 'inherit', timeout: 60_000,
    });
    log('Container is up.');
  } catch (e) {
    warn(`Docker start failed: ${e.message}`);
    warn('Run manually: docker compose up -d');
  }
}

function startHelperNative() {
  if (helperProc) { try { helperProc.kill('SIGTERM'); } catch (_) {} }

  const node = IS_WIN ? 'node.exe' : 'node';
  helperProc = spawn(node, ['server.js'], {
    cwd:   HELPER_DIR,
    stdio: ['ignore', 'pipe', 'pipe'],
    env:   { ...process.env, ...envConfig },
  });

  helperProc.stdout?.on('data', d => process.stdout.write(d));
  helperProc.stderr?.on('data', d => process.stderr.write(d));

  helperProc.on('exit', code => {
    warn(`Server exited (code ${code}). Restart with: node launcher/index.js`);
    helperProc = null;
  });

  helperProc.on('error', err => {
    warn(`Server failed to start: ${err.message}`);
    helperProc = null;
  });

  log(`Server started (PID ${helperProc.pid}).`);
}

function stopAll() {
  if (DOCKER_MODE) {
    try {
      const cmd = composeCmd();
      execSync([...cmd, '-f', COMPOSE_FILE, 'down'].join(' '), {
        cwd: ROOT, stdio: 'ignore', timeout: 15_000,
      });
      log('Container stopped.');
    } catch (_) {}
  } else {
    if (helperProc) {
      try { helperProc.kill('SIGTERM'); } catch (_) {}
      helperProc = null;
    }
  }
}

// ── --stop: kill a previously running launcher via PID file ───────

function stopRunning() {
  if (!fs.existsSync(PID_FILE)) {
    console.log('No running launcher found (no PID file).');
    return;
  }
  const pid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
  try {
    process.kill(pid, 'SIGTERM');
    fs.unlinkSync(PID_FILE);
    console.log(`Stopped launcher (PID ${pid}).`);
  } catch (e) {
    console.log(`Could not stop PID ${pid}: ${e.message}`);
    fs.unlinkSync(PID_FILE);
  }
}

// ── --status ──────────────────────────────────────────────────────

function checkStatus() {
  const req = http.get(HELPER_URL, { timeout: 3000 }, res => {
    let body = '';
    res.on('data', d => body += d);
    res.on('end', () => {
      console.log(`Helper: ● running  (${HELPER_URL})`);
      try { console.log(JSON.stringify(JSON.parse(body), null, 2)); } catch (_) {}
      process.exit(0);
    });
  });
  req.on('error', () => {
    console.log(`Helper: ⚫ not reachable  (${HELPER_URL})`);
    process.exit(1);
  });
}

// ── Login item install / uninstall ────────────────────────────────

function installStartup() {
  const launcherScript = path.join(__dirname, 'index.js');
  const nodeExec       = process.execPath;

  if (IS_MAC) {
    const label    = 'com.pechpech.launcher';
    const plistDir = path.join(os.homedir(), 'Library', 'LaunchAgents');
    const plistPath = path.join(plistDir, `${label}.plist`);

    fs.mkdirSync(plistDir, { recursive: true });
    fs.writeFileSync(plistPath, [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
      '<plist version="1.0"><dict>',
      `  <key>Label</key><string>${label}</string>`,
      '  <key>ProgramArguments</key><array>',
      `    <string>${nodeExec}</string>`,
      `    <string>${launcherScript}</string>`,
      '  </array>',
      '  <key>RunAtLoad</key><true/>',
      '  <key>KeepAlive</key><false/>',
      `  <key>WorkingDirectory</key><string>${ROOT}</string>`,
      '  <key>StandardOutPath</key>'  + `<string>${path.join(os.homedir(), 'Library/Logs/pechpech.log')}</string>`,
      '  <key>StandardErrorPath</key>' + `<string>${path.join(os.homedir(), 'Library/Logs/pechpech.log')}</string>`,
      '</dict></plist>',
    ].join('\n'));

    try { execSync(`launchctl unload "${plistPath}"`, { stdio: 'ignore' }); } catch (_) {}
    execSync(`launchctl load "${plistPath}"`, { stdio: 'ignore' });
    console.log('✓ PechPech will start automatically on login.');
    console.log(`  LaunchAgent: ${plistPath}`);
    console.log(`  Logs: ~/Library/Logs/pechpech.log`);

  } else if (IS_WIN) {
    const regKey = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
    const cmd    = `"${nodeExec}" "${launcherScript}"`;
    execSync(`reg add "${regKey}" /v "PechPech" /t REG_SZ /d "${cmd}" /f`, { stdio: 'ignore' });
    console.log('✓ PechPech will start automatically on login (Windows registry).');

  } else {
    // Linux: XDG autostart
    const autostartDir = path.join(os.homedir(), '.config', 'autostart');
    fs.mkdirSync(autostartDir, { recursive: true });
    fs.writeFileSync(path.join(autostartDir, 'pechpech.desktop'),
      `[Desktop Entry]\nType=Application\nName=PechPech\nExec="${nodeExec}" "${launcherScript}"\nHidden=false\nNoDisplay=false\nX-GNOME-Autostart-enabled=true\n`
    );
    console.log('✓ PechPech will start automatically on login (XDG autostart).');
  }
}

function uninstallStartup() {
  if (IS_MAC) {
    const plistPath = path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.pechpech.launcher.plist');
    try { execSync(`launchctl unload "${plistPath}"`, { stdio: 'ignore' }); } catch (_) {}
    try { fs.unlinkSync(plistPath); } catch (_) {}
    console.log('✓ Login item removed.');
  } else if (IS_WIN) {
    try {
      execSync('reg delete "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run" /v "PechPech" /f', { stdio: 'ignore' });
    } catch (_) {}
    console.log('✓ Login item removed.');
  } else {
    try { fs.unlinkSync(path.join(os.homedir(), '.config', 'autostart', 'pechpech.desktop')); } catch (_) {}
    console.log('✓ Login item removed.');
  }
}

// ── Main ──────────────────────────────────────────────────────────

// Save PID so --stop can find this process
fs.writeFileSync(PID_FILE, String(process.pid));

console.log('');
console.log('  ╔══════════════════════════════════════════╗');
console.log('  ║          PechPech Launcher               ║');
console.log(`  ║  Mode: ${DOCKER_MODE ? 'Docker                        ' : 'Native (no Docker)            '}║`);
console.log('  ╠══════════════════════════════════════════╣');
console.log('  ║  node launcher/index.js --install    ║');
console.log('  ║    → auto-start on every login           ║');
console.log('  ║  node launcher/index.js --stop       ║');
console.log('  ║    → stop all services                   ║');
console.log('  ╚══════════════════════════════════════════╝');
console.log('');

startHelper();

// First launch → open onboarding after helper has a moment to start
const isFirstLaunch = !fs.existsSync(FLAG_FILE);
if (isFirstLaunch) {
  fs.writeFileSync(FLAG_FILE, new Date().toISOString());
  log('First launch — opening setup guide…');
  setTimeout(openOnboarding, 2500);
}

// Notify the user via OS notification
setTimeout(() => {
  notify('PechPech', isFirstLaunch
    ? 'Starting for the first time — opening setup guide…'
    : 'Running. Extension is ready to use.');
}, 1500);

// Graceful shutdown
function shutdown() {
  log('Shutting down…');
  try { fs.unlinkSync(PID_FILE); } catch (_) {}
  stopAll();
  process.exit(0);
}

process.on('SIGINT',  shutdown);
process.on('SIGTERM', shutdown);

log('Running. Press Ctrl-C to stop, or: node launcher/index.js --stop');
