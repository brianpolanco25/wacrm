import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '../types';
import type { VoiceNoteStorage } from '../voice/audio-source';
import { hydrateConversationImages } from './hydrate';
import type { loadInboundImage } from './image-source';

const SECRET_B64 = 'U0VDUkVUX0lNQUdFX0JZVEVT';
const storage = { from: vi.fn() } as unknown as VoiceNoteStorage;
const ok = {
  ok: true as const,
  image: { mimeType: 'image/jpeg' as const, data: SECRET_B64 },
};

const imageTurn = (id: string, caption = ''): ChatMessage => ({
  role: 'user',
  content: caption
    ? `[imagen no disponible] ${caption}`
    : '[imagen no disponible]',
  image: { messageId: id, mediaUrl: `url-${id}`, mediaType: 'image/jpeg' },
});

type Load = typeof loadInboundImage;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('hydrateConversationImages (R9)', () => {
  it('attaches only the 3 most recent of 5 images', async () => {
    const load = vi.fn<Load>(async () => ok);
    const messages: ChatMessage[] = [
      imageTurn('m1'),
      { role: 'assistant', content: 'ok' },
      imageTurn('m2', 'dos'),
      imageTurn('m3'),
      { role: 'user', content: 'texto' },
      imageTurn('m4', 'cuatro'),
      imageTurn('m5'),
    ];
    const out = await hydrateConversationImages(messages, {
      accountId: 'A',
      storage,
      load,
      maxPerTurn: 3,
    });
    expect(load).toHaveBeenCalledTimes(3);
    expect(load.mock.calls.map((c) => c[0].mediaUrl).sort()).toEqual([
      'url-m3',
      'url-m4',
      'url-m5',
    ]);
    expect(out.attached).toBe(3);
    expect(out.unavailable).toBe(2);
    expect(out.messages.map((m) => m.content)).toEqual([
      '[imagen no disponible]',
      'ok',
      '[imagen no disponible] dos',
      '[imagen]',
      'texto',
      '[imagen] cuatro',
      '[imagen]',
    ]);
    expect(out.messages[0].images).toBeUndefined();
    expect(out.messages[6].images).toEqual([ok.image]);
  });

  it('maxPerTurn 0 → no load at all, everything unavailable', async () => {
    const load = vi.fn<Load>(async () => ok);
    const out = await hydrateConversationImages([imageTurn('m1')], {
      accountId: 'A',
      storage,
      load,
      maxPerTurn: 0,
    });
    expect(load).not.toHaveBeenCalled();
    expect(out.messages).toEqual([imageTurn('m1')]);
    expect(out.unavailable).toBe(1);
  });

  it('passes the Meta source only to the current inbound turn (R12)', async () => {
    const load = vi.fn<Load>(async () => ok);
    const source = { metaMediaId: 'meta-1', accessToken: 'tok' };
    await hydrateConversationImages([imageTurn('m1'), imageTurn('m2')], {
      accountId: 'A',
      storage,
      load,
      maxPerTurn: 3,
      inbound: { messageId: 'm2', source },
    });
    const byUrl = Object.fromEntries(
      load.mock.calls.map((c) => [c[0].mediaUrl, c[0].source])
    );
    expect(byUrl['url-m2']).toEqual(source);
    expect(byUrl['url-m1']).toBeUndefined();
  });

  it('a failed or throwing load leaves that turn unavailable, others load (R14)', async () => {
    const load = vi.fn<Load>(async ({ mediaUrl }) => {
      if (mediaUrl === 'url-m1') return { ok: false, reason: 'timeout' };
      if (mediaUrl === 'url-m2') throw new Error('boom');
      return ok;
    });
    const out = await hydrateConversationImages(
      [imageTurn('m1'), imageTurn('m2'), imageTurn('m3')],
      { accountId: 'A', storage, load, maxPerTurn: 3 }
    );
    expect(out.messages.map((m) => m.content)).toEqual([
      '[imagen no disponible]',
      '[imagen no disponible]',
      '[imagen]',
    ]);
    expect(out.attached).toBe(1);
  });

  it('does not mutate its input and ignores non-row image turns', async () => {
    const load = vi.fn<Load>(async () => ok);
    const input: ChatMessage[] = [
      { role: 'user', content: '[imagen]', image: { playground: true } },
      imageTurn('m1'),
    ];
    const snapshot = structuredClone(input);
    const out = await hydrateConversationImages(input, {
      accountId: 'A',
      storage,
      load,
      maxPerTurn: 3,
    });
    expect(input).toEqual(snapshot);
    expect(out.messages).not.toBe(input);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('never logs the base64 (R28)', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map(
      (k) => vi.spyOn(console, k).mockImplementation(() => {})
    );
    const load = vi.fn<Load>(async ({ mediaUrl }) =>
      mediaUrl === 'url-m1' ? { ok: false, reason: 'forbidden_path' } : ok
    );
    await hydrateConversationImages([imageTurn('m1'), imageTurn('m2')], {
      accountId: 'A',
      storage,
      load,
      maxPerTurn: 3,
    });
    const logged = JSON.stringify(spies.flatMap((s) => s.mock.calls));
    expect(logged).not.toContain(SECRET_B64);
    expect(logged).toContain('forbidden_path');
    expect(logged).toContain('m1');
  });
});
