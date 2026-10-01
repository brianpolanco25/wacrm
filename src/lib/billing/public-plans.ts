// ============================================================
// The public price list, as `/precios` shows it (fase 11, p11.2).
//
// `/precios` is read without a session, and the `plans` RLS policy of
// migration 041 lets only authenticated users read the catalogue. Rather
// than open the table to `anon` (a migration this feature does not own)
// or reach for the service role on an unauthenticated page, the public
// page renders this constant. `public-plans.test.ts` pins every number
// here against the seed of 041 and the price revisions after it (059,
// 065), so a catalogue migration that forgets this file fails the gate.
//
// Hidden plans (`ilimitado`, `gestionado`) are never listed here.
// ============================================================

export interface PublicPlan {
  id: 'inicio' | 'pro' | 'negocio';
  name: string;
  priceUsdMonth: number;
  priceUsdYear: number;
  limits: {
    operators: number;
    messages_out: number;
    ai_replies: number;
    broadcast_recipients: number;
    numbers: number;
  };
}

export const PUBLIC_PLANS: readonly PublicPlan[] = [
  {
    id: 'inicio',
    name: 'Inicio',
    priceUsdMonth: 35,
    priceUsdYear: 350,
    limits: {
      operators: 3,
      messages_out: 3000,
      ai_replies: 500,
      broadcast_recipients: 2000,
      numbers: 1,
    },
  },
  {
    id: 'pro',
    name: 'Pro',
    priceUsdMonth: 100,
    priceUsdYear: 1000,
    limits: {
      operators: 10,
      messages_out: 15000,
      ai_replies: 3000,
      broadcast_recipients: 10000,
      numbers: 1,
    },
  },
  {
    id: 'negocio',
    name: 'Negocio',
    priceUsdMonth: 199,
    priceUsdYear: 1990,
    limits: {
      operators: 30,
      messages_out: 60000,
      ai_replies: 15000,
      broadcast_recipients: 50000,
      numbers: 3,
    },
  },
];

/**
 * Service messages Meta delivers free of charge per WhatsApp number and
 * calendar month, from its pricing change of 2026-10-01 (spec of fase
 * 10). The allowance is per number: a plan with three numbers gets three
 * times this.
 */
export const META_FREE_SERVICE_PER_NUMBER = 1000;

/** Meta's free service messages per month for `numbers` connected numbers. */
export function metaFreeServiceFor(numbers: number): number {
  return Math.max(0, Math.floor(numbers)) * META_FREE_SERVICE_PER_NUMBER;
}

/**
 * A count with thousands grouped the way each catalogue writes them
 * (`3.000` in es, `3,000` in en). Done by hand because `Intl` in Spanish
 * leaves four-digit numbers ungrouped (`3000`), which would contradict
 * the prose next to it.
 */
export function formatCount(n: number, locale: string): string {
  const sep = locale.startsWith('es') ? '.' : ',';
  return String(Math.trunc(n)).replace(/\B(?=(\d{3})+(?!\d))/g, sep);
}
