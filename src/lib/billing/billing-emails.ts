// ============================================================
// Correos de facturación (fase 11, p11.7). Un barrido que corre en
// `GET /api/billing/cron` justo después de `sweepStatements` y manda, si
// hay proveedor de correo (`src/lib/email/provider.ts`), cuatro avisos
// al owner y a los admins de la cuenta:
//
//   service_quota_80   un número de una cuenta `direct` llegó a 800 de
//                      sus 1.000 mensajes de servicio gratis del mes;
//   service_quota_100  los agotó (regla de p11.3: `serviceCapState`);
//   statement_issued   se emitió un estado de cuenta (s10.4), ≤ 72 h;
//   statement_due      venció sin pagar, ≤ 72 h.
//
// El conteo NO es propio: es `loadServiceUsage` → `service_quota_usage`
// (080, p11.3). Las cuentas `managed` no se evalúan: la cuota gratis de
// Meta no es dato de ese cliente (§s10.5).
//
// Idempotencia: cada evento se RESERVA en `notification_emails` (083)
// con un upsert `ignoreDuplicates` sobre UNIQUE (account_id, kind, ref)
// antes de llamar al proveedor; solo envía quien obtuvo la fila. Una
// reserva `failed`, o `pending` de más de 1 h, se recupera con un UPDATE
// optimista sobre `attempts` (máx. 3).
//
// CP11: `sweepBillingEmails` nunca lanza; cada cuenta y cada evento van
// en su propio `try`. Solo LEE `whatsapp_config`, `subscriptions`,
// `statements` y `profiles`; solo ESCRIBE `notification_emails`.
//
// CP3: el cliente es el de rol de servicio. Toda consulta por cuenta
// filtra por `account_id`; las dos que recorren todas las cuentas
// (números conectados y estados de cuenta recientes) están con su motivo
// en los waivers de `tenant-isolation.test.ts`.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { resolveLocale, type Locale } from '@/i18n/request';
import {
  renderBillingEmail,
  type BillingEmailKind,
  type BillingEmailParams,
} from '@/lib/email/billing-templates';
import {
  resolveEmailProvider,
  sanitizeEmailError,
  type EmailProvider,
  type EmailProviderResolution,
} from '@/lib/email/provider';
import { metaBillingOf } from '@/lib/whatsapp/payment-method';

import {
  loadServiceUsage,
  SERVICE_FREE_TIER_PER_NUMBER,
  serviceCapState,
  serviceMonthWindow,
} from './service-cap';

export const QUOTA_WARN_AT = 800;
export const STATEMENT_EVENT_WINDOW_MS = 72 * 3600_000;
export const EMAIL_RETRY_AFTER_MS = 3600_000;
export const EMAIL_MAX_ATTEMPTS = 3;
export const EMAIL_SWEEP_ACCOUNT_LIMIT = 500;
export const EMAIL_MAX_RECIPIENTS = 20;

/** Filas por página al listar los números conectados. */
const CONFIG_PAGE_SIZE = 1000;
/** Cuentas por `.in('account_id', …)`: la URL de PostgREST no es infinita. */
const IN_CHUNK = 100;
/** `due_at = period_end + 3 días` (s10.4): la ventana de lectura cubre las dos. */
const STATEMENT_LOOKBACK_MS = STATEMENT_EVENT_WINDOW_MS + 3 * 24 * 3600_000;
const STATEMENT_READ_LIMIT = 1000;

// ------------------------------------------------------------------
// Lógica pura
// ------------------------------------------------------------------

