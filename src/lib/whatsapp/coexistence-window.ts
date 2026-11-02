// #1650 — Meta's 24 h window for the coexistence SMB syncs.
//
// Split out of `coexistence.ts` so the settings card (a client
// component) can use it without pulling the Graph helpers into the
// browser bundle. `coexistence.ts` re-exports both names.

/** Meta's window for the two syncs, counted from the onboarding. */
export const SMB_SYNC_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Is the onboarding recent enough for Meta to still accept a sync? */
export function isWithinSmbSyncWindow(
  onboardedAt: string | null | undefined,
  now: Date = new Date()
): boolean {
  if (!onboardedAt) return false;
  const at = Date.parse(onboardedAt);
  if (Number.isNaN(at)) return false;
  return now.getTime() - at <= SMB_SYNC_WINDOW_MS;
}
