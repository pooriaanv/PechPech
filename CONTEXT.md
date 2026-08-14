# Meeting MOM Generator — Build Spec

## 1. Problem Statement

We attend many online meetings daily. The core problem is **attention, not synthesis** — during the meeting we don't take notes because we're focused on the conversation, and afterward the details are forgotten. We need a tool that passively captures the meeting and automatically produces a Minutes of Meeting (MOM) with zero manual effort during the call.

## 2. Scope (v1)

- **Personal tool.** Each user runs this entirely on their own machine. No shared backend, no multi-user accounts, no server we host or maintain.
- **Meetings covered:** browser-tab meetings only (Google Meet, Zoom-web, Teams-web, or any tab playing meeting audio). Desktop apps (Zoom/Teams native) and phone calls are out of scope for v1.
- **Trigger:** fully manual — user clicks Start when the meeting begins, Stop when it ends. No live/streaming transcription, no auto-detection in v1.
- **Output:** a MOM with exactly three sections — **خلاصه** (Summary), **تصمیمات** (Decisions), **اقدامات** (Action Items) — shown inline in the extension popup, with a Save/Download button (.md file).
- **Recordings list:** All past recordings are listed in the idle state. Each recording shows its date, status badge, inline audio player, and a Process / View Result / Delete button. State persists across popup open/close via `chrome.storage.session`.
- **Language:** meetings are primarily in Persian/Farsi. The transcription step must handle Farsi well. MOM output is in Persian. `language=fa` is always passed to the STT endpoint.

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
3. User clicks **Stop** → background stops `MediaRecorder`, encodes audio as base64, returns `audioData` + `mimeType` to popup.
4. Popup POSTs audio to `POST /transcribe-and-summarize` → receives `{id, status: 'saved'}` → returns to **idle** and refreshes the recordings list.
5. User clicks **پردازش** on a recording card → popup POSTs to `POST /recordings/:id/process` → switches to **processing** state → polls `GET /recordings/:id` every 3 s until `done` or `error`.
6. User can close the popup while processing; on reopen `chrome.storage.session` restores the polling state.

### Technical notes
- **Manifest V3.** Service workers restart frequently; all recording state (`isRecording`, `recordingTabId`, `startedAt`) lives in `chrome.storage.session`, not in-memory variables.
- **OFFSCREEN_READY handshake:** offscreen.js sends `OFFSCREEN_READY` message before registering the capture listener. Background awaits this promise (with 5 s timeout) before sending `START_CAPTURE`, preventing the `tabCapture` stream ID from expiring during document load.
- **Mic permission from popup:** `getUserMedia` in a hidden offscreen document cannot show a permission dialog. The popup requests mic permission explicitly (then immediately stops the tracks) before calling `START_RECORDING`.
- **Mic is non-fatal:** if mic capture fails after tab audio succeeds, recording continues with tab-only audio.
- **Audio mixing:** tab + mic → `AudioContext` → `MediaStreamDestination` → `MediaRecorder(webm/opus)`.
- **Config split:** only `helperPort` lives in `chrome.storage.local`. All STT/LLM settings live in `server/src/config.json` and are read/written via `GET /config` and `POST /config` on the backend server.
- **Popup session persistence** via `chrome.storage.session` keys: `popupState`, `recordingId`, `currentMOM`, `errorMsg`.
- **Onboarding:** `chrome.runtime.onInstalled` in `background.js` opens `onboarding.html` for both `reason === 'install'` and `reason === 'update'` (which fires on developer reload too). All extension pages use external `.js` files — no inline scripts (MV3 CSP).
- **UI:** Vazirmatn font (Google Fonts), RTL layout, violet (`#7c3aed`) primary color.

### chrome.storage.local

Only `helperPort` is stored in `chrome.storage.local`. It is the bootstrap value the extension needs to reach the server before any other config can be fetched.

| Key | Default | Description |
|-----|---------|-------------|
| `helperPort` | `3456` | Port the backend server listens on |

All STT/LLM settings are fetched from `GET /config` on the server and written back via `POST /config`.

## 5. Component 2: Backend Server

