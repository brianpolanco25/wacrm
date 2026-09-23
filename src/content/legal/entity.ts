// ============================================================
// Titular de las páginas legales (`/privacy`, `/terms`, `/data-deletion`).
//
// Un solo sitio para los datos que cambian de un titular a otro: el
// nombre legal y el RNC tienen que coincidir con los documentos que se
// suben a la verificación del negocio de Meta, así que no se repiten en
// la prosa.
// ============================================================

export const LEGAL_ENTITY = {
  /** Razón social tal como figura en el registro mercantil. */
  legalName: '[NOMBRE LEGAL DE LA EMPRESA]',
  /** Nombre comercial del servicio. */
  brand: 'Cabbity CRM',
  country: { es: 'República Dominicana', en: 'Dominican Republic' },
  city: 'Santo Domingo',
  email: 'hola@cabbity.com',
  site: 'https://crm.cabbity.com',
  /** Fecha de la versión vigente (AAAA-MM-DD). */
  updatedAt: '2026-09-23',
} as const;
