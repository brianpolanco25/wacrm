import type { Metadata } from 'next';
import type { ReactNode } from 'react';

// Grupo de rutas público. No comparte nada con `(dashboard)`: ni el
// shell con barra lateral, ni `useAuth`, ni ninguna consulta a Supabase.
// `/developers` no está en la lista de rutas protegidas del middleware,
// así que se ve sin sesión, y con sesión se ve exactamente igual.
//
// El layout raíz (`src/app/layout.tsx`) ya monta next-intl y el tema
// claro/oscuro; aquí solo se corrige lo que esta sección necesita del
// revés: el panel pide `noindex` porque es privado, y la documentación
// es justo lo contrario.
export const metadata: Metadata = {
  title: {
    default: 'Documentación para desarrolladores — Cabbity CRM',
    template: '%s — Cabbity CRM',
  },
  robots: { index: true, follow: true },
};

export default function DevelopersLayout({
  children,
}: {
  children: ReactNode;
}) {
  return children;
}
