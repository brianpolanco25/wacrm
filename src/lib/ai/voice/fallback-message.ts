/**
 * n15.1 (D3): the text the bot sends when it cannot transcribe a voice
 * note, asking the customer to type instead. The AI stays on.
 *
 * Same pattern as `DEFAULT_HANDOFF_MESSAGE` (../handoff-message.ts), and
 * for the same reasons English: three copies have to agree, pinned by
 * `fallback-message.test.ts` (R44):
 *   1. the `DEFAULT` of `ai_configs.voice_fallback_message` (migration 096);
 *   2. `Settings.aiConfig.voiceFallbackMessagePlaceholder` in
 *      `messages/en.json` ("e.g. " + this text);
 *   3. this constant — what the settings form pre-fills, so a first save
 *      doesn't overwrite the database default with an empty string.
 *
 * The form sends it through `handoffMessagePayload` (generic: untouched →
 * omitted, touched → trimmed, '' = deliberate opt-out).
 */
export const DEFAULT_VOICE_FALLBACK_MESSAGE =
  "Sorry, I can't listen to voice notes. Could you type your message, please?";
