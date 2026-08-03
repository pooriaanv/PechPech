'use strict';

// providers.js — merges server/src/stt-providers.js + server/src/llm-providers.js
// for use directly inside the extension (background.js). Both were already
// pure fetch()/FormData/Blob-based code with no Node-specific APIs, so the
// port is close to verbatim. Two real changes:
//   1. STT adapters take { audioBlob, mimeType } instead of
//      { audioBuffer, audioMimeType } — no Buffer conversion needed, we
//      start from a Blob already (read straight out of IndexedDB).
//   2. Gemini's base64 step uses blobToBase64() (FileReader) since Buffer
//      doesn't exist in a browser.
// The CLI-based LLM adapter (codex/custom shell command) is dropped
// entirely — it needs child_process.spawn, which cannot run in a
// browser extension under any circumstances.

// ── Helpers ───────────────────────────────────────────────────────

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = () => resolve(reader.result.split(',')[1]); // strip data: URL prefix
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

// Combines an optional caller-provided AbortSignal (e.g. wired to a Cancel
// button) with an internal timeout, so either one can abort the fetch.
function withTimeout(signal, timeoutMs) {
  const signals = [AbortSignal.timeout(timeoutMs)];
  if (signal) signals.push(signal);
  return AbortSignal.any(signals);
}

// ── Shared Whisper-compatible Call ────────────────────────────────

