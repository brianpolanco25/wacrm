// ============================================================
// #1651 — Drenado de los lotes de coexistencia (migración 089).
//
// `coexistence-webhook.ts` captures every history chunk and every
// address-book delivery as a row of `whatsapp_coexistence_batches`
// before processing any of it. This module processes them in slices
// with a cursor and a deadline:
//
//   - the webhook drains the batches it just queued, inside the same
//     `after()`, until 45 s after the POST arrived;
//   - `GET /api/whatsapp/coexistence/cron` drains whatever is left.
//
// A batch is claimed with a conditional UPDATE (only one drain wins),
// the cursor is saved after each history thread or each slice of 200
// contacts, and a drain that runs out of time leaves the batch
// `pending` at its cursor so the next one carries on without repeating
// or skipping. Writes go through the account copied onto the batch when
// it was queued, and the config is re-read under that same account.
// No automations, flows, AI, public webhooks, charges or billing gates.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';
import { findOrCreateContact } from '@/lib/whatsapp/inbound-thread';
import {
  parseHistoryThread,
  parseStateSyncItem,
  storeThreadMessages,
  type CoexistenceConfig,
} from '@/lib/whatsapp/coexistence-webhook';

export const BATCH_LOCK_MS = 120_000;
export const BATCH_MAX_ATTEMPTS = 5;
export const STATE_SYNC_SLICE = 200;
export const DRAIN_BUDGET_MS = 45_000;
/** Batches per cron call. */
export const DRAIN_SWEEP_LIMIT = 20;
const LAST_ERROR_MAX = 500;

export type BatchStatus = 'pending' | 'processing' | 'done' | 'failed';

export interface BatchRow {
  id: string;
  account_id: string;
  whatsapp_config_id: string;
  field: 'history' | 'smb_app_state_sync';
  phase: number | null;
  chunk_order: number | null;
  progress: number | null;
  payload: Record<string, unknown> | null;
  item_count: number;
  cursor: number;
  status: BatchStatus;
  attempts: number;
  last_error: string | null;
  locked_until: string | null;
  created_at: string;
}

/** What a drain needs to claim a batch, before loading its payload. */
export interface BatchRef {
  id: string;
  account_id: string;
  attempts: number;
}

export interface DrainResult {
  processed: number;
  completed: number;
  pending: number;
  failed: number;
}

const TABLE = 'whatsapp_coexistence_batches';
const REF_COLUMNS = 'id, account_id, attempts';

function errorMessage(err: unknown): string {
  if (err && typeof err === 'object' && 'message' in err) {
    return String((err as { message: unknown }).message);
  }
  return String(err);
}

function claimableFilter(now: Date): string {
  return `status.eq.pending,and(status.eq.processing,locked_until.lt.${now.toISOString()})`;
}

/**
 * Claim a batch with a conditional UPDATE: it must still be `pending`
 * (or `processing` with an expired lock) AND still carry the attempt
 * count the caller read, so two drains racing for it cannot both win.
 * Returns the full row, or null when another drain has it.
 */
export async function claimBatch(
  db: SupabaseClient,
  ref: BatchRef,
  now: Date
): Promise<BatchRow | null> {
  const attempts = Number(ref.attempts ?? 0);
  const { data, error } = await db
    .from(TABLE)
    .update({
      status: 'processing',
      locked_until: new Date(now.getTime() + BATCH_LOCK_MS).toISOString(),
      attempts: attempts + 1,
      updated_at: now.toISOString(),
    })
    .eq('id', ref.id)
    .eq('account_id', ref.account_id)
    .eq('attempts', attempts)
    .or(claimableFilter(now))
    .select('*');
  if (error) {
    console.error(
      '[coexistence] batch claim failed:',
      JSON.stringify({ batchId: ref.id, error: errorMessage(error) })
    );
    return null;
  }
  const row = (data as BatchRow[] | null)?.[0];
  return row ?? null;
}

async function updateBatch(
  db: SupabaseClient,
  batch: BatchRow,
  patch: Record<string, unknown>
): Promise<void> {
  const { error } = await db
    .from(TABLE)
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', batch.id)
    .eq('account_id', batch.account_id);
  if (error) throw new Error(`batch update failed: ${errorMessage(error)}`);
}

