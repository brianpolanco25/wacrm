import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

import en from '../../../messages/en.json';
import es from '../../../messages/es.json';

import { PRICING_FAQ, PricingPage, pricingMetadata } from './pricing-page';

/**
 * p11.2: the public price list says who charges what (Cabbity the plan,
 * Meta the messages), that Meta's free allowance is per number (Negocio,
 * 3 numbers → 3,000) and that the plan's messages are included, not a
 * wall — in both catalogues.
 */

async function render(lang?: string) {
  const element = await PricingPage({
    searchParams: Promise.resolve(lang ? { lang } : {}),
  });
  // Entities back to text so the assertions read like the catalogue.
  return renderToStaticMarkup(element)
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, '&');
}

describe('/precios', () => {
  it('lists the three public plans with their price, never a hidden one', async () => {
    const html = await render('es');
    for (const name of ['Inicio', 'Pro', 'Negocio']) {
      expect(html).toContain(`>${name}</h3>`);
    }
    expect(html).toContain('35 USD / mes');
    expect(html).toContain('100 USD / mes');
    expect(html).toContain('199 USD / mes');
    expect(html).toContain('o 1.990 USD al año');
    expect(html).not.toMatch(/gestionado|ilimitado|1\.036/i);
  });

  it('words the plan messages as included (es)', async () => {
    const html = await render('es');
    expect(html).toContain('3.000 mensajes salientes incluidos al mes');
    expect(html).toContain('60.000 mensajes salientes incluidos al mes');
    expect(html).toContain(es.Pricing.includedNote);
  });

  it('explains that 3 numbers are 3.000 free service messages on Negocio (es)', async () => {
    const html = await render('es');
    expect(html).toContain('3 números de WhatsApp');
    expect(html).toContain(
      'con los 3 números del plan son 3.000 mensajes de servicio gratis al mes'
    );
    expect(html).toContain(
      'Meta: 3.000 mensajes de servicio gratis al mes (1.000 por número)'
    );
    expect(html).toContain('Meta: 1.000 mensajes de servicio gratis al mes');
    // The per-number note shows on Negocio only.
    expect(html.match(/con los \d+ números del plan son/g)).toHaveLength(1);
  });

  it('says what Cabbity charges and what Meta charges, with the payment method and FAQ (es)', async () => {
    const html = await render('es');
    expect(html).toContain(es.Pricing.who.title);
    expect(html).toContain(es.Pricing.who.cabbityBody);
    expect(html).toContain(es.Pricing.who.metaBody);
    expect(html).toContain(es.Pricing.free.service);
    expect(html).toContain(es.Pricing.payment.body);
    expect(html).toContain('0,0113 USD');
    expect(html).toContain('0,0740 USD');
    for (const id of PRICING_FAQ) {
      expect(html).toContain(es.Pricing.faq[id].q);
      expect(html).toContain(es.Pricing.faq[id].a);
    }
  });

  it('renders the same page in English with ?lang=en', async () => {
    const html = await render('en');
    expect(html).toContain(`>${en.Pricing.title}</h1>`);
    expect(html).toContain('199 USD / month');
    expect(html).toContain('3,000 outbound messages included per month');
    expect(html).toContain(
      "with the plan's 3 numbers that is 3,000 free service messages per month"
    );
    expect(html).toContain(en.Pricing.who.metaBody);
    expect(html).toContain('0.0113 USD');
    for (const id of PRICING_FAQ) {
      expect(html).toContain(en.Pricing.faq[id].q);
    }
    expect(html).not.toContain(es.Pricing.who.title);
  });

  it('links the other language, sign-up and sign-in', async () => {
    const html = await render('es');
    expect(html).toContain('href="/precios?lang=en"');
    expect(html).toContain('href="/signup"');
    expect(html).toContain('href="/login"');
  });

  it('titles the page in the visitor language', async () => {
    const meta = await pricingMetadata({
      searchParams: Promise.resolve({ lang: 'en' }),
    });
    expect(meta.title).toBe(en.Pricing.seoTitle);
    const metaEs = await pricingMetadata({
      searchParams: Promise.resolve({ lang: 'es' }),
    });
    expect(metaEs.title).toBe(es.Pricing.seoTitle);
  });
});
