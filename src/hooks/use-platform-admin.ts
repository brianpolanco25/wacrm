'use client';

// ============================================================
// "Should the sidebar show the platform panel?"
//
// Cosmetic ONLY. The panel's pages call `requirePlatformAdmin()` on the
// server and `notFound()` otherwise, so this hook can be wrong in either
// direction without opening anything: a false negative hides a link
// whose URL still works for whoever may use it, and a false positive
// shows a link that leads to a 404.
//
// `/api/platform/me` answers with 403 for everyone who is not in
// `platform_admins`, which is the same answer every other route of that
// prefix gives, so asking costs a tenant nothing and tells them nothing.
// ============================================================

import { useEffect, useState } from 'react';

export function usePlatformAdmin(enabled: boolean): boolean {
  const [isAdmin, setIsAdmin] = useState(false);

  useEffect(() => {
    // No synchronous `setIsAdmin(false)` on the `!enabled` branch: it is
    // already the initial state, and writing it inside the effect makes
    // React re-render for nothing (and trips the lint rule about
    // cascading renders). Signing out unmounts this tree anyway.
    if (!enabled) return;
    let cancelled = false;
    fetch('/api/platform/me', { cache: 'no-store' })
      .then((r) => r.ok)
      .catch(() => false)
      .then((ok) => {
        if (!cancelled) setIsAdmin(ok);
      });
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  return isAdmin;
}
