import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * p11.2: a plan's messages are what it includes, not a wall. No string
 * of either catalogue may present them as a cap. The list is short on
 * purpose (agreed in progress/impl_pricing-texts-kb.md): it targets the
 * phrasings that frame messages as a maximum, not every use of «límite»
 * (an image size limit or «Sin límite» are fine).
 */

const FORBIDDEN: Record<'es' | 'en', RegExp[]> = {
  es: [
    /límite máximo/i,
    /máximo de mensajes/i,
    /límite de mensajes/i,
    /tope de mensajes/i,
    /mensajes como máximo/i,
    /hasta \S+ mensajes/i,
  ],
  en: [
    /maximum (number of )?messages/i,
    /message (limit|cap)/i,
    /messages limit/i,
    /up to \S+ messages/i,
    /raise this limit/i,
  ],
};

function leaves(node: unknown, path = ''): [string, string][] {
  if (typeof node === 'string') return [[path, node]];
  if (node && typeof node === 'object') {
    return Object.entries(node).flatMap(([k, v]) =>
      leaves(v, path ? `${path}.${k}` : k)
    );
  }
  return [];
}

describe('plan messages are worded as included, not as a cap', () => {
  for (const locale of ['es', 'en'] as const) {
    it(`messages/${locale}.json has none of the forbidden phrasings`, () => {
      const catalogue = JSON.parse(
        readFileSync(join(process.cwd(), 'messages', `${locale}.json`), 'utf8')
      );
      const hits = leaves(catalogue).filter(([, text]) =>
        FORBIDDEN[locale].some((re) => re.test(text))
      );
      expect(hits).toEqual([]);
    });
  }
});
