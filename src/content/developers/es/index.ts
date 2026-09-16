import type { DocCatalogue } from '../types';

import { authentication, conventions, start } from './core';
import {
  guides,
  guidesContactsTags,
  guidesExports,
  guidesTemplates,
  guidesWebhooks,
} from './guides';
import { changelog, integrations, reference, webhooks } from './reference';

export { sections } from './reference';

/** Una entrada por slug: el tipo `DocCatalogue` no admite huecos. */
export const catalogue: DocCatalogue = {
  start,
  authentication,
  conventions,
  guides,
  'guides/templates': guidesTemplates,
  'guides/contacts-tags': guidesContactsTags,
  'guides/exports': guidesExports,
  'guides/webhooks': guidesWebhooks,
  reference,
  webhooks,
  integrations,
  changelog,
};