/** `YYYY-MM` del mes natural UTC de `nowMs`. */
export function monthKeyUtc(nowMs: number): string {
  const d = new Date(nowMs);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** `ref` de un aviso de cuota: el número y el mes. */
export function quotaRef(whatsappConfigId: string, monthKey: string): string {
  return `${whatsappConfigId}:${monthKey}`;
}

/**
 * R8. 100 si el número está agotado según p11.3 (`used >= 1000` o
 * `billable > 0`); 80 si no lo está pero `used >= 800`; si no, nada.
 */
export function quotaEventFor(u: {
  used: number;
  billable: number;
}): 'service_quota_80' | 'service_quota_100' | null {
  const state = serviceCapState(u);
  if (state.exhausted) return 'service_quota_100';
  if (state.used >= QUOTA_WARN_AT) return 'service_quota_80';
  return null;
}

export interface EmailStatementRow {
  id: string;
  account_id: string;
  period_start: string;
  period_end: string;
  total_usd: number | string;
  status: string;
  issued_at: string;
  due_at: string;
}

/**
 * R11–R13. `statement_issued` si sigue `issued` y se emitió en las
 * últimas 72 h; `statement_due` si sigue `issued` y venció en las
 * últimas 72 h. Fuera de esas ventanas, nada: un proveedor recién
 * configurado no manda avisos viejos.
 */
export function statementEventsFor(
  rows: EmailStatementRow[],
  nowMs: number
): Array<{
  kind: 'statement_issued' | 'statement_due';
  ref: string;
  row: EmailStatementRow;
}> {
  const out: Array<{
    kind: 'statement_issued' | 'statement_due';
    ref: string;
    row: EmailStatementRow;
  }> = [];
  const since = nowMs - STATEMENT_EVENT_WINDOW_MS;
  for (const row of rows) {
    if (row.status !== 'issued' || !row.id) continue;
    const issued = Date.parse(row.issued_at);
    if (Number.isFinite(issued) && issued <= nowMs && issued >= since) {
      out.push({ kind: 'statement_issued', ref: row.id, row });
    }
    const due = Date.parse(row.due_at);
    if (Number.isFinite(due) && due <= nowMs && due >= since) {
      out.push({ kind: 'statement_due', ref: row.id, row });
    }
  }
  return out;
}

export interface NotificationRow {
  id: string;
  kind: string;
  ref: string;
  status: string;
  attempts: number;
  updated_at: string;
}

/**
 * R16, R18. Sin fila → reservar. `sent`/`skipped` → nada. `failed` o
 * `pending` con menos de 3 intentos y sin tocar desde hace ≥ 1 h →
 * recuperar. Cualquier otra cosa → nada.
 */
export function claimDecision(
  existing: NotificationRow | undefined,
  nowMs: number
): 'insert' | 'reclaim' | 'skip' {
  if (!existing) return 'insert';
  if (existing.status !== 'failed' && existing.status !== 'pending') {
    return 'skip';
  }
  const attempts = Number(existing.attempts) || 0;
  if (attempts >= EMAIL_MAX_ATTEMPTS) return 'skip';
  const touched = Date.parse(existing.updated_at);
  if (!Number.isFinite(touched)) return 'skip';
  return touched <= nowMs - EMAIL_RETRY_AFTER_MS ? 'reclaim' : 'skip';
}

/** La cadena de la 053 y de `whatsapp-config.tsx`. */
export function numberLabel(row: Record<string, unknown>): string {
  for (const key of [
    'label',
    'verified_name',
    'display_phone_number',
    'phone_number_id',
  ]) {
    const v = row[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return String(row.id ?? '');
}

/** R17. Sin vacíos, sin duplicados (sin distinguir mayúsculas), máx. 20. */
export function recipientsFrom(rows: Array<{ email?: unknown }>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const row of rows) {
    if (typeof row.email !== 'string') continue;
    const email = row.email.trim();
    if (!email) continue;
    const key = email.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(email);
    if (out.length >= EMAIL_MAX_RECIPIENTS) break;
  }
  return out;
}

// ------------------------------------------------------------------
// Barrido
// ------------------------------------------------------------------

export interface BillingEmailSweep {
  enabled: boolean;
  reason?: 'not_configured' | 'misconfigured';
  /** Cuentas con números conectados evaluadas (≤ 500). */
  accounts: number;
  truncated: boolean;
  sent: number;
  failed: number;
  skipped: number;
  errors: number;
}

interface PendingEvent {
  accountId: string;
  kind: BillingEmailKind;
  ref: string;
  params: BillingEmailParams;
}

function emptySweep(): BillingEmailSweep {
  return {
    enabled: false,
    accounts: 0,
    truncated: false,
    sent: 0,
    failed: 0,
    skipped: 0,
    errors: 0,
  };
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function logError(scope: string, err: unknown): void {
  console.error(`[billing-emails] ${scope}:`, sanitizeEmailError(errText(err)));
}

/** Números conectados de todas las cuentas, hasta pasar de 500 cuentas. */
async function loadConnectedNumbers(
  admin: SupabaseClient
): Promise<{
  byAccount: Map<string, Record<string, unknown>[]>;
  truncated: boolean;
}> {
  const byAccount = new Map<string, Record<string, unknown>[]>();
  for (let from = 0; ; from += CONFIG_PAGE_SIZE) {
    // Entre cuentas a propósito (waiver en tenant-isolation.test.ts):
    // es el listado del que sale cada cuenta del barrido.
    const { data, error } = await admin
      .from('whatsapp_config')
      .select(
        'id, account_id, label, verified_name, display_phone_number, phone_number_id'
      )
      .eq('status', 'connected')
      .order('account_id')
      .order('id')
      .range(from, from + CONFIG_PAGE_SIZE - 1);
    if (error) throw new Error(`whatsapp_config: ${error.message}`);
    const rows = (data ?? []) as Record<string, unknown>[];
    for (const row of rows) {
      const acc = row.account_id;
      if (typeof acc !== 'string' || !acc || typeof row.id !== 'string')
        continue;
      if (!byAccount.has(acc)) {
        if (byAccount.size >= EMAIL_SWEEP_ACCOUNT_LIMIT) {
          return { byAccount, truncated: true };
        }
        byAccount.set(acc, []);
      }
      byAccount.get(acc)!.push(row);
    }
    if (rows.length < CONFIG_PAGE_SIZE) return { byAccount, truncated: false };
  }
}

async function quotaEvents(
  admin: SupabaseClient,
  nowMs: number,
  summary: BillingEmailSweep
): Promise<PendingEvent[]> {
  let byAccount: Map<string, Record<string, unknown>[]>;
  try {
    const loaded = await loadConnectedNumbers(admin);
    byAccount = loaded.byAccount;
    summary.truncated = loaded.truncated;
  } catch (err) {
    summary.errors += 1;
    logError('could not list connected numbers', err);
    return [];
  }
  const ids = [...byAccount.keys()];
  summary.accounts = ids.length;

  // R10: las `managed` no se evalúan. Una cuenta cuyo modo no se pudo
  // leer tampoco: mejor un aviso de menos que uno a quien no toca.
  const direct = new Set<string>();
  for (let i = 0; i < ids.length; i += IN_CHUNK) {
    const chunk = ids.slice(i, i + IN_CHUNK);
    try {
      const { data, error } = await admin
        .from('subscriptions')
        .select('account_id, meta_billing')
        .in('account_id', chunk);
      if (error) throw new Error(`subscriptions: ${error.message}`);
      const subs = new Map<string, Record<string, unknown>>();
      for (const s of (data ?? []) as Record<string, unknown>[]) {
        if (typeof s.account_id === 'string') subs.set(s.account_id, s);
      }
      for (const acc of chunk) {
        if (metaBillingOf(subs.get(acc) ?? null) === 'direct') direct.add(acc);
      }
    } catch (err) {
      summary.errors += 1;
      logError('could not read the billing mode', err);
    }
  }

  const now = new Date(nowMs);
  const monthKey = monthKeyUtc(nowMs);
  const monthStart = serviceMonthWindow(now).monthStart.toISOString();
  const events: PendingEvent[] = [];
  for (const acc of ids) {
    if (!direct.has(acc)) continue;
    try {
      const usage = await loadServiceUsage(admin, acc, now);
      for (const cfg of byAccount.get(acc) ?? []) {
        const u = usage.get(cfg.id as string);
        if (!u) continue;
        const kind = quotaEventFor(u);
        if (!kind) continue;
        events.push({
          accountId: acc,
          kind,
          ref: quotaRef(cfg.id as string, monthKey),
          params: {
            kind,
            number: numberLabel(cfg),
            used: u.used,
            limit: SERVICE_FREE_TIER_PER_NUMBER,
            monthStart,
          },
        });
      }
    } catch (err) {
      summary.errors += 1;
      logError(`account ${acc}: could not read the service quota`, err);
    }
  }
  return events;
}

async function statementEvents(
  admin: SupabaseClient,
  nowMs: number,
  summary: BillingEmailSweep
): Promise<PendingEvent[]> {
  try {
    // Entre cuentas a propósito (waiver): solo lectura, y cada evento
    // lleva el account_id de su fila.
    const { data, error } = await admin
      .from('statements')
      .select(
        'id, account_id, period_start, period_end, total_usd, status, issued_at, due_at'
      )
      .eq('status', 'issued')
      .gte('issued_at', new Date(nowMs - STATEMENT_LOOKBACK_MS).toISOString())
      .order('issued_at')
      .limit(STATEMENT_READ_LIMIT);
    if (error) throw new Error(`statements: ${error.message}`);
    return statementEventsFor((data ?? []) as EmailStatementRow[], nowMs)
      .filter((e) => typeof e.row.account_id === 'string' && e.row.account_id)
      .map((e) => ({
        accountId: e.row.account_id,
        kind: e.kind,
        ref: e.ref,
        params: {
          kind: e.kind,
          periodStart: e.row.period_start,
          periodEnd: e.row.period_end,
          totalUsd: Number(e.row.total_usd) || 0,
          dueAt: e.row.due_at,
        },
      }));
  } catch (err) {
    summary.errors += 1;
    logError('could not list recent statements', err);
    return [];
  }
}

interface SendContext {
  admin: SupabaseClient;
  provider: EmailProvider;
  nowMs: number;
  locale: Locale;
  siteUrl: string | null;
  summary: BillingEmailSweep;
}

async function loadRecipients(
  admin: SupabaseClient,
  accountId: string
): Promise<string[]> {
  const { data, error } = await admin
    .from('profiles')
    .select('email, account_role')
    .eq('account_id', accountId)
    .in('account_role', ['owner', 'admin']);
  if (error) throw new Error(`profiles: ${error.message}`);
  const rows = (data ?? []) as Array<{
    email?: unknown;
    account_role?: unknown;
  }>;
  // El owner primero, por si el tope de 20 corta.
  const ordered = [
    ...rows.filter((r) => r.account_role === 'owner'),
    ...rows.filter((r) => r.account_role !== 'owner'),
  ];
  return recipientsFrom(ordered);
}

async function processAccount(
  ctx: SendContext,
  accountId: string,
  events: PendingEvent[]
): Promise<void> {
  const { admin, summary, nowMs } = ctx;
  const nowIso = new Date(nowMs).toISOString();

  let existing: Map<string, NotificationRow>;
  try {
    const refs = [...new Set(events.map((e) => e.ref))];
    const { data, error } = await admin
      .from('notification_emails')
      .select('id, kind, ref, status, attempts, updated_at')
      .eq('account_id', accountId)
      .in('ref', refs);
    if (error) throw new Error(`notification_emails: ${error.message}`);
    existing = new Map(
      ((data ?? []) as NotificationRow[]).map((r) => [`${r.kind}|${r.ref}`, r])
    );
  } catch (err) {
    summary.errors += 1;
    logError(`account ${accountId}: could not read the email log`, err);
    return;
  }

  let recipients: string[] | null = null;

  for (const event of events) {
    let claimedId: string | null = null;
    try {
      // R9: un 100 ya registrado del mismo número y mes tapa al 80.
      if (
        event.kind === 'service_quota_80' &&
        existing.has(`service_quota_100|${event.ref}`)
      ) {
        continue;
      }
      const prior = existing.get(`${event.kind}|${event.ref}`);
      const decision = claimDecision(prior, nowMs);
      if (decision === 'skip') continue;

      if (decision === 'insert') {
        const { data, error } = await admin
          .from('notification_emails')
          .upsert(
            {
              account_id: accountId,
              kind: event.kind,
              ref: event.ref,
              status: 'pending',
              attempts: 1,
              updated_at: nowIso,
            },
            { onConflict: 'account_id,kind,ref', ignoreDuplicates: true }
          )
          .select('id');
        if (error) throw new Error(`reserve: ${error.message}`);
        const row = ((data ?? []) as Array<{ id?: string }>)[0];
        if (!row?.id) continue; // otro barrido lo reservó
        claimedId = row.id;
      } else {
        const attempts = Number(prior!.attempts) || 0;
        const { data, error } = await admin
          .from('notification_emails')
          .update({
            status: 'pending',
            attempts: attempts + 1,
            updated_at: nowIso,
          })
          .eq('id', prior!.id)
          .eq('account_id', accountId)
          .eq('attempts', attempts)
          .select('id');
        if (error) throw new Error(`reclaim: ${error.message}`);
        const row = ((data ?? []) as Array<{ id?: string }>)[0];
        if (!row?.id) continue; // otro barrido lo recuperó
        claimedId = row.id;
      }

      if (recipients === null) {
        recipients = await loadRecipients(admin, accountId);
      }
      if (recipients.length === 0) {
        await finish(ctx, claimedId, accountId, {
          status: 'skipped',
          updated_at: nowIso,
        });
        summary.skipped += 1;
        continue;
      }

      const { subject, text } = renderBillingEmail(
        event.params,
        ctx.locale,
        ctx.siteUrl
      );
      const result = await ctx.provider.send({
        to: recipients,
        subject,
        text,
        kind: event.kind,
      });
      if (result.ok) {
        await finish(ctx, claimedId, accountId, {
          status: 'sent',
          sent_at: nowIso,
          recipients: recipients.length,
          last_error: null,
          updated_at: nowIso,
        });
        summary.sent += 1;
      } else {
        const error = sanitizeEmailError(result.error);
        console.warn(
          `[billing-emails] account ${accountId}: ${event.kind} not sent: ${error}`
        );
        await finish(ctx, claimedId, accountId, {
          status: 'failed',
          last_error: error,
          updated_at: nowIso,
        });
        summary.failed += 1;
      }
    } catch (err) {
      summary.errors += 1;
      logError(`account ${accountId}: ${event.kind}`, err);
      // Lo reservado y no enviado queda `failed` para reintentarlo en
      // ≥ 1 h. Si ni eso se puede escribir, queda `pending` y R18 lo
      // recupera igual.
      if (claimedId) {
        try {
          await finish(ctx, claimedId, accountId, {
            status: 'failed',
            last_error: sanitizeEmailError(
              err instanceof Error ? err.name || 'Error' : 'Error'
            ),
            updated_at: nowIso,
          });
        } catch {
          // Ya contado arriba.
        }
      }
    }
  }
}

async function finish(
  ctx: SendContext,
  id: string,
  accountId: string,
  patch: Record<string, unknown>
): Promise<void> {
  const { error } = await ctx.admin
    .from('notification_emails')
    .update(patch)
    .eq('id', id)
    .eq('account_id', accountId);
  if (error) throw new Error(`notification_emails update: ${error.message}`);
}

/**
 * Barrido de correos de facturación. Nunca lanza (R19). Sin proveedor
 * no toca la base (R15).
 */
export async function sweepBillingEmails(
  admin: SupabaseClient,
  opts: {
    nowMs?: number;
    resolution?: EmailProviderResolution;
    locale?: Locale;
    siteUrl?: string | null;
  } = {}
): Promise<BillingEmailSweep> {
  const summary = emptySweep();
  let resolution: EmailProviderResolution;
  try {
    resolution = opts.resolution ?? resolveEmailProvider();
  } catch (err) {
    logError('could not resolve the email provider', err);
    return { ...summary, errors: 1 };
  }
  if (!resolution.provider) {
    return { ...summary, reason: resolution.reason };
  }
  summary.enabled = true;

  try {
    const nowMs = opts.nowMs ?? Date.now();
    const ctx: SendContext = {
      admin,
      provider: resolution.provider,
      nowMs,
      locale: opts.locale ?? resolveLocale(process.env.NEXT_PUBLIC_APP_LOCALE),
      siteUrl:
        opts.siteUrl !== undefined
          ? opts.siteUrl
          : (process.env.NEXT_PUBLIC_SITE_URL ?? null),
      summary,
    };

    const events = [
      ...(await quotaEvents(admin, nowMs, summary)),
      ...(await statementEvents(admin, nowMs, summary)),
    ];

    const byAccount = new Map<string, PendingEvent[]>();
    for (const e of events) {
      if (!byAccount.has(e.accountId)) byAccount.set(e.accountId, []);
      byAccount.get(e.accountId)!.push(e);
    }
    for (const [accountId, list] of byAccount) {
      await processAccount(ctx, accountId, list);
    }
  } catch (err) {
    summary.errors += 1;
    logError('sweep failed', err);
  }
  return summary;
}
