'use client';

import { useSyncExternalStore } from 'react';
import { Moon, Sun } from 'lucide-react';

import { useTheme } from '@/hooks/use-theme';
import type { Mode } from '@/lib/themes';
import { cn } from '@/lib/utils';

import { useTranslations } from 'next-intl';

const noopSubscribe = () => () => {};

/**
 * `true` once the component has hydrated on the client, `false` on the
 * server and during the hydration render itself (React uses the server
 * snapshot there), so the first client render matches the server HTML.
 */
function useMounted(): boolean {
  return useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false
  );
}

/**
 * Light/dark mode toggle — a single icon button that flips the app
 * between the two modes. Sun shows in light mode (click → go dark),
 * moon shows in dark mode (click → go light); the label always names
 * the destination so screen-reader users hear what the click does.
 *
 * The mode is only known on the client (the boot script sets
 * `data-mode` before hydration), so until mounted the button renders
 * the same neutral state the server did — Sun with a generic label —
 * and only then switches to the real one. Without this, any shell that
 * server-renders the toggle (`PlatformFrame`) hit a hydration mismatch
 * in dark mode (s9.11).
 *
 * 40×40 hit target to match the header's other touch controls.
 */
export function ModeToggle({ className }: { className?: string }) {
  const { mode, toggleMode } = useTheme();
  const mounted = useMounted();
  return (
    <ModeToggleButton
      mode={mode}
      mounted={mounted}
      onToggle={toggleMode}
      className={className}
    />
  );
}

/** Presentational half of `ModeToggle`, exported for tests. */
export function ModeToggleButton({
  mode,
  mounted,
  onToggle,
  className,
}: {
  mode: Mode;
  mounted: boolean;
  onToggle: () => void;
  className?: string;
}) {
  const t = useTranslations('ModeToggle');
  const goingTo = mode === 'dark' ? 'light' : 'dark';
  const label = mounted ? t('switchMode', { mode: goingTo }) : t('toggle');
  const showMoon = mounted && mode === 'dark';

  return (
    <button
      type="button"
      onClick={onToggle}
      aria-label={label}
      title={label}
      className={cn(
        'text-muted-foreground hover:bg-muted hover:text-foreground flex h-10 w-10 items-center justify-center rounded-md transition-colors',
        className
      )}
    >
      {showMoon ? <Moon className="h-5 w-5" /> : <Sun className="h-5 w-5" />}
    </button>
  );
}
