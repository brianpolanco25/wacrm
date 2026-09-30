// ============================================================
// Page guard for the operator's panel — `src/app/(platform)/`.
//
// `requirePlatformAdmin()` is the route-handler convention (resolve or
// throw 401/403). A PAGE has no status to map that to: whoever is not a
// platform admin — signed out, a tenant, even the owner of every company
// — gets the 404 of `notFound()`, because the existence of the panel is
// not something a tenant needs confirmed.
//
// Called by the group's layout AND by every page under it. The layout
// alone is not enough: Next docs (guides/authentication, «Layouts and
// auth checks») warn that layouts do not re-render on client navigation
// (Partial Rendering), so a page segment can be fetched without its
// layout running again. `cache()` makes the second call within the same
// request free — one `platform_admins` lookup per render, not two.
// ============================================================

import { cache } from 'react';
import { notFound } from 'next/navigation';

import { requirePlatformAdmin, type PlatformContext } from './platform';

export const guardPlatformPage = cache(async (): Promise<PlatformContext> => {
  try {
    return await requirePlatformAdmin();
  } catch {
    notFound();
  }
});
