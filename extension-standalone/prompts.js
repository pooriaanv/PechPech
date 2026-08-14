'use strict';

// prompts.js — ported verbatim from server/src/prompts.yaml (no wording
// changes) + server/src/pipeline.js's output parsers. No YAML parsing
// needed in the browser — these are just JS string literals.
//
// Two rules carried over from prompts.yaml's own header comment:
//   1. Keep the ## section headings exactly as written — parsers below
//      match them.
//   2. {{transcript}} is replaced with the transcript text.

const MOM_PROMPT = `You will receive a transcript of a meeting between multiple speakers. The transcript was produced automatically by a speech-to-text system, so it may contain errors: misheard words, phonetically similar substitutions, garbled proper nouns, missing punctuation, or run-on words.

Before generating the minutes, carefully read the transcript and use context clues from surrounding sentences to infer the intended meaning. Correct any STT errors you are confident about — wrong words, misheard technical terms, garbled names. If a phrase is genuinely unclear and you cannot confidently correct it, leave it as-is rather than guessing.
Analyze the conversation flow — question/answer pairs, topic shifts, changes in speaking style, discourse markers, and logical turn-taking — to detect when a different person is speaking.

Produce your response with exactly THREE sections in this order, using these exact headings:

## خلاصه
A concise overview of what was discussed.

## تصمیمات
Concrete decisions that were made during the meeting. If none were made, state that explicitly.

## اقدامات
Concrete next steps or tasks, including the owner's name if mentioned and any deadline if mentioned. If none, state that explicitly.

Keep the entire output in Persian.

Do not include any content outside these three sections.

Transcript:
{{transcript}}`;

const NOTES_PROMPT = `You will receive a transcript of a single person speaking their thoughts aloud. The transcript was produced automatically by a speech-to-text system and may contain errors.

Your job is to extract each distinct thought, task, idea, reminder, observation, or question as a separate note item. Think of yourself as a human note-taker listening to someone speak — you jot down each item on its own line, in the order it was said, without rewriting or summarising.

Rules:
- Write each item as a short, natural Persian phrase on its own line, starting with "- ".
- Tasks and to-dos: use imperative form (e.g. "- تماس با احمد").
- Ideas, observations: use declarative form (e.g. "- ایده: استفاده از رنگ آبی در طراحی").
- Open questions: use interrogative form (e.g. "- بررسی کنم که آیا قرارداد تمدید می‌شود؟").
- Preserve the original order of speech. Do not reorder or group items.
- Omit filler words, false starts, and repetitions.
- Merge sub-thoughts into one bullet only if they clearly form a single unified item.
- Fix obvious STT errors using context clues, but do not paraphrase or formalize the speaker's words.
- Produce exactly one section with this exact heading, followed by the bulleted list:

## یادداشت‌ها

- If nothing can be extracted from the transcript, output exactly:

## یادداشت‌ها
- (موردی یافت نشد)

Keep the entire output in Persian. Do not include any content outside the ## یادداشت‌ها section.

Transcript:
{{transcript}}`;

const CORRECTION_PROMPT = `You will receive a raw meeting transcript produced by a speech-to-text system.
It may contain errors: misheard words, phonetically similar substitutions,
garbled proper nouns, missing punctuation.

Produce a single section with this exact heading:

## متن اصلاح‌شده
1. Fix STT errors: correct misheard words, garbled terms, or wrong words where you are
   confident based on context. Leave genuinely unclear phrases as-is.
2. Identify speaker turns: start each new speaker turn on a new line with "گوینده ۱:",
   "گوینده ۲:", etc. Use their real name if mentioned. Omit labels if it is clearly
   a single speaker throughout.

Keep the output in Persian. Do not add any content outside this section.

Transcript:
{{transcript}}`;

// ── Prompt builders ────────────────────────────────────────────────

function buildMOMPrompt(transcript, customTemplate) {
  return (customTemplate || MOM_PROMPT).replace('{{transcript}}', transcript);
}

function buildNotesPrompt(transcript, customTemplate) {
  return (customTemplate || NOTES_PROMPT).replace('{{transcript}}', transcript);
}

function buildCorrectionPrompt(transcript, customTemplate) {
  return (customTemplate || CORRECTION_PROMPT).replace('{{transcript}}', transcript);
}

// ── Output parsers (ported verbatim from pipeline.js) ─────────────

function parseMOMOutput(text) {
  const normalized = text.replace(/\r\n/g, '\n').trim();
  const patterns = [
    { key: 'summary',      regex: /##\s*خلاصه[^\n]*\n([\s\S]*?)(?=##|$)/i      },
    { key: 'decisions',    regex: /##\s*تصمیمات[^\n]*\n([\s\S]*?)(?=##|$)/i    },
    { key: 'action_items', regex: /##\s*اقدامات[^\n]*\n([\s\S]*?)(?=##|$)/i    },
  ];

  const result = {};
  let anyFound = false;

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

function parseNotesOutput(text) {
  const normalized = text.replace(/\r\n/g, '\n').trim();
  const match      = normalized.match(/##\s*یادداشت‌ها[^\n]*\n([\s\S]*)/i);
  const raw        = match ? match[1].trim() : normalized;
  const lines      = raw
    .split('\n')
    .map(l => l.replace(/^[\s\-•*]+/, '').trim())
    .filter(Boolean);
  return lines.join('\n');
}

function parseCorrectionOutput(text) {
  const match = text.match(/##\s*متن اصلاح[^\n]*\n([\s\S]*)/i);
  return match ? match[1].trim() : text.trim();
}

export {
  MOM_PROMPT,
  NOTES_PROMPT,
  CORRECTION_PROMPT,
  buildMOMPrompt,
  buildNotesPrompt,
  buildCorrectionPrompt,
  parseMOMOutput,
  parseNotesOutput,
  parseCorrectionOutput,
};
