/**
 * The transition message the bot sends right before it hands a chat to a
 * human (fase 1, §2 of `docs/saas/fase-1-bandeja.md`).
 *
 * Three copies of this sentence have to agree, so they live here and are
 * pinned by `handoff-message.test.ts`:
 *   1. the `DEFAULT` of `ai_configs.handoff_message` (migration 043) —
 *      what an account gets without touching Settings → AI;
 *   2. `Settings.aiConfig.handoffMessagePlaceholder` in `messages/en.json`
 *      — the hint under the textarea;
 *   3. this constant — what the settings form pre-fills for an account
 *      that has no config row yet, so a first save doesn't silently
 *      overwrite the database default with an empty string.
 *
 * English on purpose: the product ships `en` and `ko` catalogues, `en` is
 * the default locale, and seeding a language the interface doesn't offer
 * would leave an account texting its customers something it can't read in
 * its own panel. Accounts that want another language (or silence) edit
 * the field; an empty value is an explicit "say nothing".
 */
export const DEFAULT_HANDOFF_MESSAGE =
  'Thanks for writing to us. A member of our team will continue this conversation shortly.';

/**
 * What the settings form should send for `handoff_message`.
 *
 * Mirrors how the form treats `api_key`: `undefined` means "the user
 * didn't touch this field, leave it alone" and the route omits the column
 * from the write, so the database default (or whatever the account saved
 * earlier) survives. A touched field is sent as-is — including the empty
 * string, which the route stores as a deliberate opt-out.
 *
 * The distinction matters on a *first* save: sending `''` there would
 * persist an opt-out nobody chose and the seeded default would never
 * reach a new account.
 */
export function handoffMessagePayload(args: {
  edited: boolean;
  value: string;
}): string | undefined {
  return args.edited ? args.value.trim() : undefined;
}
