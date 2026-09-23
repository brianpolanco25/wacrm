import type { DocsLocale } from '@/content/developers/types';

import { en } from './en';
import { es } from './es';
import type { LegalCatalogue, LegalDoc, LegalSlug } from './types';

const CATALOGUES: Record<DocsLocale, LegalCatalogue> = { es, en };

export function getLegalDoc(locale: DocsLocale, slug: LegalSlug): LegalDoc {
  return CATALOGUES[locale][slug];
}

export { LEGAL_ENTITY } from './entity';
export { LEGAL_SLUGS, type LegalSlug } from './types';
