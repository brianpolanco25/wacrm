# Spec p8.2 — silenciar «Nadie la atiende» en cuentas de una sola persona

Rama `feat/atencion-cuenta-solo`, worktree `.claude/worktrees/atencion`, base `main` @ 641c60c.
Decisión del humano el 2026-09-23 (opción elegida entre cuatro): en una cuenta con **un solo miembro** no hay
reparto posible, así que la alarma ámbar «Nadie la atiende» y el filtro «Sin atender» son ruido. Los equipos
(2+ miembros) siguen viéndolos igual que hoy. El resto de la regla de f1.3 no cambia.

## Regla

`deriveAttentionState` (`src/lib/inbox/attention.ts`) es **el único sitio** donde se decide el estado; el badge y
el filtro pasan por ahí y no deben divergir. Añade un tercer argumento `teamSize: number | null`:

- `assigned` y `ai` se deciden igual que hoy, antes de mirar `teamSize` (un asignado o el bot son conocibles
  sin él).
- Cuando la regla actual devolvería `'unattended'`:
  - `teamSize === null` → **desconocido** (perfiles aún en vuelo o la lectura falló) → `null`, «decidir nada»,
    el mismo criterio que ya aplica a `accountAiOn === null`. Sin flash ámbar mientras carga.
  - `teamSize <= 1` → `null` (cuenta de una persona: no hay a quién repartir).
  - `teamSize >= 2` → `'unattended'` como hoy.
- `isUnattended` recibe y propaga el mismo argumento.

## UI (`src/components/inbox/conversation-list.tsx`)

- La lista ya carga los perfiles de la cuenta (`profiles`, ~L199). Cambia el estado a `Profile[] | null`
  (inicial `null`; en error se queda `null`; en éxito `data ?? []`) y deriva `teamSize = profiles?.length ??
  null`. **Comprueba** que esa consulta trae a TODOS los miembros de la cuenta (filtra por `account_id`, no por
  rol): si excluye a alguien, el conteo es mentira; ajústala o documenta por qué no.
- Pasa `teamSize` a `deriveAttentionState` (badge) y a `isUnattended` (filtro).
- El chip «Sin atender» de `FILTER_OPTIONS` se oculta cuando `teamSize !== null && teamSize <= 1`. Si el filtro
  activo es `unattended` y el chip desaparece, vuelve a `all`.
- El hilo (`message-thread.tsx`) y cualquier otro consumidor del estado: `grep deriveAttentionState|isUnattended`
  y ajusta las llamadas; si no hay más, dilo en el informe.

## Tests

- `src/lib/inbox/attention.test.ts`: casos para `teamSize` `null`, `1`, `2`, combinados con asignado / bot / cerrado.
- Test de componente de la lista si ya existe alguno equivalente (`src/components/inbox/*.test.tsx`); si no, un
  test mínimo que renderice la lista con 1 perfil y compruebe que no aparece el texto `attentionUnattended` ni el
  chip `filterUnattended`, y con 2 perfiles que sí. Usa las mocks que ya usen otros tests de componentes de la
  bandeja (`useAuth`, `usePresence`, `next-intl`, supabase).

## Fuera de alcance

Auto-asignación al entrar, cambios de copy y de i18n (no hay claves nuevas), cambios en `attention-badge.tsx`.

## Compuerta y entrega

`npm run lint`, `npm run typecheck`, `TZ=UTC npm test`, `npm run build` (variables dummy de `ci.yml`). Un commit
(o dos: lib + UI). Entrada en `CHANGELOG.md` (Unreleased). Informe en `progress/impl_attention-solo.md` de
**este worktree**. No edites `feature_list.json` ni `progress/current.md`.
