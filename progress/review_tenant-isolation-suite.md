# Review — f2.2 tenant-isolation-suite (4ª ronda)

**Veredicto:** APPROVED

Revisado en `/Users/brian/Documents/Dev/projects/wacrm/.claude/worktrees/agent-a4220e4b5ba8896fd`
(HEAD `2e2cfef`, árbol limpio antes y después de mis mutaciones). Commits de la feature:
`2323274`, `8413526`, `313101b`, `2e2cfef`. Base de fase `61c1fbb`.

Los **tres cambios requeridos de la 3ª ronda están cerrados**, y el bloqueante real —el
borrado y el clonado entre cuentas del ex-miembro— está arreglado en el código y **atado por
un test que falla si se deshace** (no solo por la auditoría: también por el estado HTTP).
Nada nuevo en esta ronda es fuga ni pérdida de datos. Lo pendiente es producto, ya escrito
como deuda en el informe.

## Compuerta

Ejecutada por el revisor en el worktree, en orden, con las variables dummy de `docs/harness.md`:

- `npm run lint` — **verde** (0 errores, 37 warnings preexistentes)
- `npm run typecheck` — **verde**
- `TZ=UTC npm test` — **verde**: 85 archivos, **960** tests (coincide con el informe)
- `npm run build` — **verde**
- `scripts/replay-migrations.sh` — **n/a**: la feature no toca SQL (`git diff 61c1fbb..HEAD --
  supabase/` solo trae la 044 y su aserción, que son de f2.1 `private-media`)

## Cambios requeridos de la 3ª ronda: estado

**CR1 — DELETE de `/api/automations/[id]` acotado por cuenta: CERRADO.**
`route.ts:172-186`: `requireRole('agent')` aporta `accountId` y `userId`; hay lectura de
pertenencia bajo la cuenta (`:178-183`) y el `delete` lleva
`.eq('account_id', accountId).eq('user_id', userId)` (`:190-192`). El `ok` incondicional
pasa a 404.

**CR2 — GET y `duplicate` acotados, waivers retirados: CERRADO.**
GET (`route.ts:44-51`) resuelve la cuenta con `getCurrentAccount()` y filtra por
`account_id`; `duplicate/route.ts:28-34` lo mismo con `requireRole('agent')`, y el clon se
inserta con `account_id: accountId` (`:46`), no con `original.account_id`. Los dos waivers
`automations / select` y `automations / delete` **están fuera de `GLOBAL_WAIVERS`**
(`tenant-isolation.test.ts:781`, con una línea que explica por qué no hay ninguno).
La tabla vuelve a la regla general de la auditoría.

**CR3 — test de fuga del ex-miembro: CERRADO y leído.**
`tenant-isolation.test.ts:1566-1616`,
`it("an ex-member of A cannot read, delete or clone A's automation from their new account")`.
Empuja una cuenta `C`, mueve `profiles.account_id` de `USER_A` a `C` con rol `owner`
—exactamente lo que hacen 018/019—, deja `auto-a` en A y ejercita GET, DELETE, PATCH y
duplicate: los cuatro **404**, `auto-a` intacta (`name`, `is_active`, `account_id: A`), una
sola automatización en A (nada clonado dentro) y `snapshot(A)` idéntico al de después de la
mudanza. No está mockeado `@/lib/auth/account`: `getCurrentAccount()` real lee el perfil
movido por el cliente de sesión con RLS simulada, así que el test recorre el camino real.

**CR5 (opcional) — `requireUser()` duplicado: CERRADO.** El helper desaparece; `userId` sale
del contexto de `requireRole` en PATCH y DELETE.

## Mis mutaciones (repetidas esta ronda, todas revertidas)

`git status` limpio tras cada una.

