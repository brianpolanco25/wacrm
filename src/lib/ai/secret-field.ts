// ============================================================
// State machine for a "write-only secret" form field (the AI chat key
// and the embeddings key in Settings → AI).
//
// A stored key is never sent back to the browser: the form shows a mask
// and the API takes three-way input — a string sets it, an explicit
// `null` clears it, an absent field leaves it alone. Getting that third
// state right is the whole point of this module.
//
// The field has to tell two very different gestures apart:
//
//   - "the mask went away" — the input got focus, so the placeholder
//     was cleared to let the operator type. Nothing was decided yet.
//   - "forget my key" — an explicit action (the 'use the platform key'
//     link). Only this one may send `null`.
//
// Conflating them costs data: focusing the field, typing nothing and
// saving an unrelated toggle would wipe the account's provider key.
// Lives in lib/ (not in the component) because the repo has no jsdom or
// testing-library and adding one is out of scope — the component keeps
// no key decision of its own, it just renders this.
// ============================================================

/** Placeholder standing in for a stored key we are not allowed to show. */
export const MASKED_SECRET = '••••••••••••••••';

export interface SecretFieldState {
  /** Text currently in the input; `MASKED_SECRET` while hidden. */
  value: string;
  /** The operator typed in the field since it was (re)loaded. */
  typed: boolean;
  /** The operator explicitly asked to drop the stored secret. */
  clearRequested: boolean;
}

/** Fresh state after loading the config from the server. */
export function secretFieldLoaded(hasStored: boolean): SecretFieldState {
  return {
    value: hasStored ? MASKED_SECRET : '',
    typed: false,
    clearRequested: false,
  };
}

/**
 * The input got focus: drop the mask so the operator can type over it.
 * Deliberately does NOT count as an edit — this is the gesture that used
 * to be mistaken for "clear my key".
 */
export function secretFieldFocused(state: SecretFieldState): SecretFieldState {
  if (state.value !== MASKED_SECRET) return state;
  return { ...state, value: '' };
}

/** The operator typed. Typing cancels a pending clear request. */
export function secretFieldTyped(
  state: SecretFieldState,
  value: string
): SecretFieldState {
  return { value, typed: true, clearRequested: false };
}

/** The operator asked to forget the stored secret (explicit action). */
export function secretFieldCleared(): SecretFieldState {
  return { value: '', typed: false, clearRequested: true };
}

/**
 * What to send for this field:
 *   `null`      — an explicit clear was requested;
 *   `string`    — a non-empty value was typed;
 *   `undefined` — nothing was decided: leave the stored secret alone.
 *
 * Emptying the field after typing lands on `undefined`, not `null`:
 * deleting text is a change of mind, not a request to erase the key.
 */
export function secretFieldPayload(
  state: SecretFieldState
): string | null | undefined {
  if (state.clearRequested) return null;
  if (!state.typed) return undefined;
  return state.value.trim() || undefined;
}

/**
 * Will the account have a secret in this field once the form is saved?
 * Used for UI that depends on it (e.g. the knowledge card enabling
 * semantic search) without waiting for the round trip.
 */
export function secretFieldWillHaveValue(
  state: SecretFieldState,
  hasStored: boolean
): boolean {
  const payload = secretFieldPayload(state);
  if (payload === null) return false;
  if (payload === undefined) return hasStored;
  return true;
}
