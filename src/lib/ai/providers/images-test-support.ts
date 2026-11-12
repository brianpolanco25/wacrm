/**
 * Test support de los adaptadores multimodales (n15.2). Solo lo importan
 * archivos `*.images.test.ts`.
 */
import type { ChatImage, ChatMessage } from '../types';

export const IMG1: ChatImage = { mimeType: 'image/jpeg', data: 'SU1HMQ==' };
export const IMG2: ChatImage = { mimeType: 'image/png', data: 'SU1HMg==' };

/** Leading assistant greeting, a text turn merged with an image turn, an
 *  assistant turn carrying (ignored) images, and a final image turn. */
export const IMAGE_TRANSCRIPT: ChatMessage[] = [
  { role: 'assistant', content: 'Hola' },
  { role: 'user', content: 'quiero cita' },
  {
    role: 'user',
    content: '[imagen] mi cédula',
    image: { playground: true },
    images: [IMG1],
  },
  { role: 'assistant', content: 'gracias', images: [IMG2] },
  {
    role: 'user',
    content: '[imagen]',
    image: { messageId: 'm2', mediaUrl: null, mediaType: 'image/png' },
    images: [IMG2],
  },
];

export const TEXT_TRANSCRIPT: ChatMessage[] = [
  { role: 'user', content: 'hola' },
  { role: 'assistant', content: 'ok' },
  { role: 'user', content: 'cita', voice: true },
];
