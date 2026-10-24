/**
 * «Sin mensaje del cliente desde N minutos» — the pure half of the
 * `conversation_idle` condition subject (the engine does the one query).
 *
 * Why it exists: a `wait` step cannot tell whether the customer wrote
 * again while the run was parked, so «wait 24 h → add tag» tagged
 * active threads as unanswered whenever an older run's timer fired
 * after a newer inbound. This condition lets the resumed run ask the
 * only question that matters — «is the customer still silent?» — with
 * the operand as the threshold in minutes.
 */

/** Minutes of silence the operand asks for; `null` when it is not a
 *  positive whole number (the builder stores it as a string). */
export function parseIdleMinutes(operand: unknown): number | null {
  const n = Number(String(operand ?? '').trim());
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) return null;
  return n;
}

/**
 * True when the customer's last message is at least `minutes` old, or
 * when the customer never wrote at all (an outbound-only thread is, for
 * this purpose, unanswered).
 */
export function isIdleSince(
  lastCustomerMessageAt: string | null,
  minutes: number,
  now: number = Date.now()
): boolean {
  if (!lastCustomerMessageAt) return true;
  const last = Date.parse(lastCustomerMessageAt);
  if (!Number.isFinite(last)) return false;
  return now - last >= minutes * 60_000;
}
