import type { Metadata } from 'next';
import Link from 'next/link';
import { createTranslator } from 'next-intl';
import { Check } from 'lucide-react';

import { CabbityMark } from '@/components/auth/cabbity-logo';
import { DOCS_LOCALES, type DocsLocale } from '@/content/developers/types';
import { resolveDocsLocale } from '@/content/developers/nav';
import { LEGAL_ENTITY } from '@/content/legal';
import {
  formatCount,
  META_FREE_SERVICE_PER_NUMBER,
  metaFreeServiceFor,
  PUBLIC_PLANS,
  type PublicPlan,
} from '@/lib/billing/public-plans';

import en from '../../../messages/en.json';
import es from '../../../messages/es.json';

// ============================================================
// `/precios` (fase 11, p11.2): the public price list and its FAQ.
//
// Same rules as the legal pages and `/developers`: no session, language
// from `?lang=` (es | en) and otherwise the instance's. The prose lives
// in `messages/*.json` under `Pricing`, so the catalogue tests (parity,
// forbidden phrases) cover it like any other screen.
//
// What it has to make clear: Cabbity charges for the plan, Meta charges
// for WhatsApp messages separately and directly; Meta's free service
// allowance is per number (Negocio, 3 numbers → 3,000); the plan's
// message counts are what it includes, not a wall.
// ============================================================

export interface PricingPageProps {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}

const CATALOGUES = { es, en } as const;

/** FAQ entries, in the order the page lists them. */
export const PRICING_FAQ = [
  'whoCharges',
  'metaIncluded',
  'freeQuota',
  'negocio',
  'rates',
  'paymentMethod',
  'usedUp',
] as const;

function translator(locale: DocsLocale) {
  return createTranslator({
    locale,
    messages: CATALOGUES[locale],
    namespace: 'Pricing',
  });
}

async function readLocale(props: PricingPageProps): Promise<DocsLocale> {
  const { lang } = await props.searchParams;
  return resolveDocsLocale(lang);
}

export async function pricingMetadata(
  props: PricingPageProps
): Promise<Metadata> {
  const t = translator(await readLocale(props));
  return {
    title: t('seoTitle'),
    description: t('seoDescription'),
    robots: { index: true, follow: true },
  };
}

function PlanCard({ plan, locale }: { plan: PublicPlan; locale: DocsLocale }) {
  const t = translator(locale);
  const n = (value: number) => formatCount(value, locale);
  const { limits } = plan;
  const free = metaFreeServiceFor(limits.numbers);
  const lines = [
    t('operators', { count: n(limits.operators) }),
    t('messagesOut', { count: n(limits.messages_out) }),
    t('aiReplies', { count: n(limits.ai_replies) }),
    t('broadcastRecipients', { count: n(limits.broadcast_recipients) }),
    t('numbers', { count: limits.numbers }),
    t('freeService', {
      numbers: limits.numbers,
      free: n(free),
      perNumber: n(META_FREE_SERVICE_PER_NUMBER),
    }),
  ];

  return (
    <section
      aria-labelledby={`plan-${plan.id}`}
      className="border-border rounded-xl border p-6"
    >
      <h3 id={`plan-${plan.id}`} className="text-lg font-semibold">
        {plan.name}
      </h3>
      <p className="mt-1 text-2xl font-bold">
        {t('priceMonth', { price: n(plan.priceUsdMonth) })}
      </p>
      <p className="text-muted-foreground text-sm">
        {t('priceYear', { price: n(plan.priceUsdYear) })}
      </p>
      <ul className="text-muted-foreground mt-4 space-y-1.5 text-sm">
        {lines.map((line) => (
          <li key={line} className="flex items-start gap-2">
            <Check
              className="text-primary mt-0.5 h-4 w-4 flex-shrink-0"
              aria-hidden
            />
            <span>{line}</span>
          </li>
        ))}
      </ul>
      {limits.numbers > 1 && (
        <p className="mt-4 text-sm">
          {t('freePerNumberNote', {
            numbers: limits.numbers,
            free: n(free),
          })}
        </p>
      )}
    </section>
  );
}

