import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { FakeDatabase } from '@/lib/security/fake-supabase';
import type { TemplatePayload } from '@/lib/whatsapp/template-validators';

// Fuga entre cuentas en las escrituras compartidas de plantillas: con un id
// de OTRA cuenta (lo que pasaría si la lectura previa de una ruta dejara de
// filtrar), ninguna escritura toca esa fila. Antes el panel escribía solo
// por `id`.

const meta = vi.hoisted(() => ({ editFails: false }));

vi.mock('@/lib/whatsapp/meta-api', () => ({
  editMessageTemplate: async () => {
    if (meta.editFails) throw new Error('Meta says no');
    return { success: true };
  },
  deleteMessageTemplate: async () => ({ success: true }),
  submitMessageTemplate: async () => ({ id: 'meta-new', status: 'PENDING' }),
}));

vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: () => db.admin,
}));

import { deleteTemplate, editTemplate } from './template-operations';

const A = 'acct-a';
const TPL_B = 'bbbbbbbb-0000-4000-8000-000000000001';

const payload: TemplatePayload = {
  name: 'promo',
  category: 'Marketing',
  language: 'en_US',
  body_text: 'Hello',
};

let db: FakeDatabase;
const client = () => db.admin as unknown as SupabaseClient;
const rowB = () => db.rows('message_templates').find((r) => r.id === TPL_B);

beforeEach(() => {
  meta.editFails = false;
  db = new FakeDatabase({
    message_templates: [
      {
        id: TPL_B,
        account_id: 'acct-b',
        name: 'promo',
        language: 'en_US',
        status: 'APPROVED',
        body_text: 'B body',
        submission_error: null,
        meta_template_id: 'meta-b',
      },
    ],
  });
});

describe('template-operations: writes scoped by account_id', () => {
  it("editTemplate with B's id under A leaves B's row untouched", async () => {
    const res = await editTemplate(client(), {
      accountId: A,
      id: TPL_B,
      metaTemplateId: 'meta-b',
      accessToken: null,
      payload,
      select: '*',
    });
    expect(res).toMatchObject({ ok: false, step: 'local' });
    expect(rowB()).toMatchObject({ status: 'APPROVED', body_text: 'B body' });
  });

  it('a Meta refusal records submission_error only on the caller account', async () => {
    meta.editFails = true;
    const res = await editTemplate(client(), {
      accountId: A,
      id: TPL_B,
      metaTemplateId: 'meta-b',
      accessToken: 'tok',
      payload,
      select: '*',
    });
    expect(res).toMatchObject({ ok: false, step: 'meta' });
    expect(rowB()?.submission_error).toBeNull();
  });

  it("deleteTemplate with B's id under A deletes nothing", async () => {
    const res = await deleteTemplate(client(), {
      accountId: A,
      id: TPL_B,
      name: 'promo',
      metaTemplateId: null,
      target: null,
    });
    expect(res).toEqual({ ok: true, deleted: false });
    expect(rowB()).toBeDefined();
  });
});
