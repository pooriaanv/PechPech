'use strict';

// Combines an optional caller-provided AbortSignal (wired to the /cancel
// endpoint) with an internal timeout, so either one can abort the fetch.
function withTimeout(signal, timeoutMs) {
  const signals = [AbortSignal.timeout(timeoutMs)];
  if (signal) signals.push(signal);
  return AbortSignal.any(signals);
}

// ── Shared Whisper-compatible Call ────────────────────────────────
// Used by both the Custom and OpenAI adapters below — they only differ
// in which base URL is used.

async function callWhisperEndpoint({ baseUrl, apiKey, model, audioBuffer, audioMimeType, signal }) {
  const endpoint = `${baseUrl}/audio/transcriptions`;
  console.log(`[stt] Sending audio to ${endpoint} (${audioBuffer.length} bytes), model="${model}"`);

  const mime = audioMimeType || 'audio/webm';
  const ext  = mime.includes('ogg') ? 'ogg' : mime.includes('wav') ? 'wav' : 'webm';
  const blob = new Blob([audioBuffer], { type: mime });
  const form = new globalThis.FormData();
  form.append('model',           model);
  // No `language` field, deliberately: leaving it out asks the server to detect
  // the spoken language itself. It must NOT be derived from the UI language —
  // that is a preference for the interface and the generated minutes, not a
  // statement about what was said, and forcing it makes a Persian meeting come
  // back as English (or the reverse). The server picks the language from the
  // start of the audio, so a meeting that opens in a different language than
  // it continues in can be transcribed in the opening one.
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
      signal:  withTimeout(signal, 300_000),
    });
  } catch (err) {
    if (err.name === 'AbortError' || err.name === 'TimeoutError') {
      throw new Error('STT endpoint timed out (>5 min) or was cancelled. Is the Whisper server running?');
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

// ── Custom / Local Adapter ────────────────────────────────────────
// Any OpenAI-compatible /audio/transcriptions endpoint — local
// whisper.cpp server, self-hosted, GapGPT, Groq, etc. Base URL is
// user-provided.

function createCustomSTTAdapter({ sttUrl, sttKey, sttModel }) {
  const baseUrl = (sttUrl || 'http://localhost:8080/v1').replace(/\/$/, '');
  const apiKey  = sttKey   || '';
  const model   = sttModel || 'whisper-1';

  return {
    transcribe({ audioBuffer, audioMimeType, signal }) {
      return callWhisperEndpoint({ baseUrl, apiKey, model, audioBuffer, audioMimeType, signal });
    },
  };
}

// ── OpenAI Adapter ────────────────────────────────────────────────
// Preset for api.openai.com/v1/audio/transcriptions — same wire format
// as the custom adapter, base URL fixed so users only provide a model
// and an API key.

function createOpenAISTTAdapter({ sttKey, sttModel }) {
  if (!sttKey) {
    throw new Error('OpenAI selected for STT but no API key is set. Add it in the extension settings.');
  }
  const model = sttModel || 'whisper-1';

  return {
    transcribe({ audioBuffer, audioMimeType, signal }) {
      return callWhisperEndpoint({
        baseUrl: 'https://api.openai.com/v1',
        apiKey:  sttKey,
        model,
        audioBuffer,
        audioMimeType,
        signal,
      });
    },
  };
}

// ── Gemini Adapter ────────────────────────────────────────────────
// Gemini has no dedicated transcription endpoint — audio is sent as
// inline multimodal data to generateContent with a transcription
// instruction. Inline data is capped around 20MB by the API; very long
// recordings should use the OpenAI or Custom adapter instead.

function createGeminiSTTAdapter({ sttKey, sttModel }) {
  const apiKey = sttKey   || '';
  const model  = sttModel || 'gemini-3.6-flash';

  if (!apiKey) {
    throw new Error('Gemini selected for STT but no API key is set. Add it in the extension settings.');
  }

  return {
    async transcribe({ audioBuffer, audioMimeType, signal }) {
      const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
      const mime     = audioMimeType || 'audio/ogg';

      console.log(`[stt] Gemini: ${model} (${audioBuffer.length} bytes, ${mime})`);

      if (audioBuffer.length > 19 * 1024 * 1024) {
        throw new Error(
          `Audio is too large for Gemini's inline transcription (${(audioBuffer.length / 1024 / 1024).toFixed(1)} MB, ~19MB limit). ` +
          'Use the OpenAI or Custom STT provider for long recordings.'
        );
      }

      // Language-neutral on purpose (see the note in callWhisperEndpoint): the
      // model is told to write down what is spoken, in whatever language that is.
      const transcribeInstruction =
        'Transcribe this audio file word-for-word and accurately, in the language(s) actually spoken — do not translate. ' +
        'Return only the transcribed text, without any explanation or introduction.';

      let response;
      try {
        response = await globalThis.fetch(endpoint, {
          method:  'POST',
          headers: {
            'Content-Type':   'application/json',
            'x-goog-api-key': apiKey,
          },
          body: JSON.stringify({
            contents: [{
              role:  'user',
              parts: [
                { text: transcribeInstruction },
                { inline_data: { mime_type: mime, data: audioBuffer.toString('base64') } },
              ],
            }],
          }),
          signal: withTimeout(signal, 300_000),
        });
      } catch (err) {
        if (err.name === 'AbortError' || err.name === 'TimeoutError') {
          throw new Error('Gemini STT timed out (>5 min) or was cancelled.');
        }
        throw new Error(`Gemini STT unreachable: ${err.message}`);
      }

      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new Error(`Gemini STT returned HTTP ${response.status}: ${detail || response.statusText}`);
      }

      let json;
      try { json = await response.json(); }
      catch { throw new Error('Gemini STT returned invalid JSON.'); }

      const candidate = json.candidates?.[0];
      if (!candidate) {
        const blockReason = json.promptFeedback?.blockReason;
        throw new Error(
          blockReason
            ? `Gemini blocked the audio request (${blockReason}).`
            : `Gemini STT response missing candidates. Got: ${JSON.stringify(json).slice(0, 200)}`
        );
      }

      const transcript = (candidate.content?.parts || []).map(p => p.text || '').join('').trim();
      if (!transcript) {
        throw new Error(`Gemini STT returned an empty transcript. Finish reason: ${candidate.finishReason || 'unknown'}`);
      }

      console.log(`[stt] Transcript (${transcript.length} chars): ${transcript.slice(0, 120)}…`);
      return transcript;
    },
  };
}

// ── Factory ───────────────────────────────────────────────────────
// Selects the right adapter based on config.sttProvider.

function createSTTProvider(config) {
  const provider = config.sttProvider || 'custom';

  if (provider === 'openai') {
    return createOpenAISTTAdapter({ sttKey: config.sttKey, sttModel: config.sttModel });
  }
  if (provider === 'gemini') {
    return createGeminiSTTAdapter({ sttKey: config.sttKey, sttModel: config.sttModel });
  }
  return createCustomSTTAdapter({
    sttUrl:   config.sttUrl,
    sttKey:   config.sttKey,
    sttModel: config.sttModel,
  });
}

module.exports = { createSTTProvider };
