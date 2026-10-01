import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { MINUTE_MS, startMinuteClock } from './use-minute-clock';

describe('startMinuteClock (R20)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-01T12:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('el intervalo es de 60 s', () => {
    expect(MINUTE_MS).toBe(60_000);
  });

  it('no avanza antes de 60 s y avanza a los 60 s con la hora nueva', () => {
    const setNow = vi.fn();
    const stop = startMinuteClock(setNow);
    vi.advanceTimersByTime(59_999);
    expect(setNow).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(setNow).toHaveBeenCalledTimes(1);
    expect(setNow).toHaveBeenLastCalledWith(Date.parse('2026-10-01T12:01:00Z'));
    vi.advanceTimersByTime(MINUTE_MS * 2);
    expect(setNow).toHaveBeenCalledTimes(3);
    stop();
  });

  it('la limpieza para el intervalo y no deja temporizadores vivos', () => {
    const setNow = vi.fn();
    const stop = startMinuteClock(setNow);
    expect(vi.getTimerCount()).toBe(1);
    stop();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(MINUTE_MS * 5);
    expect(setNow).not.toHaveBeenCalled();
  });

  it('montar y desmontar varias veces no acumula intervalos', () => {
    for (let i = 0; i < 5; i++) {
      const stop = startMinuteClock(vi.fn());
      stop();
    }
    expect(vi.getTimerCount()).toBe(0);
  });
});