async function loadConfig(
  db: SupabaseClient,
  batch: BatchRow
): Promise<CoexistenceConfig | null> {
  const { data, error } = await db
    .from('whatsapp_config')
    .select('id, account_id, user_id, phone_number_id, display_phone_number')
    .eq('id', batch.whatsapp_config_id)
    .eq('account_id', batch.account_id)
    .limit(1);
  if (error) throw new Error(`config lookup failed: ${errorMessage(error)}`);
  return ((data as CoexistenceConfig[] | null) ?? [])[0] ?? null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

type Step = { kind: 'done' } | { kind: 'paused' };

async function processHistory(
  db: SupabaseClient,
  batch: BatchRow,
  config: CoexistenceConfig,
  deadline: number
): Promise<Step> {
  const payload = batch.payload ?? {};
  const threads = asArray(payload.threads);
  const businessPhone =
    (typeof payload.display_phone_number === 'string'
      ? payload.display_phone_number
      : null) ??
    config.display_phone_number ??
    '';
  const startCursor = batch.cursor;
  let cursor = startCursor;
  let messages = 0;
  let inserted = 0;
  let failedThreads = 0;
  let invalidThreads = 0;
  let paused = false;

  while (cursor < threads.length) {
    if (Date.now() >= deadline) {
      paused = true;
      break;
    }
    const parsed = parseHistoryThread(threads[cursor], businessPhone);
    if (!parsed) {
      invalidThreads += 1;
    } else {
      messages += parsed.messages.length;
      const result = await storeThreadMessages(
        db,
        config,
        parsed.phone,
        parsed.messages
      );
      if (result) inserted += result.inserted;
      else failedThreads += 1;
    }
    cursor += 1;
    await updateBatch(db, batch, {
      cursor,
      locked_until: new Date(Date.now() + BATCH_LOCK_MS).toISOString(),
    });
  }
  batch.cursor = cursor;

  console.log(
    '[webhook] history chunk:',
    JSON.stringify({
      batchId: batch.id,
      phoneNumberId: config.phone_number_id,
      phase: batch.phase,
      chunkOrder: batch.chunk_order,
      progress: batch.progress,
      threadsDone: cursor,
      threadsTotal: threads.length,
      messages,
      inserted,
      failedThreads,
      invalidThreads,
      paused,
    })
  );
  return paused ? { kind: 'paused' } : { kind: 'done' };
}

async function processStateSync(
  db: SupabaseClient,
  batch: BatchRow,
  config: CoexistenceConfig,
  deadline: number
): Promise<Step> {
  const items = asArray((batch.payload ?? {}).state_sync);
  let cursor = batch.cursor;
  const counts = { created: 0, existing: 0, ignored: 0, invalid: 0, failed: 0 };
  let paused = false;

  while (cursor < items.length) {
    if (Date.now() >= deadline) {
      paused = true;
      break;
    }
    const end = Math.min(cursor + STATE_SYNC_SLICE, items.length);
    for (let i = cursor; i < end; i++) {
      const parsed = parseStateSyncItem(items[i]);
      if (parsed === 'invalid') {
        counts.invalid += 1;
        continue;
      }
      // `remove` never deletes or edits a CRM contact (R15).
      if (parsed === 'ignored' || parsed.action === 'remove') {
        counts.ignored += 1;
        continue;
      }
      const outcome = await findOrCreateContact(
        db,
        config.account_id,
        config.user_id,
        {
          phone: parsed.phone,
          waUserId: null,
          username: null,
          name: parsed.name,
        }
      );
      if (!outcome) counts.failed += 1;
      else if (outcome.wasCreated) counts.created += 1;
      else counts.existing += 1;
    }
    cursor = end;
    await updateBatch(db, batch, {
      cursor,
      locked_until: new Date(Date.now() + BATCH_LOCK_MS).toISOString(),
    });
  }
  batch.cursor = cursor;

  console.log(
    '[webhook] contacts sync:',
    JSON.stringify({
      batchId: batch.id,
      phoneNumberId: config.phone_number_id,
      ...counts,
      done: cursor,
      total: items.length,
      paused,
    })
  );
  return paused ? { kind: 'paused' } : { kind: 'done' };
}

/**
 * Process a claimed batch from its cursor until it is finished or the
 * deadline (epoch ms) is reached. Never throws.
 */
export async function processBatch(
  db: SupabaseClient,
  batch: BatchRow,
  deadline: number
): Promise<'done' | 'pending' | 'failed'> {
  const startCursor = batch.cursor;
  try {
    const config = await loadConfig(db, batch);
    if (!config) {
      await updateBatch(db, batch, {
        status: 'failed',
        last_error: 'config_missing',
        locked_until: null,
      });
      console.warn(
        '[coexistence] batch failed:',
        JSON.stringify({ batchId: batch.id, error: 'config_missing' })
      );
      return 'failed';
    }

    const step =
      batch.field === 'history'
        ? await processHistory(db, batch, config, deadline)
        : await processStateSync(db, batch, config, deadline);

    if (step.kind === 'paused') {
      // Progress resets the attempt count: a big batch that needs many
      // drains is not a failing one. Only drains that die without
      // moving the cursor add up to BATCH_MAX_ATTEMPTS.
      await updateBatch(db, batch, {
        status: 'pending',
        locked_until: null,
        ...(batch.cursor > startCursor ? { attempts: 0 } : {}),
      });
      return 'pending';
    }

    await updateBatch(db, batch, {
      status: 'done',
      payload: null,
      processed_at: new Date().toISOString(),
      locked_until: null,
      last_error: null,
    });
    return 'done';
  } catch (err) {
    const attempts = Number(batch.attempts ?? 0);
    const status = attempts >= BATCH_MAX_ATTEMPTS ? 'failed' : 'pending';
    const lastError = errorMessage(err).slice(0, LAST_ERROR_MAX);
    console.error(
      '[coexistence] batch error:',
      JSON.stringify({ batchId: batch.id, attempts, status, error: lastError })
    );
    try {
      await updateBatch(db, batch, {
        status,
        last_error: lastError,
        locked_until: null,
      });
    } catch {
      // The lock expires on its own; the cron will retry the batch.
    }
    return status;
  }
}

/**
 * Drain the given batch ids (webhook) or, without ids, the oldest
 * claimable batches across accounts (cron, `limit` per call). Stops
 * starting new work at `deadline`. Never throws.
 */
export async function drainCoexistenceBatches(
  db: SupabaseClient,
  opts: { deadline: number; batchIds?: string[]; limit?: number }
): Promise<DrainResult> {
  const result: DrainResult = {
    processed: 0,
    completed: 0,
    pending: 0,
    failed: 0,
  };
  try {
    let refs: BatchRef[];
    if (opts.batchIds) {
      if (opts.batchIds.length === 0) return result;
      const { data, error } = await db
        .from(TABLE)
        .select(REF_COLUMNS)
        .in('id', opts.batchIds);
      if (error) throw error;
      refs = (data ?? []) as BatchRef[];
    } else {
      const now = new Date();
      const { data, error } = await db
        .from(TABLE)
        .select(REF_COLUMNS)
        .in('status', ['pending', 'processing'])
        .or(claimableFilter(now))
        .order('created_at', { ascending: true })
        .limit(opts.limit ?? DRAIN_SWEEP_LIMIT);
      if (error) throw error;
      refs = (data ?? []) as BatchRef[];
    }

    for (const ref of refs) {
      if (Date.now() >= opts.deadline) {
        result.pending += 1;
        continue;
      }
      const batch = await claimBatch(db, ref, new Date());
      if (!batch) continue;
      result.processed += 1;
      const outcome = await processBatch(db, batch, opts.deadline);
      if (outcome === 'done') result.completed += 1;
      else if (outcome === 'failed') result.failed += 1;
      else result.pending += 1;
    }
  } catch (err) {
    console.error(
      '[coexistence] drain failed:',
      JSON.stringify({ error: errorMessage(err) })
    );
  }
  return result;
}
