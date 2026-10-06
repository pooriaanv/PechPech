'use strict';

// i18n.js — bilingual (English / Persian) string dictionary + helpers,
// shared by every page (popup, settings, onboarding, permission) and by
// background.js. English is the default language; Persian is opt-in.
//
// Mirrors extension-standalone/i18n.js exactly (same mechanism, same key
// names for every string that exists in both trees) — see that file for the
// full design rationale. This copy additionally covers extension/-only UI
// (the Local Helper server card, the extra LLM connection types, and a
// handful of local-helper-specific error strings) that has no equivalent
// in the standalone variant.
//
// Usage in a page:
//   import { bootLanguage, t, getLanguage, setLanguage, onLanguageChange } from './i18n.js';
//   await bootLanguage();               // reads storage, sets dir/lang, translates data-i18n nodes
//   el.textContent = t('someKey');      // for strings built dynamically in JS
//
// Static markup is tagged with:
//   data-i18n="key"            → el.textContent = t(key)
//   data-i18n-html="key"       → el.innerHTML   = t(key)   (only for dictionary entries with trusted markup, e.g. <code>)
//   data-i18n-attr="title:key,aria-label:key2"  → sets each attribute from t(key)

const STRINGS = {
  // ── Common ──────────────────────────────────────────────────────
  settingsTitle:        { en: 'Settings', fa: 'تنظیمات' },
  toggleLanguageTitle:  { en: 'Switch to Persian', fa: 'تغییر به انگلیسی' },
  deleteTitle:          { en: 'Delete', fa: 'حذف' },
  cancel:                { en: 'Cancel', fa: 'لغو' },

  // ── Popup — header / idle ──────────────────────────────────────
  modeGroupLabel:       { en: 'Processing mode', fa: 'حالت پردازش' },
  modeMeeting:          { en: 'Meeting', fa: 'جلسه' },
  modeNotes:            { en: 'Notes', fa: 'یادداشت' },
  startRecordingAria:   { en: 'Start recording', fa: 'شروع ضبط' },
  heroLabelMom:         { en: 'Start recording meeting', fa: 'شروع ضبط جلسه' },
  heroLabelNotes:       { en: 'Start voice notes', fa: 'شروع یادداشت صوتی' },
  recentRecordings:     { en: 'Recent recordings', fa: 'ضبط‌های اخیر' },
  refreshTitle:         { en: 'Refresh', fa: 'بازخوانی' },
  loading:              { en: 'Loading…', fa: 'در حال بارگذاری…' },
  noRecordingsYet:      { en: 'No recordings yet.', fa: 'هنوز ضبطی وجود ندارد.' },
  // Local-helper-specific: shown when the /recordings list fetch itself
  // fails (server down / unreachable) — extension-standalone has no
  // equivalent failure mode since it has no server to reach.
  serverUnreachable:    { en: 'Server unavailable.', fa: 'سرور در دسترس نیست.' },

  // ── Popup — recording state ────────────────────────────────────
  recModeLabelPrefix:   { en: 'Mode:', fa: 'حالت:' },
  stopAndSave:          { en: 'Stop & Save', fa: 'توقف و ذخیره' },

  // ── Popup — processing state ───────────────────────────────────
  stepTranscribe:       { en: 'Transcribing', fa: 'رونویسی' },
  stepAnalyze:          { en: 'Analysis', fa: 'تحلیل' },
  processingDefault:    { en: 'Processing…', fa: 'در حال پردازش…' },
  processingSaving:     { en: 'Saving recording…', fa: 'در حال ذخیره‌سازی ضبط…' },
  // Local-helper-specific status: this variant's server reports a distinct
  // 'uploading' phase (audio in transit to the server) before 'transcribing'.
  processingUploading:  { en: 'Uploading audio…', fa: 'در حال آپلود صدا…' },
  processingTranscribing: { en: 'Transcribing…', fa: 'در حال رونویسی…' },
  processingSummarizingMom:   { en: 'Generating minutes…', fa: 'در حال تولید صورت‌جلسه…' },
  processingSummarizingNotes: { en: 'Extracting notes…', fa: 'در حال استخراج یادداشت‌ها…' },
  processingNote:        { en: 'You can close this window — processing continues.', fa: 'می‌توانید این پنجره را ببندید، پردازش ادامه می‌یابد.' },
  cancelProcessing:      { en: 'Cancel processing', fa: 'لغو پردازش' },

  // ── Popup — result state ───────────────────────────────────────
  summary:               { en: 'Summary', fa: 'خلاصه' },
  decisions:              { en: 'Decisions', fa: 'تصمیمات' },
  actionItems:            { en: 'Action Items', fa: 'اقدامات' },
  notesLabel:             { en: 'Notes', fa: 'یادداشت‌ها' },
  notesEmpty:             { en: 'No notes found in this recording.', fa: 'یادداشتی در این ضبط یافت نشد.' },
  correctTranscript:      { en: 'Correct & separate speakers', fa: 'اصلاح و تفکیک گوینده‌ها' },
  correcting:             { en: 'Correcting text…', fa: 'در حال اصلاح متن…' },
  correctedTranscript:    { en: 'Corrected text', fa: 'متن اصلاح‌شده' },
  saveMd:                 { en: 'Save .md', fa: 'ذخیره .md' },
  back:                   { en: '← Back', fa: '← بازگشت' },

  // ── Popup — recording card ─────────────────────────────────────
  editNameTitle:          { en: 'Edit name', fa: 'ویرایش نام' },
  meetingNamePlaceholder: { en: 'Meeting name...', fa: 'نام جلسه...' },
  saveEnterTitle:         { en: 'Save (Enter)', fa: 'ذخیره (Enter)' },
  cancelEscTitle:         { en: 'Cancel (Esc)', fa: 'انصراف (Esc)' },
  badgeSaved:             { en: 'Saved', fa: 'ذخیره شده' },
  badgeDone:              { en: '✓ Ready', fa: '✓ آماده' },
  // Local-helper-specific: the server-backed pipeline exposes a distinct
  // 'processing' status (generic, before it narrows to transcribing/summarizing).
  badgeProcessing:        { en: 'Processing…', fa: 'پردازش…' },
  badgeTranscribing:      { en: 'Transcribing…', fa: 'رونویسی…' },
  badgeSummarizing:       { en: 'Summarizing…', fa: 'خلاصه‌سازی…' },
  badgeError:             { en: 'Error', fa: 'خطا' },
  process:                { en: 'Process', fa: 'پردازش' },
  viewResult:             { en: 'View result', fa: 'مشاهده نتیجه' },

  // ── Popup — errors / status ─────────────────────────────────────
  micDeniedRetry:   { en: 'Microphone access was previously denied.\nA new tab opened — follow the instructions to enable access, then come back here and click "Start Recording" again.',
                       fa: 'دسترسی میکروفون قبلاً رد شده است.\nیک تب جدید باز شد — طبق راهنما دسترسی را فعال کنید، سپس به اینجا برگردید و دوباره «شروع ضبط» را بزنید.' },
  micPromptOpened:  { en: 'A new tab opened for microphone access.\nAfter granting access, come back to this window and click "Start Recording" again.',
                       fa: 'یک تب جدید برای دسترسی میکروفون باز شد.\nپس از تایید دسترسی، به این پنجره برگردید و دوباره «شروع ضبط» را بزنید.' },
  micDenied:        { en: 'Microphone access was denied.\nPlease enable microphone access in Chrome settings.',
                       fa: 'دسترسی به میکروفون رد شد.\nلطفاً در تنظیمات Chrome دسترسی میکروفون را فعال کنید.' },
  recordingNotStarted:   { en: 'Recording did not start: {error}', fa: 'ضبط شروع نشد: {error}' },
  errorStoppingRecording: { en: 'Error stopping recording', fa: 'خطا در توقف ضبط' },
  processingFailed:      { en: 'Processing failed.', fa: 'پردازش با خطا مواجه شد.' },
  // Local-helper-specific: shown when the health check before recording
  // starts finds no local server listening.
  localServerUnreachable: { en: 'Local server unavailable.\nPlease start the local helper:\ncd local-helper && node server.js',
                             fa: 'سرور محلی در دسترس نیست.\nلطفاً local helper را اجرا کنید:\ncd local-helper && node server.js' },

  // ── Export markdown ─────────────────────────────────────────────
  exportNoteHeading:     { en: '# Note', fa: '# یادداشت' },
  exportNotesSection:    { en: '## Notes', fa: '## یادداشت‌ها' },
  exportMomHeading:      { en: '# Minutes of Meeting', fa: '# صورت‌جلسه' },
  exportSummarySection:  { en: '## Summary', fa: '## خلاصه' },
  exportDecisionsSection:{ en: '## Decisions', fa: '## تصمیمات' },
  exportActionsSection:  { en: '## Action Items', fa: '## اقدامات' },
  exportCorrectedSection:{ en: '## Corrected Text', fa: '## متن اصلاح‌شده' },
  exportGeneratedBy:     { en: '*Generated by PechPech*', fa: '*تولید شده توسط PechPech*' },

  // ── background.js — request errors / notifications ─────────────
  bgAlreadyRecording:    { en: 'A recording is already in progress.', fa: 'در حال حاضر ضبط در جریان است.' },
  bgNoActiveTab:         { en: 'No active tab found.', fa: 'تب فعالی یافت نشد.' },
  bgRecordingLost:       { en: 'Recording was lost due to a browser restart. Please start again.', fa: 'ضبط به دلیل ری‌استارت مرورگر از دست رفت. لطفاً دوباره شروع کنید.' },
  bgNoRecordingInProgress: { en: 'No recording in progress.', fa: 'ضبطی در جریان نیست.' },
  bgSaveTimedOut:        { en: 'Timed out waiting to save the recording.', fa: 'زمان انتظار برای ذخیره ضبط به پایان رسید.' },
  bgMeetingDetectedTooltip: { en: 'Meeting detected — click the icon to record', fa: 'جلسه شناسایی شد — برای ضبط روی آیکون کلیک کنید' },
  bgNotifTitle:          { en: 'PechPech', fa: 'PechPech' },
  bgNotifBody:           { en: 'You joined a call — want to start recording?', fa: 'وارد کال شدی — ضبط رو شروع کنی؟' },

  // ── Settings page ────────────────────────────────────────────────
  settingsPageTitle:      { en: 'Settings — PechPech', fa: 'تنظیمات — PechPech' },
  settingsHeaderTitle:    { en: '🎙️ PechPech — Settings', fa: '🎙️ PechPech — تنظیمات' },
  // extension/ has a real local server, so its "settings never leave this
  // device" copy is shorter than extension-standalone's (which also claims
  // "no server — processing happens directly from the extension").
  settingsHeaderSubServer: { en: 'Settings are stored on this device and never leave it.',
                              fa: 'تنظیمات در این دستگاه ذخیره می‌شوند و هرگز از آن خارج نمی‌شوند.' },
  sttCardTitle:           { en: 'Speech-to-Text (STT)', fa: 'تبدیل گفتار به متن (STT)' },
  sttProviderLabel:       { en: 'Service type', fa: 'نوع سرویس' },
  sttProviderCustomOpt:   { en: 'Local / custom server (Whisper-compatible)', fa: 'سرور محلی / سفارشی (Whisper-compatible)' },
  sttProviderOpenAIOpt:   { en: 'OpenAI Whisper', fa: 'OpenAI Whisper' },
  sttProviderGeminiOpt:   { en: 'Google Gemini', fa: 'Google Gemini' },
  sttProviderHint:        { en: 'For OpenAI and Gemini, only the API key and model name are needed.', fa: 'برای OpenAI و Gemini فقط کلید API و نام مدل لازم است.' },
  sttUrlLabel:            { en: 'STT server base URL', fa: 'آدرس پایه سرور STT' },
  sttUrlHint:             { en: 'Compatible with the OpenAI Whisper API. Example for a local server:', fa: 'سازگار با OpenAI Whisper API. مثال برای سرور محلی:' },
  apiKeyLabel:            { en: 'API Key', fa: 'کلید API' },
  optionalSuffix:         { en: ' (optional)', fa: ' (اختیاری)' },
  getApiKey:              { en: 'Get API Key', fa: 'Get API Key' },
  sttKeyHintDefault:      { en: 'Leave empty for a local server. Enter it for OpenAI / Groq.', fa: 'برای سرور محلی خالی بگذارید. برای OpenAI / Groq وارد کنید.' },
  sttModelLabel:          { en: 'STT model name', fa: 'نام مدل STT' },
  sttModelHintDefault:    { en: 'Default: <code>whisper-1</code> (OpenAI) &nbsp;|&nbsp; GapGPT: <code>whisper-large-v3</code>',
                             fa: 'پیش‌فرض: <code>whisper-1</code> (OpenAI) &nbsp;|&nbsp; GapGPT: <code>whisper-large-v3</code>' },
  llmCardTitle:           { en: 'Language Model (LLM)', fa: 'مدل زبانی (LLM)' },
  llmTypeLabel:           { en: 'Connection type', fa: 'نوع اتصال' },
  llmOpenAIOpt:           { en: 'OpenAI (ChatGPT)', fa: 'OpenAI (ChatGPT)' },
  llmGeminiOpt:           { en: 'Google Gemini', fa: 'Google Gemini' },
  llmCustomApiOpt:        { en: 'Custom API (OpenAI-compatible)', fa: 'Custom API (OpenAI-compatible)' },
  // extension/-only connection types — no equivalent in extension-standalone
  // (which cannot shell out to a CLI from inside a browser).
  llmClaudeOpt:           { en: 'Claude Code (claude)', fa: 'Claude Code (claude)' },
  llmCustomCliOpt:        { en: 'Custom CLI', fa: 'Custom CLI' },
  llmCustomCommandLabel:  { en: 'Custom CLI command', fa: 'دستور سفارشی CLI' },
  llmCustomCommandHint:   { en: 'The command to run for the custom CLI. The prompt text is passed as the first argument.',
                             fa: 'دستور اجرا برای CLI سفارشی. متن prompt به عنوان اولین آرگومان ارسال می‌شود.' },
  apiUrlLabel:            { en: 'API base URL', fa: 'آدرس پایه API' },
  apiUrlHint:             { en: 'Compatible with the OpenAI Chat Completions API.', fa: 'سازگار با OpenAI Chat Completions API.' },
  modelNameLabel:         { en: 'Model name', fa: 'نام مدل' },
  modelDefaultHint:       { en: 'Default: <code>gpt-4o</code>', fa: 'پیش‌فرض: <code>gpt-4o</code>' },
  // extension/-only card: the local helper server that extension-standalone
  // doesn't need (it processes everything in-browser).
  helperCardTitle:        { en: 'Local Helper Server', fa: 'سرور محلی (Local Helper)' },
  helperPortLabel:        { en: 'Port', fa: 'پورت' },
  helperPortHint:         { en: 'The port <code>server.js</code> runs on. Default: 3456',
                             fa: 'پورتی که <code>server.js</code> روی آن اجرا می‌شود. پیش‌فرض: ۳۴۵۶' },
  helperRunInfoBox:       { en: 'To run the Local Helper:<br/><code>node server/src/server.js</code> — simple, in the foreground<br/><code>node launcher/index.js</code> — with notifications and auto-start<br/>or with Docker: <code>docker compose up -d</code>',
                             fa: 'برای اجرای Local Helper:<br/><code>node server/src/server.js</code> ساده و در پیش‌زمینه<br/><code>node launcher/index.js</code> با نوتیفیکیشن و راه‌اندازی خودکار<br/>یا با Docker: <code>docker compose up -d</code>' },
  meetingDetectionCardTitle: { en: 'Call-Join Detection', fa: 'تشخیص ورود به کال' },
  defaultDomainsLabel:    { en: 'Default domains', fa: 'دامنه‌های پیش‌فرض' },
  defaultDomainsHint:     { en: 'Always enabled and cannot be removed.', fa: 'همیشه فعال هستند و قابل حذف نیستند.' },
  addCustomDomainLabel:   { en: 'Add custom domain', fa: 'افزودن دامنه سفارشی' },
  add:                    { en: 'Add', fa: 'افزودن' },
  domainInputHint:        { en: 'Domain name only, no https:// — e.g. <code>whereby.com</code>', fa: 'فقط نام دامنه بدون https:// — مثلاً <code>whereby.com</code>' },
  saveSettings:           { en: 'Save settings', fa: 'ذخیره تنظیمات' },
  reset:                  { en: 'Reset', fa: 'بازنشانی' },
  savedToast:             { en: '✓ Settings saved successfully.', fa: '✓ تنظیمات با موفقیت ذخیره شد.' },
  resetToast:             { en: 'Settings reset.', fa: 'تنظیمات بازنشانی شد.' },
  confirmReset:           { en: 'Reset settings to defaults?', fa: 'تنظیمات به حالت پیش‌فرض بازنشانی شود؟' },
  keyHintOpenAI:          { en: 'API key from platform.openai.com', fa: 'کلید API از platform.openai.com' },
  keyHintGemini:          { en: 'API key from aistudio.google.com', fa: 'کلید API از aistudio.google.com' },
  sttKeyHintOpenAIRequired: { en: 'API key from platform.openai.com — required.', fa: 'کلید API از platform.openai.com — الزامی است.' },
  sttKeyHintGeminiRequired: { en: 'API key from aistudio.google.com — required.', fa: 'کلید API از aistudio.google.com — الزامی است.' },
  defaultModelHint:       { en: 'Default: <code>{model}</code>', fa: 'پیش‌فرض: <code>{model}</code>' },
  // Local-helper-specific: settings.js talks to the server's GET/POST
  // /config — these surface a dead/unreachable server, which has no
  // equivalent in extension-standalone (no server to reach).
  settingsServerUnreachable: { en: 'Cannot reach the PechPech server at localhost:{port}. Start it first, then reload this page.',
                                fa: 'اتصال به سرور PechPech روی localhost:{port} برقرار نشد. لطفاً ابتدا سرور را اجرا کنید و این صفحه را دوباره بارگذاری کنید.' },
  settingsSaveFailed:     { en: 'Could not save to server: {message}', fa: 'ذخیره در سرور ناموفق بود: {message}' },
  settingsResetFailed:    { en: 'Could not reset: {message}', fa: 'بازنشانی ناموفق بود: {message}' },

  // ── Onboarding ──────────────────────────────────────────────────
  onboardingPageTitle:    { en: 'PechPech — Setup', fa: 'PechPech — راه‌اندازی' },
  // extension/'s onboarding describes a server-backed flow, so most of its
  // copy differs from extension-standalone's — new keys throughout, with
  // the *Server suffix marking ones that have a same-named but
  // different-content counterpart in the standalone dictionary.
  onboardingBrandSubServer: { en: 'Automatically generates meeting minutes from your online meetings.',
                               fa: 'تولید خودکار صورت‌جلسه از جلسات آنلاین' },
  stepIntro:              { en: 'Intro', fa: 'معرفی' },
  stepHowItWorks:         { en: 'How it works', fa: 'نحوه کار' },
  stepSetup:              { en: 'Setup', fa: 'راه‌اندازی' },
  stepConnection:         { en: 'Connection', fa: 'اتصال' },
  stepStart:              { en: 'Start', fa: 'شروع' },
  introWelcomeTitle:      { en: 'Welcome to PechPech 👋', fa: 'به PechPech خوش آمدید 👋' },
  introWelcomeBodyServer: { en: 'An extension that records your online meetings and delivers ready-made meeting minutes without any note-taking.',
                             fa: 'افزونه‌ای که جلسات آنلاین شما را ضبط می‌کند و بدون هیچ یادداشتی، صورت‌جلسه آماده تحویل می‌دهد.' },
  feat1Title:             { en: 'Smart meeting recording', fa: 'ضبط هوشمند جلسه' },
  feat1Desc:               { en: 'Simultaneously records and mixes browser tab audio (Google Meet, Teams, Zoom Web) and your microphone. No extra software needed.',
                              fa: 'صدای تب مرورگر (Google Meet، Teams، Zoom Web) و میکروفون شما را همزمان ضبط و ترکیب می‌کند. هیچ نرم‌افزار جانبی لازم نیست.' },
  feat2TitleServer:        { en: 'Speech-to-text with Whisper', fa: 'تبدیل گفتار به متن با Whisper' },
  feat2DescServer:         { en: 'Recorded audio is sent to the Whisper service and converted into accurate text — with support for accents and technical terminology.',
                              fa: 'صدای ضبط‌شده به سرویس Whisper ارسال می‌شود و به متن دقیق تبدیل می‌گردد — با پشتیبانی از لهجه و اصطلاحات فنی.' },
  feat3TitleServer:        { en: 'Structured meeting minutes', fa: 'صورت‌جلسه ساختارمند' },
  feat3DescServer:         { en: 'A language model (Claude, GPT, or any other LLM) analyzes the transcript and writes the summary, decisions, and action items.',
                              fa: 'یک مدل زبانی (Claude، GPT یا هر LLM دیگری) متن را تحلیل کرده و خلاصه، تصمیمات، و اقدامات جلسه را می‌نویسد.' },
  howItWorksTitle:        { en: 'How does it work?', fa: 'چطور کار می‌کند؟' },
  howItWorksSubServer:    { en: 'PechPech is made up of four parts working together:',
                             fa: 'PechPech از چهار بخش تشکیل شده که با هم کار می‌کنند:' },
  archFlowLabel:          { en: 'Processing flow — from recording to minutes:', fa: 'جریان پردازش — از ضبط تا صورت‌جلسه:' },
  archExt:                { en: 'Chrome<br/>Extension', fa: 'افزونه<br/>Chrome' },
  archNodeExtLabel:       { en: 'Record audio', fa: 'ضبط صدا' },
  archArrowAudioFile:     { en: 'Audio file', fa: 'فایل صوتی' },
  archSrv:                { en: 'Local<br/>Server', fa: 'سرور<br/>محلی' },
  archSrvLabel:           { en: 'Node.js', fa: 'Node.js' },
  archArrowCleanAudio:    { en: 'Clean audio', fa: 'صدای پاکیزه' },
  archStt:                { en: 'Whisper<br/>Service', fa: 'سرویس<br/>Whisper' },
  archSttLabel:           { en: 'Speech to text', fa: 'تبدیل به متن' },
  archArrowTranscript:    { en: 'Meeting transcript', fa: 'متن جلسه' },
  archLlm:                { en: 'Language<br/>Model', fa: 'مدل<br/>زبانی' },
  archLlmLabelServer:     { en: 'Claude / GPT', fa: 'Claude / GPT' },
  archArrowFinalMom:      { en: 'Final minutes', fa: 'MOM نهایی' },
  archOut:                { en: 'Meeting<br/>Minutes', fa: 'صورت‌<br/>جلسه' },
  archOutLabelServer:     { en: 'Markdown file', fa: 'فایل Markdown' },
  setupHowStep1Title:      { en: 'Chrome Extension', fa: 'افزونه Chrome' },
  setupHowStep1DescServer: { en: 'Records the meeting audio and sends it to the local server. All processing happens on your own machine — no data goes to an external server.',
                              fa: 'صدای جلسه را ضبط و به سرور محلی ارسال می‌کند. همه پردازش‌ها روی سیستم خودتان انجام می‌شود — هیچ داده‌ای به سرور خارجی نمی‌رود.' },
  setupServerStepTitle:    { en: 'Local Server (Node.js)', fa: 'سرور محلی (Node.js)' },
  setupServerStepDesc:     { en: 'Receives the audio file, cleans it up, and sends it to Whisper. Passes the resulting text to the LLM and stores the final minutes.',
                              fa: 'فایل صوتی را دریافت، پاکسازی و به Whisper ارسال می‌کند. متن دریافتی را به LLM می‌دهد و صورت‌جلسه نهایی را ذخیره می‌کند.' },
  setupHowStep2Title:      { en: 'Whisper STT', fa: 'Whisper STT' },
  setupHowStep2DescServer: { en: 'A local or cloud service compatible with the OpenAI API that converts audio into text. You can use Groq, OpenAI, or a local whisper.cpp.',
                              fa: 'یک سرویس محلی یا ابری سازگار با OpenAI API که صدا را به متن تبدیل می‌کند. می‌توانید از Groq، OpenAI، یا whisper.cpp محلی استفاده کنید.' },
  setupHowStep3Title:      { en: 'Language Model (LLM)', fa: 'مدل زبانی (LLM)' },
  setupHowStep3DescServer: { en: 'Claude Code (recommended), any OpenAI-compatible API, or any custom CLI. Analyzes the transcript and writes the minutes.',
                              fa: 'Claude Code (پیشنهادی)، یا هر API سازگار با OpenAI، یا هر CLI سفارشی. متن جلسه را تحلیل و صورت‌جلسه می‌نویسد.' },
  setupPanelTitle:         { en: 'Initial setup', fa: 'راه‌اندازی اولیه' },
  setupPanelSubServer:     { en: "If you haven't installed the server yet, follow these steps. If you've already run <code>install.sh</code>, skip this step.",
                              fa: 'اگر هنوز سرور را نصب نکرده‌اید، این مراحل را طی کنید. اگر قبلاً <code>install.sh</code> را اجرا کرده‌اید، از این مرحله رد شوید.' },
  setupInstallStep1Title:  { en: 'Install the prerequisites', fa: 'پیش‌نیازها را نصب کنید' },
  setupInstallStep1Desc:   { en: 'Have Node.js 18+, Docker Desktop, and the Claude CLI (or any other LLM) installed on your machine.',
                              fa: 'Node.js 18+، Docker Desktop، و Claude CLI (یا هر LLM دیگری) روی سیستم داشته باشید.' },
  setupInstallStep2Title:  { en: 'Run the install script', fa: 'اسکریپت نصب را اجرا کنید' },
  setupInstallStep2Desc:   { en: 'From the PechPech root folder:<br/><code>chmod +x install.sh && ./install.sh</code><br/>This script configures Whisper and the LLM settings.',
                              fa: 'در پوشه اصلی PechPech:<br/><code>chmod +x install.sh && ./install.sh</code><br/>این اسکریپت Whisper و تنظیمات LLM را پیکربندی می‌کند.' },
  setupInstallStep3Title:  { en: 'Start the server', fa: 'سرور را اجرا کنید' },
  setupInstallStep3Desc:   { en: '<code>node src/launcher/index.js</code><br/>The server comes up on port 3456. Keep this window open.',
                              fa: '<code>node src/launcher/index.js</code><br/>سرور روی پورت ۳۴۵۶ بالا می‌آید. این پنجره را باز نگه دارید.' },
  setupInstallStep4Title:  { en: 'Load the extension in Chrome', fa: 'افزونه را در Chrome بارگذاری کنید' },
  setupInstallStep4Desc:   { en: 'Go to <code>chrome://extensions</code>, turn on Developer mode, click "Load unpacked", and select the <code>src/extension</code> folder.',
                              fa: 'به <code>chrome://extensions</code> بروید، Developer mode را روشن کنید، روی «Load unpacked» کلیک کنید و پوشه <code>src/extension</code> را انتخاب کنید.' },
  connectionPanelTitle:    { en: 'Check connection', fa: 'بررسی اتصال' },
  connectionPanelSubServer: { en: "Let's make sure the local server is running.", fa: 'بیایید مطمئن شویم سرور محلی در حال اجرا است.' },
  connCheckingServer:      { en: 'Checking connection to the server…', fa: 'در حال بررسی ارتباط با سرور…' },
  connOkText:              { en: 'Server is running — localhost:{port} ✓', fa: 'سرور در حال اجرا است — localhost:{port} ✓' },
  allReadyBody:            { en: '<strong>Everything\'s ready!</strong><br/>You can move to the next step and record your first meeting.',
                              fa: '<strong>همه چیز آماده است!</strong><br/>می‌توانید به مرحله بعد بروید و اولین جلسه را ضبط کنید.' },
  connFailText:            { en: 'Server is not responding on localhost:{port}', fa: 'سرور پاسخ نمی‌دهد روی localhost:{port}' },
  connInfoServerNotRunning: { en: "Server not started yet?<br/>Run in your terminal:<br/><code>node src/launcher/index.js</code><br/><br/>Then click \"Recheck\".",
                               fa: 'سرور هنوز راه‌اندازی نشده؟<br/>در ترمینال اجرا کنید:<br/><code>node src/launcher/index.js</code><br/><br/>سپس دکمه «بررسی مجدد» را بزنید.' },
  onbRecheckConn:          { en: '↺ Recheck connection', fa: '↺ بررسی مجدد اتصال' },
  openExtensionSettings:   { en: '⚙ Open extension settings', fa: '⚙ باز کردن تنظیمات افزونه' },
  readyTitle:              { en: "You're all set!", fa: 'آماده‌اید!' },
  readySub:                { en: 'PechPech is installed and waiting for your first meeting.', fa: 'PechPech نصب شده و منتظر اولین جلسه شماست.' },
  tip1:                    { en: 'On your next meeting, open the Google Meet or Teams tab, click the PechPech icon in the Chrome toolbar, and click <strong>Start Recording</strong>.',
                              fa: 'در جلسه بعدی، تب Google Meet یا Teams را باز کنید، روی آیکون PechPech در نوار Chrome کلیک کنید و <strong>شروع ضبط</strong> را بزنید.' },
  tip2Server:              { en: 'At the end of the meeting, click <strong>Stop & Save</strong>. The audio file is sent to the server and processing begins.',
                              fa: 'در پایان جلسه <strong>توقف و ذخیره</strong> را بزنید. فایل صوتی به سرور ارسال می‌شود و پردازش شروع می‌شود.' },
  tip3Server:              { en: 'Wait a few minutes. The final minutes (summary + decisions + action items) appear in the extension popup.',
                              fa: 'چند دقیقه صبر کنید. صورت‌جلسه نهایی (خلاصه + تصمیمات + اقدامات) در پاپ‌آپ افزونه ظاهر می‌شود.' },
  tip4:                    { en: 'If the transcript needs correcting, click <strong>Correct Transcript</strong> to have the LLM review it.',
                              fa: 'اگر متن جلسه نیاز به اصلاح دارد، دکمه <strong>اصلاح رونوشت</strong> را بزنید تا LLM متن را بازبینی کند.' },
  stepProgress:            { en: 'Step {n} of {total}', fa: 'مرحله {n} از {total}' },
  navPrev:                 { en: '← Previous', fa: 'قبلی →' },
  navNext:                 { en: 'Next →', fa: '← بعدی' },
  navDone:                 { en: 'Get started ✓', fa: 'شروع کنید ✓' },

  // ── Permission page ─────────────────────────────────────────────
  permPageTitle:          { en: 'Microphone Access — PechPech', fa: 'دسترسی میکروفون — PechPech' },
  permTitle:              { en: 'Microphone Access', fa: 'دسترسی به میکروفون' },
  permBody:               { en: 'To record your voice alongside the meeting audio, PechPech needs microphone access. This permission is specific to this extension and won\'t be asked again once granted.',
                             fa: 'برای ضبط صدای شما در کنار صدای جلسه، PechPech نیاز به دسترسی میکروفون دارد. این دسترسی فقط مخصوص همین افزونه است و پس از تایید، دیگر لازم نیست تکرار شود.' },
  permGrant:              { en: 'Grant microphone access', fa: 'اعطای دسترسی میکروفون' },
  permOpenSettings:       { en: 'Open Chrome settings', fa: 'باز کردن تنظیمات Chrome' },
  permGranted:            { en: '✓ Access granted. You can close this tab and return to the extension.', fa: '✓ دسترسی داده شد. می‌توانید این تب را ببندید و به افزونه برگردید.' },
  permDeniedManual:       { en: '✗ Access denied. To enable manually, click the button below and set "Microphone" to Allow.', fa: 'دسترسی رد شد. برای فعال‌سازی دستی، روی دکمه زیر بزنید و «Microphone» را روی Allow بگذارید.' },
  permError:              { en: 'Error: {message}', fa: 'خطا: {message}' },
  permAlreadyGranted:     { en: '✓ Access is already granted. You can close this tab.', fa: '✓ دسترسی از قبل فعال است. می‌توانید این تب را ببندید.' },
  permAlreadyDenied:      { en: 'Microphone access was previously denied. Click the button below to enable it.', fa: 'دسترسی میکروفون قبلاً رد شده است. برای فعال‌سازی، روی دکمه زیر بزنید.' },
};