**Location:** `server/src/server.js`
**Runtime:** Node.js 18+ (native) or Docker container.
**Port default:** `3456`. Configurable via `PECHPECH_PORT` env var.
**Host binding:** `127.0.0.1` by default (native). `0.0.0.0` inside Docker — the Docker port mapping exposes only `127.0.0.1:3456` on the host, so it is never publicly reachable.

### Key modules

**`server.js`** (~253 lines) — Express HTTP layer only. Handles routing, audio upload, recording list/audio serving, config persistence, and delegates processing to the pipeline.

**`pipeline.js`** — Recording Pipeline deep module. Single seam: `createPipeline({ store, createProvider })` returns `{ run(id, config), correct(id, config) }`.
- `run`: reads audio from disk → `cleanAudio` (ffmpeg) → `transcribeAudio` (STT) → LLM with MOM prompt → `parseMOMOutput` → store update.
- `correct`: LLM with correction prompt → parse `## متن اصلاح` section → store update.
- All errors are caught and written to `store.update({ error })` — callers never see a thrown exception.
- Prompts are loaded from `prompts.yaml` at startup via `js-yaml`.

**`llm-providers.js`** — LLM provider seam. `createProvider(config)` is a factory called once per pipeline invocation. Returns an object with a single method `invoke(prompt)`.
- `createCLIAdapter({ llmCli, llmCommand })` — handles `claude` (stdin pipe), `custom`; 15-min timeout with SIGKILL.
- `createAPIAdapter({ llmApiUrl, llmApiKey, llmApiModel })` — OpenAI-compatible `POST /chat/completions`; Bearer auth; default model `gpt-4o`.
- Dispatches to API adapter when `config.llmCli === 'api'`, else CLI adapter.

**`prompts.yaml`** — LLM prompt templates. Two keys: `mom` (MOM generation) and `correction` (transcript correction). Use `{{transcript}}` as the placeholder. Headings `## خلاصه`, `## تصمیمات`, `## اقدامات` are parsed by the pipeline — do not change them without updating the regex parser.

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
| `GET` | `/recordings/:id/audio` | Streams the audio file. Supports `Range` requests. |
| `POST` | `/recordings/:id/process` | Starts `pipeline.run(id, config)` in background. Returns `{id, status: 'processing'}`. |
| `POST` | `/recordings/:id/correct` | Starts `pipeline.correct(id, config)` in background. |
| `DELETE` | `/recordings/:id` | Deletes metadata + audio file. |

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

Fields per recording: `id`, `createdAt`, `status`, `mimeType`, `transcript`, `correctedTranscript`, `summary`, `decisions`, `action_items`, `error`.

### Audio pre-processing (ffmpeg)

Runs inline in `pipeline.js` before STT. Filter chain:

```
highpass=f=80, loudnorm=I=-16:TP=-1.5:LRA=11 [, afftdn=nr=10:nf=-25]
```

Falls back to raw audio if ffmpeg is not installed. All parameters are tunable via environment variables.

### STT integration

- Request: `multipart/form-data` with `file` (audio blob), `model`, `language=fa`.
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
│       ├── prompts.yaml        — LLM prompt templates (mom + correction)
│       ├── config.json         — Runtime config (gitignored, written by install.sh)
│       └── config.example.json — Documents the config.json shape
├── extension/
│   ├── manifest.json
│   ├── background.js           — Service worker: tab capture, offscreen, onInstalled→onboarding
│   ├── offscreen.html/js       — Audio capture and mixing (Web Audio API)
│   ├── popup.html/css/js       — Start / Stop / Result / Save UI
│   ├── settings.html/js        — Settings page (reads/writes via GET/POST /config)
│   ├── onboarding.html/js      — 5-step setup wizard (opens on install/reload)
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

Prompts live in `server/src/prompts.yaml`. The `mom` key contains the generation prompt; the `correction` key contains the transcript correction prompt.

The parser matches these exact Persian headings in the LLM output:

```
## خلاصه
## تصمیمات
## اقدامات
```

Do not change these headings without also updating the regex parser in `pipeline.js`.

The `{{transcript}}` placeholder in `prompts.yaml` is replaced with the raw transcript text before the prompt is sent to the LLM.

## 10. Data Flow (End to End)

