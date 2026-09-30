import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CONTINUE_DELAY_MS, scheduleContinue } from './checkout-return';

// s9.6: /onboarding/return moves on to the dashboard by itself once the
// webhook activated the plan — and only then.

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('scheduleContinue', () => {
  it('goes to the dashboard after the delay once the plan is active', () => {
    const navigate = vi.fn();
    scheduleContinue(
      { phase: 'active', continueOnActive: true, href: '/dashboard' },
      navigate
    );
    vi.advanceTimersByTime(CONTINUE_DELAY_MS - 1);
    expect(navigate).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(navigate).toHaveBeenCalledWith('/dashboard');
  });

  it.each(['confirming', 'slow'])('does not move while %s', (phase) => {
    const navigate = vi.fn();
    expect(
      scheduleContinue(
        { phase, continueOnActive: true, href: '/dashboard' },
        navigate
      )
    ).toBeUndefined();
    vi.runAllTimers();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('/billing/return (no continueOnActive) never moves on its own', () => {
    const navigate = vi.fn();
    scheduleContinue(
      { phase: 'active', continueOnActive: false, href: '/dashboard' },
      navigate
    );
    vi.runAllTimers();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('cancels when the page unmounts first', () => {
    const navigate = vi.fn();
    const cleanup = scheduleContinue(
      { phase: 'active', continueOnActive: true, href: '/dashboard' },
      navigate
    );
    cleanup?.();
    vi.runAllTimers();
    expect(navigate).not.toHaveBeenCalled();
  });
});