export async function PricingPage(props: PricingPageProps) {
  const locale = await readLocale(props);
  const t = translator(locale);
  const lang = `?lang=${locale}`;

  return (
    <div className="bg-background text-foreground min-h-screen">
      <header className="border-border border-b">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3 px-4 py-4">
          <Link href="/" className="flex items-center gap-2">
            <CabbityMark className="text-brand size-8" />
            <span className="font-heading text-xl font-extrabold tracking-tight">
              {LEGAL_ENTITY.brand}
            </span>
          </Link>
          <nav className="flex gap-3 text-sm">
            {DOCS_LOCALES.map((l) => (
              <Link
                key={l}
                href={`/precios?lang=${l}`}
                aria-current={l === locale ? 'true' : undefined}
                className={
                  l === locale
                    ? 'font-semibold'
                    : 'text-muted-foreground hover:text-foreground'
                }
              >
                {l.toUpperCase()}
              </Link>
            ))}
          </nav>
        </div>
      </header>

      <main className="mx-auto max-w-5xl space-y-12 px-4 py-10">
        <div>
          <h1 className="font-heading text-3xl font-extrabold tracking-tight">
            {t('title')}
          </h1>
          <p className="text-muted-foreground mt-2 max-w-3xl">
            {t('subtitle')}
          </p>
        </div>

        <div>
          <div className="grid gap-4 md:grid-cols-3">
            {PUBLIC_PLANS.map((plan) => (
              <PlanCard key={plan.id} plan={plan} locale={locale} />
            ))}
          </div>
          <p className="mt-4 max-w-3xl text-sm leading-relaxed">
            {t('includedNote')}
          </p>
          <p className="text-muted-foreground mt-2 text-xs">{t('taxNote')}</p>
          <div className="mt-6 flex flex-wrap gap-3 text-sm">
            <Link
              href="/signup"
              className="bg-primary text-primary-foreground rounded-md px-4 py-2 font-semibold"
            >
              {t('signup')}
            </Link>
            <Link
              href="/login"
              className="border-border rounded-md border px-4 py-2 font-semibold"
            >
              {t('login')}
            </Link>
          </div>
        </div>

        <section aria-labelledby="who-charges" className="max-w-3xl">
          <h2 id="who-charges" className="text-xl font-bold">
            {t('who.title')}
          </h2>
          <div className="mt-4 grid gap-4 md:grid-cols-2">
            <div className="border-border rounded-xl border p-5">
              <h3 className="font-semibold">{t('who.cabbityTitle')}</h3>
              <p className="mt-2 text-sm leading-relaxed">
                {t('who.cabbityBody')}
              </p>
            </div>
            <div className="border-border rounded-xl border p-5">
              <h3 className="font-semibold">{t('who.metaTitle')}</h3>
              <p className="mt-2 text-sm leading-relaxed">
                {t('who.metaBody')}
              </p>
            </div>
          </div>
        </section>

        <section aria-labelledby="meta-free" className="max-w-3xl">
          <h2 id="meta-free" className="text-xl font-bold">
            {t('free.title')}
          </h2>
          <p className="mt-3 leading-relaxed">{t('free.service')}</p>
          <p className="mt-3 leading-relaxed">{t('free.perNumber')}</p>
          <p className="mt-3 leading-relaxed">{t('free.window')}</p>
          <h3 className="mt-6 font-semibold">{t('example.title')}</h3>
          <p className="mt-2 leading-relaxed">{t('example.body')}</p>
        </section>

        <section aria-labelledby="meta-payment" className="max-w-3xl">
          <h2 id="meta-payment" className="text-xl font-bold">
            {t('payment.title')}
          </h2>
          <p className="mt-3 leading-relaxed">{t('payment.body')}</p>
        </section>

        <section aria-labelledby="faq" className="max-w-3xl">
          <h2 id="faq" className="text-xl font-bold">
            {t('faq.title')}
          </h2>
          <dl className="mt-4 space-y-5">
            {PRICING_FAQ.map((id) => (
              <div key={id} id={`faq-${id}`}>
                <dt className="font-semibold">{t(`faq.${id}.q`)}</dt>
                <dd className="mt-1 leading-relaxed">{t(`faq.${id}.a`)}</dd>
              </div>
            ))}
          </dl>
        </section>
      </main>

      <footer className="border-border border-t">
        <div className="text-muted-foreground mx-auto flex max-w-5xl flex-wrap gap-x-5 gap-y-2 px-4 py-6 text-sm">
          <Link href={`/terms${lang}`} className="hover:text-foreground">
            {t('footerTerms')}
          </Link>
          <Link href={`/privacy${lang}`} className="hover:text-foreground">
            {t('footerPrivacy')}
          </Link>
          <span>
            © {LEGAL_ENTITY.legalName} · {LEGAL_ENTITY.email}
          </span>
        </div>
      </footer>
    </div>
  );
}
