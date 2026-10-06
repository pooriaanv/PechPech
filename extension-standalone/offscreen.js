/**
 * offscreen.js — PechPech Standalone Offscreen Document
 *
 * Flow:
 *  1. Script loads → sends OFFSCREEN_READY to background
 *  2. Background receives READY, then sends START_CAPTURE { streamId }
 *  3. Opens tab audio stream via chromeMediaSource + mic (falls back to tab-only if mic denied)
 *  4. Mixes both via Web Audio API → MediaRecorder
 *  5. On STOP_CAPTURE, finalizes recording and writes it directly into
 *     IndexedDB via store.js — no server, no chrome.runtime.sendMessage
 *     transfer of the Blob (which has a ~64MB IPC ceiling). Only the
 *     resulting {id} goes back to background via messaging.
 */

import { createRecording } from './store.js';
import { fixWebmDuration } from './webm-duration.js';

// Meeting speech, not music. Chrome defaults MediaRecorder to 128 kbps stereo
// (~54 MB/hour), a ceiling set for music rather than for the STT model that
// actually consumes this file. The user picks one of two presets in Settings
// ("audioQuality"); only the preset NAME is stored there, the numbers live
// here next to the recorder.
//
//   standard  64 kbps  up to ~28 MB/hour (measured: 27.7 MiB for non-stop
//                      audio, ~21 MiB with the pauses real meetings have).
//                      Default: the safest for transcription accuracy.
//   compact   32 kbps  up to ~13 MB/hour. Half the size, for slow uplinks and
//                      for hour-plus meetings that would otherwise exceed a
//                      provider's upload limit (OpenAI: 25 MB).
//
// Accuracy cost of compact is NOT measured for Whisper or Farsi. The one study
// found (arXiv 2002.00122, a different recognizer, English far-field) saw
// word error rate rise 2.4% relative at 128 kbps and 6.6% at 32 kbps against
// uncompressed audio, with a steep cliff below 16 kbps. Hence a choice, with
// the safer preset as the default. A recording can't be upgraded afterwards.
const AUDIO_QUALITY_BITRATES = { standard: 64000, compact: 32000 };
const DEFAULT_AUDIO_QUALITY  = 'standard';

// Anything unrecognised (a missing setting, a hand-edited or stale value)
// falls back to the default rather than failing the recording.
function resolveQuality(quality) {
  return Object.hasOwn(AUDIO_QUALITY_BITRATES, quality) ? quality : DEFAULT_AUDIO_QUALITY;
}

let mediaRecorder = null;
let audioChunks   = [];
let audioContext  = null;
let tabStream     = null;
let micStream     = null;
let destination   = null;
let recordingStartedAt = 0;

// ── Message handler ───────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'START_CAPTURE') {
    startCapture(msg.streamId, msg.audioQuality)
      .then(() => sendResponse({ success: true }))
      .catch((err) => {
        const detail = `${err.name}: ${err.message}`;
        console.error('[offscreen] Start error:', detail, err);
        chrome.runtime.sendMessage({ type: 'OFFSCREEN_ERROR', error: detail });
        sendResponse({ success: false, error: detail });
      });
    return true;
  }

  if (msg.type === 'STOP_CAPTURE') {
    stopCapture()
      .then(() => sendResponse({ success: true }))
      .catch((err) => {
        const detail = `${err.name}: ${err.message}`;
        console.error('[offscreen] Stop error:', detail, err);
        chrome.runtime.sendMessage({ type: 'OFFSCREEN_ERROR', error: detail });
      });
    return true;
  }
});

// Tell background we are ready to receive START_CAPTURE.
// Background waits for this before sending the message, so the stream ID
// doesn't expire while the offscreen doc is still loading.
chrome.runtime.sendMessage({ type: 'OFFSCREEN_READY' });

// ── Start Capture ─────────────────────────────────────────────────

