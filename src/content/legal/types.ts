export const LEGAL_SLUGS = ['privacy', 'terms', 'data-deletion'] as const;
export type LegalSlug = (typeof LEGAL_SLUGS)[number];

export interface LegalSection {
  heading: string;
  paragraphs?: string[];
  bullets?: string[];
}

export interface LegalDoc {
  title: string;
  summary: string;
  sections: LegalSection[];
}

export type LegalCatalogue = Record<LegalSlug, LegalDoc>;