async function callWhisperEndpoint({ baseUrl, apiKey, model, audioBlob, mimeType, signal }) {
  const endpoint = `${baseUrl}/audio/transcriptions`;
  console.log(`[stt] Sending audio to ${endpoint} (${audioBlob.size} bytes), model="${model}"`);

  const mime = mimeType || 'audio/webm';
  const ext  = mime.includes('ogg') ? 'ogg' : mime.includes('wav') ? 'wav' : 'webm';
  const form = new FormData();
  form.append('model',           model);
  form.append('language',        'fa');
  form.append('response_format', 'json');
  form.append('file',            audioBlob, `recording.${ext}`);

  const headers = {};
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  let response;
  try {
    response = await fetch(endpoint, {
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

// ── Custom / Local STT Adapter ────────────────────────────────────

function createCustomSTTAdapter({ sttUrl, sttKey, sttModel }) {
  const baseUrl = (sttUrl || 'http://localhost:8080/v1').replace(/\/$/, '');
  const apiKey  = sttKey   || '';
  const model   = sttModel || 'whisper-1';

  return {
    transcribe({ audioBlob, mimeType, signal }) {
      return callWhisperEndpoint({ baseUrl, apiKey, model, audioBlob, mimeType, signal });
    },
  };
}

// ── OpenAI STT Adapter ────────────────────────────────────────────

function createOpenAISTTAdapter({ sttKey, sttModel }) {
  if (!sttKey) {
    throw new Error('OpenAI selected for STT but no API key is set. Add it in the extension settings.');
  }
  const model = sttModel || 'whisper-1';

  return {
    transcribe({ audioBlob, mimeType, signal }) {
      return callWhisperEndpoint({
        baseUrl: 'https://api.openai.com/v1',
        apiKey:  sttKey,
        model,
        audioBlob,
        mimeType,
        signal,
      });
    },
  };
}

// ── Gemini STT Adapter ────────────────────────────────────────────

function createGeminiSTTAdapter({ sttKey, sttModel }) {
  const apiKey = sttKey   || '';
  const model  = sttModel || 'gemini-3.6-flash';

  if (!apiKey) {
    throw new Error('Gemini selected for STT but no API key is set. Add it in the extension settings.');
  }

  return {
    async transcribe({ audioBlob, mimeType, signal }) {
      const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
      const mime     = mimeType || 'audio/ogg';

      console.log(`[stt] Gemini: ${model} (${audioBlob.size} bytes, ${mime})`);

      if (audioBlob.size > 19 * 1024 * 1024) {
        throw new Error(
          `Audio is too large for Gemini's inline transcription (${(audioBlob.size / 1024 / 1024).toFixed(1)} MB, ~19MB limit). ` +
          'Use the OpenAI or Custom STT provider for long recordings.'
        );
      }

      const base64 = await blobToBase64(audioBlob);

      let response;
      try {
        response = await fetch(endpoint, {
          method:  'POST',
          headers: {
            'Content-Type':   'application/json',
            'x-goog-api-key': apiKey,
          },
          body: JSON.stringify({
            contents: [{
              role:  'user',
              parts: [
                { text: 'این فایل صوتی را کلمه به کلمه و دقیق به فارسی رونویسی کن. فقط متن رونویسی‌شده را برگردان، بدون هیچ توضیح یا مقدمه‌ای.' },
                { inline_data: { mime_type: mime, data: base64 } },
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

// ── STT Factory ───────────────────────────────────────────────────

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

// ── Generic OpenAI-compatible Chat API Adapter ────────────────────

function createAPIAdapter({ llmApiUrl, llmApiKey, llmApiModel }) {
  const baseUrl = (llmApiUrl || '').replace(/\/$/, '');
  const apiKey  = llmApiKey   || '';
  const model   = llmApiModel || 'gpt-4o';

  if (!baseUrl) {
    throw new Error('Custom API selected but no API URL is set. Configure it in the extension settings.');
  }

  return {
    async invoke(promptText, { signal } = {}) {
      console.log(`[llm] API: ${baseUrl}/chat/completions model=${model} (prompt ${promptText.length} chars)`);

      let response;
      try {
        response = await fetch(`${baseUrl}/chat/completions`, {
          method:  'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
          },
          body:   JSON.stringify({
            model,
            messages: [{ role: 'user', content: promptText }],
          }),
          signal: withTimeout(signal, 900_000),
        });
      } catch (err) {
        if (err.name === 'AbortError' || err.name === 'TimeoutError') {
          throw new Error(`LLM API timed out after 15 minutes or was cancelled. URL: ${baseUrl}`);
        }
        throw new Error(`LLM API unreachable: ${err.message}`);
      }

      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new Error(`LLM API returned HTTP ${response.status}: ${detail || response.statusText}`);
      }

      let json;
      try { json = await response.json(); }
      catch { throw new Error('LLM API returned invalid JSON.'); }

      const text = json.choices?.[0]?.message?.content;
      if (typeof text !== 'string') {
        throw new Error(
          `LLM API response missing choices[0].message.content. ` +
          `Got: ${JSON.stringify(json).slice(0, 200)}`
        );
      }

      return text;
    },
  };
}

// ── OpenAI LLM Adapter ────────────────────────────────────────────

function createOpenAIAdapter({ llmApiKey, llmApiModel }) {
  if (!llmApiKey) {
    throw new Error('OpenAI selected but no API key is set. Add it in the extension settings.');
  }
  return createAPIAdapter({
    llmApiUrl:   'https://api.openai.com/v1',
    llmApiKey,
    llmApiModel: llmApiModel || 'gpt-4o',
  });
}

// ── Gemini LLM Adapter ────────────────────────────────────────────

function createGeminiAdapter({ llmApiKey, llmApiModel }) {
  const apiKey = llmApiKey || '';
  const model  = llmApiModel || 'gemini-3.6-flash';

  if (!apiKey) {
    throw new Error('Gemini selected but no API key is set. Add it in the extension settings.');
  }

  return {
    async invoke(promptText, { signal } = {}) {
      const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
      console.log(`[llm] Gemini: ${model} (prompt ${promptText.length} chars)`);

      let response;
      try {
        response = await fetch(endpoint, {
          method:  'POST',
          headers: {
            'Content-Type':   'application/json',
            'x-goog-api-key': apiKey,
          },
          body: JSON.stringify({
            contents: [{ role: 'user', parts: [{ text: promptText }] }],
          }),
          signal: withTimeout(signal, 900_000),
        });
      } catch (err) {
        if (err.name === 'AbortError' || err.name === 'TimeoutError') {
          throw new Error(`Gemini API timed out after 15 minutes or was cancelled. Model: ${model}`);
        }
        throw new Error(`Gemini API unreachable: ${err.message}`);
      }

      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new Error(`Gemini API returned HTTP ${response.status}: ${detail || response.statusText}`);
      }

      let json;
      try { json = await response.json(); }
      catch { throw new Error('Gemini API returned invalid JSON.'); }

      const candidate = json.candidates?.[0];
      if (!candidate) {
        const blockReason = json.promptFeedback?.blockReason;
        throw new Error(
          blockReason
            ? `Gemini blocked the request (${blockReason}).`
            : `Gemini API response missing candidates. Got: ${JSON.stringify(json).slice(0, 200)}`
        );
      }

      const text = (candidate.content?.parts || []).map(p => p.text || '').join('');
      if (!text) {
        throw new Error(`Gemini API returned an empty response. Finish reason: ${candidate.finishReason || 'unknown'}`);
      }

      return text;
    },
  };
}

// ── LLM Factory ───────────────────────────────────────────────────
// Note: unlike the server's createProvider(), there is no CLI-adapter
// fallback branch here — CLI tools cannot run in a browser extension.

function createLLMProvider(config) {
  const provider = config.llmCli || 'openai';

  if (provider === 'api') {
    return createAPIAdapter({
      llmApiUrl:   config.llmApiUrl,
      llmApiKey:   config.llmApiKey,
      llmApiModel: config.llmApiModel,
    });
  }
  if (provider === 'openai') {
    return createOpenAIAdapter({ llmApiKey: config.llmApiKey, llmApiModel: config.llmApiModel });
  }
  if (provider === 'gemini-api') {
    return createGeminiAdapter({ llmApiKey: config.llmApiKey, llmApiModel: config.llmApiModel });
  }

  throw new Error(`LLM provider "${provider}" is not supported in the standalone build.`);
}

export { createSTTProvider, createLLMProvider };