async function startCapture(streamId, audioQuality) {
  const qualityName        = resolveQuality(audioQuality);
  const audioBitsPerSecond = AUDIO_QUALITY_BITRATES[qualityName];

  // 1. Tab audio — must succeed, this is the primary stream
  tabStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource:   'tab',
        chromeMediaSourceId: streamId,
      },
    },
    video: false,
  });

  // 2. Microphone — optional, fall back gracefully if denied or unavailable
  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
      },
      video: false,
    });
  } catch (micErr) {
    console.warn(
      `[offscreen] Mic unavailable (${micErr.name}: ${micErr.message}). ` +
      'Recording tab audio only.'
    );
    micStream = null;
  }

  // 3. Mix via Web Audio API
  audioContext = new AudioContext();
  destination  = audioContext.createMediaStreamDestination();

  // Record in mono. At a fixed bitrate the encoder then spends every bit on a
  // single channel instead of splitting them across two, which matters at the
  // low bitrate set above. This applies only to the recorded stream — the
  // speaker passthrough below is a different node and stays untouched, so the
  // user keeps hearing the call at full quality.
  destination.channelCount          = 1;
  destination.channelCountMode      = 'explicit';
  destination.channelInterpretation = 'speakers';

  const tabSource = audioContext.createMediaStreamSource(tabStream);
  tabSource.connect(destination);
  tabSource.connect(audioContext.destination); // play back to speakers so user still hears the call

  if (micStream) {
    const micSource = audioContext.createMediaStreamSource(micStream);
    micSource.connect(destination);
  }

  // 4. Record the mixed stream
  const mimeType = getSupportedMimeType();
  audioChunks    = [];

  mediaRecorder = new MediaRecorder(destination.stream, {
    mimeType,
    audioBitsPerSecond,
  });

  mediaRecorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) audioChunks.push(e.data);
  };

  mediaRecorder.onerror = (e) => {
    const detail = e.error ? `${e.error.name}: ${e.error.message}` : 'unknown MediaRecorder error';
    console.error('[offscreen] MediaRecorder error:', detail);
    chrome.runtime.sendMessage({ type: 'OFFSCREEN_ERROR', error: detail });
  };

  mediaRecorder.start(5000);
  recordingStartedAt = performance.now();

  chrome.runtime.sendMessage({
    type:    'RECORDING_STARTED',
    hasMic:  !!micStream,
  });
  console.log(
    '[offscreen] Recording started — mimeType:', mimeType,
    '| mic:', !!micStream,
    '|', audioBitsPerSecond / 1000, 'kbps mono', `(${qualityName})`
  );
}

// ── Stop Capture ──────────────────────────────────────────────────
// Writes the blob directly into IndexedDB (store.js) instead of passing
// it through Chrome message channels (~64MB IPC limit) or uploading it
// anywhere — this offscreen document is the only place that ever holds
// the raw Blob in memory.

async function stopCapture() {
  return new Promise((resolve, reject) => {
    if (!mediaRecorder || mediaRecorder.state === 'inactive') {
      reject(new Error('MediaRecorder is not active'));
      return;
    }

    mediaRecorder.onstop = async () => {
      try {
        const mimeType   = mediaRecorder.mimeType;
        const durationMs = performance.now() - recordingStartedAt;
        const rawBlob    = new Blob(audioChunks, { type: mimeType });

        // MediaRecorder never writes a duration into the WebM header (it is
        // still streaming when the header goes out). Most players don't care,
        // but some STT services reject the upload outright — "webm duration
        // parsing requires full EBML parser". Patch it in before storing, so
        // every later re-process/retry uses the fixed blob too. Returns the
        // original blob untouched if anything about the structure is unexpected.
        const audioBlob = await fixWebmDuration(rawBlob, durationMs);

        const rec = await createRecording({ audioBlob, mimeType });

        chrome.runtime.sendMessage({ type: 'RECORDING_SAVED', id: rec.id });
        cleanup();
        resolve();
      } catch (err) {
        const detail = `${err.name}: ${err.message}`;
        console.error('[offscreen] Save error:', detail);
        chrome.runtime.sendMessage({ type: 'OFFSCREEN_ERROR', error: detail });
        cleanup();
        reject(err);
      }
    };

    mediaRecorder.stop();
  });
}

// ── Helpers ───────────────────────────────────────────────────────

function getSupportedMimeType() {
  // WebM, because one recording format has to serve every STT provider (this
  // runs before anything knows which provider will process it — that is only
  // decided later, at process time) and WebM is what they have all been handed
  // so far. MP4 is NOT a way out of WebM's missing-duration problem: Chrome's
  // MP4 is fragmented and also ships with duration 0 in its header (checked by
  // parsing the boxes — <audio> only looks fine because Chrome's own demuxer is
  // lenient), so it has the same defect in another container. It would also
  // risk Gemini, whose documented inline_data audio types are
  // wav/mp3/aiff/aac/ogg/flac, with no audio/mp4. The defect is instead patched
  // after recording by fixWebmDuration(), which changes nothing a provider sees
  // except the header.
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/ogg;codecs=opus',
    'audio/ogg',
  ];
  for (const type of candidates) {
    if (MediaRecorder.isTypeSupported(type)) return type;
  }
  return '';
}


function cleanup() {
  try {
    tabStream?.getTracks().forEach(t => t.stop());
    micStream?.getTracks().forEach(t => t.stop());
    if (audioContext?.state !== 'closed') audioContext?.close();
  } catch (e) {
    console.warn('[offscreen] Cleanup error:', e);
  }
  tabStream = micStream = audioContext = destination = mediaRecorder = null;
  audioChunks = [];
  recordingStartedAt = 0;
}
