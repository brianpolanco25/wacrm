'use client';

// ============================================================
// Cuota gratis de mensajes de servicio por número (p11.3) — una lectura
// de `GET /api/whatsapp/service-cap` por cuenta, compartida por la
// bandeja (aviso) y Ajustes → WhatsApp (uso por número y el ajuste).
//
// Las tres reglas de `use-billing-status.ts`, por las mismas razones:
//
//   1. Clave por `accountId`: una sesión de soporte o un cambio de
//      empresa nunca ve la cuota de la cuenta anterior.
//   2. Un fallo es `null` = **sin dato**, nunca «agotado» ni «todo
//      bien». Quien lo use no pinta nada (R8).
//   3. Las lecturas buenas caducan (TTL 60 s), y `refresh()` la fuerza
//      tras guardar el ajuste.
// ============================================================

import { useCallback, useEffect, useState } from 'react';

import { useAuth } from '@/hooks/use-auth';

export interface ServiceCapNumber {
  id: string;
  label: string | null;
  displayPhoneNumber: string | null;
  used: number;
  billable: number;
  exhausted: boolean;
}

/** El cuerpo de `GET /api/whatsapp/service-cap`. */
export interface ServiceCapStatus {
  metaBilling: 'direct' | 'managed';
  action: 'warn' | 'pause_ai';
  freeTier: number;
  monthStart: string;
  resetsAt: string;
  numbers: ServiceCapNumber[];
}

export const SERVICE_CAP_TTL_MS = 60_000;

interface CacheEntry {
  status: ServiceCapStatus;
  at: number;
}

const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<ServiceCapStatus | null>>();
/**
 * Generación de la última petición por cuenta. Una petición forzada (tras
 * guardar el ajuste) no anula la que ya iba en vuelo; si la vieja responde
 * después, no puede pisar la caché con la acción anterior.
 */
const generation = new Map<string, number>();

/** `null` cuando no se pudo leer (respuesta no OK o error de red). */
export function fetchServiceCap(
  accountId: string,
  opts: { force?: boolean } = {}
): Promise<ServiceCapStatus | null> {
  const cached = cache.get(accountId);
  if (!opts.force && cached && Date.now() - cached.at < SERVICE_CAP_TTL_MS) {
    return Promise.resolve(cached.status);
  }
  if (cached) cache.delete(accountId);
  const pending = inFlight.get(accountId);
  if (pending && !opts.force) return pending;

  const gen = (generation.get(accountId) ?? 0) + 1;
  generation.set(accountId, gen);
  const request = (async () => {
    try {
      const res = await fetch('/api/whatsapp/service-cap', {
        cache: 'no-store',
      });
      if (!res.ok) return null;
      const status = (await res.json()) as ServiceCapStatus;
      if (!status || !Array.isArray(status.numbers)) return null;
      if (generation.get(accountId) === gen) {
        cache.set(accountId, { status, at: Date.now() });
      }
      return status;
    } catch {
      return null;
    }
  })();

  inFlight.set(accountId, request);
  void request.finally(() => {
    if (inFlight.get(accountId) === request) inFlight.delete(accountId);
  });
  return request;
}

/** Test seam — vacía las cachés del módulo entre casos. */
export function __resetServiceCapCache() {
  cache.clear();
  inFlight.clear();
  generation.clear();
}

/**
 * La cuota del mes de la cuenta, o `null` mientras no se sepa (aún no
 * llegó, sin cuenta, o la lectura falló). `refresh()` vuelve a pedirla
 * saltándose la caché.
 */
export function useServiceCap(): {
  status: ServiceCapStatus | null;
  refresh: () => void;
} {
  const { accountId } = useAuth();
  const [state, setState] = useState<{
    accountId: string;
    status: ServiceCapStatus | null;
  } | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!accountId) return;
    let alive = true;
    fetchServiceCap(accountId, { force: nonce > 0 }).then((status) => {
      if (alive) setState({ accountId, status });
    });
    return () => {
      alive = false;
    };
  }, [accountId, nonce]);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  // Regla 1: lo leído para otra cuenta no se enseña.
  const status =
    state && accountId && state.accountId === accountId ? state.status : null;
  return { status, refresh };
}