1. User opens meeting in a browser tab, clicks **Start** in the extension popup.
2. Popup requests mic permission, health-checks the backend server (`GET /health`).
3. Background creates offscreen document → receives OFFSCREEN_READY → sends START_CAPTURE.
4. Offscreen captures tab audio + mic, mixes via AudioContext, records with MediaRecorder.
5. User clicks **Stop** → MediaRecorder stops → blobs concatenated → base64 returned to popup.
6. Popup POSTs audio to `POST /transcribe-and-summarize`.
7. Server saves audio to `data/audio/<id>.webm`, creates metadata with `status: 'saved'`, returns `{id, status: 'saved'}`.
8. Popup returns to idle; recordings list refreshes showing the new card.
9. User clicks **پردازش** on the card → popup POSTs to `POST /recordings/:id/process`.
10. Server calls `pipeline.run(id, loadServerConfig())` in the background.
11. Pipeline: `cleanAudio` (ffmpeg highpass + loudnorm) → `transcribeAudio` (STT POST) → transcript.
12. Pipeline: `createProvider(config).invoke(momPrompt)` → LLM response → `parseMOMOutput`.
13. Pipeline: `store.update({ status: 'done', summary, decisions, action_items, transcript })`.
14. Popup (polling every 3 s) detects `status: 'done'` → switches to **result** state.
15. User optionally clicks **اصلاح رونوشت** → popup POSTs to `POST /recordings/:id/correct`.
16. Pipeline: `createProvider(config).invoke(correctionPrompt)` → parses `## متن اصلاح` → `store.update({ correctedTranscript })`.
17. User can click **ذخیره .md** to download the MOM as a Markdown file.

## 11. Known Limitations / Edge Cases

- **Tab audio capture tab-switching:** `chrome.tabCapture` ties the stream to the original tab. Switching tabs during recording may silently stop tab audio. Mic audio continues.
- **Service worker restart:** MV3 service workers are killed after ~30 s of inactivity. All state is in `chrome.storage.session`; each handler calls `readState()` at the top to reload it.
- **Offscreen document liveness:** if the SW is restarted while recording, the offscreen document is also destroyed. The Stop handler detects a missing offscreen doc and clears state with an informative error.
- **Onboarding on every update:** `chrome.runtime.onInstalled` with `reason === 'update'` fires on every developer reload, so onboarding opens every time the extension is reloaded during development. This is intentional for now.

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
14. ✅ Config unification — `config.json` as single source of truth; `GET /config` + `POST /config` endpoints; extension settings reads/writes via server API; only `helperPort` in `chrome.storage.local`.
15. ✅ Custom API adapter — OpenAI-compatible endpoint support (`llmCli: 'api'`) with configurable URL, key, and model.
16. ✅ Extension onboarding — 5-step wizard (`onboarding.html`) opens on install/reload via `chrome.runtime.onInstalled`.

## 14. Open Questions / Future Work

- Default local Whisper model size recommendation for Persian (`medium` or `large-v3` recommended).
- Tab audio capture survives tab-switch: needs testing per browser version.
- Whisper installation via `install.sh` — currently out of scope; users set up their own STT server.
- Onboarding on `reason === 'update'`: consider restricting to `reason === 'install'` once the tool is stable.

## 15. Standalone Extension Variant (No-Server Mode)