| Mutación | Resultado |
|---|---|
| `route.ts:49` — GET sin `.eq('account_id', accountId)` | **rojo**, 2 tests: `select on automations without account_id (filters: id, user_id)` + `expected 200 to be 404` (ex-miembro leía A) |
| `route.ts:93` — lectura de pertenencia del PATCH sin cuenta | **rojo**, 3 tests: `select … (filters: id)` + `expected 200 to be 404` |
| `route.ts:142` — `update` del PATCH sin cuenta | **rojo**: `update on automations without account_id (filters: id)` |
| `route.ts:182` — lectura de pertenencia del DELETE sin cuenta | **rojo**, 3 tests: `select … (filters: id)` + `expected 200 to be 404` (el ex-miembro volvía a pasar la puerta) |
| `route.ts:192` — `delete` sin cuenta | **rojo**: `delete on automations without account_id (filters: id, user_id)` |
| `duplicate/route.ts:32` — lectura del original sin cuenta | **rojo**, 3 tests: `select … (filters: id, user_id)` + `expected 201 to be 404` (el ex-miembro clonaba dentro de A) |

Las cuatro consultas que sostienen el arreglo fallan **dos veces**: por la auditoría del
`afterEach` y por el estado HTTP del test del ex-miembro. Eso es lo que faltaba en las rondas
anteriores.

## El mismo patrón en el resto del código: verificado por mí

Repasados los 14 `.eq('user_id', …)` de `src/app/api` y `src/lib` fuera de tests. El barrido
del informe (§5) es exacto: `automations/route.ts:49`, `flows/route.ts:70`,
`whatsapp/config/route.ts:28`, `whatsapp/templates/[id]/route.ts:74,265`,
`whatsapp/config/verify-registration/route.ts:47`, `whatsapp/media/[mediaId]/route.ts:41`,
`lib/storage/upload-media.ts:114` y `lib/auth/account.ts:120` son lecturas de `profiles` con
el **cliente de sesión** (RLS activa) para *resolver* la cuenta; `ai/config/route.ts:111` y
`lib/whatsapp/outbound-media.ts:210` ya llevan `.eq('account_id', …)` junto al `user_id`.
No queda ningún sitio donde `user_id` haga de frontera de inquilino con el cliente de rol de
servicio.

## Trazabilidad criterio ↔ test (spec §2)

- **C1 «al menos una prueba de fuga por ruta con rol de servicio»: [x]** — 37 rutas
  importadas y ejercitadas (`tenant-isolation.test.ts:216-252`): `/api/v1`, webhook de
  WhatsApp, send/broadcast/resume, config, lifecycle de plantillas, los dos crons,
  automations, flows, quick replies y las 8 de IA. Cada `it` afirma 404 para ids de B más
  `expectBUnchanged(before)`.
- **C2 «quitar a mano un `.eq('account_id', …)` hace fallar la suite»: [x]** — seis mutaciones
  mías en rojo esta ronda (tabla de arriba), más las de rondas anteriores (`flows` PUT,
  `/api/v1/contacts`). La propiedad corre en el `afterEach` de `:791-801`, es decir en los 52
  tests del archivo, y la respaldan los 9 de `service-role-audit.test.ts`.
- **C3 «la suite corre en el `npm test` de CI»: [x]** — 85 archivos / 960 tests en mi
  ejecución.
- No aplica `progress/checks_*.sql` (nada depende de base real) ni guion manual (ni Meta ni
  PayPal en el alcance).
- La regla de ESLint que el spec llama «complemento barato» sigue sin añadirse; el informe lo
  argumenta (falsos positivos/negativos textuales) y la auditoría en tiempo de ejecución cubre
  el mismo objetivo con más precisión. Aceptado.

## Checkpoints

- **CP1 Compuerta:** [x] verde, ejecutada por el revisor.
- **CP2 Migraciones:** [x] n/a — la feature no toca SQL.
- **CP3 Aislamiento:** [x] las cuatro operaciones de `/api/automations/[id]` (+ duplicate)
  llevan `account_id` del llamante, con test de fuga entre cuentas y el caso ex-miembro. No
  queda waiver de `automations`. El resto del alcance seguía acotado desde rondas anteriores.
- **CP4 Tests:** [x] C1, C2 y C3 cubiertos con tests leídos por mí, no solo declarados.
- **CP5 Sin dependencias nuevas:** [x] `package.json` y `package-lock.json` sin tocar en
  `61c1fbb..HEAD`.
- **CP6 i18n:** [x] n/a — `messages/` sin cambios en el rango; la UI reutiliza
  `loadError`/`toasts.deleteError`, que ya existen.
- **CP7 Next 16:** [x] `{ params }: { params: Promise<{ id: string }> }` comprobada contra
  `node_modules/next/dist/docs/`; el diff no introduce API de framework nueva.
