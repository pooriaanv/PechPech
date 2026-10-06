'use strict';

const fs     = require('fs');
const path   = require('path');
const os     = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');
const yaml   = require('js-yaml');

const { createSTTProvider } = require('./stt-providers');

// ── Prompt Templates ──────────────────────────────────────────────

const PROMPTS = yaml.load(fs.readFileSync(path.join(__dirname, 'prompts.yaml'), 'utf8'));

// Prompt builders: `language` ('en' | 'fa') selects the base template from
// prompts.yaml; an optional `customTemplate` (e.g. a user-supplied prompt
// synced from extension settings) still wins regardless of language,
// mirroring extension-standalone/prompts.js's buildMOMPrompt/etc exactly.
function buildMOMPrompt(transcript, language, customTemplate) {
  const base = customTemplate || (language === 'fa' ? PROMPTS.mom.fa : PROMPTS.mom.en);
  return base.replace('{{transcript}}', transcript);
}

function buildNotesPrompt(transcript, language, customTemplate) {
  const base = customTemplate || (language === 'fa' ? PROMPTS.notes.fa : PROMPTS.notes.en);
  return base.replace('{{transcript}}', transcript);
}

function buildCorrectionPrompt(transcript, language, customTemplate) {
  const base = customTemplate || (language === 'fa' ? PROMPTS.correction.fa : PROMPTS.correction.en);
  return base.replace('{{transcript}}', transcript);
}

// ── MOM Output Parser ─────────────────────────────────────────────
// Parallel EN/FA regex pattern sets, ported verbatim from
// extension-standalone/prompts.js's MOM_PATTERNS.

