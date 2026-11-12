import { describe, it, expect } from 'vitest'
import { latestUserMessage } from './query'

describe('latestUserMessage', () => {
  it('returns the most recent user turn', () => {
    expect(
      latestUserMessage([
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'reply' },
        { role: 'user', content: 'latest' },
      ]),
    ).toBe('latest')
  })

  it('falls back to the last message when none are user', () => {
    expect(
      latestUserMessage([{ role: 'assistant', content: 'only assistant' }]),
    ).toBe('only assistant')
  })

  it('returns empty string for no messages', () => {
    expect(latestUserMessage([])).toBe('')
  })

  it('strips the voice-note marker from a voice turn (n15.1, R27)', () => {
    expect(
      latestUserMessage([
        { role: 'user', content: '[nota de voz] cita el jueves', voice: true },
      ]),
    ).toBe('cita el jueves')
  })

  it('keeps a typed "[nota de voz]" prefix on a non-voice turn', () => {
    expect(
      latestUserMessage([{ role: 'user', content: '[nota de voz] hola' }]),
    ).toBe('[nota de voz] hola')
  })

  it('returns the caption of an image turn without its marker (n15.2, R15)', () => {
    const image = { messageId: 'm1', mediaUrl: null, mediaType: 'image/jpeg' }
    expect(
      latestUserMessage([
        { role: 'user', content: '[imagen] mi cédula', image },
      ]),
    ).toBe('mi cédula')
    expect(
      latestUserMessage([
        { role: 'user', content: '[imagen no disponible] mi carnet', image },
      ]),
    ).toBe('mi carnet')
    expect(
      latestUserMessage([{ role: 'user', content: '[imagen]', image }]),
    ).toBe('')
  })
})