let _lang = 'en';
const _listeners = [];

function normalizeLang(lang) {
  return lang === 'fa' ? 'fa' : 'en';
}

function getStorageLanguage() {
  return new Promise(resolve => {
    chrome.storage.local.get(['language'], ({ language }) => resolve(normalizeLang(language)));
  });
}

function setStorageLanguage(lang) {
  return new Promise(resolve => chrome.storage.local.set({ language: lang }, resolve));
}

function getLanguage() {
  return _lang;
}

async function initLanguage() {
  _lang = await getStorageLanguage();
  return _lang;
}

async function setLanguage(lang) {
  _lang = normalizeLang(lang);
  await setStorageLanguage(_lang);
  _listeners.forEach(fn => fn(_lang));
  return _lang;
}

// Updates this module instance's in-memory language WITHOUT writing to
// storage — for contexts (like background.js's service worker) that mirror
// a language change made elsewhere via their own chrome.storage.onChanged
// listener, so they don't redundantly re-write the value another context
// already persisted.
function setLanguageLocal(lang) {
  _lang = normalizeLang(lang);
  return _lang;
}

function onLanguageChange(fn) {
  _listeners.push(fn);
}

function tFor(key, lang, vars) {
  const entry = STRINGS[key];
  const useLang = normalizeLang(lang);
  let s = entry ? (entry[useLang] || entry.en) : key;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(v);
  }
  return s;
}

