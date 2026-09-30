import { describe, expect, it } from 'vitest';

import { validatePlanInput } from '@/lib/billing/plan-catalog';
import { emptyPlanForm, formToPayload, planToForm } from './plan-form';

// The plan editor's form ↔ request body (s9.3).

const PRO = {
  id: 'pro',
  name: 'Pro',
  description: null,
  priceMonth: 100,
  priceYear: 1000,
  isPublic: true,
  sortOrder: 2,
  limits: {
    operators: 10,
    contacts: 10000,
    messages_out: 15000,
    ai_replies: 3000,
    broadcast_recipients: 10000,
    knowledge_documents: 50,
    numbers: 1,
    retention_months: null,
  },
  features: ['webhooks', 'api', 'ai_autoreply'],
};

describe('plan form', () => {
  it('round-trips a plan into a PATCH body the server accepts', () => {
    const form = planToForm(PRO);
    expect(form.limits.retention_months).toEqual({
      unlimited: true,
      value: '',
    });
    const result = formToPayload(form, 'edit');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.body).not.toHaveProperty('id');
    expect(result.body.limits).toEqual(PRO.limits);
    expect(result.body.features).toEqual(['ai_autoreply', 'api', 'webhooks']);
    expect(validatePlanInput(result.body, 'update').ok).toBe(true);
  });

  it('«ilimitado» ticked sends null, never an empty value', () => {
    const form = planToForm(PRO);
    form.limits.operators = { unlimited: true, value: '10' };
    const result = formToPayload(form, 'edit');
    expect(result.ok && result.body.limits).toMatchObject({ operators: null });
  });

  it('an empty limit is an error, not «unlimited»', () => {
    const form = planToForm(PRO);
    form.limits.ai_replies = { unlimited: false, value: '' };
    expect(formToPayload(form, 'edit')).toEqual({
      ok: false,
      error: 'limit',
      field: 'ai_replies',
    });
  });

  it('a new plan needs a slug and sends it', () => {
    const form = emptyPlanForm(4);
    form.name = 'Plus';
    form.priceMonth = '49,50';
    for (const key of Object.keys(form.limits) as (keyof typeof form.limits)[])
      form.limits[key] = { unlimited: false, value: '1' };
    expect(formToPayload(form, 'create')).toEqual({ ok: false, error: 'id' });

    form.id = 'plus';
    const result = formToPayload(form, 'create');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.body).toMatchObject({
      id: 'plus',
      price_usd_month: 49.5,
      price_usd_year: null,
      sort_order: 4,
      is_public: false,
    });
    expect(validatePlanInput(result.body, 'create').ok).toBe(true);
  });

  it.each([
    ['priceMonth', 'abc'],
    ['priceMonth', '1.999'],
    ['priceYear', '-5'],
    ['sortOrder', '1.5'],
    ['name', '  '],
  ] as const)('flags %s = %j', (field, value) => {
    const form = planToForm(PRO);
    form[field] = value;
    expect(formToPayload(form, 'edit')).toMatchObject({
      ok: false,
      error: field,
    });
  });
});
