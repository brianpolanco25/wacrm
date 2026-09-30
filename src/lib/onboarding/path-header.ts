// ============================================================
// The request path, handed from the middleware to the (dashboard) layout
// (s9.6). Import-free: the middleware runs on Edge.
//
// Layouts do not receive the pathname. The onboarding gate needs it for
// one exemption only: `/billing` stays reachable for every account that
// is not `incomplete`, profile or not. The middleware sets this header on
// EVERY request (overwriting whatever a client sent), so it only ever
// carries the middleware's word — and forging it would only let a paying
// owner put off the company step, which grants nothing.
// ============================================================

export const REQUEST_PATH_HEADER = 'x-wacrm-pathname';

/** `/billing` and everything under it (`/billing/return`). */
export function isBillingPath(pathname: string | null | undefined): boolean {
  if (!pathname) return false;
  return pathname === '/billing' || pathname.startsWith('/billing/');
}
