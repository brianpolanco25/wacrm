# Billing audit — wacrm (read-only)

Scope: `src/lib/billing/*`, `src/app/api/billing/**`, `src/app/api/platform/accounts/[id]/{statements,plan,hold,meta-pricing,payment-status}`, `src/lib/platform/{statements,managed-plan}.ts`, parts of `provisioning.ts`, migrations 075/078 (041/076 partially). Nothing was changed, no tests were run. Paths are relative to `/mnt/nvme-big/Dev/apps/cabbity/wacrm`.

Ranked by severity. 2 must, 4 should, 2 nice.

---

## 1. A cancelled subscription never loses access — one payment buys service forever

- **Severity:** must · **Confidence:** high
- **Where:** `src/lib/billing/entitlements.ts:184-196` (`isReadOnly`), `:269-275` (columns read), `src/lib/billing/webhook-events.ts:628-649` (CANCELLED handler), `src/app/api/billing/subscription/route.ts:428-431`
- **What the code does:** `isReadOnly` locks only `incomplete`, `suspended`, `expired`, and `past_due` past its grace. `getEntitlements` never reads `current_period_end` or `cancel_at_period_end`. On CANCELLED with paid time left the webhook writes only `cancel_at_period_end = true` and leaves `status = 'active'`; with no paid time left it writes `status = 'cancelled'`, which `isReadOnly` also treats as writable.
- **Nothing ever expires it:** no code writes `'expired'` except the PayPal `EXPIRED` status map (our plans have `total_cycles: 0`, so PayPal never sends it), there is no pg_cron job, and the billing cron does not touch it. `webhook-events.ts:380-388` says so itself: "there is no expiry job". The comment at `entitlements.ts:181-182` ("the gateway then flips it to `expired`") describes something that does not exist.
- **Failure case:** account pays one month of `inicio` (US$35), clicks Cancel the next day. Row is `active` + `cancel_at_period_end = true` + `current_period_end = +1 month`. Two months later the row is unchanged, `readOnly` is false, and the account sends messages, uses the AI and the API indefinitely without being charged again.
- **Tests:** `entitlements.test.ts:220` and `:444` pin `cancelled → not read-only`; no test covers "period ended".
- **Smallest fix:** in `getEntitlements`, add `current_period_end, cancel_at_period_end` to the select and OR into `subscriptionLock`: `(status === 'cancelled' || cancel_at_period_end) && (!current_period_end || Date.parse(current_period_end) < now)`. Manual plans are unaffected (`cancel_at_period_end = false`, status `active`). One test for the new branch.

## 2. A managed account paying by PayPal can move itself to a cheap public plan and keep the managed Meta package

