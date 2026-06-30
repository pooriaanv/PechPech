/**
 * offscreen.js — PechPech Offscreen Document
 *
 * Flow:
 *  1. Script loads → sends OFFSCREEN_READY to background
 *  2. Background receives READY, then sends START_CAPTURE { streamId }
 *  3. Opens tab audio stream via chromeMediaSource + mic (falls back to tab-only if mic denied)
 *  4. Mixes both via Web Audio API → MediaRecorder
 *  5. On STOP_CAPTURE, finalizes recording and sends audio blob (base64) back
 */

let mediaRecorder = null;
let audioChunks   = [];
let audioContext  = null;
let tabStream     = null;
let micStream     = null;
let destination   = null;

// ── Message handler ───────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'START_CAPTURE') {
    startCapture(msg.streamId)
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

async function startCapture(streamId) {
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

  mediaRecorder = new MediaRecorder(destination.stream, { mimeType });

  mediaRecorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) audioChunks.push(e.data);
  };

  mediaRecorder.onerror = (e) => {
    const detail = e.error ? `${e.error.name}: ${e.error.message}` : 'unknown MediaRecorder error';
    console.error('[offscreen] MediaRecorder error:', detail);
    chrome.runtime.sendMessage({ type: 'OFFSCREEN_ERROR', error: detail });
  };

  mediaRecorder.start(5000);

  chrome.runtime.sendMessage({
    type:    'RECORDING_STARTED',
    hasMic:  !!micStream,
  });
  console.log('[offscreen] Recording started — mimeType:', mimeType, '| mic:', !!micStream);
}

// ── Stop Capture ──────────────────────────────────────────────────

async function stopCapture() {
  return new Promise((resolve, reject) => {
    if (!mediaRecorder || mediaRecorder.state === 'inactive') {
      reject(new Error('MediaRecorder is not active'));
      return;
    }

    mediaRecorder.onstop = async () => {
      try {
        const mimeType  = mediaRecorder.mimeType;
        const audioBlob = new Blob(audioChunks, { type: mimeType });
        const base64    = await blobToBase64(audioBlob);

        chrome.runtime.sendMessage({
          type:      'AUDIO_DATA',
          audioData: base64,
          mimeType:  mimeType,
        });

        cleanup();
        resolve();
      } catch (err) {
        reject(err);
      }
    };

    mediaRecorder.stop();
  });
}

// ── Helpers ───────────────────────────────────────────────────────

function getSupportedMimeType() {
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

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result.split(',')[1]);
    reader.onerror   = reject;
    reader.readAsDataURL(blob);
  });
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
}
