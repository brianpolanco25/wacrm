// ============================================================
// Plantillas de texto plano de los correos de facturación (p11.7).
//
// Los textos viven en `messages/*.json` bajo `Emails.billing`, así que
// los tests de catálogo (paridad es/en, placeholders, marca, ICU) los
// cubren como a cualquier pantalla. El formato de números y fechas se
// hace aquí con `Intl` (UTC) y entra al mensaje ya como cadena: el ICU
// solo sustituye.
//
// El idioma es el del despliegue (`NEXT_PUBLIC_APP_LOCALE`, supuesto
// S-B3): no hay idioma por usuario en la base. Quien llama lo resuelve.
// ============================================================

import { createTranslator } from 'next-intl';

import type { Locale } from '@/i18n/request';

import en from '../../../messages/en.json';
import es from '../../../messages/es.json';

const CATALOGUES = { es, en } as const;

export type BillingEmailKind =
  | 'service_quota_80'
  | 'service_quota_100'
  | 'statement_issued'
  | 'statement_due';

export const BILLING_EMAIL_KINDS: readonly BillingEmailKind[] = [
  'service_quota_80',
  'service_quota_100',
  'statement_issued',
  'statement_due',
];

export interface QuotaEmailParams {
  kind: 'service_quota_80' | 'service_quota_100';
  /** Etiqueta del número (label → verified_name → teléfono → id). */
  number: string;
  used: number;
  limit: number;
  /** Día 1 del mes, ISO; solo cuenta el mes y el año (UTC). */
  monthStart: string;
}

export interface StatementEmailParams {
  kind: 'statement_issued' | 'statement_due';
  periodStart: string;
  periodEnd: string;
  totalUsd: number;
  dueAt: string;
}

export type BillingEmailParams = QuotaEmailParams | StatementEmailParams;

function isQuota(p: BillingEmailParams): p is QuotaEmailParams {
  return p.kind === 'service_quota_80' || p.kind === 'service_quota_100';
}

function formatCount(value: number, locale: Locale): string {
  return new Intl.NumberFormat(locale).format(value);
}

function formatUsd(value: number, locale: Locale): string {
  return new Intl.NumberFormat(locale, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

function formatDay(iso: string, locale: Locale): string {
  return new Intl.DateTimeFormat(locale, {
    dateStyle: 'long',
    timeZone: 'UTC',
  }).format(new Date(iso));
}

/** Con hora, y `UTC` explícito: el vencimiento es un instante. */
function formatDueAt(iso: string, locale: Locale): string {
  const text = new Intl.DateTimeFormat(locale, {
    dateStyle: 'long',
    timeStyle: 'short',
    timeZone: 'UTC',
  }).format(new Date(iso));
  return `${text} UTC`;
}

function formatMonth(iso: string, locale: Locale): string {
  return new Intl.DateTimeFormat(locale, {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(iso));
}

/** `<site>/billing`, sin doble barra; null si no hay sitio. */
export function billingUrl(siteUrl: string | null | undefined): string | null {
  const base = (siteUrl ?? '').trim().replace(/\/+$/, '');
  return base ? `${base}/billing` : null;
}

/** R22–R24. Asunto y cuerpo en texto plano. */
export function renderBillingEmail(
  params: BillingEmailParams,
  locale: Locale,
  siteUrl?: string | null
): { subject: string; text: string } {
  const t = createTranslator({
    locale,
    messages: CATALOGUES[locale],
    namespace: 'Emails.billing',
  });

  let subject: string;
  let body: string;
  if (isQuota(params)) {
    const values = {
      number: params.number,
      used: formatCount(params.used, locale),
      limit: formatCount(params.limit, locale),
      month: formatMonth(params.monthStart, locale),
    };
    subject = t(`${params.kind}.subject`, values);
    body = t(`${params.kind}.body`, values);
  } else {
    const values = {
      period: `${formatDay(params.periodStart, locale)} – ${formatDay(params.periodEnd, locale)}`,
      total: formatUsd(params.totalUsd, locale),
      dueDate: formatDueAt(params.dueAt, locale),
    };
    subject = t(`${params.kind}.subject`, values);
    body = t(`${params.kind}.body`, values);
  }

  const url = billingUrl(siteUrl);
  const text = url ? `${body}\n\n${t('link', { url })}` : body;
  return { subject, text };
}
