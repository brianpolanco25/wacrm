import { describe, expect, it } from 'vitest';

import {
  MASKED_SECRET,
  secretFieldCleared,
  secretFieldFocused,
  secretFieldLoaded,
  secretFieldPayload,
  secretFieldTyped,
  secretFieldWillHaveValue,
  type SecretFieldState,
} from './secret-field';

// This module is the whole decision surface of the two masked key
// inputs in `src/components/settings/ai-config.tsx`: the component only
// wires `onFocus`/`onChange`/the links to these transitions and sends
// `secretFieldPayload(...)` in the body. There is no jsdom or
// testing-library in this repo (and no new dependencies allowed), so the
// gestures are replayed here in the same order the DOM would fire them.

/** What `buildBody()` in the settings form ends up putting on the wire. */
function wireBody(state: SecretFieldState) {
  return JSON.parse(
    JSON.stringify({
      system_prompt: 'a new prompt',
      api_key: secretFieldPayload(state),
    })
  ) as Record<string, unknown>;
}

describe('secretFieldPayload', () => {
  it('leaves the stored key alone when the field was only focused (no typing)', () => {
    // The regression this module exists for: clicking or tabbing into
    // the key field clears the mask so you can type. That is not a
    // request to delete the account's provider key.
    let state = secretFieldLoaded(true);
    expect(state.value).toBe(MASKED_SECRET);

    state = secretFieldFocused(state);
    expect(state.value).toBe('');
    expect(state.clearRequested).toBe(false);
    expect(secretFieldPayload(state)).toBeUndefined();
  });

  it('keeps api_key out of the body when a focused-but-untouched field is saved with another change', () => {
    const state = secretFieldFocused(secretFieldLoaded(true));
    const body = wireBody(state);
    expect('api_key' in body).toBe(false);
    expect(body).toEqual({ system_prompt: 'a new prompt' });
  });

  it('sends the typed key', () => {
    let state = secretFieldFocused(secretFieldLoaded(true));
    state = secretFieldTyped(state, '  sk-new  ');
    expect(secretFieldPayload(state)).toBe('sk-new');
    expect(wireBody(state).api_key).toBe('sk-new');
  });

  it('treats deleting what you typed as a change of mind, not as "erase my key"', () => {
    let state = secretFieldFocused(secretFieldLoaded(true));
    state = secretFieldTyped(state, 'sk-half');
    state = secretFieldTyped(state, '');
    expect(secretFieldPayload(state)).toBeUndefined();
    expect('api_key' in wireBody(state)).toBe(false);
  });

  it('sends null only on an explicit clear request', () => {
    const state = secretFieldCleared();
    expect(state.clearRequested).toBe(true);
    expect(secretFieldPayload(state)).toBeNull();
    expect(wireBody(state).api_key).toBeNull();
  });

  it('cancels a pending clear as soon as a new key is typed', () => {
    let state = secretFieldCleared();
    state = secretFieldTyped(state, 'sk-changed-my-mind');
    expect(state.clearRequested).toBe(false);
    expect(secretFieldPayload(state)).toBe('sk-changed-my-mind');
  });

  it('restores the mask when the clear request is undone', () => {
    const state = secretFieldLoaded(true);
    expect(secretFieldPayload(secretFieldCleared())).toBeNull();
    expect(secretFieldPayload(state)).toBeUndefined();
    expect(state.value).toBe(MASKED_SECRET);
  });

  it('does not re-mask a field that is already being edited', () => {
    let state = secretFieldTyped(secretFieldLoaded(true), 'sk-typing');
    state = secretFieldFocused(state);
    expect(state.value).toBe('sk-typing');
    expect(secretFieldPayload(state)).toBe('sk-typing');
  });

  it('sends nothing from an untouched field on an account with no stored key', () => {
    const state = secretFieldLoaded(false);
    expect(state.value).toBe('');
    expect(secretFieldPayload(state)).toBeUndefined();
  });
});

// The settings form gates the save on the payload alone:
//   - a first save with `undefined` and no platform key is refused;
//   - an explicit `null` with no platform key is refused;
//   - anything else goes through.
// A focused-but-untouched field must land on the "goes through" side,
// or turning the assistant off would be impossible until a reload.
function saveBlocked(
  state: SecretFieldState,
  { configured, platformKey }: { configured: boolean; platformKey: boolean }
) {
  const key = secretFieldPayload(state);
  if (!configured && key === undefined && !platformKey) return true;
  if (key === null && !platformKey) return true;
  return false;
}

describe('save guards', () => {
  it('does not block a save after focusing the key field on a deployment with no platform key', () => {
    const state = secretFieldFocused(secretFieldLoaded(true));
    expect(saveBlocked(state, { configured: true, platformKey: false })).toBe(
      false
    );
  });

  it('still asks for a key on a first save with nothing typed and no platform key', () => {
    const state = secretFieldLoaded(false);
    expect(saveBlocked(state, { configured: false, platformKey: false })).toBe(
      true
    );
    expect(saveBlocked(state, { configured: false, platformKey: true })).toBe(
      false
    );
  });

  it('refuses to drop the stored key when there is no platform key to land on', () => {
    const state = secretFieldCleared();
    expect(saveBlocked(state, { configured: true, platformKey: false })).toBe(
      true
    );
    expect(saveBlocked(state, { configured: true, platformKey: true })).toBe(
      false
    );
  });
});

describe('secretFieldWillHaveValue', () => {
  it('follows the pending decision, falling back to what is stored', () => {
    const loaded = secretFieldLoaded(true);
    expect(secretFieldWillHaveValue(loaded, true)).toBe(true);
    // Focus alone must not make the knowledge card think the embeddings
    // key is about to disappear.
    expect(secretFieldWillHaveValue(secretFieldFocused(loaded), true)).toBe(
      true
    );
    expect(secretFieldWillHaveValue(secretFieldCleared(), true)).toBe(false);
    expect(
      secretFieldWillHaveValue(secretFieldTyped(loaded, 'sk-x'), false)
    ).toBe(true);
    expect(secretFieldWillHaveValue(secretFieldLoaded(false), false)).toBe(
      false
    );
  });
});
