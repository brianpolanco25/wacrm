import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  parseStatusPricing,
  recordMessageCharge,
  resetPricingWarningsForTests,
  type MessageChargeInput,
} from './message-charges';

let warn: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  resetPricingWarningsForTests();
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  error = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  warn.mockRestore();
  error.mockRestore();
});

describe('parseStatusPricing', () => {
  it('lee el payload real de Meta', () => {
    expect(
      parseStatusPricing({
        billable: true,
        pricing_model: 'PMP',
        category: 'marketing',
        type: 'regular',
      })
    ).toEqual({
      category: 'marketing',
      billable: true,
      type: 'regular',
      model: 'PMP',
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it('sin pricing, o sin categoría utilizable, devuelve null: no se inventa', () => {
    expect(parseStatusPricing(undefined)).toBeNull();
    expect(parseStatusPricing(null)).toBeNull();
    expect(parseStatusPricing('marketing')).toBeNull();
    expect(parseStatusPricing([])).toBeNull();
    expect(parseStatusPricing({ billable: true, type: 'regular' })).toBeNull();
    expect(parseStatusPricing({ category: '   ' })).toBeNull();
    expect(parseStatusPricing({ category: 42 })).toBeNull();
    expect(parseStatusPricing({ category: 'x'.repeat(65) })).toBeNull();
  });

  it('una categoría desconocida se guarda tal cual y avisa una vez por valor', () => {
    expect(parseStatusPricing({ category: 'marketing_lite' })?.category).toBe(
      'marketing_lite'
    );
    expect(
      parseStatusPricing({ category: 'authentication-international' })?.category
    ).toBe('authentication-international');
    parseStatusPricing({ category: 'marketing_lite' });

    expect(warn).toHaveBeenCalledTimes(2);
    expect(String(warn.mock.calls[0][0])).toContain('marketing_lite');
  });

  it('las categorías y tipos conocidos no avisan', () => {
    for (const category of [
      'service',
      'utility',
      'marketing',
      'authentication',
      'authentication_international',
    ]) {
      for (const type of [
        'regular',
        'free_customer_service',
        'free_entry_point',
      ]) {
        parseStatusPricing({ category, type });
      }
    }
    expect(warn).not.toHaveBeenCalled();
  });

  it('los campos mal formados quedan en null sin descartar la categoría', () => {
    expect(
      parseStatusPricing({
        category: ' utility ',
        billable: 'true',
        type: 7,
        pricing_model: '',
      })
    ).toEqual({ category: 'utility', billable: null, type: null, model: null });
  });

  it('un tipo desconocido se conserva y avisa', () => {
    expect(
      parseStatusPricing({ category: 'service', type: 'free_tier' })?.type
    ).toBe('free_tier');
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe('recordMessageCharge', () => {
  const INPUT: MessageChargeInput = {
    accountId: 'acc-1',
    whatsappConfigId: 'cfg-1',
    wamid: 'wamid.X',
    status: 'sent',
    eventAt: '2026-10-01T10:00:00.000Z',
    messageId: 'msg-1',
    broadcastRecipientId: null,
    recipientPhone: '18095550101',
    pricing: {
      category: 'marketing',
      billable: true,
      type: 'regular',
      model: 'PMP',
    },
  };

  function dbWith(rpc: (...a: unknown[]) => unknown) {
    return { rpc: vi.fn(rpc) } as unknown as SupabaseClient & {
      rpc: ReturnType<typeof vi.fn>;
    };
  }

  it('llama a la RPC con la cuenta y el precio', async () => {
    const db = dbWith(async () => ({ data: 'inserted', error: null }));
    await expect(recordMessageCharge(db, INPUT)).resolves.toBe('inserted');
    expect(db.rpc).toHaveBeenCalledWith('record_message_charge', {
      p_account_id: 'acc-1',
      p_wamid: 'wamid.X',
      p_status: 'sent',
      p_event_at: '2026-10-01T10:00:00.000Z',
      p_whatsapp_config_id: 'cfg-1',
      p_message_id: 'msg-1',
      p_broadcast_recipient_id: null,
      p_recipient_phone: '18095550101',
      p_pricing_category: 'marketing',
      p_pricing_billable: true,
      p_pricing_type: 'regular',
      p_pricing_model: 'PMP',
    });
  });

  it('sin pricing manda la categoría en null', async () => {
    const db = dbWith(async () => ({ data: 'updated', error: null }));
    await recordMessageCharge(db, { ...INPUT, pricing: null });
    expect(db.rpc.mock.calls[0][1]).toMatchObject({
      p_pricing_category: null,
      p_pricing_billable: null,
      p_pricing_type: null,
      p_pricing_model: null,
    });
  });

  it('un error de la RPC se registra y no lanza', async () => {
    const db = dbWith(async () => ({
      data: null,
      error: { message: 'boom' },
    }));
    await expect(recordMessageCharge(db, INPUT)).resolves.toBe('error');
    expect(error).toHaveBeenCalled();
  });

  it('una excepción del cliente se registra y no lanza', async () => {
    const db = dbWith(async () => {
      throw new Error('network down');
    });
    await expect(recordMessageCharge(db, INPUT)).resolves.toBe('error');
    expect(error).toHaveBeenCalled();
  });

  it('un wamid de otra cuenta se avisa y no se toca', async () => {
    const db = dbWith(async () => ({ data: 'foreign', error: null }));
    await expect(recordMessageCharge(db, INPUT)).resolves.toBe('foreign');
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