function t(key, vars) {
  return tFor(key, _lang, vars);
}

function applyTranslations(root = document) {
  root.querySelectorAll('[data-i18n]').forEach(el => {
    el.textContent = t(el.dataset.i18n);
  });
  root.querySelectorAll('[data-i18n-html]').forEach(el => {
    el.innerHTML = t(el.dataset.i18nHtml);
  });
  root.querySelectorAll('[data-i18n-attr]').forEach(el => {
    el.dataset.i18nAttr.split(',').forEach(pair => {
      const [attr, key] = pair.split(':');
      el.setAttribute(attr, t(key));
    });
  });
  if (root === document || root.ownerDocument) {
    document.documentElement.lang = _lang;
    document.documentElement.dir  = _lang === 'fa' ? 'rtl' : 'ltr';
  }
}

// Called once, as early as possible, on every page. Pairs with a
// `<script>document.documentElement.classList.add('lang-pending')</script>`
// placed first in <head> (plus `html.lang-pending body{visibility:hidden}`)
// so the page stays invisible for the few ms it takes to read storage,
// instead of flashing the wrong direction before this resolves.
async function bootLanguage(root = document) {
  await initLanguage();
  applyTranslations(root);
  document.documentElement.classList.remove('lang-pending');
  return _lang;
}

export {
  STRINGS,
  t,
  tFor,
  getLanguage,
  initLanguage,
  setLanguage,
  setLanguageLocal,
  onLanguageChange,
  applyTranslations,
  bootLanguage,
};