- **Severity:** must · **Confidence:** medium (code path verified; PayPal accepting the `revise` between the two plans was not exercised — both are published under the same PayPal product, `plan-sync.ts:642`)
- **Where:** `src/app/api/billing/subscription/route.ts:477-575` (`change_plan`), `src/app/api/billing/checkout/route.ts:203-233`, `src/lib/billing/webhook-events.ts:568-621` (UPDATED), `src/lib/billing/statements.ts:320`
- **What the code does:** `change_plan` only requires a live PayPal subscription and a target plan with `is_public`. It never looks at `meta_billing`. The UPDATED webhook then writes `plan_id` and `cycle` only; `meta_billing = 'managed'`, `meta_pricing` and `payment_method = 'paypal'` stay. For `payment_method = 'paypal'` the statement bills `plan_fee_usd = 0` because "the fee is PayPal's".
- **Failure case:** account on `gestionado` (fee US$1,036/month through PayPal, 7,000 included messages, Cabbity pays Meta). Its admin POSTs `{action:'change_plan', planId:'inicio', cycle:'month'}`. PayPal now charges US$35/month. Statements still count 7,000 included messages against `meta_pricing`, charge fee 0, and Cabbity keeps paying Meta for the traffic. Same result through cancel → `POST /api/billing/checkout` with a public plan (the adoption path keeps `meta_*` too).
- **Tests:** none mention `managed` in `subscription/route.test.ts` or `checkout/route.test.ts`.
- **Smallest fix:** add `meta_billing` to `SUBSCRIPTION_COLUMNS` in both routes and answer 409 for `change_plan` and for checkout POST when it is `'managed'` (plan changes for those accounts already go through the operator's `/api/platform/accounts/[id]/plan`). One test per route.

## 3. An issued statement is due 3 days after the cut-off, not after it was issued — a late issue locks the account immediately

- **Severity:** should · **Confidence:** high
- **Where:** `src/lib/billing/statement-cron.ts:222` (`dueAt = statementDueAt(periodEnd)`), `src/lib/billing/statements.ts:385-387`, `src/lib/billing/entitlements.ts:339-346`
- **What the code does:** `due_at` is always `period_end + 3 days`, whatever the date of issue. A statement that could not be built is retried every run (`rate_missing`, `pricing`, `database`), and the scheduler is external.
- **Failure case:** cut-off 1 Oct; a Meta rate for one market is missing, so the account is skipped hourly. The operator loads the rate on 8 Oct. The statement is issued on 8 Oct with `due_at = 4 Oct`: `isStatementOverdue` is true in the same instant, the account is read-only before anyone saw the bill, and `applyLock` writes `past_due` with a grace already expired. The `statement_due` email is also skipped (its 72 h window around `due_at` has passed). Same for every managed account if the scheduler is down for more than 3 days.
- **Tests:** the cron tests always issue on the cut-off day (`due_at: '2026-11-04'` for a 1 Nov cut).
- **Smallest fix:** `const dueAt = statementDueAt(new Date(Math.max(Date.parse(periodEnd), Date.now())).toISOString())` in `processOne`. The 078 CHECK (`due_at >= period_end`) still holds. One test with `now` a week after the anchor.

## 4. Deliveries whose status webhook lands after the cut are never billed

- **Severity:** should · **Confidence:** medium (mechanism verified; how often Meta delivers statuses late was not measured)
- **Where:** `src/lib/billing/statements.ts:540-565` (`loadPeriodCharges` filters on `delivered_at`), `src/lib/billing/statement-cron.ts:259-268`, `supabase/migrations/075_message_charges.sql:183-198` and `:230-234`, `src/app/api/whatsapp/webhook/route.ts:844`
- **What the code does:** `message_charges.delivered_at` is Meta's event timestamp (`eventAt: tsIso`), not arrival time, and `LEAST(...)` can move it earlier later on. The cron issues the statement for `[start, period_end)` on the first hourly run after the anchor; the next period starts exactly at that `period_end`.
- **Failure case:** cut-off 1 Nov 00:00, cron runs 00:05 and issues. A broadcast message delivered at 31 Oct 23:58 has its `delivered` status retried by Meta and received at 00:20 (a redeploy of the single container is enough; Meta retries for days). The row gets `delivered_at = 31 Oct 23:58`: inside a period already issued, before the start of the next one. It is in no statement. Same when a `read` (after the cut) arrives first and a later `delivered` (before the cut) pulls `delivered_at` back.
- **Tests:** none for a charge written after its period was issued.
- **Smallest fix:** let the sweep wait before cutting: `.lte('statement_period_end', new Date(now.getTime() - SETTLE_MS).toISOString())` with a few hours of margin (pairs with finding 3, so the wait does not eat the grace). It narrows the window; it does not close it for statuses that arrive days late.

## 5. The rate card is read without pagination — past 1,000 rows it silently prices with stale rates

- **Severity:** should · **Confidence:** medium (assumes Supabase's default `max-rows = 1000`, which `statements.ts:65` already assumes)
- **Where:** `src/lib/billing/meta-rates.ts:204-217` (`loadRateCard`), used by `statement-cron.ts:278`, `meta-usage.ts:611`, `broadcast-estimate/route.ts`
- **What the code does:** one `select` per table with no `order` and no `range`. `meta_rates` keeps every revision (PK `market, category, effective_from`); `rateFor` takes the newest loaded entry with `effective_from <= day`.
- **Failure case:** a full card is "a few hundred lines" (`rates/import/route.ts`). After a handful of imports the table passes 1,000 rows; PostgREST returns an arbitrary 1,000. If the newest row of `rest_of_latam|marketing` is among the dropped ones, `rateFor` finds the previous revision and the statement is issued with the old Meta rate — no error, wrong `meta_cost_usd` and wrong overage for every `multiplier` price. If all rows of a pair are dropped it fails loudly instead (`MetaRateMissingError`).
- **Tests:** `meta-rates.test.ts` builds cards from in-memory rows only.
- **Smallest fix:** page `meta_rates` with `.order('market').order('category').order('effective_from').range(...)` in a loop, as `loadPeriodCharges` does. `meta_market_countries` is bounded by ISO countries (~250) and can stay.

## 6. PayPal refunds and reversals are filed as "processed" and nobody sees them

- **Severity:** should · **Confidence:** high
- **Where:** `src/lib/billing/webhook-events.ts:30-37`, `src/app/api/billing/webhook/route.ts:256-261` and `:599-622`
- **What the code does:** any event outside the six handled types returns `skipped`, and `finishEvent` stamps `processed_at`. The reconciliation queue is `processed_at IS NULL AND error IS NOT NULL`, so these rows are not in it.
- **Failure case:** customer pays a yearly plan, then opens a dispute. PayPal sends `PAYMENT.SALE.REVERSED` (or the operator refunds: `PAYMENT.SALE.REFUNDED`). The row stays `active` with `current_period_end` a year ahead; the event is acknowledged and disappears among the processed ones. Service continues for a year unless someone notices in PayPal's dashboard.
- **Tests:** `webhook/route.test.ts:937-949` pins the current behaviour (`skipped`, no write).
- **Smallest fix:** in `handleEvent`, return `{ status: 'unmatched', note: 'refund/reversal — review by hand' }` for `PAYMENT.SALE.REFUNDED` and `PAYMENT.SALE.REVERSED`, so they land in the existing queue. No automatic state change.

## 7. Statement periods overlap after a month with no statement when the cut-off day is 29–31

- **Severity:** nice · **Confidence:** high
- **Where:** `src/lib/billing/statements.ts:350-382` (`subtractMonth`, `statementPeriodStart`), `src/lib/billing/statement-cron.ts:200-220` (zero-total branch), mirrored in `meta-usage.ts:128-162`
- **What the code does:** when a period totals 0 (PayPal account, no overage) no statement row is written and the anchor moves with `addCycle`, which clamps (31 Jan → 28 Feb). The next period has no previous statement to chain from, so it starts at `subtractMonth(anchor)` (28 Feb → 28 Jan).
- **Failure case:** PayPal managed account assigned on 31 Dec, 7,000 included. January `[31 Dec, 31 Jan)`: 6,500 delivered, 600 of them on 28–30 Jan → total 0, anchor → 28 Feb. February is computed over `[28 Jan, 28 Feb)`: those 600 count again, so 6,800 real February deliveries become 7,400 and 400 are billed as overage although neither month passed 7,000. One-off per account (3 days at most, 1 day for a 31 → 30 clamp); after it the anchor stays on the 28th/30th.
- **Tests:** `statements.test.ts:404-417` covers the clamp of each helper, not the two together.
- **Smallest fix:** in the zero-total branch pass the real previous cut forward: store the period with a `paid` US$0 statement row (status `paid`, `paid_at = now`, no lock) instead of writing nothing, so `statementPeriodStart` chains from it. Alternative with less surface: clamp new anchors to day ≤ 28 in `managedStatementAnchor` (`provisioning.ts:387-398`).

## 8. Two operators settling the same statement leave a false line in the bitácora

- **Severity:** nice · **Confidence:** medium (read, not reproduced)
- **Where:** `src/lib/platform/statements.ts:240-249`, `:279-307`, `:327-338`
- **What the code does:** reads the statement (`issued`), writes the audit row, patches the subscription, then updates the statement conditional on `status = 'issued'`. The loser of a race gets `not_open`, after its audit row was written.
- **Failure case:** operator A clicks «Anular» and operator B «Confirmar pago» on the same statement within the same second. Both pass the read; both audit rows are written. A's update wins: the statement is `void`, and the log keeps "payment confirmed: statement …, US$ 1,406.00, ref. …" for a payment that was never recorded. The subscription ends in the same state either way.
- **Tests:** none for concurrent settle.
- **Smallest fix:** when the final update matches 0 rows, append the outcome to the audit row just written (`details.outcome = 'lost_race'`) instead of only returning `not_open`.

---

## Checked and found sound

- PayPal signature: fails closed on a missing `PAYPAL_WEBHOOK_ID`, missing headers, non-PayPal `cert_url` and verification errors; raw bytes are forwarded; body proven to be one JSON object first.
- Webhook replay: `UNIQUE (provider, provider_event_id)` lock before processing; a finished event answers `duplicate`.
- Duplicate statements under concurrent crons: `UNIQUE (account_id, period_end)` + `upsert ignoreDuplicates`; the zero-total extension and `applyLock` are both filtered by the anchor read.
- A customer cannot mark a statement paid: `claim-paid` writes only `claimed_*`, scoped by `account_id` and `status = 'issued'`; confirm/void need `requirePlatformAdmin`.
- Account scoping on the service-role queries I read: every one carries `account_id`, except the documented cross-account sweeps.
- An overdue statement still locks a PayPal account whose row a renewal put back to `active` (`entitlements.ts:310-312`).
- Money rounding: sums are accumulated raw and rounded once to cents; no currency other than USD in the billing path (`src/lib/currency.ts` is deal formatting only).

## Not read

- `src/lib/billing/`: `plan-sync.ts` (only the product lines), `plan-catalog.ts`, `plan-prices`, `meta-rate-input.ts`, `public-plans.ts`, `paypal-catalog.ts`, `plan-admin.test-support.ts`.
- All test files (only grepped for specific cases).
- `src/app/api/platform/plans/**`, `src/app/api/platform/rates/route.ts` and `rates/markets`, `src/lib/platform/rates.ts`, `src/lib/platform/accounts.ts` (`setManualHold`, `loadAccountSummary`), `src/lib/platform/audit.ts`.
- `src/lib/platform/provisioning.ts` lines 1-354 and 600+, `managed-plan.ts` lines 1-119.
- Migrations other than 075 and 078: 041 and 076 only in part; 045, 048, 050, 056, 059, 065, 070, 073, 074, 077, 080, 083, 084 not read.
- Callers of `assertQuota` / `recordUsage` (send, broadcast, AI routes) — quota races and off-by-one at the call sites were not checked.
- `src/app/api/whatsapp/webhook/route.ts` beyond lines 835-848; `recordMessageCharge` swallowing an RPC error (a lost charge) was seen but not followed.
- UI components under `src/components/billing` and `src/components/platform`.
- PayPal's real behaviour (revise between plans, which events it emits) — nothing was called.
