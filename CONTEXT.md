# Meeting MOM Generator — Build Spec

## 1. Problem Statement

We attend many online meetings daily. The core problem is **attention, not synthesis** — during the meeting we don't take notes because we're focused on the conversation, and afterward the details are forgotten. We need a tool that passively captures the meeting and automatically produces a Minutes of Meeting (MOM) with zero manual effort during the call.

## 2. Scope (v1)

- **Personal tool.** Each user runs this entirely on their own machine. No shared backend, no multi-user accounts, no server we host or maintain.
- **Meetings covered:** browser-tab meetings only (Google Meet, Zoom-web, Teams-web, or any tab playing meeting audio). Desktop apps (Zoom/Teams native) and phone calls are out of scope for v1.
- **Trigger:** recording is fully manual — user clicks Start when the meeting begins, Stop when it ends. No live/streaming transcription. Both variants do watch for meeting URLs (Meet, Zoom, Teams, Skype plus user-added domains), but only to *suggest* recording with a toolbar badge and a notification — they never start it.
- **Output:** a MOM with exactly three sections — **Summary / Decisions / Action Items** (**خلاصه / تصمیمات / اقدامات** in Persian) — shown inline in the extension popup, with a Save/Download button (.md file). A **Notes** mode instead extracts one bullet per thought, for a single speaker thinking aloud (§15).
- **Recordings list:** All past recordings are listed in the idle state. Each recording shows its title (or date), status badge, an inline audio player **with the recording's length**, and Process / View Result / Cancel / Delete buttons. The card that is playing stays highlighted and keeps its play/pause state when the list is redrawn. State persists across popup open/close via `chrome.storage.session`.
- **Language:** meetings are primarily in Persian/Farsi, but nothing is forced. The **spoken language is auto-detected** by the STT step — no `language` is sent to the STT endpoint (§5, §15). Separately, the UI and the generated minutes are English (default) or Persian, chosen by the user (§16); that choice never influences the transcript.

## 3. Architecture Overview

The system has two cooperating components, because Chrome extensions cannot invoke local CLI tools or run heavy local ML models. The split is:

```
┌──────────────────────────────┐
│   Chrome Extension            │   - Captures tab audio + mic
│   (capture + UI only)         │   - Start/Stop controls
│                               │   - Recordings list + audio playback
│                               │   - Settings screen (reads/writes via server API)
│                               │   - Displays MOM + Save button
│                               │   - Onboarding page on first install
└──────────────┬────────────────┘
               │ HTTP (localhost only)
               ▼
┌──────────────────────────────┐
│   Backend Server              │   - Small always-running local server
│   (orchestration)             │   - Receives audio, saves to disk
│                               │   - Pre-processes audio with ffmpeg (inline)
│                               │   - Serves recordings list + audio
│                               │   - Manages config (GET/POST /config)
│                               │   - Recording Pipeline: STT → LLM → parsed MOM
└──────┬──────────────┬─────────┘
       │              │
       ▼              ▼
┌─────────────┐  ┌──────────────────────────────┐
│ STT Provider │  │ LLM Provider (configurable)   │
│ (Whisper-   │  │ - Claude Code (CLI)            │
│  compatible) │  │ - Custom API (OpenAI-compat.)  │
│             │  │ - Custom CLI command            │
└─────────────┘  └──────────────────────────────┘
```

**Why this split:**
- The extension stays lightweight and is the natural place for tab-audio capture (`chrome.tabCapture`) and UI.
- The backend server is the only place that can shell out to CLI tools and call any HTTP-based STT/LLM provider.
- Nothing here requires us to run or pay for any shared infrastructure. Everything lives on the user's own machine.

**Run modes:** the backend server runs either as a native Node.js process or inside a Docker container. The launcher (`launcher/index.js`) abstracts this — it reads `.env` and handles both modes transparently.

**No-server variant:** `extension-standalone/` collapses both boxes above into a single MV3 extension with no backend at all — STT/LLM calls go straight from the service worker to the provider, and recordings live in IndexedDB instead of on disk. See §15.

## 4. Component 1: Chrome Extension

