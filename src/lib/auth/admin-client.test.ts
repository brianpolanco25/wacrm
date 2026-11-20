import { describe, expect, it } from 'vitest';
import { supabaseAdmin } from './admin-client';
import { supabaseAdmin as aiAdmin } from '@/lib/ai/admin-client';
import { supabaseAdmin as automationsAdmin } from '@/lib/automations/admin-client';
import { supabaseAdmin as flowsAdmin } from '@/lib/flows/admin-client';

describe('supabaseAdmin', () => {
  it('es una sola función (un solo cliente de servicio por proceso)', () => {
    expect(aiAdmin).toBe(supabaseAdmin);
    expect(automationsAdmin).toBe(supabaseAdmin);
    expect(flowsAdmin).toBe(supabaseAdmin);
  });
});
