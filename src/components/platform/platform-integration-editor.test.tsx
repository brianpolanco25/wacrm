import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';

import en from '../../../messages/en.json';
import es from '../../../messages/es.json';

// /platform/integrations/[id] (n13.1, R11, R34): formulario de la
// integración y lista editable de operaciones, marcado estático.

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));

import {
  PlatformIntegrationEditor,
  type PlatformIntegrationDetailView,
} from './platform-integration-editor';

const CATALOGUES = { en, es } as const;

const DETAIL: PlatformIntegrationDetailView = {
  id: '9a000000-0000-4000-8000-000000000001',
  slug: 'health',
  name: 'Cabbity Health',
  description: 'Citas',
  logo_url: null,
  base_url: 'https://health.example.com/api/v1',
  auth_scheme: 'header',
  auth_header_name: 'X-Api-Key',
  credential_help: null,
  test_path: '/me',
  is_active: false,
  sort_order: 1,
  operations: [
    {
      id: '9b000000-0000-4000-8000-000000000002',
      integration_id: '9a000000-0000-4000-8000-000000000001',
      key: 'create_appointment',
      name: 'Crear cita',
      description: 'Crea una cita',
      method: 'POST',
      path: '/doctors/{doctorId}/appointments',
      params: [
        {
          name: 'doctorId',
          in: 'path',
          type: 'integer',
          required: true,
          description: 'Doctor',
        },
        {
          name: 'shift',
          in: 'body',
          type: 'string',
          required: false,
          description: 'Turno',
        },
      ],
      outputs: [
        { name: 'id', path: 'data.id', type: 'integer', description: '' },
      ],
      response_description: 'La cita',
      is_active: true,
      sort_order: 1,
    },
  ],
};

function render(locale: keyof typeof CATALOGUES, detail = DETAIL) {
  return renderToStaticMarkup(
    <NextIntlClientProvider
      locale={locale}
      timeZone="UTC"
      messages={CATALOGUES[locale]}
    >
      <PlatformIntegrationEditor id={detail.id} initial={detail} />
    </NextIntlClientProvider>
  );
}

describe('PlatformIntegrationEditor', () => {
  it('shows the integration form with the slug locked', () => {
    const html = render('es');
    expect(html).toContain(`data-integration-editor="${DETAIL.id}"`);
    expect(html).toMatch(/id="int-slug"[^>]*disabled/);
    expect(html).toContain('value="https://health.example.com/api/v1"');
    // header scheme → the header name input is there with its value.
    expect(html).toContain('id="int-header"');
    expect(html).toContain('value="X-Api-Key"');
    expect(html).toContain(es.Platform.integrations.status.draft);
    expect(html).toContain('href="/platform/integrations"');
  });

  it('lists each operation with its parameter and output rows', () => {
    const html = render('es');
    expect(html).toContain('data-operation="create_appointment"');
    expect(html.match(/data-param-row=/g)).toHaveLength(2);
    expect(html.match(/data-output-row=/g)).toHaveLength(1);
    expect(html).toContain('value="/doctors/{doctorId}/appointments"');
    expect(html).toContain(es.Platform.integrations.operations.add);
    expect(html).toContain(es.Platform.integrations.params.add);
    expect(html).not.toMatch(/Eliminar integración|Borrar/);
  });

  it('says when there are no operations', () => {
    expect(render('es', { ...DETAIL, operations: [] })).toContain(
      es.Platform.integrations.operations.empty
    );
  });

  it.each(['en', 'es'] as const)('is translated in %s (CP6)', (loc) => {
    const html = render(loc);
    const m = CATALOGUES[loc].Platform.integrations;
    expect(html).toContain(m.form.baseUrl);
    expect(html).toContain(m.operations.title);
    expect(html).toContain(m.params.in_path);
    expect(html).not.toContain('Platform.integrations.');
  });
});
