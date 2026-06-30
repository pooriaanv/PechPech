'use strict';

const fs     = require('fs');
const path   = require('path');
const os     = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');
const yaml   = require('js-yaml');

// ── Prompt Templates ──────────────────────────────────────────────

const PROMPTS = yaml.load(fs.readFileSync(path.join(__dirname, 'prompts.yaml'), 'utf8'));

const buildMOMPrompt        = t => PROMPTS.mom.replace('{{transcript}}',        t);
const buildCorrectionPrompt = t => PROMPTS.correction.replace('{{transcript}}', t);

// ── MOM Output Parser ─────────────────────────────────────────────

function parseMOMOutput(text) {
  const normalized = text.replace(/\r\n/g, '\n').trim();
  const patterns = [
    { key: 'summary',      regex: /##\s*خلاصه[^\n]*\n([\s\S]*?)(?=##|$)/i      },
    { key: 'decisions',    regex: /##\s*تصمیمات[^\n]*\n([\s\S]*?)(?=##|$)/i    },
    { key: 'action_items', regex: /##\s*اقدامات[^\n]*\n([\s\S]*?)(?=##|$)/i    },
  ];

  const result  = {};
  let anyFound  = false;

  for (const { key, regex } of patterns) {
    const match = normalized.match(regex);
    if (match) { result[key] = match[1].trim(); anyFound = true; }
    else        { result[key] = null; }
  }

  if (!anyFound) {
    console.warn('[parser] Could not parse MOM sections — returning raw output as summary.');
    return {
      summary:        normalized,
      decisions:      null,
      action_items:   null,
      _parse_warning: 'Could not identify MOM sections in LLM output. Raw output returned in summary.',
    };
  }

  return result;
}

// ── Audio Preprocessing (inline ffmpeg) ──────────────────────────
// Cleans audio via ffmpeg: highpass filter, loudness normalisation,
// optional denoising, resampled to 16 kHz mono Opus/OGG.
// Falls back to raw audio if ffmpeg is not installed.

const FFMPEG_CFG = {
  highpassFreq:   process.env.HIGHPASS_FREQ   || '80',
  loudnormI:      process.env.LOUDNORM_I      || '-16',
  loudnormTp:     process.env.LOUDNORM_TP     || '-1.5',
  loudnormLra:    process.env.LOUDNORM_LRA    || '11',
  denoiseEnabled: process.env.DENOISE_ENABLED === 'true',
  denoiseNr:      process.env.DENOISE_NR      || '10',
  denoiseNf:      process.env.DENOISE_NF      || '-25',
};

function buildFfmpegFilter() {
  const filters = [
    `highpass=f=${FFMPEG_CFG.highpassFreq}`,
    `loudnorm=I=${FFMPEG_CFG.loudnormI}:TP=${FFMPEG_CFG.loudnormTp}:LRA=${FFMPEG_CFG.loudnormLra}`,
  ];
  if (FFMPEG_CFG.denoiseEnabled) {
    filters.push(`afftdn=nr=${FFMPEG_CFG.denoiseNr}:nf=${FFMPEG_CFG.denoiseNf}`);
  }
  return filters.join(',');
}

function cleanAudio(audioBuffer, mimeType) {
  const tmpId   = crypto.randomBytes(6).toString('hex');
  const ext     = (mimeType || '').includes('wav') ? 'wav' : 'webm';
  const inPath  = path.join(os.tmpdir(), `pechpech_in_${tmpId}.${ext}`);
  const outPath = path.join(os.tmpdir(), `pechpech_out_${tmpId}.ogg`);

  fs.writeFileSync(inPath, audioBuffer);

  return new Promise((resolve) => {
    const proc = spawn('ffmpeg', [
      '-y', '-i', inPath,
      '-ar', '16000', '-ac', '1',
      '-af', buildFfmpegFilter(),
      '-c:a', 'libopus', '-b:a', '24k',
      outPath,
    ], { stdio: ['ignore', 'ignore', 'pipe'] });

    let ffmpegStderr = '';
    proc.stderr?.setEncoding('utf8');
    proc.stderr?.on('data', chunk => { ffmpegStderr += chunk; });

    proc.on('error', err => {
      try { fs.unlinkSync(inPath); } catch (_) {}
      if (err.code === 'ENOENT') {
        console.warn('[ffmpeg] not found — sending raw audio to STT (install ffmpeg to enable preprocessing)');
      } else {
        console.warn(`[ffmpeg] spawn error: ${err.message} — sending raw audio to STT`);
      }
      resolve({ buffer: audioBuffer, mimeType });
    });

    proc.on('close', code => {
      try { fs.unlinkSync(inPath); } catch (_) {}
      if (code !== 0) {
        console.warn(`[ffmpeg] exited with code ${code} — sending raw audio to STT`);
        if (ffmpegStderr) console.warn(`[ffmpeg] stderr: ${ffmpegStderr.slice(-400)}`);
        try { fs.unlinkSync(outPath); } catch (_) {}
        resolve({ buffer: audioBuffer, mimeType });
        return;
      }
      try {
        const cleaned = fs.readFileSync(outPath);
        fs.unlinkSync(outPath);
        console.log(`[ffmpeg] cleaned: ${audioBuffer.length} → ${cleaned.length} bytes (16 kHz mono Opus/OGG)`);
        resolve({ buffer: cleaned, mimeType: 'audio/ogg' });
      } catch (e) {
        console.warn(`[ffmpeg] could not read output: ${e.message} — sending raw audio to STT`);
        resolve({ buffer: audioBuffer, mimeType });
      }
    });
  });
}

// ── STT: Whisper-compatible Call ──────────────────────────────────

async function transcribeAudio({ audioBuffer, audioMimeType, sttUrl, sttKey, sttModel }) {
  const baseUrl  = (sttUrl || 'http://localhost:8080/v1').replace(/\/$/, '');
  const endpoint = `${baseUrl}/audio/transcriptions`;
  const apiKey   = sttKey   || '';
  const model    = sttModel || 'whisper-1';

  console.log(`[stt] Sending audio to ${endpoint} (${audioBuffer.length} bytes), model="${model}"`);

  const mime     = audioMimeType || 'audio/webm';
  const ext      = mime.includes('ogg') ? 'ogg' : mime.includes('wav') ? 'wav' : 'webm';
  const blob     = new Blob([audioBuffer], { type: mime });
  const form     = new globalThis.FormData();
  form.append('model',           model);
  form.append('language',        'fa');
  form.append('response_format', 'json');
  form.append('file',            blob, `recording.${ext}`);

  const headers = {};
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  let response;
  try {
    response = await globalThis.fetch(endpoint, {
      method:  'POST',
      headers,
      body:    form,
      signal:  AbortSignal.timeout(120_000),
    });
  } catch (err) {
    if (err.name === 'AbortError' || err.name === 'TimeoutError') {
      throw new Error('STT endpoint timed out (>2 min). Is the Whisper server running?');
    }
    throw new Error(`STT endpoint unreachable: ${err.message}. Is the server at ${baseUrl} running?`);
  }

  if (!response.ok) {
    let detail = '';
    try { detail = await response.text(); } catch (_) {}
    throw new Error(`STT server returned HTTP ${response.status}: ${detail || response.statusText}`);
  }

  let json;
  try { json = await response.json(); }
  catch { throw new Error('STT server returned invalid JSON response.'); }

  if (typeof json.text !== 'string') {
    throw new Error(`STT response missing "text" field. Got: ${JSON.stringify(json).slice(0, 200)}`);
  }

  const transcript = json.text.trim();
  console.log(`[stt] Transcript (${transcript.length} chars): ${transcript.slice(0, 120)}…`);
  return transcript;
}

// ── Pipeline Factory ──────────────────────────────────────────────
// createPipeline({ store, createProvider }) → { run, correct }
//
// run(id, config)     — STT → MOM prompt → LLM → parse → store
// correct(id, config) — correction prompt → LLM → parse → store
//
// Both methods are fire-and-forget safe: all errors are caught and
// written to the store rather than thrown to the caller.

function createPipeline({ store, createProvider }) {
  return {
    async run(id, config) {
      try {
        const rec = store.get(id);
        if (!rec) throw new Error(`Recording not found: ${id}`);

        let transcript = rec.transcript || null;

        if (transcript) {
          console.log(`[pipeline] ${id} transcript already exists — skipping STT`);
          store.update(id, { status: 'summarizing' });
        } else {
          store.update(id, { status: 'transcribing' });

          const audioPath   = path.join(store.audioDir, rec.filename);
          const audioBuffer = fs.readFileSync(audioPath);

          const { buffer: cleanedBuffer, mimeType: cleanedMimeType } =
            await cleanAudio(audioBuffer, rec.mimeType);

          if (cleanedMimeType === 'audio/ogg') {
            store.saveCleanedAudio(id, cleanedBuffer, cleanedMimeType);
          }

          transcript = await transcribeAudio({
            audioBuffer:   cleanedBuffer,
            audioMimeType: cleanedMimeType,
            sttUrl:        config.sttUrl,
            sttKey:        config.sttKey,
            sttModel:      config.sttModel,
          });
          store.update(id, { transcript, status: 'summarizing' });
        }

        const provider  = createProvider(config);
        const llmOutput = await provider.invoke(buildMOMPrompt(transcript));
        const mom       = parseMOMOutput(llmOutput);

        store.update(id, {
          status:       'done',
          summary:      mom.summary      || '',
          decisions:    mom.decisions    || '',
          action_items: mom.action_items || '',
          ...(mom._parse_warning ? { warning: mom._parse_warning } : {}),
        });
        console.log(`[pipeline] ${id} done`);

      } catch (err) {
        console.error(`[pipeline] ${id} failed:`, err.message);
        store.update(id, { status: 'error', error: err.message });
      }
    },

    async correct(id, config) {
      try {
        const rec = store.get(id);
        if (!rec?.transcript) {
          store.update(id, {
            correction_status: 'error',
            correction_error:  'No transcript available to correct.',
          });
          return;
        }

        store.update(id, { correction_status: 'correcting', correction_error: null });

        const provider  = createProvider(config);
        const llmOutput = await provider.invoke(buildCorrectionPrompt(rec.transcript));

        const match     = llmOutput.match(/##\s*متن اصلاح[^\n]*\n([\s\S]*)/i);
        const corrected = match ? match[1].trim() : llmOutput.trim();

        store.update(id, {
          correction_status:    'done',
          corrected_transcript: corrected,
        });
        console.log(`[pipeline] correct ${id} done`);

      } catch (err) {
        console.error(`[pipeline] correct ${id} failed:`, err.message);
        store.update(id, { correction_status: 'error', correction_error: err.message });
      }
    },
  };
}

module.exports = { createPipeline };
