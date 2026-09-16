import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  add: vi.fn(),
  remove: vi.fn(),
  dispatch: vi.fn(),
  emit: vi.fn(),
}));

vi.mock('./tag-write', () => ({
  addContactTagIfAbsent: mocks.add,
  removeContactTag: mocks.remove,
}));

vi.mock('@/lib/webhooks/emit', () => ({
  emitWebhookEvent: mocks.emit,
}));

vi.mock('@/lib/automations/engine', () => ({
  runAutomationsForTrigger: mocks.dispatch,
}));

import {
  addContactTagAndDispatch,
  removeContactTagAndDispatch,
  getTagChainDepth,
  MAX_TAG_CHAIN_DEPTH,
} from './tag-events';

const base = {
  db: {} as never,
  accountId: 'account-1',
  contactId: 'contact-1',
  tagId: 'tag-1',
};

beforeEach(() => {
  mocks.add.mockReset();
  mocks.remove.mockReset();
  mocks.remove.mockResolvedValue(true);
  mocks.dispatch.mockReset();
  mocks.dispatch.mockResolvedValue(undefined);
  mocks.emit.mockReset();
  mocks.emit.mockResolvedValue(undefined);
});

describe('addContactTagAndDispatch', () => {
  it('dispatches once for a newly inserted tag and propagates depth', async () => {
    mocks.add.mockResolvedValue(true);

    const result = await addContactTagAndDispatch({
      ...base,
      context: { vars: { source: 'flow', _tag_chain_depth: 1 } },
    });

    expect(result).toEqual({ added: true, dispatched: true });
    expect(mocks.dispatch).toHaveBeenCalledWith({
      accountId: 'account-1',
      triggerType: 'tag_added',
      contactId: 'contact-1',
      context: {
        tag_id: 'tag-1',
        vars: { source: 'flow', _tag_chain_depth: 2 },
      },
    });
  });

  it('does not dispatch when the tag already exists', async () => {
    mocks.add.mockResolvedValue(false);

    await expect(addContactTagAndDispatch(base)).resolves.toEqual({
      added: false,
      dispatched: false,
      reason: 'duplicate',
    });
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });

  it('adds the tag but cuts a chain at the configured depth limit', async () => {
    mocks.add.mockResolvedValue(true);

    await expect(
      addContactTagAndDispatch({
        ...base,
        context: { vars: { _tag_chain_depth: MAX_TAG_CHAIN_DEPTH } },
      })
    ).resolves.toEqual({
      added: true,
      dispatched: false,
      reason: 'max_depth',
    });
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });

  it('cuts an A-to-B-to-A tag chain before it can loop forever', async () => {
    mocks.add.mockResolvedValue(true);
    mocks.dispatch.mockImplementation(async (event) => {
      const nextTag = event.context.tag_id === 'tag-a' ? 'tag-b' : 'tag-a';
      await addContactTagAndDispatch({
        ...base,
        tagId: nextTag,
        context: event.context,
      });
    });

    await addContactTagAndDispatch({ ...base, tagId: 'tag-a' });

    expect(mocks.dispatch).toHaveBeenCalledTimes(MAX_TAG_CHAIN_DEPTH);
    expect(mocks.add).toHaveBeenCalledTimes(MAX_TAG_CHAIN_DEPTH + 1);
  });
});

describe('getTagChainDepth', () => {
  it('normalizes missing, invalid and fractional values', () => {
    expect(getTagChainDepth()).toBe(0);
    expect(getTagChainDepth({ vars: { _tag_chain_depth: '3' } })).toBe(0);
    expect(getTagChainDepth({ vars: { _tag_chain_depth: -1 } })).toBe(0);
    expect(getTagChainDepth({ vars: { _tag_chain_depth: 2.8 } })).toBe(2);
  });
});

// ============================================================
// Fase 7 §4 — el webhook sale de aquí y no de la ruta, porque por esta
// lib pasan el panel, la API pública y las automatizaciones.
// ============================================================

describe('webhooks de etiquetas', () => {
  it('emite contact.tag_added solo cuando el alta fue real', async () => {
    mocks.add.mockResolvedValue(true);
    await addContactTagAndDispatch(base);
    expect(mocks.emit).toHaveBeenCalledWith('account-1', 'contact.tag_added', {
      contact_id: 'contact-1',
      tag_id: 'tag-1',
    });
  });

  it('no emite nada si la etiqueta ya estaba puesta', async () => {
    mocks.add.mockResolvedValue(false);
    await addContactTagAndDispatch(base);
    expect(mocks.emit).not.toHaveBeenCalled();
  });

  it('emite contact.tag_removed al quitarla', async () => {
    await expect(removeContactTagAndDispatch(base)).resolves.toEqual({
      removed: true,
    });
    expect(mocks.remove).toHaveBeenCalledWith(base.db, {
      accountId: 'account-1',
      contactId: 'contact-1',
      tagId: 'tag-1',
    });
    expect(mocks.emit).toHaveBeenCalledWith(
      'account-1',
      'contact.tag_removed',
      { contact_id: 'contact-1', tag_id: 'tag-1' }
    );
  });

  // Fase 7 §2 — deuda que dejó la revisión de a7.4 (hallazgo 2). Es el
  // espejo exacto del caso `no emite nada si la etiqueta ya estaba
  // puesta` de arriba: si el DELETE no alcanzó ninguna fila, no hubo
  // cambio y no hay evento que anunciar.
  it('no emite contact.tag_removed si el DELETE no quitó ninguna fila', async () => {
    mocks.remove.mockResolvedValue(false);

    await expect(removeContactTagAndDispatch(base)).resolves.toEqual({
      removed: false,
      reason: 'absent',
    });
    expect(mocks.emit).not.toHaveBeenCalled();
  });

  it('un segundo DELETE seguido solo emite una vez', async () => {
    mocks.remove.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    await removeContactTagAndDispatch(base);
    await removeContactTagAndDispatch(base);

    expect(
      mocks.emit.mock.calls.filter((c) => c[1] === 'contact.tag_removed')
    ).toHaveLength(1);
  });

  it('no emite si el borrado falla', async () => {
    mocks.remove.mockRejectedValue(new Error('boom'));
    await expect(removeContactTagAndDispatch(base)).rejects.toThrow('boom');
    expect(mocks.emit).not.toHaveBeenCalled();
  });
});
