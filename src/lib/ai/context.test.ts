import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { buildConversationContext } from './context'

/** Minimal fake matching the query chain in buildConversationContext:
 *  from().select().eq().in().or().order().limit() → { data, error }.
 *  `calls` records the filters (n15.1). */
function fakeDb(rows: unknown[], calls: unknown[][] = []): SupabaseClient {
  const chain = {
    from: () => chain,
    select: (...a: unknown[]) => (calls.push(['select', ...a]), chain),
    eq: (...a: unknown[]) => (calls.push(['eq', ...a]), chain),
    in: (...a: unknown[]) => (calls.push(['in', ...a]), chain),
    or: (...a: unknown[]) => (calls.push(['or', ...a]), chain),
    order: () => chain,
    limit: () => Promise.resolve({ data: rows, error: null }),
  }
  return chain as unknown as SupabaseClient
}

describe('buildConversationContext', () => {
  it('maps sender_type to role and returns chronological order', async () => {
    // DB returns newest-first (created_at DESC); the fn reverses it.
    const rows = [
      { sender_type: 'customer', content_text: 'third' },
      { sender_type: 'agent', content_text: 'second' },
      { sender_type: 'customer', content_text: 'first' },
    ]
    const out = await buildConversationContext(fakeDb(rows), 'conv-1')
    expect(out).toEqual([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'second' },
      { role: 'user', content: 'third' },
    ])
  })

  it('treats bot messages as assistant', async () => {
    const out = await buildConversationContext(
      fakeDb([{ sender_type: 'bot', content_text: 'auto reply' }]),
      'conv-1',
    )
    expect(out).toEqual([{ role: 'assistant', content: 'auto reply' }])
  })

  it('drops empty / whitespace-only messages', async () => {
    const out = await buildConversationContext(
      fakeDb([
        { sender_type: 'customer', content_text: '   ' },
        { sender_type: 'customer', content_text: null },
        { sender_type: 'customer', content_text: 'real' },
      ]),
      'conv-1',
    )
    expect(out).toEqual([{ role: 'user', content: 'real' }])
  })
})

describe('buildConversationContext — voice notes (n15.1, R25)', () => {
  it('asks for text plus transcribed audio only', async () => {
    const calls: unknown[][] = []
    await buildConversationContext(fakeDb([], calls), 'conv-1')
    expect(calls).toContainEqual(['eq', 'conversation_id', 'conv-1'])
    // n15.2 (design §4) widened both filters to `image`; the audio rule —
    // only `transcript_status = done` — is unchanged.
    expect(calls).toContainEqual([
      'in',
      'content_type',
      ['text', 'audio', 'image'],
    ])
    expect(calls).toContainEqual([
      'or',
      'content_type.eq.text,content_type.eq.image,transcript_status.eq.done',
    ])
  })

  it('maps a transcribed customer voice note to a marked user turn', async () => {
    const out = await buildConversationContext(
      fakeDb([
        {
          sender_type: 'customer',
          content_type: 'audio',
          content_text: null,
          transcript: 'tienen cita el jueves',
          transcript_status: 'done',
        },
        { sender_type: 'bot', content_type: 'text', content_text: 'Hola' },
      ]),
      'conv-1',
    )
    expect(out).toEqual([
      { role: 'assistant', content: 'Hola' },
      {
        role: 'user',
        content: '[nota de voz] tienen cita el jueves',
        voice: true,
      },
    ])
  })

  it('drops audio without a done transcript, and agent/bot audio', async () => {
    const out = await buildConversationContext(
      fakeDb([
        {
          sender_type: 'customer',
          content_type: 'audio',
          content_text: null,
          transcript: null,
          transcript_status: 'failed',
        },
        {
          sender_type: 'agent',
          content_type: 'audio',
          content_text: null,
          transcript: 'x',
          transcript_status: 'done',
        },
        { sender_type: 'customer', content_type: 'text', content_text: 'hola' },
      ]),
      'conv-1',
    )
    expect(out).toEqual([{ role: 'user', content: 'hola' }])
  })
})

describe('buildConversationContext — customer images (n15.2)', () => {
  const ref = (id: string, mediaUrl: string | null = 'u', mediaType = 'image/jpeg') => ({
    messageId: id,
    mediaUrl,
    mediaType,
  })

  it('selects id, media_url and media_type (R6)', async () => {
    const calls: unknown[][] = []
    await buildConversationContext(fakeDb([], calls), 'conv-1')
    const select = calls.find((c) => c[0] === 'select')?.[1] as string
    for (const col of ['id', 'media_url', 'media_type', 'content_type']) {
      expect(select.split(/,\s*/)).toContain(col)
    }
  })

  it('maps a customer image without and with caption to an unavailable user turn (R6, R37)', async () => {
    const out = await buildConversationContext(
      fakeDb([
        {
          id: 'm2',
          sender_type: 'customer',
          content_type: 'image',
          content_text: '  esta es mi cédula ',
          media_url: 'u',
          media_type: 'image/jpeg',
        },
        {
          id: 'm1',
          sender_type: 'customer',
          content_type: 'image',
          content_text: null,
          media_url: null,
          media_type: 'image/jpeg',
        },
      ]),
      'conv-1',
    )
    expect(out).toEqual([
      { role: 'user', content: '[imagen no disponible]', image: ref('m1', null) },
      {
        role: 'user',
        content: '[imagen no disponible] esta es mi cédula',
        image: ref('m2'),
      },
    ])
  })

  it('drops agent/bot images and stickers (R7)', async () => {
    const out = await buildConversationContext(
      fakeDb([
        {
          id: 's1',
          sender_type: 'customer',
          content_type: 'image',
          content_text: null,
          media_url: 'u',
          media_type: 'image/webp',
        },
        {
          id: 'a1',
          sender_type: 'agent',
          content_type: 'image',
          content_text: 'catálogo',
          media_url: 'u',
          media_type: 'image/jpeg',
        },
        {
          id: 'b1',
          sender_type: 'bot',
          content_type: 'image',
          content_text: null,
          media_url: 'u',
          media_type: 'image/png',
        },
        { sender_type: 'customer', content_type: 'text', content_text: 'hola' },
      ]),
      'conv-1',
    )
    expect(out).toEqual([{ role: 'user', content: 'hola' }])
  })

  it('keeps chronological order mixed with text and voice notes (R6)', async () => {
    const out = await buildConversationContext(
      fakeDb([
        { sender_type: 'bot', content_type: 'text', content_text: 'Gracias' },
        {
          id: 'm1',
          sender_type: 'customer',
          content_type: 'image',
          content_text: null,
          media_url: 'u',
          media_type: 'image/jpeg; charset=binary',
        },
        {
          sender_type: 'customer',
          content_type: 'audio',
          content_text: null,
          transcript: 'te mando la cédula',
          transcript_status: 'done',
        },
        { sender_type: 'customer', content_type: 'text', content_text: 'hola' },
      ]),
      'conv-1',
    )
    expect(out).toEqual([
      { role: 'user', content: 'hola' },
      { role: 'user', content: '[nota de voz] te mando la cédula', voice: true },
      {
        role: 'user',
        content: '[imagen no disponible]',
        image: ref('m1', 'u', 'image/jpeg; charset=binary'),
      },
      { role: 'assistant', content: 'Gracias' },
    ])
  })
})
