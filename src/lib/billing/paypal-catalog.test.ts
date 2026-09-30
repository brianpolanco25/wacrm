import { describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_PRODUCT_NAME,
  ensureProduct,
  money,
  paypalPlanDescription,
  paypalPlanName,
  productNameFromEnv,
} from './paypal-catalog';

// What the CLI bootstrap and the panel's sync share (s9.3): a plan made
// from either place has to look the same at PayPal.

describe('paypal-catalog', () => {
  it('names plans and prices exactly as the bootstrap always did', () => {
    expect(paypalPlanName('Pro', 'month')).toBe('Pro (monthly)');
    expect(paypalPlanName('Pro', 'year')).toBe('Pro (yearly)');
    expect(paypalPlanDescription('Pro', 'year')).toBe(
      'Cabbity CRM Pro plan, billed yearly'
    );
    expect(money(35)).toBe('35.00');
    expect(money('1000')).toBe('1000.00');
  });

  it('defaults the product name', () => {
    expect(productNameFromEnv(undefined)).toBe(DEFAULT_PRODUCT_NAME);
    expect(productNameFromEnv('  ')).toBe(DEFAULT_PRODUCT_NAME);
    expect(productNameFromEnv(' Otro ')).toBe('Otro');
  });

  it('reuses the product by name, creates it otherwise', async () => {
    const createProduct = vi.fn(async (name: string) => ({
      id: 'PROD-NEW',
      name,
    }));
    const found = await ensureProduct(
      {
        listProducts: async () => [
          { id: 'PROD-OTHER', name: 'Otro' },
          { id: 'PROD-CAB', name: 'Cabbity CRM' },
        ],
        createProduct,
      },
      'Cabbity CRM'
    );
    expect(found).toEqual({
      product: { id: 'PROD-CAB', name: 'Cabbity CRM' },
      reused: true,
    });
    expect(createProduct).not.toHaveBeenCalled();

    const made = await ensureProduct(
      { listProducts: async () => [], createProduct },
      'Cabbity CRM'
    );
    expect(made).toEqual({
      product: { id: 'PROD-NEW', name: 'Cabbity CRM' },
      reused: false,
    });
  });
});
