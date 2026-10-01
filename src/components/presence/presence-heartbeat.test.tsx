import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { HEARTBEAT_MS } from '@/lib/presence';
import {
  startPresenceHeartbeat,
  type HeartbeatEnv,
} from './presence-heartbeat';

// s9.12: no `touch_presence` while a support session is open. Migration
// 072 and `guardReadOnly` refuse it anyway; beating only produced a
// `console.error` every 30 seconds under the customer's banner.
//
// The effect body is a plain function (`startPresenceHeartbeat`) so it
// runs here without a DOM: the test environment is `node`, with no jsdom.

function fakeEnv(inSession = false) {
  const listeners = new Map<string, Set<() => void>>();
  const target = {
    addEventListener: vi.fn((type: string, fn: () => void) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(fn);
    }),
    removeEventListener: vi.fn((type: string, fn: () => void) => {
      listeners.get(type)?.delete(fn);
    }),
  };
  const touch = vi.fn(async () => ({ error: null }));
  const state = { inSession };
  const env: HeartbeatEnv = {
    touch,
    inSupportSession: () => state.inSession,
    document: {
      hidden: false,
      ...target,
    } as unknown as HeartbeatEnv['document'],
    window: target as unknown as HeartbeatEnv['window'],
  };
  const fire = (type: string) => listeners.get(type)?.forEach((fn) => fn());
  return { env, touch, target, state, fire };
}

const ACCOUNT = 'aaaaaaaa-0000-4000-8000-000000000001';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-30T12:00:00Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('PresenceHeartbeat', () => {
  it('beats right away and every HEARTBEAT_MS outside a support session', async () => {
    const { env, touch } = fakeEnv();
    const stop = startPresenceHeartbeat(ACCOUNT, false, env);
    await vi.advanceTimersByTimeAsync(0);
    expect(touch).toHaveBeenCalledTimes(1);
    expect(touch).toHaveBeenLastCalledWith('online');
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
    expect(touch).toHaveBeenCalledTimes(2);
    stop();
  });

  it('never calls touch_presence during a support session, and logs nothing', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { env, touch, target, fire } = fakeEnv(true);
    const stop = startPresenceHeartbeat(ACCOUNT, true, env);
    fire('focus');
    fire('visibilitychange');
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS * 4);
    expect(touch).not.toHaveBeenCalled();
    // Nothing to clean up either: it never attached a listener.
    expect(target.addEventListener).not.toHaveBeenCalled();
    expect(errors).not.toHaveBeenCalled();
    stop();
    errors.mockRestore();
  });

  it('stands down when a session opens while it is running (before the re-render)', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { env, touch, state } = fakeEnv(false);
    const stop = startPresenceHeartbeat(ACCOUNT, false, env);
    await vi.advanceTimersByTimeAsync(0);
    expect(touch).toHaveBeenCalledTimes(1);

    state.inSession = true;
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS * 3);
    expect(touch).toHaveBeenCalledTimes(1);
    expect(errors).not.toHaveBeenCalled();
    stop();
    errors.mockRestore();
  });

  it('does nothing until the account is known', async () => {
    const { env, touch } = fakeEnv();
    const stop = startPresenceHeartbeat(null, false, env);
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS * 2);
    expect(touch).not.toHaveBeenCalled();
    stop();
  });

  it('stops beating and detaches its listeners on cleanup', async () => {
    const { env, touch, target } = fakeEnv();
    const stop = startPresenceHeartbeat(ACCOUNT, false, env);
    await vi.advanceTimersByTimeAsync(0);
    stop();
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS * 3);
    expect(touch).toHaveBeenCalledTimes(1);
    expect(target.removeEventListener).toHaveBeenCalledTimes(
      target.addEventListener.mock.calls.length
    );
  });
});
