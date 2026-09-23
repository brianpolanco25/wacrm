# impl p8.2 — attention-solo

## Plan

1. `deriveAttentionState(conv, accountAiOn, teamSize)`: `assigned`/`ai` como hoy; donde saldría `'unattended'`,
   `teamSize === null` o `<= 1` → `null`. `isUnattended` propaga el argumento. Helper `offersUnattendedFilter`.
2. `conversation-list.tsx`: `profiles` pasa a `Profile[] | null`, `teamSize = profiles?.length ?? null`, se pasa
   al badge y al filtro; el chip se oculta con `teamSize` conocido `<= 1` y el filtro activo vuelve a `all`.
3. Tests de la derivación (null/1/2 × asignado/bot/cerrado) y test de componente de la lista.
4. Compuerta, CHANGELOG, informe.

## Rama y commits

Rama `feat/atencion-cuenta-solo` (worktree `.claude/worktrees/atencion`), sobre 836da76.

- `51d9cdc` feat: no dar por desatendida una conversación en cuentas de una persona (lib + tests)
- `3b48162` feat: silenciar «Nadie la atiende» y el filtro «Sin atender» en cuentas de una persona (UI + test + CHANGELOG)

## Por punto de la spec

**Regla (`src/lib/inbox/attention.ts`).** Tercer argumento `teamSize: number | null`. Orden: asignado →
`'assigned'`; `accountAiOn === null` → `null`; bot activo y no pausado → `'ai'`; cerrado → `null`;
`teamSize === null || teamSize <= 1` → `null`; si no, `'unattended'`. `isUnattended(conv, ai, teamSize)` sigue
siendo `deriveAttentionState(...) === 'unattended'` (una sola fuente). Añadido `offersUnattendedFilter(teamSize)`
(`teamSize === null || teamSize >= 2`) para que la regla del chip viva junto a la del estado.

**UI (`src/components/inbox/conversation-list.tsx`).** `profiles` inicial `null`; en error se queda `null`; en
éxito `data ?? []`. `teamSize = profiles?.length ?? null`. Se pasa a `deriveAttentionState` (badge) y a
`isUnattended` (filtro, y en las dependencias del `useMemo`). `FILTER_OPTIONS` se deriva de las seis opciones
filtrando `unattended` cuando `!offersUnattendedFilter(teamSize)`. Si el filtro activo es `unattended` y el chip
desaparece, `setFilter("all")` durante el render (patrón de React de ajustar estado en render, sin efecto: no hay
un fotograma con el filtro viejo).