const MOM_PATTERNS = {
  en: [
    { key: 'summary',      regex: /##\s*Summary[^\n]*\n([\s\S]*?)(?=##|$)/i      },
    { key: 'decisions',    regex: /##\s*Decisions[^\n]*\n([\s\S]*?)(?=##|$)/i    },
    { key: 'action_items', regex: /##\s*Action Items[^\n]*\n([\s\S]*?)(?=##|$)/i },
  ],
  fa: [
    { key: 'summary',      regex: /##\s*خلاصه[^\n]*\n([\s\S]*?)(?=##|$)/i      },
    { key: 'decisions',    regex: /##\s*تصمیمات[^\n]*\n([\s\S]*?)(?=##|$)/i    },
    { key: 'action_items', regex: /##\s*اقدامات[^\n]*\n([\s\S]*?)(?=##|$)/i    },
  ],
};

function parseMOMOutput(text, language) {
  const normalized = text.replace(/\r\n/g, '\n').trim();
  const patterns    = MOM_PATTERNS[language] || MOM_PATTERNS.en;

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

// ── Notes Output Parser ───────────────────────────────────────────

const NOTES_HEADING_RE = {
  en: /##\s*Notes[^\n]*\n([\s\S]*)/i,
  fa: /##\s*یادداشت‌ها[^\n]*\n([\s\S]*)/i,
};

function parseNotesOutput(text, language) {
  const normalized = text.replace(/\r\n/g, '\n').trim();
  const regex       = NOTES_HEADING_RE[language] || NOTES_HEADING_RE.en;
  const match       = normalized.match(regex);
  const raw         = match ? match[1].trim() : normalized;
  const lines        = raw
    .split('\n')
    .map(l => l.replace(/^[\s\-•*]+/, '').trim())
    .filter(Boolean);
  return lines.join('\n');
}

// ── Correction Output Parser ──────────────────────────────────────

const CORRECTION_HEADING_RE = {
  en: /##\s*Corrected Text[^\n]*\n([\s\S]*)/i,
  fa: /##\s*متن اصلاح[^\n]*\n([\s\S]*)/i,
};

function parseCorrectionOutput(text, language) {
  const regex = CORRECTION_HEADING_RE[language] || CORRECTION_HEADING_RE.en;
  const match = text.match(regex);
  return match ? match[1].trim() : text.trim();
}

// ── Pipeline Factory ──────────────────────────────────────────────
// createPipeline({ store, createProvider }) → { run, correct }
//
// run(id, config, mode, signal, language)  — STT → prompt (mom|notes) → LLM → parse → store
// correct(id, config, signal, language)    — correction prompt → LLM → parse → store
//
// `language` ('en' | 'fa', defaults to 'en') is resolved and pinned by the
// caller (server.js) — see its /recordings/:id/process and
// /recordings/:id/correct handlers for the pinning logic. It is used
// as-is here to select the prompt/parser language only — speech-to-text takes
// no language and detects the spoken one from the audio.
//
// Both methods are fire-and-forget safe: all errors are caught and
// written to the store rather than thrown to the caller.

function createPipeline({ store, createProvider }) {
  return {
    async run(id, config, mode = 'mom', signal, language = 'en') {
      try {
        const rec = store.get(id);
        if (!rec) throw new Error(`Recording not found: ${id}`);

        let transcript = rec.transcript || null;

        if (transcript) {
          console.log(`[pipeline] ${id} transcript already exists — skipping STT`);
          store.update(id, { status: 'summarizing' });
        } else {
          store.update(id, { status: 'transcribing', processingStartedAt: Date.now() });

          const audioPath   = path.join(store.audioDir, rec.filename);
          const audioBuffer = fs.readFileSync(audioPath);

          const { buffer: cleanedBuffer, mimeType: cleanedMimeType } =
            await cleanAudio(audioBuffer, rec.mimeType);

          if (cleanedMimeType === 'audio/ogg') {
            store.saveCleanedAudio(id, cleanedBuffer, cleanedMimeType);
          }

          const sttProvider = createSTTProvider(config);
          transcript = await sttProvider.transcribe({
            audioBuffer:   cleanedBuffer,
            audioMimeType: cleanedMimeType,
            signal,
          });
          store.update(id, { transcript, status: 'summarizing' });
        }

        const provider = createProvider(config);

        if (mode === 'notes') {
          const llmOutput = await provider.invoke(buildNotesPrompt(transcript, language, config.promptNotes), { signal });
          const notes     = parseNotesOutput(llmOutput, language);
          store.update(id, { status: 'done', mode: 'notes', notes });
        } else {
          const llmOutput = await provider.invoke(buildMOMPrompt(transcript, language, config.promptMom), { signal });
          const mom       = parseMOMOutput(llmOutput, language);
          store.update(id, {
            status:       'done',
            mode:         'mom',
            summary:      mom.summary      || '',
            decisions:    mom.decisions    || '',
            action_items: mom.action_items || '',
            ...(mom._parse_warning ? { warning: mom._parse_warning } : {}),
          });
        }
        console.log(`[pipeline] ${id} done (mode: ${mode}, language: ${language})`);

      } catch (err) {
        console.error(`[pipeline] ${id} failed:`, err.message);
        store.update(id, { status: 'error', error: err.message });
      }
    },

    async correct(id, config, signal, language = 'en') {
      try {
        const rec = store.get(id);
        if (!rec?.transcript) {
          store.update(id, {
            correction_status: 'error',
            correction_error:  'No transcript available to correct.',
          });
          return;
        }

        store.update(id, {
          correction_status:   'correcting',
          correction_error:    null,
          processingStartedAt: Date.now(),
        });

        const provider  = createProvider(config);
        const llmOutput = await provider.invoke(buildCorrectionPrompt(rec.transcript, language, config.promptCorrection), { signal });

        const corrected = parseCorrectionOutput(llmOutput, language);

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

module.exports = {
  createPipeline,
  buildMOMPrompt,
  buildNotesPrompt,
  buildCorrectionPrompt,
  parseMOMOutput,
  parseNotesOutput,
  parseCorrectionOutput,
};
