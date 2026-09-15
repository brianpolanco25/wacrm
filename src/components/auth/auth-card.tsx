import type { ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils';
import { CabbityLogo } from './cabbity-logo';

interface AuthCardProps {
  title: ReactNode;
  description?: ReactNode;
  /**
   * Optional glyph for states that are not "the brand" — a check mark
   * on the "email sent" screens, a people icon when accepting an invite.
   * Rendered in a soft brand disc under the lockup.
   */
  icon?: ReactNode;
  children: ReactNode;
  className?: string;
}

/**
 * The white card every auth screen sits in. Owns the brand lockup, the
 * heading pair and the surface; pages own the form. Lives inside
 * `AuthShell` (see `(auth)/layout.tsx`), which supplies the `.auth-brand`
 * tokens the card's `bg-card` / `text-foreground` resolve against.
 */
export function AuthCard({
  title,
  description,
  icon,
  children,
  className,
}: AuthCardProps) {
  const t = useTranslations('LoginPage');
  return (
    <section
      data-slot="auth-card"
      className={cn(
        'bg-card text-card-foreground ring-navy/5 flex w-full flex-col gap-6 rounded-3xl px-6 py-8 shadow-[0_24px_60px_-24px_rgba(27,24,21,0.22)] ring-1 sm:px-10 sm:py-10 [@media(max-height:760px)]:gap-5 [@media(max-height:760px)]:sm:py-7',
        className
      )}
    >
      <header className="flex flex-col items-center gap-5 text-center">
        <CabbityLogo
          orientation="column"
          tagline={t('brand.kicker')}
          className="animate-in fade-in zoom-in-95 duration-700 motion-reduce:animate-none"
        />
        {icon ? (
          <div className="bg-brand-soft text-brand flex size-12 items-center justify-center rounded-2xl">
            {icon}
          </div>
        ) : null}
        <div className="flex flex-col gap-1.5">
          <h1 className="font-heading text-navy text-2xl font-bold tracking-tight">
            {title}
          </h1>
          {description ? (
            <p className="text-muted-foreground text-sm sm:text-base">
              {description}
            </p>
          ) : null}
        </div>
      </header>
      {children}
    </section>
  );
}
