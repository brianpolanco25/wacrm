import type { ReactNode } from 'react';
import { AuthHero } from './auth-hero';
import { CabbityMark } from './cabbity-logo';

/**
 * Two-column frame shared by every `(auth)` page. The `.auth-brand`
 * class on the root pins the corporate palette (see globals.css) so the
 * card and its shadcn primitives render orange-on-light regardless of
 * the accent/mode the visitor's browser remembers.
 */
export function AuthShell({ children }: { children: ReactNode }) {
  return (
    <div className="auth-brand bg-background text-foreground min-h-dvh lg:grid lg:h-dvh lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)] lg:overflow-hidden">
      <AuthHero />

      {/* Decorations live on a non-scrolling layer; only the inner column
          scrolls when a tall card (sign-up on a short laptop) overflows,
          so the page itself never grows past the viewport on desktop. */}
      <main className="relative min-h-dvh overflow-hidden lg:h-full lg:min-h-0">
        {/* Orange sweep + dot grid, bottom-right, as in the handoff. */}
        <div
          aria-hidden="true"
          className="from-brand/80 via-brand/45 to-peach/70 animate-auth-drift pointer-events-none absolute -right-40 -bottom-56 size-[34rem] rounded-full bg-gradient-to-tl motion-reduce:animate-none sm:-right-32 sm:-bottom-48 lg:-right-24 lg:-bottom-40 lg:size-[38rem]"
        />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute right-8 bottom-10 size-32 [background-image:radial-gradient(circle,#ffffff_1.5px,transparent_1.6px)] [background-size:16px_16px] opacity-90 lg:size-40"
        />
        <CabbityMark
          aria-hidden="true"
          className="text-brand/[0.07] pointer-events-none absolute -bottom-6 -left-8 size-40 -rotate-12 lg:hidden"
        />

        <div className="relative z-10 flex min-h-dvh justify-center px-4 py-8 sm:px-8 lg:absolute lg:inset-0 lg:min-h-0 lg:overflow-y-auto [@media(max-height:760px)]:py-5">
          <div className="animate-in fade-in slide-in-from-bottom-6 zoom-in-95 fill-mode-backwards my-auto w-full max-w-md delay-150 duration-700 motion-reduce:animate-none">
            {children}
          </div>
        </div>
      </main>
    </div>
  );
}
