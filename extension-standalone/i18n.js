'use strict';

// i18n.js — bilingual (English / Persian) string dictionary + helpers,
// shared by every page (popup, settings, onboarding, permission) and by
// background.js. English is the default language; Persian is opt-in.
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
  errorLoadingRecordings: { en: 'Error loading recordings.', fa: 'خطا در بارگذاری ضبط‌ها.' },

  // ── Popup — recording state ────────────────────────────────────
  recModeLabelPrefix:   { en: 'Mode:', fa: 'حالت:' },
  stopAndSave:          { en: 'Stop & Save', fa: 'توقف و ذخیره' },

  // ── Popup — processing state ───────────────────────────────────
  stepTranscribe:       { en: 'Transcribing', fa: 'رونویسی' },
  stepAnalyze:          { en: 'Analysis', fa: 'تحلیل' },
  processingDefault:    { en: 'Processing…', fa: 'در حال پردازش…' },
  processingSaving:     { en: 'Saving recording…', fa: 'در حال ذخیره‌سازی ضبط…' },
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
  bgCancelledByUser:     { en: 'Cancelled by user', fa: 'لغو شد توسط کاربر' },
  bgWatchdogRecovered:   { en: 'Processing stopped (likely due to a browser restart). Please try again.', fa: 'پردازش متوقف شد (احتمالاً به دلیل ری‌استارت مرورگر). لطفاً دوباره تلاش کنید.' },
  bgMeetingDetectedTooltip: { en: 'Meeting detected — click the icon to record', fa: 'جلسه شناسایی شد — برای ضبط روی آیکون کلیک کنید' },
  bgNotifTitle:          { en: 'PechPech', fa: 'PechPech' },
  bgNotifBody:           { en: 'You joined a call — want to start recording?', fa: 'وارد کال شدی — ضبط رو شروع کنی؟' },

  // ── Settings page ────────────────────────────────────────────────
  settingsPageTitle:      { en: 'Settings — PechPech', fa: 'تنظیمات — PechPech' },
  settingsHeaderTitle:    { en: '🎙️ PechPech — Settings', fa: '🎙️ PechPech — تنظیمات' },
  settingsHeaderSub:      { en: 'Settings are stored only on this device and never leave it. No server — processing happens directly from the extension.',
                             fa: 'تنظیمات فقط در این دستگاه ذخیره می‌شوند و هرگز از آن خارج نمی‌شوند. بدون سرور — پردازش مستقیم از افزونه انجام می‌شود.' },
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
  apiUrlLabel:            { en: 'API base URL', fa: 'آدرس پایه API' },
  apiUrlHint:             { en: 'Compatible with the OpenAI Chat Completions API.', fa: 'سازگار با OpenAI Chat Completions API.' },
  modelNameLabel:         { en: 'Model name', fa: 'نام مدل' },
  modelDefaultHint:       { en: 'Default: <code>gpt-4o</code>', fa: 'پیش‌فرض: <code>gpt-4o</code>' },
  recordingCardTitle:     { en: 'Recording', fa: 'ضبط' },
  audioQualityLabel:      { en: 'Audio quality', fa: 'کیفیت صدا' },
  audioQualityStandardOpt: { en: 'Standard (64 kbps)', fa: 'استاندارد (64 kbps)' },
  audioQualityCompactOpt: { en: 'Compact (32 kbps)', fa: 'فشرده (32 kbps)' },
  audioQualityHint:       { en: "Applies to new recordings only. Standard gives the best transcription accuracy — up to about 28 MB per hour of meeting. Compact roughly halves the file (up to about 13 MB per hour) so long meetings upload faster on a slow connection and fit provider size limits (OpenAI: 25 MB), but may slightly reduce accuracy. A recording can't be improved after it's made.",
                             fa: 'فقط برای ضبط‌های جدید اعمال می‌شود. حالت استاندارد بهترین دقت رونویسی را دارد — حداکثر حدود ۲۸ مگابایت در هر ساعت جلسه. حالت فشرده حجم فایل را تقریباً نصف می‌کند (حداکثر حدود ۱۳ مگابایت در ساعت) تا جلسه‌های طولانی روی اینترنت کند سریع‌تر آپلود شوند و در محدودیت حجم سرویس‌ها (OpenAI: ۲۵ مگابایت) جا شوند، اما ممکن است دقت را کمی کم کند. کیفیت یک ضبط بعد از ضبط‌شدن قابل بهبود نیست.' },
  promptsCardTitle:       { en: 'Prompts', fa: 'پرامپت‌ها' },
  promptMomTitle:         { en: 'Meeting minutes (MOM) prompt', fa: 'پرامپت خلاصه جلسه (MOM)' },
  promptNotesTitle:       { en: 'Notes prompt', fa: 'پرامپت یادداشت‌ها' },
  promptCorrectionTitle:  { en: 'Transcript correction & speaker-separation prompt', fa: 'پرامپت اصلاح متن و تشخیص گوینده‌ها' },
  promptWarning:          { en: "Don't change lines starting with <code>##</code> or the <code>{{transcript}}</code> placeholder — otherwise the output won't parse correctly.",
                             fa: 'خطوط شروع‌شده با <code>##</code> و متن <code>{{transcript}}</code> را تغییر ندهید — در غیر این صورت خروجی درست پردازش نمی‌شود.' },
  promptOverrideHint:     { en: "This overrides the default prompt regardless of language — write it in whichever language you want the output to be, and make sure the section headings match exactly (## Summary / ## Decisions / ## Action Items, etc.).",
                             fa: 'این پرامپت جایگزین پیش‌فرض می‌شود، مستقل از زبان — آن را به هر زبانی که می‌خواهید خروجی باشد بنویسید و مطمئن شوید عنوان بخش‌ها دقیقاً مطابقت دارند (## Summary / ## Decisions / ## Action Items و مشابه).' },
  resetToDefault:         { en: 'Reset to default', fa: 'بازنشانی به پیش‌فرض' },
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

  // ── Onboarding ──────────────────────────────────────────────────
  onboardingPageTitle:    { en: 'PechPech — Setup', fa: 'PechPech — راه‌اندازی' },
  onboardingBrandSub:     { en: 'Automatically generate meeting minutes — no local server required.', fa: 'تولید خودکار صورت‌جلسه — بدون سرور محلی' },
  stepIntro:              { en: 'Intro', fa: 'معرفی' },
  stepHowItWorks:         { en: 'How it works', fa: 'نحوه کار' },
  stepSetup:              { en: 'Setup', fa: 'راه‌اندازی' },
  stepConnection:         { en: 'Connection', fa: 'اتصال' },
  stepStart:              { en: 'Start', fa: 'شروع' },
  introWelcomeTitle:      { en: 'Welcome to PechPech 👋', fa: 'به PechPech خوش آمدید 👋' },
  introWelcomeBody:       { en: 'An extension that records your online meetings and hands you ready-made meeting minutes without any note-taking. This version needs no local server — everything runs directly from your browser.',
                             fa: 'افزونه‌ای که جلسات آنلاین شما را ضبط می‌کند و بدون هیچ یادداشتی، صورت‌جلسه آماده تحویل می‌دهد. این نسخه هیچ سرور محلی نیاز ندارد — همه‌چیز مستقیماً از داخل مرورگر شما انجام می‌شود.' },
  feat1Title:             { en: 'Smart meeting recording', fa: 'ضبط هوشمند جلسه' },
  feat1Desc:               { en: 'Simultaneously records and mixes browser tab audio (Google Meet, Teams, Zoom Web) and your microphone. No extra software needed.',
                              fa: 'صدای تب مرورگر (Google Meet، Teams، Zoom Web) و میکروفون شما را همزمان ضبط و ترکیب می‌کند. هیچ نرم‌افزار جانبی لازم نیست.' },
  feat2Title:              { en: 'Local browser storage', fa: 'ذخیره‌سازی محلی در مرورگر' },
  feat2Desc:               { en: 'Recordings are stored directly in your browser storage (IndexedDB) — no files on disk and no intermediary server.',
                              fa: 'ضبط‌ها مستقیماً در حافظه مرورگر شما (IndexedDB) ذخیره می‌شوند — بدون فایل روی دیسک و بدون سرور واسط.' },
  feat3Title:              { en: 'Speech-to-text & meeting minutes', fa: 'تبدیل گفتار به متن و صورت‌جلسه' },
  feat3Desc:               { en: 'Audio is sent directly to an STT service (OpenAI Whisper or Gemini), then a language model writes the summary, decisions, and action items.',
                              fa: 'صدا مستقیماً به سرویس STT (OpenAI Whisper یا Gemini) ارسال می‌شود، سپس یک مدل زبانی خلاصه، تصمیمات و اقدامات را می‌نویسد.' },
  howItWorksTitle:        { en: 'How does it work?', fa: 'چطور کار می‌کند؟' },
  howItWorksSub:          { en: 'This version has no local server — the extension talks directly to the STT and LLM services:',
                             fa: 'در این نسخه هیچ سرور محلی وجود ندارد — افزونه مستقیماً با سرویس‌های STT و LLM ارتباط برقرار می‌کند:' },
  archFlowLabel:          { en: 'Processing flow — from recording to minutes:', fa: 'جریان پردازش — از ضبط تا صورت‌جلسه:' },
  archExt:                { en: 'Chrome<br/>Extension', fa: 'افزونه<br/>Chrome' },
  archExtLabel:           { en: 'Record + store locally', fa: 'ضبط + ذخیره محلی' },
  archStt:                { en: 'Whisper<br/>Service', fa: 'سرویس<br/>Whisper' },
  archSttLabel:           { en: 'Speech to text', fa: 'تبدیل به متن' },
  archLlm:                { en: 'Language<br/>Model', fa: 'مدل<br/>زبانی' },
  archLlmLabel:           { en: 'OpenAI / Gemini', fa: 'OpenAI / Gemini' },
  archOut:                { en: 'Meeting<br/>Minutes', fa: 'صورت‌<br/>جلسه' },
  archOutLabel:            { en: 'Markdown file', fa: 'فایل Markdown' },
  archArrowDirectApi:      { en: 'Direct API request', fa: 'درخواست مستقیم API' },
  archArrowTranscript:     { en: 'Meeting transcript', fa: 'متن جلسه' },
  archArrowFinalMom:       { en: 'Final minutes', fa: 'MOM نهایی' },
  setupHowStep1Title:      { en: 'Chrome Extension', fa: 'افزونه Chrome' },
  setupHowStep1Desc:       { en: 'Records the meeting audio and stores it directly in your browser storage (IndexedDB) — no server or file on disk involved.',
                              fa: 'صدای جلسه را ضبط و مستقیماً در حافظه مرورگر شما (IndexedDB) ذخیره می‌کند — هیچ سرور یا فایل روی دیسک درگیر نیست.' },
  setupHowStep2Title:      { en: 'Whisper STT', fa: 'Whisper STT' },
  setupHowStep2Desc:       { en: 'Audio is sent directly from the extension to OpenAI or Gemini and converted to text. Enter your API key in settings.',
                              fa: 'صدا مستقیماً از افزونه به OpenAI یا Gemini ارسال می‌شود و به متن تبدیل می‌گردد. کلید API را در تنظیمات وارد کنید.' },
  setupHowStep3Title:      { en: 'Language Model (LLM)', fa: 'مدل زبانی (LLM)' },
  setupHowStep3Desc:       { en: 'OpenAI or Gemini (recommended), or any OpenAI-compatible API. Analyzes the transcript and writes the minutes.',
                              fa: 'OpenAI یا Gemini (پیشنهادی)، یا هر API سازگار با OpenAI. متن جلسه را تحلیل و صورت‌جلسه می‌نویسد.' },
  setupPanelTitle:         { en: 'Initial setup', fa: 'راه‌اندازی اولیه' },
  setupPanelSub:           { en: "You just need an API key for STT and a key for the LLM — no server to install or run.",
                              fa: 'فقط کافی است یک کلید API برای STT و یک کلید برای LLM وارد کنید — نیازی به نصب یا اجرای هیچ سروری نیست.' },
  setupStep1Title:         { en: 'Get an API key', fa: 'یک کلید API تهیه کنید' },
  setupStep1Desc:          { en: 'Get a free/paid API key from <code>platform.openai.com</code> or <code>aistudio.google.com</code>.',
                              fa: 'از <code>platform.openai.com</code> یا <code>aistudio.google.com</code> یک کلید API رایگان/پولی بگیرید.' },
  setupStep2Title:         { en: 'Open the extension settings', fa: 'تنظیمات افزونه را باز کنید' },
  setupStep2Desc:          { en: 'Click "Open extension settings" below, choose your STT and LLM service, and enter the API key.',
                              fa: 'روی دکمه «باز کردن تنظیمات افزونه» زیر بزنید، سرویس STT و LLM را انتخاب کرده و کلید API را وارد کنید.' },
  setupStep3Title:         { en: 'Save', fa: 'ذخیره کنید' },
  setupStep3Desc:          { en: 'Click "Save settings". You\'re all set — move to the next step to check the connection.',
                              fa: 'روی «ذخیره تنظیمات» بزنید. آماده‌اید — به مرحله بعد بروید تا اتصال را بررسی کنیم.' },
  connectionPanelTitle:    { en: 'Check connection', fa: 'بررسی اتصال' },
  connectionPanelSub:      { en: "Let's make sure at least one STT key and one LLM key are set.", fa: 'بیایید مطمئن شویم حداقل یک کلید STT و یک کلید LLM تنظیم شده است.' },
  checkingConnection:      { en: 'Checking…', fa: 'در حال بررسی…' },
  checkingConfig:          { en: 'Checking settings…', fa: 'در حال بررسی تنظیمات…' },
  bothConfigured:          { en: 'STT and LLM are both configured ✓', fa: 'STT و LLM هر دو پیکربندی شده‌اند ✓' },
  allReadyBody:            { en: '<strong>Everything\'s ready!</strong><br/>You can move to the next step and record your first meeting.',
                              fa: '<strong>همه چیز آماده است!</strong><br/>می‌توانید به مرحله بعد بروید و اولین جلسه را ضبط کنید.' },
  missingKeyText:          { en: 'The {missing} key hasn\'t been set yet', fa: 'کلید {missing} هنوز تنظیم نشده است' },
  noKeysBody:              { en: '<strong>Haven\'t entered a key yet?</strong><br/>Click "Open extension settings", enter and save the STT and LLM keys,<br/>then click "Recheck".',
                              fa: '<strong>هنوز کلیدی وارد نکرده‌اید؟</strong><br/>روی «باز کردن تنظیمات افزونه» بزنید، کلید STT و LLM را وارد و ذخیره کنید،<br/>سپس دکمه «بررسی مجدد» را بزنید.' },
  recheck:                 { en: '↺ Recheck', fa: '↺ بررسی مجدد' },
  openExtensionSettings:   { en: '⚙ Open extension settings', fa: '⚙ باز کردن تنظیمات افزونه' },
  readyTitle:              { en: 'You\'re all set!', fa: 'آماده‌اید!' },
  readySub:                { en: 'PechPech is installed and waiting for your first meeting.', fa: 'PechPech نصب شده و منتظر اولین جلسه شماست.' },
  tip1:                    { en: 'On your next meeting, open the Google Meet or Teams tab, click the PechPech icon in the Chrome toolbar, and click <strong>Start Recording</strong>.',
                              fa: 'در جلسه بعدی، تب Google Meet یا Teams را باز کنید، روی آیکون PechPech در نوار Chrome کلیک کنید و <strong>شروع ضبط</strong> را بزنید.' },
  tip2:                    { en: 'At the end of the meeting, click <strong>Stop & Save</strong>. The audio file is stored right here in this browser.',
                              fa: 'در پایان جلسه <strong>توقف و ذخیره</strong> را بزنید. فایل صوتی مستقیماً در همین مرورگر ذخیره می‌شود.' },
  tip3:                    { en: 'Click <strong>Process</strong> and wait a few minutes. The final minutes (summary + decisions + action items) appear in the extension popup.',
                              fa: 'روی «پردازش» بزنید و چند دقیقه صبر کنید. صورت‌جلسه نهایی (خلاصه + تصمیمات + اقدامات) در پاپ‌آپ افزونه ظاهر می‌شود.' },
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
