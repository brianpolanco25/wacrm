'use client';

import { useEffect, useState } from 'react';

/** Cada cuánto avanza el reloj de la bandeja (p11.6, R20). */
export const MINUTE_MS = 60_000;

/**
 * El cuerpo del efecto de `useMinuteClock`, aparte para poder probarlo
 * con temporizadores falsos (el repo no tiene jsdom ni testing-library).
 * Devuelve la limpieza, que para el intervalo.
 */
export function startMinuteClock(setNow: (now: number) => void): () => void {
  const tick = setInterval(() => setNow(Date.now()), MINUTE_MS);
  return () => clearInterval(tick);
}

/**
 * Hora actual que avanza cada minuto. Un reloj por componente (la lista
 * y la cabecera), nunca uno por fila, y nunca `Date.now()` en el render
 * (regla de pureza de React 19). Mismo patrón que `use-presence.ts`.
 */
export function useMinuteClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => startMinuteClock(setNow), []);
  return now;
}