**Location:** `extension-standalone/`. A separate MV3 manifest — a distinct extension id from `extension/` when both are loaded, so install one or the other rather than both (they'd otherwise double up meeting-detection badges/notifications).

Components 1+2 require the user to keep a local server process (or Docker container) running. This variant needs **no server at all** — everything Components 1+2 split across "extension ↔ server" runs entirely inside the extension:

| Concern | Server-based (`extension/` + `server/`) | Standalone (`extension-standalone/`) |
|---|---|---|
| Recording storage | POSTed to server, saved to `data/` on disk | `store.js` — IndexedDB, audio kept as a `Blob` field on the record |
| STT + LLM calls | Server-side, can shell out to CLI tools | `providers.js` — `fetch()` directly from the service worker; **no CLI adapter** (child_process cannot run in a browser) |
| Processing orchestration | `pipeline.js` on the server, triggered via `POST /recordings/:id/process` | `background.js`, triggered via a `PROCESS_RECORDING` runtime message |
| Config storage | `server/src/config.json` on disk | `chrome.storage.local` directly (see key table below) |
| Prompts | `server/src/prompts.yaml`, edited by hand | `prompts.js` (verbatim port) + **editable per-user overrides** in Settings (see below) |

### STT providers (`providers.js`)

| Provider | Notes |
|---|---|
| `custom` (default) | Same Whisper-compatible endpoint shape as the server variant — points at a local server the user runs themselves (e.g. `http://localhost:8080/v1`) |
| `openai` | OpenAI Whisper API, requires `sttKey` |
| `gemini` | Gemini `generateContent` with inline audio (base64) — 19 MB request-size ceiling, throws a clear error above that instead of silently failing |

### LLM providers (`providers.js`)

| Provider | Notes |
|---|---|
| `openai` (default) | OpenAI Chat Completions, default model `gpt-4o` |
| `gemini-api` | Gemini `generateContent`, default model `gemini-3.6-flash` |
| `api` | Any OpenAI-compatible `/chat/completions` endpoint (custom URL) |

No CLI-based LLM option — the `llmCli: 'claude'`/`'custom'` CLI adapters from the server variant don't exist here; `createLLMProvider()` throws for any unrecognized `llmCli` value.

### Processing modes: MOM vs Notes

The popup's mode toggle (`جلسه` / `یادداشت`) selects between two output shapes, both handled by the same `continueProcessing()` in `background.js`:
- **`mom`** (default) — the usual خلاصه/تصمیمات/اقدامات three-section minutes, via `buildMOMPrompt`/`parseMOMOutput`.
- **`notes`** — for one person thinking aloud rather than a multi-party meeting; extracts each distinct thought as its own bulleted line under `## یادداشت‌ها`, via `buildNotesPrompt`/`parseNotesOutput`.

### Editable prompts

Settings → **پرامپت‌ها** exposes the three prompt templates (`prompts.js`'s `MOM_PROMPT`, `NOTES_PROMPT`, `CORRECTION_PROMPT`) as collapsed, individually-expandable textareas — collapsed by default so the settings page stays scannable despite each prompt being 20–30 lines. Storage keys `promptMom` / `promptNotes` / `promptCorrection` in `chrome.storage.local` are empty-string by default, meaning "use the built-in default"; `prompts.js`'s three `build*Prompt(transcript, customTemplate)` functions fall back to the default when the override is falsy. This keeps future default-prompt updates flowing through to any user who never customized a given prompt. The `##` section headings are load-bearing (parsed by `parseMOMOutput`/`parseNotesOutput`/`parseCorrectionOutput`) — the settings UI warns against editing them but does not enforce it.

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
| `promptMom` / `promptNotes` / `promptCorrection` | `""` | Empty = use built-in default; see "Editable prompts" above |
| `customMeetingDomains` | `[]` | Extra domains for meeting-URL detection, beyond the built-in Meet/Zoom/Teams/Skype patterns |

### Stuck-job watchdog

MV3 service workers can be killed by Chrome without warning, including mid-`fetch()` — this destroys the entire execution context, so no `catch` block runs to record the failure, and a recording can be left stuck in `transcribing`/`summarizing`/`correcting` forever. Fixed with `chrome.alarms` (alarms can wake an already-terminated service worker, unlike a timer): a `processing-watchdog` alarm fires every minute and flags any recording that's been in a processing state for more than 25 minutes (comfortably above the 5 min STT + 15 min LLM worst-case sequential timeout) as `error`, with a Persian message asking the user to retry. Each processing/correction job also has a **Cancel** button in the popup (`CANCEL_PROCESSING` message), which aborts the in-flight `fetch` via `AbortController` if the same service-worker instance is still alive, and unconditionally resets the record's status either way.

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
├── prompts.js           — Prompt templates + builders + output parsers (ported from
│                         server/src/prompts.yaml + pipeline.js's parsers)
├── offscreen.html/js    — Audio capture and mixing (same role as extension/'s)
├── popup.html/css/js    — Recording UI + mode toggle (MOM / Notes)
├── settings.html/js     — Settings page: STT/LLM provider config + editable prompts
│                         (writes directly to chrome.storage.local — no server API)
├── onboarding.html/js   — Setup wizard
├── permission.html/js   — Standalone mic-permission helper page
├── fonts.css, fonts/    — Self-hosted Vazirmatn (see "Fonts" above)
└── icons/
```
