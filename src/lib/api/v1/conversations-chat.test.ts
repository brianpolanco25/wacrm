import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { FakeDatabase } from '@/lib/security/fake-supabase';
import type { Message } from '@/types';
import {
  serializeMessage,
  serializeMessagesWithMedia,
  serviceWindowExpiresAt,
} from './conversations';

// n15.5: remitente, URL firmada de adjuntos y ventana de 24 h.

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const db = new FakeDatabase({}).admin as unknown as SupabaseClient;

const url = (account: string, name = 'foto.jpg') =>
  `https://fake.supabase.co/storage/v1/object/public/chat-media/account-${account}/${name}`;

const msg = (over: Partial<Message>): Message =>
  ({
    id: 'm1',
    conversation_id: 'c1',
    sender_type: 'agent',
    content_type: 'image',
    status: 'sent',
    created_at: '2026-01-01T00:00:00Z',
    ...over,
  }) as Message;

describe('serializeMessage', () => {
  it('sender_member_id solo para agentes', () => {
    expect(serializeMessage(msg({ sender_id: 'u1' })).sender_member_id).toBe(
      'u1'
    );
    expect(
      serializeMessage(msg({ sender_type: 'customer', sender_id: 'u1' }))
        .sender_member_id
    ).toBeNull();
    expect(serializeMessage(msg({})).sender_member_id).toBeNull();
  });
});

describe('serializeMessagesWithMedia', () => {
  // signMessageMedia solo acepta URLs del origen de Supabase del entorno
  // (NEXT_PUBLIC_SUPABASE_URL). CI lo define con otro host; fijarlo aquí
  // al host del fake hace el test independiente del entorno.
  beforeEach(() => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://fake.supabase.co');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('firma el adjunto propio con mime y nombre, y conserva media_url', async () => {
    const [out] = await serializeMessagesWithMedia(db, A, [
      msg({ media_url: url(A), media_type: 'image/jpeg' }),
    ]);
    expect(out.media_url).toBe(url(A));
    expect(out.media).toMatchObject({
      mime_type: 'image/jpeg',
      filename: 'foto.jpg',
    });
    expect(out.media?.url).toContain('/object/sign/chat-media/');
    expect(Date.parse(out.media!.expires_at)).toBeGreaterThan(Date.now());
  });

  it('no firma objetos de otra cuenta, enlaces externos ni otros buckets', async () => {
    const out = await serializeMessagesWithMedia(db, A, [
      msg({ media_url: url(B) }),
      msg({ media_url: 'https://example.com/a.jpg' }),
      msg({
        media_url:
          'https://fake.supabase.co/storage/v1/object/public/otro-bucket/x.jpg',
      }),
      msg({}),
    ]);
    expect(out.map((m) => m.media)).toEqual([null, null, null, null]);
  });
});

describe('serviceWindowExpiresAt', () => {
  it('suma 24 h al último entrante, o null', () => {
    expect(serviceWindowExpiresAt('2026-03-01T10:00:00.000Z')).toBe(
      '2026-03-02T10:00:00.000Z'
    );
    expect(serviceWindowExpiresAt(null)).toBeNull();
    expect(serviceWindowExpiresAt('basura')).toBeNull();
  });
});