### Responsibilities
- Capture **tab audio output** (other participants) via `chrome.tabCapture`.
- Capture **microphone input** (the user's own voice) via `getUserMedia`.
- Mix both streams via `AudioContext` → `MediaStreamDestination` → `MediaRecorder` (webm/opus).
- Open **onboarding.html** in a new tab on first install and on extension reload (`chrome.runtime.onInstalled`).
- Provide UI:
  - **Idle state** — large gradient record button + scrollable list of past recordings.
  - **Recording state** — red ripple animation, elapsed timer, Stop button.
  - **Processing state** — two-step indicator (رونویسی / تحلیل) with pulse animation.
  - **Result state** — MOM card (خلاصه / تصمیمات / اقدامات) + corrected transcript section + Save .md + Back buttons.
  - **Error state** — error card with word-break overflow protection.
  - **Settings page** — STT URL, STT key, STT model, LLM type (claude/api/custom), API fields, helper port.
  - **Onboarding page** — 5-step wizard explaining PechPech, how it works, setup, live server health check, and ready state.

### User flow (implemented)

1. User clicks **Start** → popup requests mic permission, health-checks the helper, then sends `START_RECORDING` to background.
2. Background creates offscreen document (audio capture runs there).
3. User clicks **Stop** → background tells the offscreen document to stop `MediaRecorder`. The offscreen document then POSTs the finished recording straight to the server (`POST /transcribe-and-summarize`) — this avoids Chrome's ~64 MB message-size limit — and reports only the new `{id}` back to background via `AUDIO_SAVED`.
4. Popup returns to **idle** and refreshes the recordings list.
5. User clicks **Process** on a recording card → popup POSTs `{ mode, language }` to `POST /recordings/:id/process` → switches to **processing** state → polls `GET /recordings/:id` every 3 s until `done` or `error`. **Cancel** calls `POST /recordings/:id/cancel`.
6. User can close the popup while processing; on reopen `chrome.storage.session` restores the polling state.

### Technical notes
- **Manifest V3.** Service workers restart frequently; all recording state (`isRecording`, `recordingTabId`, `startedAt`) lives in `chrome.storage.session`, not in-memory variables.
- **OFFSCREEN_READY handshake:** offscreen.js sends `OFFSCREEN_READY` message before registering the capture listener. Background awaits this promise (with 5 s timeout) before sending `START_CAPTURE`, preventing the `tabCapture` stream ID from expiring during document load.
- **Mic permission from popup:** `getUserMedia` in a hidden offscreen document cannot show a permission dialog. The popup requests mic permission explicitly (then immediately stops the tracks) before calling `START_RECORDING`.
- **Mic is non-fatal:** if mic capture fails after tab audio succeeds, recording continues with tab-only audio.
- **Audio mixing:** tab + mic → `AudioContext` → `MediaStreamDestination` → `MediaRecorder(webm/opus)`.
- **Config split:** all STT/LLM settings live in `server/src/config.json` and are read/written via `GET /config` and `POST /config` on the backend server. `chrome.storage.local` holds only `helperPort` (the bootstrap value) and a few extension-side preferences (table below).
- **Popup session persistence** via `chrome.storage.session` keys: `popupState`, `recordingId`, `currentMOM`, `errorMsg`.
- **Onboarding:** `chrome.runtime.onInstalled` in `background.js` opens `onboarding.html` for both `reason === 'install'` and `reason === 'update'` (which fires on developer reload too). All extension pages use external `.js` files — **no inline scripts**: MV3's CSP blocks them unconditionally and the manifest cannot relax it. This is why the early-boot snippet that hides a page until its language is applied is a separate `lang-pending.js` (a plain classic `<script src>`, not a module, so it still runs before first paint) rather than an inline `<script>`.
- **UI:** Vazirmatn font, self-hosted (`fonts.css` + `fonts/*.woff2`, see §15 "Fonts"), RTL layout when the language is Persian, violet (`#7c3aed`) primary color. English/Persian UI: §16.

### chrome.storage.local

`helperPort` is the bootstrap value the extension needs to reach the server before any other config can be fetched. All STT/LLM settings come from `GET /config` on the server and are written back via `POST /config`. The remaining keys are small extension-side preferences:

| Key | Default | Description |
|-----|---------|-------------|
| `helperPort` | `3456` | Port the backend server listens on |
| `language` | `en` | UI and generated-minutes language: `en` / `fa` (§16) |
| `defaultMode` | `mom` | Last-selected processing mode: `mom` / `notes` |
| `customMeetingDomains` | `[]` | Extra domains for meeting-URL detection, beyond the built-in Meet/Zoom/Teams/Skype patterns |
| `recordingDurations` | `{}` | Recording id → length in seconds (see below) |

**Recording lengths.** The server does not report a recording's duration, and a MediaRecorder WebM carries none in its header, so `<audio>` reports `Infinity` for it. The popup therefore measures each recording once, from its audio URL (`probeDuration`), and remembers the result in `recordingDurations`; entries for recordings that no longer exist on the server are pruned on every list load. For a header-less WebM the measurement seeks far past the end (`currentTime = 1e101`), which makes Chrome read to the real end and report the true length — so the first time the list opens with many old recordings, Chrome fetches those files from the server one at a time, newest first, once. The player uses the remembered length whenever `<audio>` itself reports none.

## 5. Component 2: Backend Server

**Location:** `server/src/server.js`
**Runtime:** Node.js 18+ (native) or Docker container.
**Port default:** `3456`. Configurable via `PECHPECH_PORT` env var.
**Host binding:** `127.0.0.1` by default (native). `0.0.0.0` inside Docker — the Docker port mapping exposes only `127.0.0.1:3456` on the host, so it is never publicly reachable.

### Key modules

**`server.js`** (~253 lines) — Express HTTP layer only. Handles routing, audio upload, recording list/audio serving, config persistence, and delegates processing to the pipeline.

**`pipeline.js`** — Recording Pipeline deep module. Single seam: `createPipeline({ store, createProvider })` returns `{ run(id, config, mode, signal, language), correct(id, config, signal, language) }`.
- `run`: reads audio from disk → `cleanAudio` (ffmpeg) → `transcribeAudio` (STT) → LLM with the MOM *or* Notes prompt (`mode`) in the pinned `language` → matching parser → store update.
- `correct`: LLM with the correction prompt → parse the corrected-text section → store update.
- `signal` is an `AbortSignal` so a job can be cancelled mid-flight (`POST /recordings/:id/cancel`).
- `language` (`'en'` | `'fa'`) selects the prompt template and the parser only. It is **not** passed to speech-to-text, which detects the spoken language itself.
- All errors are caught and written to `store.update({ error })` — callers never see a thrown exception.
- Prompts are loaded from `prompts.yaml` at startup via `js-yaml`.

**`stt-providers.js`** — STT provider seam, the server-side twin of the `STT providers` in §15: `createSTTProvider(config)` → `transcribe({ audioBuffer, audioMimeType, signal })` for the `custom` (any Whisper-compatible endpoint), `openai` and `gemini` providers.

**`llm-providers.js`** — LLM provider seam. `createProvider(config)` is a factory called once per pipeline invocation. Returns an object with a single method `invoke(prompt)`.
- `createCLIAdapter({ llmCli, llmCommand })` — handles `claude` (stdin pipe), `custom`; 15-min timeout with SIGKILL.
- `createAPIAdapter({ llmApiUrl, llmApiKey, llmApiModel })` — OpenAI-compatible `POST /chat/completions`; Bearer auth; default model `gpt-4o`.
- Dispatches to API adapter when `config.llmCli === 'api'`, else CLI adapter.

**`prompts.yaml`** — LLM prompt templates. Three keys — `mom` (MOM generation), `notes` (one bullet per thought) and `correction` (transcript correction) — each with an `en` and an `fa` variant. Use `{{transcript}}` as the placeholder. The section headings of each variant are parsed by the pipeline (§9) — do not change them without updating the regex parsers.

### Configuration (`config.json`)

`server/src/config.json` is the single source of truth for all STT/LLM settings. It is written by `install.sh` on first setup and updated live via `POST /config`.

| Key | Default | Description |
|-----|---------|-------------|
| `sttUrl` | `http://localhost:8080/v1` | STT base URL (Whisper-compatible) |
| `sttKey` | `""` | STT API key |
| `sttModel` | `whisper-1` | Model name sent as the `model` form field |
| `llmCli` | `claude` | LLM type: `claude`, `api`, or `custom` |
| `llmCommand` | `""` | Full command for `custom` CLI |
| `llmApiUrl` | `""` | Base URL for `api` type |
| `llmApiKey` | `""` | API key for `api` type |
| `llmApiModel` | `""` | Model name for `api` type (default: `gpt-4o`) |

`config.json` is gitignored. `config.example.json` documents the shape.

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `PECHPECH_PORT` | `3456` | HTTP port |
| `PECHPECH_HOST` | `127.0.0.1` | Bind address (`0.0.0.0` in Docker) |
| `DATA_DIR` | `../../data` (relative to `server/src/server.js`) | Where recordings are stored |
| `HIGHPASS_FREQ` | `80` | ffmpeg highpass cutoff (Hz) |
| `LOUDNORM_I` | `-16` | ffmpeg loudnorm integrated loudness target |
| `LOUDNORM_TP` | `-1.5` | ffmpeg loudnorm true peak |
| `LOUDNORM_LRA` | `11` | ffmpeg loudnorm LRA |
| `DENOISE_ENABLED` | `false` | Enable afftdn denoising |
| `DENOISE_NR` | `10` | afftdn noise reduction strength |
| `DENOISE_NF` | `-25` | afftdn noise floor (dB) |

### API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Returns `{status: 'ok'}`. |
| `GET` | `/config` | Returns current `config.json` contents. |
| `POST` | `/config` | Merges body into `config.json`, returns updated config. Only known keys are written. |
| `POST` | `/transcribe-and-summarize` | Accepts multipart audio upload. Saves to disk, returns `{id, status: 'saved'}` immediately. Does **not** start processing. |
| `GET` | `/recordings` | Returns array of all recordings sorted newest-first. |
| `GET` | `/recordings/:id` | Returns single recording with full fields. |
| `PATCH` | `/recordings/:id` | Accepts `{ title }` — sets or clears the recording's display name (trimmed, max 80 chars). |
| `GET` | `/recordings/:id/audio` | Streams the audio file. Supports `Range` requests. |
| `POST` | `/recordings/:id/process` | Body `{ mode: 'mom' \| 'notes', language: 'en' \| 'fa' }`. Pins `language` on the record the first time (see below), then starts `pipeline.run(...)` in background. Returns `{id, status: 'processing'}`. |
| `POST` | `/recordings/:id/cancel` | Aborts the in-flight job (its `AbortController`) and resets the record to `error` / "cancelled by user" — works whether or not a job was actually still running. |
| `POST` | `/recordings/:id/correct` | Body `{ language }`, used only for a recording with no pinned language. Starts `pipeline.correct(...)` in background. |
| `DELETE` | `/recordings/:id` | Deletes metadata + audio file. |

**Pinned language.** The generation language (`en` / `fa`) is recorded on the recording the first time it is processed and reused for every later re-process and correction. Toggling the UI language between those clicks therefore cannot change what a given recording was generated in. Requests that omit `language` default to English.

### Recording lifecycle states

```
saved → processing → transcribing → summarizing → done
                                                 ↘ error
```

### RecordingStore (disk persistence)

```
data/
  recordings.json       ← JSON array of all recording metadata
  audio/
    <id>.webm           ← raw audio files
```

Fields per recording: `id`, `filename`, `createdAt`, `status`, `mimeType`, `title`, `mode` (`mom` / `notes`), `language` (pinned, see above), `transcript`, `summary`, `decisions`, `action_items`, `notes`, `error`, `corrected_transcript`, `correction_status`, `correction_error`. There is no stored duration (see §4 "Recording lengths").

### Job cancellation and restart recovery

Each running job has an `AbortController` in an in-memory `activeJobs` map; `/cancel` aborts it. Because the server is a persistent process, a record can only be left stuck mid-processing if the process itself crashed or restarted, so a **one-time scan at boot** (marking anything still `processing` / `transcribing` / `summarizing` / `correcting` as `error`) is sufficient — unlike the standalone variant, which needs a periodic watchdog (§15).

### Audio pre-processing (ffmpeg)

Runs inline in `pipeline.js` before STT. Filter chain:

```
highpass=f=80, loudnorm=I=-16:TP=-1.5:LRA=11 [, afftdn=nr=10:nf=-25]
```

Falls back to raw audio if ffmpeg is not installed. All parameters are tunable via environment variables.

### STT integration

- Request: `multipart/form-data` with `file` (audio blob), `model` and `response_format=json`. **No `language` field, on purpose:** leaving it out asks the provider to detect the spoken language itself. It must not be derived from the UI language — that is a preference about the interface and the generated minutes, and forcing it makes a Persian meeting come back as English (or the reverse). For the `gemini` provider the equivalent is a language-neutral instruction ("in the language(s) actually spoken — do not translate").
- Whisper picks the language from the start of the audio, so a meeting that opens in a different language than it continues in can be transcribed in the opening one. Some local Whisper servers may fall back to English when no language is sent — this was not confirmed; if Persian comes back as English, start the server with its auto-detect option (e.g. whisper.cpp's `-l auto`).
- Uses Node 18+ native `FormData` + `Blob` — do **not** use the `form-data` npm package.
- Response: JSON with a `text` field (OpenAI Whisper shape).

### LLM integration

Two adapters behind the `provider.invoke(prompt)` seam:

- **CLIAdapter** — `child_process.spawn(cli, ['-p', prompt])` for `claude`. For `custom`, uses `llmCommand` split as argv. Stdout is the response. 15-minute timeout with SIGKILL cleanup.
- **APIAdapter** — `POST ${llmApiUrl}/chat/completions` with `Bearer` auth. OpenAI Chat Completions shape. Default model `gpt-4o`.

The factory `createProvider(config)` is called once per `pipeline.run()` / `pipeline.correct()` invocation so the provider type always reflects the current config.

## 6. Component 3: Launcher

**Location:** `launcher/index.js`
**Runtime:** Node.js. Zero npm dependencies — built-ins only.

The launcher is the single entry point after installation. It reads `.env` at the project root.

### Modes

**Native (`MODE=native`)**
- Spawns `node server.js` from `server/src/`.
- Watches the process and logs its output.

**Docker (`MODE=docker`)**
- Runs `docker compose up -d`.
- `--stop` runs `docker compose down`.

### CLI flags

| Flag | Action |
|---|---|
| *(none)* | Start services, open onboarding on first launch |
| `--install` | Register as a login item (launchd on macOS, autostart on Linux) |
| `--uninstall` | Remove the login item |
| `--stop` | Stop a running launcher + services via PID file |
| `--status` | Print whether the backend server is reachable |

### First launch detection

A `.launched` marker file in `launcher/` tracks the first run. If absent, the launcher opens `launcher/onboarding/index.html` in the browser and writes the file.

## 7. Project Structure

```
PechPech/
├── server/                     — Backend server (Docker build context)
│   ├── Dockerfile
│   ├── .dockerignore
│   ├── package.json
│   └── src/                    — Source code only
│       ├── server.js           — Express HTTP layer
│       ├── pipeline.js         — Recording Pipeline deep module (run + correct)
│       ├── llm-providers.js    — LLM provider seam (CLIAdapter + APIAdapter)
│       ├── stt-providers.js    — STT provider seam (custom / openai / gemini)
│       ├── prompts.yaml        — LLM prompt templates (mom + notes + correction, each en + fa)
│       ├── config.json         — Runtime config (gitignored, written by install.sh)
│       └── config.example.json — Documents the config.json shape
├── extension/
│   ├── manifest.json
│   ├── background.js           — Service worker: tab capture, offscreen, onInstalled→onboarding
│   ├── offscreen.html/js       — Audio capture and mixing (Web Audio API)
│   ├── popup.html/css/js       — Start / Stop / Result / Save UI
│   ├── settings.html/js        — Settings page (reads/writes via GET/POST /config)
│   ├── onboarding.html/js      — 5-step setup wizard (opens on install/reload)
│   ├── permission.html/js      — Microphone-permission helper page
│   ├── i18n.js, lang-pending.js — English/Persian strings + helpers; early-boot snippet (§16)
│   ├── fonts.css, fonts/       — Self-hosted Vazirmatn
│   └── icons/
├── extension-standalone/       — No-server variant, see §15
├── launcher/
│   ├── index.js                — Start, stop, status, auto-start on login
│   └── onboarding/
│       └── index.html          — First-run setup guide (opened by launcher)
├── data/                       — Recordings and output files (gitignored)
│   ├── recordings.json
│   └── audio/
├── docker-compose.yml          — Build context: ./server; mounts config.json volume
├── install.sh                  — Interactive setup (native or Docker)
├── .env                        — Written by install.sh; gitignored
└── .gitignore
```

## 8. Configuration

### config.json (primary — STT/LLM settings)

`server/src/config.json` is the single source of truth for all STT and LLM configuration. It is:
- Written once by `install.sh` during setup.
- Read by the server on every `/process` and `/correct` call (`loadServerConfig()`).
- Updated live by the extension settings page via `POST /config`.
- Mounted as a Docker volume so settings survive container rebuilds.

### .env (infrastructure only)

The `.env` file (gitignored) controls how the launcher starts the server:

| Key | Values | Description |
|---|---|---|
| `MODE` | `native` / `docker` | How the launcher starts the backend |
| `PECHPECH_PORT` | `3456` | Port exposed on the host |
| `LLM_CLI` | `openai` / `gemini-api` / `api` / `claude` / `custom` | Baked into the Docker image at build time |

API keys and STT credentials are **not** stored in `.env` — they go in `config.json`.

## 9. MOM Prompt Template

Prompts live in `server/src/prompts.yaml` (server variant) and `extension-standalone/prompts.js` (standalone). There are three prompts — `mom` (generation), `notes` (one bullet per thought) and `correction` (transcript correction + speaker separation) — and each exists in an `en` and an `fa` variant. The recording's pinned language (§5) picks the variant for both the prompt and the parser.

The parser matches these exact section headings in the LLM output:

| Prompt | `en` headings | `fa` headings |
|---|---|---|
| `mom` | `## Summary`, `## Decisions`, `## Action Items` | `## خلاصه`, `## تصمیمات`, `## اقدامات` |
| `notes` | `## Notes` | `## یادداشت‌ها` |
| `correction` | `## Corrected Text` | `## متن اصلاح‌شده` |

Do not change these headings without also updating the matching regex parsers (`pipeline.js`; `prompts.js` in the standalone variant). If the LLM output contains none of the expected headings, the MOM parser falls back to returning the whole output as the summary with a parse warning, so a wrong heading degrades visibly rather than failing silently.

The `{{transcript}}` placeholder is replaced with the raw transcript text before the prompt is sent to the LLM.

## 10. Data Flow (End to End)

1. User opens meeting in a browser tab, clicks **Start** in the extension popup.
2. Popup requests mic permission, health-checks the backend server (`GET /health`).
3. Background creates offscreen document → receives OFFSCREEN_READY → sends START_CAPTURE.
4. Offscreen captures tab audio + mic, mixes via AudioContext, records with MediaRecorder.
5. User clicks **Stop** → MediaRecorder stops in the offscreen document → chunks are concatenated into one blob.
6. The offscreen document POSTs the blob to `POST /transcribe-and-summarize` itself, then sends `AUDIO_SAVED {id}` to background.
7. Server saves audio to `data/audio/<id>.webm`, creates metadata with `status: 'saved'`, returns `{id, status: 'saved'}`.
8. Popup returns to idle; recordings list refreshes showing the new card (its length is measured and filled in shortly after, §4).
9. User clicks **Process** on the card → popup POSTs `{ mode, language }` to `POST /recordings/:id/process`.
10. Server pins `language` on the record (first time only) and calls `pipeline.run(id, loadServerConfig(), mode, signal, language)` in the background.
11. Pipeline: `cleanAudio` (ffmpeg highpass + loudnorm) → `transcribeAudio` (STT POST, no `language` — auto-detected) → transcript.
12. Pipeline: `createProvider(config).invoke(prompt)` for the chosen mode and pinned language → LLM response → matching parser.
13. Pipeline: `store.update({ status: 'done', summary, decisions, action_items | notes, transcript })`.
14. Popup (polling every 3 s) detects `status: 'done'` → switches to **result** state.
15. User optionally clicks **Correct transcript** → popup POSTs to `POST /recordings/:id/correct`.
16. Pipeline: `createProvider(config).invoke(correctionPrompt)` (pinned language) → parses the corrected-text section → `store.update({ corrected_transcript })`.
17. User can click **Save .md** to download the result as a Markdown file; its headings follow the recording's own language, not the live UI language.

## 11. Known Limitations / Edge Cases

- **Tab audio capture tab-switching:** `chrome.tabCapture` ties the stream to the original tab. Switching tabs during recording may silently stop tab audio. Mic audio continues.
- **Service worker restart:** MV3 service workers are killed after ~30 s of inactivity. All state is in `chrome.storage.session`; each handler calls `readState()` at the top to reload it.
- **Offscreen document liveness:** if the SW is restarted while recording, the offscreen document is also destroyed. The Stop handler detects a missing offscreen doc and clears state with an informative error.
- **Onboarding on every update:** `chrome.runtime.onInstalled` with `reason === 'update'` fires on every developer reload, so onboarding opens every time the extension is reloaded during development. This is intentional for now.
- **Recordings carry no duration in their header.** Chrome's MediaRecorder writes WebM as a live stream and never goes back to fill the length in (§15 "WebM header duration"). Players cope; a strict STT gateway may not. The server variant avoids it only because ffmpeg re-muxes the audio first — if ffmpeg is not installed, `pipeline.js` falls back to the raw audio and a strict provider can reject it.
- **Spoken language comes from the start of the audio.** With auto-detection, a meeting that opens in one language and continues in another may be transcribed entirely in the first (§5).
- **First list open can be slow (server variant).** Measuring old recordings' lengths makes Chrome read their files from the server, once each (§4).
- **Long recordings vs provider limits.** An hour is roughly 13–28 MB depending on settings, against OpenAI's 25 MB upload limit and the 19 MB inline limit the standalone Gemini adapter enforces (§15 "Recording format and size").

## 12. Explicit Non-Goals for v1

- Desktop-app meeting support (native Zoom/Teams), phone call capture
- Live/streaming transcription or live MOM generation during the meeting
- Auto-start/auto-detection of meetings
- Speaker diarization (who-said-what)
- Any shared backend, multi-user accounts, or hosted infrastructure
- Auto-saving/syncing MOMs to Notion, Google Docs, or any external service

## 13. Build Status

1. ✅ Backend server skeleton — stub endpoint, fake MOM.
2. ✅ STT integration — Whisper-compatible multipart upload with configurable URL/key/model.
3. ✅ LLM CLI integration — `child_process.spawn(claude, ['-p', prompt])`, stdout parsing.
4. ✅ Extension shell — Manifest V3, popup HTML/CSS/JS, settings page, `chrome.storage.local`.
5. ✅ Audio capture — `tabCapture` + `getUserMedia`, AudioContext mixing, MediaRecorder.
6. ✅ End-to-end wiring — extension → server → STT → LLM → poll → display → save.
7. ✅ Recordings persistence — disk store, list view, audio playback, manual Process button.
8. ✅ Polish — OFFSCREEN_READY handshake, session state persistence, error surfaces, Vazirmatn UI.
9. ✅ ffmpeg inline audio pre-processing — highpass + loudnorm + optional denoising, graceful fallback.
10. ✅ Docker support — static `docker-compose.yml`, `Dockerfile` with dynamic LLM CLI build arg, config.json volume mount.
11. ✅ Launcher — native and Docker mode, first-launch onboarding, auto-start on login, `--stop` / `--status`.
12. ✅ Interactive installer — `install.sh` with native and Docker paths, 3 LLM options, writes `config.json`.
13. ✅ Architecture refactor — `pipeline.js` (Recording Pipeline deep module) + `llm-providers.js` (CLIAdapter + APIAdapter seam). Server reduced from ~734 to ~253 lines.
14. ✅ Config unification — `config.json` as single source of truth; `GET /config` + `POST /config` endpoints; extension settings reads/writes via server API; `helperPort` was the only key in `chrome.storage.local` at that point (a few extension-side preferences were added later, §4).
15. ✅ Custom API adapter — OpenAI-compatible endpoint support (`llmCli: 'api'`) with configurable URL, key, and model.
16. ✅ Extension onboarding — 5-step wizard (`onboarding.html`) opens on install/reload via `chrome.runtime.onInstalled`.
17. ✅ Standalone (no-server) variant — `extension-standalone/`: IndexedDB store, direct STT/LLM calls, processing in the service worker (§15).
18. ✅ Notes mode, recording titles, per-recording cancel, stuck-job recovery (watchdog in the standalone variant, boot-time scan on the server).
19. ✅ Editable prompts (standalone Settings) and self-hosted Vazirmatn font in both variants.
20. ✅ English/Persian UI and generated minutes — `i18n.js`, per-language prompts and parsers, language pinned per recording (§16).
21. ✅ WebM header-duration patch, `Audio quality` setting (Standard 64 / Compact 32 kbps) and a 15-minute STT timeout (§15).
22. ✅ STT language auto-detection in both variants — no `language` sent to speech-to-text (§5).
23. ✅ Recording length shown on every card, and the playing card's state restored after the list is redrawn (both variants).

## 14. Open Questions / Future Work

- Default local Whisper model size recommendation for Persian (`medium` or `large-v3` recommended).
- Tab audio capture survives tab-switch: needs testing per browser version.
- Whisper installation via `install.sh` — currently out of scope; users set up their own STT server.
- Onboarding on `reason === 'update'`: consider restricting to `reason === 'install'` once the tool is stable.
- Whether an MV3 service worker survives a pending `fetch()` longer than Chrome's documented 5-minute limits. The standalone STT timeout is 15 minutes (§15), but only a 150-second request has been observed to survive; if a long upload dies silently, the watchdog reports it after 35 minutes.
- Accuracy cost of the `compact` (32 kbps) preset for Whisper and Farsi is unmeasured; the only data found is one study on a different recognizer (§15).
- What a Whisper server does when no language is sent: OpenAI auto-detects, but whisper.cpp's server default was not confirmed.
- Very long meetings: recording in separately uploadable segments would remove the size-limit and timeout pressure instead of just easing it.

## 15. Standalone Extension Variant (No-Server Mode)

**Location:** `extension-standalone/`. A separate MV3 manifest — a distinct extension id from `extension/` when both are loaded, so install one or the other rather than both (they'd otherwise double up meeting-detection badges/notifications).

Components 1+2 require the user to keep a local server process (or Docker container) running. This variant needs **no server at all** — everything Components 1+2 split across "extension ↔ server" runs entirely inside the extension:

| Concern | Server-based (`extension/` + `server/`) | Standalone (`extension-standalone/`) |
|---|---|---|
| Recording storage | POSTed to server, saved to `data/` on disk | `store.js` — IndexedDB, audio kept as a `Blob` field on the record |
| STT + LLM calls | Server-side, can shell out to CLI tools | `providers.js` — `fetch()` directly from the service worker; **no CLI adapter** (child_process cannot run in a browser) |
| Processing orchestration | `pipeline.js` on the server, triggered via `POST /recordings/:id/process` | `background.js`, triggered via a `PROCESS_RECORDING` runtime message |
| Config storage | `server/src/config.json` on disk | `chrome.storage.local` directly (see key table below) |
| Prompts | `server/src/prompts.yaml` (en + fa), edited by hand | `prompts.js` (port of the same templates, en + fa) + **editable per-user overrides** in Settings (see below) |

### STT providers (`providers.js`)

| Provider | Notes |
|---|---|
| `custom` (default) | Same Whisper-compatible endpoint shape as the server variant — points at a local server the user runs themselves (e.g. `http://localhost:8080/v1`) |
| `openai` | OpenAI Whisper API, requires `sttKey` |
| `gemini` | Gemini `generateContent` with inline audio (base64) — 19 MB request-size ceiling, throws a clear error above that instead of silently failing |

All three share one timeout, `STT_TIMEOUT_MS` (**15 minutes**, in `providers.js`), which covers the upload as well as the transcription — an hour of audio is 13–28 MB, which a slow uplink needs minutes just to send. None of them sends a `language`: it is auto-detected (§5). The Whisper-style adapters name the uploaded file `recording.<ext>` from the recording's MIME type (`webm`, `ogg`, `wav`, or `m4a` for MP4).

### LLM providers (`providers.js`)

| Provider | Notes |
|---|---|
| `openai` (default) | OpenAI Chat Completions, default model `gpt-4o` |
| `gemini-api` | Gemini `generateContent`, default model `gemini-3.6-flash` |
| `api` | Any OpenAI-compatible `/chat/completions` endpoint (custom URL) |

No CLI-based LLM option — the `llmCli: 'claude'`/`'custom'` CLI adapters from the server variant don't exist here; `createLLMProvider()` throws for any unrecognized `llmCli` value.

The OpenAI-compatible adapter (behind both `openai` and `api`) sends `"stream": false` explicitly, and rejects a `text/event-stream` reply with a specific error instead of a confusing JSON-parse failure. Real OpenAI treats an omitted `stream` as false, but gateways built for CLI tools default to streaming — observed with 9Router, which answered with SSE `data: {…"delta":{"content":…}}` chunks that the single-JSON parsing cannot read. The Gemini adapters call `:generateContent` (never `:streamGenerateContent`), so they are unaffected.

### Permissions

`host_permissions` is `http://*/*` and `https://*/*`. The Settings page lets the user type any STT or LLM URL, and an extension's own `fetch()` bypasses CORS only for origins it holds host permission for — so the earlier narrow list (OpenAI, Google, `localhost`) silently broke every custom endpoint not on `localhost` with a CORS error (hit with a gateway on a remote IP). The cost is a broader permission warning when the extension is installed or updated. The least-privilege alternative — `optional_host_permissions` plus a runtime `chrome.permissions.request()` when a custom URL is saved — was not built: more machinery than a personal tool needs. The server-based extension only needs `localhost` / `127.0.0.1`: its outbound calls are made by the Node server, which is not subject to CORS.

### Processing modes: MOM vs Notes

The popup's mode toggle (**Meeting** / **Notes**; `جلسه` / `یادداشت` in Persian) selects between two output shapes, both handled by the same `continueProcessing()` in `background.js` (the last choice is remembered as `defaultMode`):
- **`mom`** (default) — the usual Summary / Decisions / Action Items minutes (خلاصه / تصمیمات / اقدامات), via `buildMOMPrompt`/`parseMOMOutput`.
- **`notes`** — for one person thinking aloud rather than a multi-party meeting; extracts each distinct thought as its own bulleted line under `## Notes` (`## یادداشت‌ها` in Persian), via `buildNotesPrompt`/`parseNotesOutput`.

### Editable prompts

Settings → **Prompts** exposes the three prompt templates (`prompts.js`: `MOM_PROMPT_EN/FA`, `NOTES_PROMPT_EN/FA`, `CORRECTION_PROMPT_EN/FA`) as collapsed, individually-expandable textareas — collapsed by default so the settings page stays scannable despite each prompt being 20–30 lines. Storage keys `promptMom` / `promptNotes` / `promptCorrection` in `chrome.storage.local` are empty-string by default, meaning "use the built-in default"; the three `build*Prompt(transcript, language, customTemplate)` functions fall back to the default for the recording's language when the override is falsy. A textarea whose text equals the current-language default is saved as empty, which keeps future default-prompt updates flowing through to any user who never customized a given prompt. A saved override replaces the default **regardless of language** — it must be written in the language the user wants the output in, with the matching section headings (§9). Those headings are load-bearing (parsed by `parseMOMOutput`/`parseNotesOutput`/`parseCorrectionOutput`); the settings UI warns against editing them but does not enforce it.

### chrome.storage.local keys

| Key | Default | Description |
|---|---|---|
| `sttProvider` | `custom` | `custom` / `openai` / `gemini` |
| `sttUrl` | `http://localhost:8080/v1` | Only used for `custom` |
| `sttKey` | `""` | Required for `openai`/`gemini`, optional for `custom` |
| `sttModel` | `whisper-1` | |
| `llmCli` | `openai` | `openai` / `gemini-api` / `api` (name kept consistent with the server variant's `llmCli` key, though "CLI" is a misnomer here — no CLI option exists) |
| `llmApiUrl` | `""` | Only used for `api` |
| `llmApiKey` | `""` | |
| `llmApiModel` | `""` | Defaults to `gpt-4o` / `gemini-3.6-flash` per provider |
| `audioQuality` | `standard` | `standard` (64 kbps) / `compact` (32 kbps) — see "Recording format and size" |
| `promptMom` / `promptNotes` / `promptCorrection` | `""` | Empty = use built-in default; see "Editable prompts" above |
| `customMeetingDomains` | `[]` | Extra domains for meeting-URL detection, beyond the built-in Meet/Zoom/Teams/Skype patterns |
| `language` | `en` | UI and generated-minutes language: `en` / `fa` (§16) |
| `defaultMode` | `mom` | Last-selected processing mode: `mom` / `notes` |

A recording (IndexedDB, `store.js`) carries: `id`, `audioBlob`, `mimeType`, `status`, `createdAt`, `title`, `mode`, `language` (pinned on first processing), `notes`, `transcript`, `summary`, `decisions`, `action_items`, `error`, `corrected_transcript`, `correction_status`, `correction_error` — plus `processingStartedAt` (set when a job starts; the watchdog reads it), `warning` (a parse warning) and `durationMs` (measured once by the popup) when present.

### Recording format and size

Recordings are **WebM/Opus, mono**, from `MediaRecorder` in the offscreen document. One format has to serve every STT provider and it is chosen at record time, before anything knows which provider will process the recording (that is decided at process time, and the user may change it in between).

Settings → **Recording → Audio quality** (`audioQuality`) picks the Opus bitrate:

| Preset | Bitrate | Size per hour |
|---|---|---|
| `standard` (default) | 64 kbps | up to ~28 MB |
| `compact` | 32 kbps | up to ~13 MB |

Measured with Chrome's Opus encoder: non-stop audio gives 27.7 MiB/hour at 64 kbps and 12.8 MiB/hour at 32 kbps; audio with the pauses real meetings have comes out nearer 21 and 10 MiB; silence is ~0.9 MiB/hour — the encoder is variable-rate. Chrome's own default is 128 kbps stereo, ~54 MB/hour.

- **Where the numbers live.** `offscreen.js` holds the preset → bitrate table; Settings stores only the preset name. An offscreen document cannot read `chrome.storage` (Chrome gives it the `chrome.runtime` API only), so `background.js` reads `audioQuality` and passes it in the `START_CAPTURE` message. A missing or unknown value falls back to `standard`.
- **Applies to new recordings only**, and a recording cannot be improved afterwards — the original is not kept.
- **Limits it has to fit:** OpenAI's 25 MB per upload; the 19 MB the standalone Gemini adapter allows (inline base64); and the 15-minute STT timeout, of which the upload is part. A talkative hour at 64 kbps can exceed OpenAI's limit; `compact` is for that case and for slow uplinks (an hour at `standard` is ~4 minutes of upload at 1 Mbps).
- **Accuracy.** `standard` is the default because the cost of `compact` for Whisper and Farsi is unmeasured. The only data found is one study on a different recognizer (arXiv 2002.00122, English far-field audio): word error rate rose 2.4% relative at 128 kbps, 6.6% at 32 kbps, 12.6% at 16 kbps and 202% at 8 kbps against uncompressed audio; 64 kbps was not tested. Compare transcripts of the same content at both presets before relying on `compact`.
- **Ruled out:** MP3 (`MediaRecorder` cannot produce it — `isTypeSupported('audio/mpeg')` is false in Chrome); MP4 (see below); `ffmpeg.wasm` (a ~31 MB core against a whole extension of ~376 KB, plus a build step this project does not have).

### WebM header duration

Chrome's `MediaRecorder` writes WebM as a live stream: the header goes out before the length is known, and Chrome never seeks back to fill in `Segment > Info > Duration`. Players do not care (`<audio>` derives the length from the last cluster, and reports `Infinity` until it does), so this is invisible until something reads the header strictly. It surfaced when an OpenAI-compatible gateway began rejecting uploads with *"invalid audio input: error getting audio duration: webm duration parsing requires full EBML parser (consider using ffprobe for webm files)"* — an error raised by the gateway itself, before any Whisper model, on a file format that had not changed.

`webm-duration.js` → `fixWebmDuration(blob, durationMs)` runs in `offscreen.js` before the recording is stored, so every later re-process uses the patched blob. It walks the EBML tree to `Segment > Info` and either overwrites an existing Duration or splices an 11-byte Duration element in and grows Info's size field. `MediaRecorder` writes the Segment with "unknown size", so the Segment's own size never needs recalculating; if a Segment has a known size the patch refuses to shift its contents. It is **fail-safe**: any unexpected structure returns the original blob untouched (an upload that is rejected is recoverable; a recording corrupted by a bad byte patch is not). Verified on real recordings: `Infinity` becomes the correct length, the audio decodes identically, and patching twice does not append a second Duration.

What the patch does *not* do: Segment and cluster sizes stay "unknown", so a validator that insists on a fully finalized file may still refuse it — that needs a full remux, which is what ffmpeg does on the server and what a browser extension cannot do. Whether the patch alone satisfied the failing gateway was never established; that gateway was resolved by switching provider.

**MP4 is not a way out.** Chrome's MP4 recording is fragmented (`ftyp`, `moov`, then `moof`+`mdat` pairs) with `mvhd.duration = 0` and no `mehd`, found by parsing the boxes — `<audio>` shows a correct length only because Chrome's demuxer scans the fragments. It has the same defect in another container, and it would also risk Gemini, whose documented inline audio types are `wav` / `mp3` / `aiff` / `aac` / `ogg` / `flac`, with no `audio/mp4`. (If that route is ever revisited: the MP4 fields are fixed-width integers that already exist, so patching them is an in-place overwrite, no resizing.)

### Popup list: lengths and playback state

- **Length.** Every card shows `0:00 / <length>` as soon as the list opens. The length is measured once from the recording's blob (`probeDuration`; for a header-less WebM it seeks far past the end so Chrome reads to the real end) and saved on the record as `durationMs`, so later refreshes are a text write. The player falls back to that stored length whenever `<audio>` reports none, which also keeps the total from being overwritten with `0:00` for older recordings. Lengths of an hour or more show as `h:mm:ss`.
- **Playback state.** The list is rebuilt from scratch on every refresh (returning from a result, polling while something processes, a delete), which would put every card back to its idle look while the audio keeps playing underneath. After each rebuild `player.refreshUI()` re-applies the play/pause icon, progress and time to the card that owns the player, marks it with a `.playing` highlight while it plays, and scrolls it into view — so after leaving and returning, the playing recording is visible and can be stopped. A recording paused part-way keeps its position without the highlight. The audio itself keeps playing while the list is hidden; there is no control for it elsewhere.
- The server-based extension has the same behaviour, with lengths remembered in `chrome.storage.local` instead of on the record (§4).

### Stuck-job watchdog

MV3 service workers can be killed by Chrome without warning, including mid-`fetch()` — this destroys the entire execution context, so no `catch` block runs to record the failure, and a recording can be left stuck in `transcribing`/`summarizing`/`correcting` forever. Fixed with `chrome.alarms` (alarms can wake an already-terminated service worker, unlike a timer): a `processing-watchdog` alarm fires every minute and flags any recording that's been in a processing state for more than **35 minutes** (`STUCK_THRESHOLD_MS`; above the 15 min STT + 15 min LLM worst-case sequential timeout of 30) as `error`, with a message asking the user to retry. That threshold must stay above the STT and LLM timeouts combined, or a slow-but-healthy job would be declared dead just before its result lands — it was raised from 25 to 35 minutes when the STT timeout went from 5 to 15. Each processing/correction job also has a **Cancel** button in the popup (`CANCEL_PROCESSING` message), which aborts the in-flight `fetch` via `AbortController` if the same service-worker instance is still alive, and unconditionally resets the record's status either way.

### Fonts

All extension pages (popup, settings, onboarding, permission) load Vazirmatn from a **self-hosted** `fonts.css` + `fonts/*.woff2` (two variable-font files — arabic-script and latin subsets, covering all weights) rather than Google Fonts' CDN, since remote-stylesheet loading proved unreliable inside the packaged extension context. The identical `fonts.css`/`fonts/` setup also exists in `extension/` for the same reason.

### Meeting URL detection + notifications

Implemented in `background.js` via `chrome.tabs.onUpdated`: matches a built-in pattern list (Meet, Zoom, Teams, Skype) plus any `customMeetingDomains`, sets a toolbar badge, and fires a `chrome.notifications` prompt (throttled to once per 30 min per tab) suggesting the user start recording. Clicking the notification opens the popup via `chrome.action.openPopup()`.

### Project structure

```
extension-standalone/
├── manifest.json
├── background.js      — Service worker: recording orchestration, STT+LLM processing,
│                         watchdog, meeting detection (no server to delegate to)
├── store.js            — IndexedDB-backed recording store (replaces server's disk store)
├── providers.js         — STT + LLM provider factories, fetch()-based (replaces
│                         server/src/{stt,llm}-providers.js; no CLI adapter)
├── prompts.js           — Prompt templates (en + fa) + builders + per-language output
│                         parsers (ported from server/src/prompts.yaml + pipeline.js)
├── offscreen.html/js    — Audio capture and mixing; quality presets; applies the duration patch
├── webm-duration.js     — Writes the missing Duration into a MediaRecorder WebM
├── popup.html/css/js    — Recording UI, mode toggle (MOM / Notes), language toggle,
│                         recordings list with lengths and playback state
├── settings.html/js     — Settings: STT/LLM provider config, audio quality, editable prompts
│                         (writes directly to chrome.storage.local — no server API)
├── onboarding.html/js   — Setup wizard
├── permission.html/js   — Standalone mic-permission helper page
├── i18n.js              — English/Persian strings + helpers (§16)
├── lang-pending.js      — Early-boot script that hides a page until its language is applied
├── fonts.css, fonts/    — Self-hosted Vazirmatn (see "Fonts" above)
└── icons/
```

## 16. Bilingual UI (English / Persian)

Both extension variants — and the server's prompts — support English and Persian. **English is the default; Persian is opt-in** via a toggle button in the popup header.

- **`i18n.js`** (one copy per extension) holds the `STRINGS` dictionary (`{ en, fa }` per key) and the helpers: `t(key, vars)`, `getLanguage()`, `setLanguage()`, `onLanguageChange()`, `applyTranslations()`, `bootLanguage()`. `{name}` placeholders in a string are substituted from `vars`. It is used by the popup, settings, onboarding and permission pages and by `background.js` (for error messages, the meeting-detected tooltip and notifications); a service worker's copy is kept in sync through a `chrome.storage.onChanged` listener rather than by re-writing the value.
- **Markup.** Static text is tagged `data-i18n="key"`; trusted markup such as `<code>` uses `data-i18n-html="key"`; attributes use `data-i18n-attr="title:key,aria-label:key2"`. Strings built in JS call `t()`. Adding a string means adding one `{ en, fa }` entry — a key missing from the dictionary renders as the raw key.
- **State.** The choice is `chrome.storage.local.language` (`en` / `fa`). It sets `<html lang>` and `dir` (`rtl` for Persian) on every page.
- **No flash of the wrong direction.** Each page loads `lang-pending.js` first in `<head>`, which adds a `lang-pending` class; CSS `html.lang-pending body { visibility: hidden }` keeps the page invisible until `bootLanguage()` has read the stored language, translated the page and removed the class. It has to be an external, non-module script: MV3's CSP blocks inline scripts (§4), and a module would be deferred past first paint.
- **Two languages, kept independent.** The **UI language** is live and can be toggled at any time. A recording's **generation language** is pinned once, on first processing, and decides its prompt variant, the headings its parser looks for and its Markdown export — so toggling the UI afterwards cannot change what an existing recording was generated in (§5 "Pinned language"). **Speech-to-text receives neither**: it detects the spoken language itself (§5).
- **Prompts.** `prompts.js` / `prompts.yaml` carry an `en` and an `fa` variant of each prompt, with matching per-language parsers (§9). A user's saved prompt override applies regardless of language (§15 "Editable prompts").
