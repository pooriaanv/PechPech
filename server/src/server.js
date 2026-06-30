'use strict';

const express = require('express');
const cors    = require('cors');
const multer  = require('multer');
const fs      = require('fs');
const path    = require('path');

const { createProvider } = require('./llm-providers');
const { createPipeline } = require('./pipeline');

// ── Server Config ─────────────────────────────────────────────────

const PORT = parseInt(process.env.PECHPECH_PORT, 10) || 3456;
// In Docker, PECHPECH_HOST=0.0.0.0; host-side binding to 127.0.0.1 is enforced by docker-compose
const HOST = process.env.PECHPECH_HOST || '127.0.0.1';

// ── LLM/STT Config (server/src/config.json) ──────────────────────

const CONFIG_PATH = path.join(__dirname, 'config.json');

const CONFIG_DEFAULTS = {
  sttUrl:      'http://localhost:8080/v1',
  sttKey:      '',
  sttModel:    'whisper-1',
  llmCli:      'claude',
  llmCommand:  '',
  llmApiUrl:   '',
  llmApiKey:   '',
  llmApiModel: '',
};

function loadServerConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    return { ...CONFIG_DEFAULTS, ...raw };
  } catch {
    return { ...CONFIG_DEFAULTS };
  }
}

function saveServerConfig(patch) {
  const current = loadServerConfig();
  const updated = { ...current };
  for (const key of Object.keys(CONFIG_DEFAULTS)) {
    if (key in patch) updated[key] = String(patch[key] ?? '');
  }
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(updated, null, 2));
  return updated;
}

// ── Recording Store ───────────────────────────────────────────────

class RecordingStore {
  constructor() {
    this.dataDir  = process.env.DATA_DIR || path.join(__dirname, '../../data');
    this.audioDir = path.join(this.dataDir, 'audio');
    this.metaPath = path.join(this.dataDir, 'recordings.json');
    this._records = {};
    fs.mkdirSync(this.audioDir, { recursive: true });
    this._load();
  }

  _load() {
    try {
      if (fs.existsSync(this.metaPath)) {
        this._records = JSON.parse(fs.readFileSync(this.metaPath, 'utf8'));
      }
    } catch (e) {
      console.warn('[store] Could not load recordings.json:', e.message);
    }
  }

  _flush() {
    fs.writeFileSync(this.metaPath, JSON.stringify(this._records, null, 2));
  }

  create({ audioBuffer, mimeType }) {
    const id  = `rec_${Date.now()}`;
    const ext = mimeType?.includes('ogg') ? 'ogg' : 'webm';
    fs.writeFileSync(path.join(this.audioDir, `${id}.${ext}`), audioBuffer);
    this._records[id] = {
      id, filename: `${id}.${ext}`, mimeType: mimeType || 'audio/webm',
      status: 'saved', createdAt: Date.now(),
      transcript: null, summary: null, decisions: null, action_items: null, error: null,
      corrected_transcript: null, correction_status: null, correction_error: null,
    };
    this._flush();
    return this._records[id];
  }

  update(id, patch) {
    if (!this._records[id]) return;
    Object.assign(this._records[id], patch);
    this._flush();
  }

  get(id)  { return this._records[id] || null; }

  list() {
    return Object.values(this._records).sort((a, b) => b.createdAt - a.createdAt);
  }

  saveCleanedAudio(id, buffer, mimeType) {
    const rec = this._records[id];
    if (!rec) return;
    const filename = `${id}_clean.ogg`;
    fs.writeFileSync(path.join(this.audioDir, filename), buffer);
    Object.assign(rec, { cleanedFilename: filename, cleanedMimeType: mimeType });
    this._flush();
  }

  delete(id) {
    const rec = this._records[id];
    if (!rec) return false;
    try { fs.unlinkSync(path.join(this.audioDir, rec.filename)); } catch (_) {}
    if (rec.cleanedFilename) {
      try { fs.unlinkSync(path.join(this.audioDir, rec.cleanedFilename)); } catch (_) {}
    }
    delete this._records[id];
    this._flush();
    return true;
  }
}

const store    = new RecordingStore();
const pipeline = createPipeline({ store, createProvider });

// ── Express App ───────────────────────────────────────────────────

const app    = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 500 * 1024 * 1024 },
});