- **CP8 Alcance:** [x] `2e2cfef` toca 4 archivos: las dos rutas de automatizaciones, la suite
  y `CHANGELOG.md`. Nada fuera de la sección 2.
- **CP9 Documentación:** [x] `CHANGELOG.md` (Unreleased → Fixed) describe la fuga del
  ex-miembro y el cambio de `ok` a 404; sin variables nuevas; el informe coincide con el diff.
- **CP10 Git:** [x] `2e2cfef` en la rama de fase, en español con prefijo y `Co-Authored-By`;
  `git branch -r --contains 2e2cfef` vacío (nada pusheado); `main` (`46a0999`), `dev`
  (`7ecf644`) y `feat/saas-multiempresa` (`593b92f`) intactos.
- **CP11 Entrante no bloqueado:** [x] n/a — la feature no toca facturación ni el webhook.

## Hallazgos (archivo:línea) — ninguno bloqueante

Contrastados con `code-review` a nivel `high` sobre `313101b..2e2cfef`. Sus tres hallazgos
son de producto/UX; ninguno es fuga ni pérdida de datos, y dos de los tres son preexistentes
al diff.

1. `src/app/api/automations/[id]/route.ts:95,184` — **observación, preexistente**. La regla
   por autor (`existing.user_id !== userId`) deja las automatizaciones de un miembro que se
   fue **sin nadie que las gestione**: siguen disparando y ningún agente de A puede abrirlas,
   pausarlas ni borrarlas, aunque la RLS `automations_delete` (017:459) lo permitiría. No lo
   introduce este commit —el filtro `user_id` ya estaba—; lo que cambia es que el fallo pasa
   de silencioso (`{ok:true}` sin borrar nada) a visible (404), que es mejor. Ya está escrito
   como deuda 1 y 5 del informe. Arreglo natural: quitar el `user_id` de las cuatro consultas
   ahora que `account_id` es la frontera, o que 018 reasigne las filas del expulsado.
   **Merece feature propia con decisión de producto.**
2. `src/app/(dashboard)/automations/page.tsx:73` vs `route.ts:50` — **observación,
   preexistente**. La lista va por cliente de sesión + RLS y muestra las automatizaciones de
   los compañeros con sus botones activos; el detalle y las cuatro operaciones 404. El texto
   del waiver retirado era el único registro del síntoma dentro del código; ahora vive solo
   en el informe. Vale la pena moverlo a un comentario en la ruta cuando se aborde el punto 1.
3. `src/app/api/automations/[id]/route.ts:184` — **menor, nuevo**. El DELETE pierde la
   idempotencia: una fila ya inexistente contesta 404 en vez de 200. `confirmDelete`
   (`page.tsx:124-132`) sale por `!res.ok`, así que en un doble borrado (dos pestañas, o
   reintento tras un timeout que sí borró) el usuario ve `toasts.deleteError` y el diálogo se
   queda abierto. El hermano `/api/ai/knowledge/[id]` sí es idempotente a propósito
   (`tenant-isolation.test.ts:1409`). Distinguir «no existe» de «no es tuya» exigiría una
   lectura sin acotar que la auditoría marcaría, así que la forma actual es defendible; si se
   quiere arreglar, se hace con la lectura ya acotada, comparando `!existing` contra
   `existing.user_id !== userId`.
4. `src/lib/security/service-role-audit.ts:106-111` y `:77-81`, `fake-supabase.ts:114` y
   `:415+` — **los hallazgos 4-7 de la 3ª ronda siguen abiertos**, documentados como deuda 4
   del informe, tal y como acotó el líder. El más relevante sigue siendo que el stub de
   `storage` no escribe en `db.log`, así que `upload/download/createSignedUrl/remove` con rol
   de servicio son invisibles a la propiedad. Es el hueco más grande que queda y debería
   entrar en la siguiente feature de seguridad que toque adjuntos.
5. Prettier: las dos rutas de automatizaciones siguen fuera de estilo, y lo estaban **antes**
   del commit (verificado con `git show 313101b:… | prettier --check`, las dos salen
   marcadas). `npm run lint` pasa, así que no es compuerta. Se reformatean cuando se toque el
   punto 1.

## Cambios requeridos

Ninguno.