**¿La consulta de perfiles trae a todos los miembros?** Sí. Es `from("profiles").select("*").eq("account_id",
accountId)`, sin filtro de rol. La pertenencia vive en `profiles` (017: `account_role` en `profiles`, "no
separate memberships table", una fila por miembro), y la RLS `profiles_select` es `auth.uid() = user_id OR
is_account_member(account_id)` (rol mínimo `viewer`), así que cualquier miembro ve a todos los de su cuenta. Es
el mismo conteo que usa el panel de plataforma (058: `count(*) FROM profiles WHERE account_id = p.id`). En
sesión de soporte el operador tiene su perfil en otra cuenta y el `eq("account_id", ...)` lo excluye. Los
`viewer` cuentan como miembros (la spec pide no filtrar por rol). No se tocó la consulta.

**Otros consumidores.** `grep deriveAttentionState|isUnattended` en `src/`: solo `conversation-list.tsx` y el
test de la lib. `message-thread.tsx` no los usa; no hubo más que ajustar. `attention-badge.tsx` intacto.

## Criterio ↔ test

| Criterio | Test |
|---|---|
| `teamSize` 2+ → `'unattended'` como hoy | `attention.test.ts` › team size › "is 'unattended' only from two members up" (y todo el bloque previo, ahora con `TEAM = 2`) |
| `teamSize` 1 → `null` | › "decides nothing for a one-person account"; "treats a size of 0 like one person" |
| `teamSize` null → `null` | › "decides nothing while the team size is unknown" |
| asignado gana con cualquier tamaño | › "still names the assignee whatever the team size" |
| bot gana con cualquier tamaño | › "still reads the bot's threads as 'ai' whatever the team size" |
| cerrado fuera de la cola con cualquier tamaño | › "keeps closed threads out of the queue whatever the team size" |
| filtro y badge no divergen | › "the filter agrees with the badge for every size" |
| chip oculto solo con tamaño conocido ≤ 1 | `attention.test.ts` › offersUnattendedFilter (2 `it`) |
| lista con 2 perfiles: badge y chip | `conversation-list.test.tsx` › "shows the badge and the chip to a team of two" |
| lista con 1 perfil: ni `attentionUnattended` ni `filterUnattended` | › "shows neither to a one-person account" |
| perfiles desconocidos: sin badge, chip visible | › "shows no badge while the team size is unknown, but keeps the chip" |
| filtro `unattended` activo + 1 perfil → vuelve a `all` | › "falls back to \"all\" when \"unattended\" was active and the chip goes" |
| equipo con filtro `unattended` | › "keeps the \"unattended\" queue for a team" |

Sobre el test de componente: no había uno de la lista. El repo no tiene jsdom ni testing-library (y no se añaden
dependencias), así que se renderiza con `renderToStaticMarkup`, como los demás tests de componentes. En estático
los efectos no corren, de modo que los perfiles se inyectan con un shim de `useState` (el primer estado
inicializado a `null` en cada pasada es `profiles`; `loading` arranca en `false`; el filtro inicial es
configurable) y el menú de Base UI se aplana con un mock. Mocks: `next-intl` (claves literales), `useAuth`,
`usePresence`, `useAiAccountStatus` (bot apagado), supabase. El caso positivo (2 perfiles → badge y chip) prueba
que el shim está cableado; además comprobé por mutación que, forzando `teamSize = 2`, fallan los dos casos de
cuenta de una persona. Punto frágil: si se reordenan los `useState` de la lista, el shim puede apuntar a otro
estado; el caso positivo lo detectaría.

## Compuerta (en este worktree, 2026-09-23)

- `npm run lint`: 0 errores, 35 warnings, todos preexistentes (en `conversation-list.tsx` solo el `<img>` de
  siempre, L632).
- `npm run typecheck`: limpio.
- `TZ=UTC npm test`: 205 archivos, 2680 tests, todos en verde.
- `npm run build` (variables dummy de `ci.yml`): completa, tabla de rutas generada.

Sin SQL, sin migraciones, sin dependencias, sin claves i18n nuevas, sin variables de entorno nuevas.

## Verificación manual pendiente

1. Cuenta con un solo miembro, bot apagado: `/inbox` no muestra «Nadie la atiende» en ninguna fila; el menú de
   filtro no ofrece «Sin atender».
2. Invitar a un segundo miembro y recargar: vuelven badge y chip.
3. Con la red lenta (DevTools), al cargar no hay destello ámbar antes de que lleguen los perfiles.

## Decisiones

- Tamaño `0` (no debería ocurrir: el perfil propio siempre es legible) se trata como una persona: sin alarma.
- Mientras `teamSize` es desconocido el chip se mantiene (la spec solo lo oculta con tamaño conocido ≤ 1); el
  filtro lista vacío en ese intervalo, igual que con el flag de IA desconocido.
- `conversation-list.tsx` no estaba formateado con prettier antes de este cambio (comillas dobles, ~370 líneas de
  diff si se formatea). No lo formateé entero para no ensuciar el diff; sí los archivos nuevos y la lib.

## Deuda fuera de alcance

- Al cambiar `accountId` (entrar/salir de una sesión de soporte) `profiles` conserva la lista anterior hasta que
  llega la nueva, como ya pasaba con los nombres; el conteo puede ser el de la cuenta previa durante esa carga.
- `conversation-list.tsx` sin formato prettier (ver arriba).
