'use client';

import { useEffect, useState } from 'react';
import Image from 'next/image';
import { useTranslations } from 'next-intl';
import { BarChart3, Users, Zap } from 'lucide-react';
import { cn } from '@/lib/utils';
import { CabbityLogo } from './cabbity-logo';
import heroImage from '@/app/(auth)/_assets/login-hero.jpg';

/** Catalogue ids of the rotating headline/quote pairs, in display order. */
export const HERO_SLIDES = ['growth', 'clients', 'results'] as const;
export type HeroSlide = (typeof HERO_SLIDES)[number];

const FEATURES = [
  { id: 'clients', Icon: Users, tone: 'bg-peach/70 text-brand' },
  { id: 'sales', Icon: BarChart3, tone: 'bg-sky-100 text-sky-600' },
  { id: 'productivity', Icon: Zap, tone: 'bg-emerald-100 text-positive' },
] as const;

/** Milliseconds a slide stays before the hero advances on its own. */
export const SLIDE_INTERVAL_MS = 6500;

interface AuthHeroProps {
  /** Slide shown first. Exposed for tests; the page starts at 0. */
  initialSlide?: number;
}

/**
 * Left half of the auth shell: brand lockup, a rotating headline with
 * three value propositions, the feature list and the hero photograph.
 * Hidden below `lg` — the card carries the lockup on phones.
 *
 * Auto-advance pauses while the pointer is over the panel and never
 * starts for visitors with `prefers-reduced-motion: reduce`; the dots
 * remain clickable in both cases.
 */
export function AuthHero({ initialSlide = 0 }: AuthHeroProps) {
  const t = useTranslations('LoginPage');
  const [index, setIndex] = useState(initialSlide % HERO_SLIDES.length);
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    if (paused) return;
    if (
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    ) {
      return;
    }
    const timer = window.setInterval(() => {
      setIndex((i) => (i + 1) % HERO_SLIDES.length);
    }, SLIDE_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [paused]);

  const slide = HERO_SLIDES[index];

  return (
    <aside
      data-slot="auth-hero"
      className="bg-background relative hidden h-full overflow-hidden lg:flex"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
    >
      {/* Photograph on the right 60% of the panel, framed so the person
          stays clear of the copy column at every desktop width. */}
      <div className="animate-in fade-in absolute inset-y-0 right-0 left-[40%] duration-1000 motion-reduce:animate-none">
        <div className="relative h-full w-full">
          <Image
            src={heroImage}
            alt={t('hero.imageAlt')}
            fill
            preload
            placeholder="blur"
            sizes="(min-width: 1024px) 45vw, 0px"
            className="object-cover object-[45%_center]"
          />
        </div>
        {/* Fade the photo into the copy column. */}
        <div className="from-background via-background/85 absolute inset-0 bg-gradient-to-r via-35% to-transparent" />
        <div className="from-background/90 absolute inset-x-0 top-0 h-40 bg-gradient-to-b to-transparent" />
      </div>

      {/* Warm blob peeking from the bottom-left corner. */}
      <div
        aria-hidden="true"
        className="bg-peach/40 animate-auth-drift absolute -bottom-32 -left-24 size-[28rem] rounded-full blur-3xl motion-reduce:animate-none"
      />

      <div className="relative z-10 flex w-full max-w-[min(34rem,54%)] flex-col justify-between px-10 py-8 xl:px-14 xl:py-10">
        <div className="animate-in fade-in slide-in-from-bottom-4 fill-mode-backwards duration-700 motion-reduce:animate-none">
          <CabbityLogo tagline={t('brand.tagline')} size="lg" />
        </div>

        <div className="my-6 flex flex-col gap-[clamp(1.25rem,3vh,2rem)] xl:my-8">
          {/* Re-keyed on every slide so the entrance animation replays. */}
          <div
            key={slide}
            className="animate-in fade-in slide-in-from-bottom-3 flex flex-col gap-5 duration-700 motion-reduce:animate-none"
            aria-live="polite"
          >
            <h2 className="font-heading text-navy text-[clamp(2rem,4.6vh,3rem)] leading-[1.08] font-extrabold tracking-tight">
              {t(`hero.slides.${slide}.lead`)}{' '}
              <span className="text-brand">
                {t(`hero.slides.${slide}.accent`)}
              </span>
            </h2>
            <p className="text-muted-foreground max-w-[26rem] text-base leading-relaxed xl:text-lg">
              {t(`hero.slides.${slide}.body`)}
            </p>
          </div>

          <ul className="flex flex-col gap-[clamp(0.5rem,1.6vh,1rem)]">
            {FEATURES.map(({ id, Icon, tone }, i) => (
              <li
                key={id}
                className="group animate-in fade-in slide-in-from-bottom-4 fill-mode-backwards flex items-center gap-4 duration-700 motion-reduce:animate-none"
                style={{ animationDelay: `${250 + i * 120}ms` }}
              >
                <span
                  className={cn(
                    'flex size-[clamp(2.75rem,5.6vh,3.5rem)] shrink-0 items-center justify-center rounded-full transition-transform duration-300 group-hover:-translate-y-0.5 group-hover:scale-105',
                    tone
                  )}
                >
                  <Icon className="size-6" strokeWidth={2.2} />
                </span>
                <div className="flex flex-col">
                  <span className="text-navy text-lg font-semibold">
                    {t(`hero.features.${id}.title`)}
                  </span>
                  <span className="text-muted-foreground text-sm">
                    {t(`hero.features.${id}.desc`)}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </div>

        <div className="animate-in fade-in slide-in-from-bottom-2 fill-mode-backwards flex flex-col gap-6 delay-500 duration-700 motion-reduce:animate-none">
          <div className="flex items-center gap-2" role="tablist">
            {HERO_SLIDES.map((id, i) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={i === index}
                aria-label={t('hero.goToSlide', { n: i + 1 })}
                onClick={() => setIndex(i)}
                className={cn(
                  'h-1.5 rounded-full transition-all duration-500',
                  i === index
                    ? 'bg-brand w-10'
                    : 'bg-navy/15 hover:bg-navy/30 w-6'
                )}
              />
            ))}
          </div>
          <blockquote
            key={`quote-${slide}`}
            className="text-muted-foreground animate-in fade-in max-w-[24rem] text-base leading-relaxed italic duration-700 motion-reduce:animate-none [@media(max-height:760px)]:hidden"
          >
            “{t(`hero.slides.${slide}.quote`)}”
          </blockquote>
        </div>
      </div>
    </aside>
  );
}