app.use(cors({
  origin: (origin, callback) => {
    if (
      !origin ||
      origin.startsWith('chrome-extension://') ||
      origin.startsWith('http://localhost') ||
      origin.startsWith('http://127.0.0.1')
    ) {
      callback(null, true);
    } else {
      callback(new Error(`CORS: origin not allowed: ${origin}`));
    }
  },
  methods:        ['GET', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

app.use(express.json());

// ── GET /health ───────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', version: '1.0.0', service: 'PechPech Local Helper' });
});

// ── GET /config ───────────────────────────────────────────────────
app.get('/config', (_req, res) => {
  res.json(loadServerConfig());
});

// ── POST /config ──────────────────────────────────────────────────
app.post('/config', express.json(), (req, res) => {
  try {
    const updated = saveServerConfig(req.body || {});
    res.json(updated);
  } catch (e) {
    res.status(500).json({ error: `Could not save config: ${e.message}` });
  }
});

// ── POST /transcribe-and-summarize ────────────────────────────────
// Accepts audio upload, saves to disk, returns ID immediately.
// Processing is triggered separately via POST /recordings/:id/process.
app.post('/transcribe-and-summarize', upload.single('audio'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No audio file received. Field name must be "audio".' });
  }

  const audioBuffer   = req.file.buffer;
  const audioMimeType = req.file.mimetype || 'audio/webm';

  const record = store.create({ audioBuffer, mimeType: audioMimeType });
  console.log(`\n[request] Created ${record.id} (${audioBuffer.length} bytes)`);

  res.json({ id: record.id, status: 'saved' });
});

// ── GET /recordings ───────────────────────────────────────────────
app.get('/recordings', (_req, res) => {
  res.json(store.list());
});

// ── GET /recordings/:id ───────────────────────────────────────────
app.get('/recordings/:id', (req, res) => {
  const rec = store.get(req.params.id);
  if (!rec) return res.status(404).json({ error: 'Recording not found.' });
  res.json(rec);
});

// ── DELETE /recordings/:id ────────────────────────────────────────
app.delete('/recordings/:id', (req, res) => {
  const ok = store.delete(req.params.id);
  if (!ok) return res.status(404).json({ error: 'Recording not found.' });
  res.json({ ok: true });
});

// ── GET /recordings/:id/audio ─────────────────────────────────────
app.get('/recordings/:id/audio', (req, res) => {
  const rec = store.get(req.params.id);
  if (!rec) return res.status(404).json({ error: 'Recording not found.' });

  const audioPath = path.join(store.audioDir, rec.filename);
  if (!fs.existsSync(audioPath)) return res.status(404).json({ error: 'Audio file missing.' });

  const stat  = fs.statSync(audioPath);
  const range = req.headers.range;

  res.setHeader('Content-Type', rec.mimeType || 'audio/webm');
  res.setHeader('Accept-Ranges', 'bytes');

  if (range) {
    const [startStr, endStr] = range.replace(/bytes=/, '').split('-');
    const start = parseInt(startStr, 10);
    const end   = endStr ? parseInt(endStr, 10) : stat.size - 1;
    res.setHeader('Content-Range',  `bytes ${start}-${end}/${stat.size}`);
    res.setHeader('Content-Length', end - start + 1);
    res.status(206);
    fs.createReadStream(audioPath, { start, end }).pipe(res);
  } else {
    res.setHeader('Content-Length', stat.size);
    fs.createReadStream(audioPath).pipe(res);
  }
});

// ── POST /recordings/:id/process ─────────────────────────────────
app.post('/recordings/:id/process', (req, res) => {
  const rec = store.get(req.params.id);
  if (!rec) return res.status(404).json({ error: 'Recording not found.' });

  const active = ['processing', 'transcribing', 'summarizing'];
  if (active.includes(rec.status)) {
    return res.json({ id: rec.id, status: rec.status, message: 'Already processing.' });
  }

  store.update(rec.id, { status: 'processing', error: null });
  res.json({ id: rec.id, status: 'processing' });

  pipeline.run(rec.id, loadServerConfig());
});

// ── POST /recordings/:id/correct ─────────────────────────────────
app.post('/recordings/:id/correct', (req, res) => {
  const rec = store.get(req.params.id);
  if (!rec) return res.status(404).json({ error: 'Recording not found.' });

  if (!rec.transcript) {
    return res.status(400).json({ error: 'Recording has no transcript yet. Process it first.' });
  }

  if (rec.correction_status === 'correcting') {
    return res.json({ id: rec.id, correction_status: 'correcting', message: 'Already correcting.' });
  }

  res.json({ id: rec.id, correction_status: 'correcting' });
  pipeline.correct(rec.id, loadServerConfig());
});

// ── 404 / Error Handlers ──────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: `Unknown endpoint: ${req.method} ${req.path}` });
});

app.use((err, _req, res, _next) => {
  console.error('[error]', err.message);
  res.status(500).json({ error: err.message });
});

// ── Start ─────────────────────────────────────────────────────────
app.listen(PORT, HOST, () => {
  console.log(`\n╔══════════════════════════════════════════════════╗`);
  console.log(`║          PechPech Local Helper v1.0.0           ║`);
  console.log(`╠══════════════════════════════════════════════════╣`);
  console.log(`║  Listening: http://${HOST}:${PORT}              ║`);
  console.log(`╚══════════════════════════════════════════════════╝\n`);
});

process.on('SIGINT',  () => { console.log('\n[server] Shutting down…'); process.exit(0); });
process.on('SIGTERM', () => { console.log('\n[server] Shutting down…'); process.exit(0); });
