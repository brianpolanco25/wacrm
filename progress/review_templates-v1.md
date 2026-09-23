# Review — a7.3 templates-v1

**Veredicto:** CHANGES_REQUESTED

Rama `api/templates`, worktree `.claude/worktrees/api-templates`, base `6b0d768`.
Commits revisados: `8aa9ceb`, `b188aab`, `8a25e18`, `abae331`, `8f5ec43`, `341fc6d`
(17 archivos, +3574/−271). Un solo cambio requerido (hallazgo 1); todo lo demás verde.

## Compuerta

Ejecutada por el reviewer en el worktree, comando por comando, en primer plano:

- `npm run lint`: **verde** — 0 errores, 35 avisos, todos preexistentes (ninguno en
  archivos de esta feature).
- `npm run typecheck`: **verde** — limpio.
- `TZ=UTC npm test`: **verde** — 176 archivos, 2279 tests, 0 fallos.
- `npm run build` con las variables dummy de `docs/harness.md`: **verde** —
  `✓ Compiled successfully in 8.6s`; registra `/api/v1/templates`,
  `/api/v1/templates/[id]` y `/api/v1/templates/sync`.
- `replay-migrations`: **n/a**. `git diff 6b0d768..HEAD --stat -- supabase` sale vacío,
  como dice el spec (§3 «Sin migración»).

## Trazabilidad criterio ↔ test

Spec §3 + «Seguridad transversal» + S-A4 / S-A7. Todos los `it` citados se leyeron.

- C1 «`GET /templates` paginado, filtros `status`/`language`/`category`/`search`»:
  [x] `src/app/api/v1/templates/route.test.ts` › `pagina por keyset: la segunda página
  continúa donde acabó la primera` (cursor real, `next_cursor` null al final),
  `filtra por idioma y por categoría sin distinguir mayúsculas`, `busca en el nombre y
  en el cuerpo, y nunca cruza de cuenta` (afirma que `order` del cuerpo de B no sale),
  `rechaza un estado que no existe en lugar de devolver una lista vacía` (400, no lista
  vacía).
- C2 «`GET /templates/{id}` devuelve estado, componentes, `rejection_reason`,
  `quality_score`»: [x] `src/app/api/v1/templates/[id]/route.test.ts` › `expone las
  variables {{1}}…{{n}} del cuerpo en orden de índice, con su ejemplo` (el
  `toMatchObject` del mismo `it` fija `quality_score`, `status`, `meta_template_id`) +
  `route.test.ts` › `una plantilla sin variables sale con la lista vacía…`
  (`rejection_reason: 'INVALID_FORMAT'`).
- C3 **«Test: las variables `{{1}}…{{n}}` en orden»**: [x] `[id]/route.test.ts:177`. El
  cuerpo sembrado es `'Order {{2}} is ready, {{1}}'` —el `{{2}}` antes que el `{{1}}`—
  y se exige `[{index:1,…},{index:2,…}]`: prueba el orden por índice, no el de
  aparición. `src/lib/api/v1/templates.ts:94` deriva del cuerpo con
  `extractVariableIndices`, no de una columna.
- C4 «`POST` crea y envía a Meta, 201 `PENDING`»: [x] `route.test.ts` › `valida, envía a
  Meta el cuerpo de componentes y guarda la fila en PENDING` — afirma la URL
  (`/waba-a/message_templates`), el `Authorization` con el token descifrado correcto,
  el array `components` completo y la fila guardada bajo `account_id: A`.
- C5 «`PATCH` edita y reenvía»: [x] `[id]/route.test.ts` › `hereda lo que no viene en el
  cuerpo y reenvía a Meta los componentes completos` (el FOOTER y el BUTTONS que no
  venían siguen en el cuerpo enviado; edita por `meta_template_id`, no por nombre),
  `un `null` explícito sí borra el componente`, `no deja renombrar ni cambiar de
  idioma` (400 sin llamar a Meta). Coherente con `editMessageTemplate`, que manda solo
  `components`.
- C6 «`DELETE` borra en Meta y en local»: [x] `[id]/route.test.ts` › `borra en Meta solo
  esta traducción y luego la fila local` — comprueba `hsm_id=meta-a` en la query (sin
  él Meta borraría todas las traducciones) y que la fila desaparece.
- C7 «errores de Meta → `meta_error` 502 con código público»: [x] `route.test.ts` › `un
  rechazo de Meta sale como meta_error 502 con su código público y no escribe nada`
  (`meta_code: 2388023`, el JSON no contiene `token-a` ni `graph.facebook.com`, y la
  tabla no crece), `[id]/route.test.ts` › `un rechazo de Meta … queda anotado en la
  fila` (estado NO avanza a PENDING), `sync/route.test.ts` › `un error de Meta sale como
  meta_error 502 sin filtrar el token`.
- C8 «`from`/`whatsapp_config_id` opcional como en `/messages`»: [x] `route.test.ts` ›
  `acepta `from` …` / `un `from` que no es de la cuenta es 400 y no se envía nada a
  Meta`; `[id]/route.test.ts` › `un `?from=` de otra cuenta no presta su WABA para el
  borrado`; `sync/route.test.ts` › `acepta un cuerpo para elegir el número y rechaza uno
  ajeno`.
- C9 «`POST /templates/sync` devuelve `{synced, created, updated, status_changes}`»:
  [x] `sync/route.test.ts` › `sincroniza sin cuerpo y devuelve el recuento con los
  cambios de estado` — compara `status_changes` elemento a elemento.
- C10 **«Test: el cubo de `sync` responde 429 con `Retry-After`» (S-A7)**: [x]
  `sync/route.test.ts:269` — seis 200 y el séptimo 429 con `Retry-After` entre 1 y 60,
  `X-RateLimit-Remaining: 0`, y `fetch` llamado exactamente 6 veces (el cubo protege a
  Meta de verdad). Por cuenta: `el cubo es por cuenta: agotarlo en una no bloquea a la
  otra`. `RATE_LIMITS.templatesSync = { limit: 6, windowMs: 60_000 }`
  (`src/lib/rate-limit.ts:207`), clave `templatesSync:${ctx.accountId}`.
- C11 «emite `template.status_updated` al cambiar el estado»: [x]
  `src/lib/whatsapp/template-sync.test.ts` › `emite `template.status_updated` solo
  cuando Meta movió la revisión` — segunda pasada idéntica: `statusChanges` vacío y cero
  emisiones. Un alta no emite. `emitWebhookEvent` (`src/lib/webhooks/emit.ts:27`) nunca
  lanza, así que un receptor caído no rompe el sync.
- C12 **«Test: Meta simulado (fetch mock) de crear/editar/borrar/sync»**: [x] los cuatro
  archivos doblan `global.fetch` con un tipo (`FetchLike`) y afirman URL, headers y
  cuerpo enviados, no solo el código de estado.
- C13 **«Test: fuga entre cuentas»**: [x] `src/lib/security/tenant-isolation.test.ts`
  (bloque al final, 4 `it`): `GET /templates lists A's and never B's same-named one`,
  `GET/PATCH/DELETE on B's template id are 404 and touch neither B nor Meta` (+ la
  propia sí se lee, así que el 404 no es un falso verde), `POST /templates submits under
  A's WABA even when B has the same name`, `POST /templates/sync rewrites A's catalogue
  only`. Más, por ruta: `el mismo par que tiene OTRA cuenta sí se puede crear`,
  `escribe solo dentro de la cuenta de la clave`, `actualiza la fila de la cuenta, no la
  homónima de la otra`.
- C14 «sync compartido con el panel sin cambiar su comportamiento»: [x] comparado a mano
  `git show 6b0d768:src/app/api/whatsapp/templates/sync/route.ts` contra
  `src/lib/whatsapp/template-sync.ts` + la cáscara nueva: `normalizeCategory`,
  `normalizeQualityScore`, `parseButtons`, `extractSampleValues`, la fila, el orden
  lectura→update/insert, el tope de 20 páginas y el JSON del panel
  (`{success,total,inserted,updated,errors,truncated}`) son idénticos. La única
  diferencia de código es `.eq('account_id', …)` de más en el UPDATE (endurecimiento) y
  el 502 de Meta que ahora viaja como `TemplateSyncError` y se traduce al mismo
  `{error}` + 502 en `route.ts:91`. Suite: `template-sync.test.ts`, 7 `it` (paginación,
  alta/actualización, normalización incluida la caída silenciosa de botones FLOW, 502,
  `truncated` tras 20 páginas, fallo por plantilla que no tumba las demás).
- C15 «S-A4 scopes»: [x] `templates:read`/`templates:write` al final de `API_SCOPES` y
  `SCOPE_DESCRIPTIONS`; exigidos en cada handler vía `requireApiKey(request, …)`.
- C16 «escrituras con `Content-Type` obligatorio y tope de 1 MiB»: [x] `route.test.ts` ›
  `exige Content-Type JSON como toda escritura de /api/v1` (415); `sync/route.test.ts` ›
  `acepta `Content-Type: application/json` con el cuerpo vacío` y, en el mismo `it`, que
  un `[]` en la raíz sigue siendo 400.
- SQL de comprobación: **no aplica**, sin migración. La fuga se prueba contra
  `fake-supabase.ts`, que evalúa las consultas de verdad sobre dos cuentas sembradas
  —el mecanismo que el repo ya usa para esto—. Guion manual contra Meta: presente y
  concreto en `progress/impl_templates-v1.md` («Verificación manual pendiente», 7
  pasos, incluidos el 429 del cubo y la cabecera de imagen).

## Checkpoints

- CP1 Compuerta: [x] los cuatro verdes, ejecutados por el reviewer.
- CP2 Migraciones: [x] n/a — sin SQL (`git diff -- supabase` vacío).
- CP3 Aislamiento: [x] las 11 consultas con rol de servicio de la feature llevan
  `account_id`: `route.ts:69` (lista), `:167` (choque de nombre), `:233` (insert),
  `[id]/route.ts:66` (loadTemplate), `:221` (update de `submission_error`), `:245`
  (update tras editar), `:310` (delete), `template-sync.ts:306` (lookup), `:330`
  (UPDATE, el `account_id` añadido en `abae331`), `:282` (account_id en la fila del
  insert). Las indirectas también: `resolveWhatsAppConfig` y
  `configIdForPhoneNumberId` filtran por cuenta (`resolve-config.ts:117-121`, `:213`),
  `assertMediaPathOwnedBy` en la cabecera de imagen, `resolveAuditUserId` por
  `accountId`. Fuga probada en GET/PATCH/DELETE/POST/sync (C13).
- CP4 Tests: [x] ver trazabilidad; leídos, no contados.
- CP5 Dependencias: [x] `git diff 6b0d768..HEAD -- package.json package-lock.json` vacío.
- CP6 i18n: [x] n/a — la feature no añade texto de interfaz. Las dos
  `SCOPE_DESCRIPTIONS` nuevas se pintan en `api-keys-settings.tsx:539` en inglés, igual
  que las siete que ya estaban: deuda preexistente de a7.1, no de esta feature.
- CP7 Next 16: [x] `{ params }: { params: Promise<{ id: string }> }` con `await params`
  comprobado contra
  `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/route.md:87`,
  no de memoria.
- CP8 Alcance: [x] los 17 archivos caen dentro de §3 o de la extracción que §3 obliga.
  Deuda encontrada fuera (WABA por plantilla, `WHATSAPP_TEMPLATES_DRY_RUN` sin
  documentar, `/messages type=template` sin comprobar estado local, botones OTP/FLOW
  descartados) anotada en el informe, no arreglada.
- CP9 Documentación: [x] `CHANGELOG.md` (Unreleased) y `docs/public-api.md` con las seis
  rutas, el cubo y la sección «Templates and sending»; sin variables de entorno nuevas;
  el informe coincide con el diff que leí.
- CP10 Git: [x] seis commits en `api/templates`, en español con prefijo y
  `Co-Authored-By: Claude Opus 5 (1M context)`; sin upstream (nada pusheado); `main` @
  `3b82698` y `feat/saas-multiempresa` @ `4756a47` intactos.
- CP11 Entrante: [x] n/a — nada de esto toca el webhook de WhatsApp.

## Hallazgos (archivo:línea)

1. **[bloqueante] `src/app/api/v1/templates/sync/route.ts:89` — la respuesta pública
   devuelve mensajes de error de Postgres tal cual.** `errors: result.errors` sale en un
   200 al integrador, y cada `message` viene de `template-sync.ts:315` (`lookupErr`),
   `:335` (`updErr`) y `:357` (`insErr`), que son el `PostgrestError.message` literal
   («duplicate key value violates unique constraint
   "message_templates_account_id_name_language_key"», «null value in column … violates
   not-null constraint»). El spec, «Seguridad transversal»: *«Los mensajes de error no
   exponen SQL, rutas del servidor ni detalles de Meta más allá de su código y mensaje
   público»*. En el panel esto se lo comía la interfaz de un admin; por `/api/v1` es
   esquema interno en manos de un tercero. El propio test lo enseña:
   `template-sync.test.ts:344` afirma `message: 'insert exploded'`, el texto del motor,
   sin filtrar. `errors` además es un campo que §3 no pide (§3: `{synced, created,
   updated, status_changes}`), así que es una adición que trajo el problema con ella.
2. `docs/public-api.md:58-71` — la tabla de scopes se reformateó entera (prettier
   realineó los bordes) en vez de añadir dos filas al final. `api/recursos` (a7.2) añade
   `tags:read`/`tags:write` a esa misma tabla: el conflicto al integrar será de tabla
   completa, no de dos líneas. No es un defecto del código; aviso para el líder. El
   resto de lo compartido sí está localizado al final: `scopes.ts:24` y `:39`,
   `rate-limit.ts:200-207`, `CHANGELOG.md:446`, y el bloque de
   `tenant-isolation.test.ts:3002` con sus imports al final de la lista.
3. `src/app/api/whatsapp/templates/sync/route.ts` (la cáscara del panel) sigue sin test
   propio, como antes de la extracción. La equivalencia con `6b0d768` la comprobé línea
   a línea y el algoritmo ya tiene suite; queda anotado, no es cambio requerido.

## Cambios requeridos

1. Que `POST /api/v1/templates/sync` no devuelva el texto del motor de base de datos.
   Dos formas razonables, a elección del implementer: (a) sustituir el `message` por uno
   fijo por plantilla —«could not be saved», con `name`/`language`, que es lo que el
   cliente puede accionar— y dejar el detalle en `console.error`; o (b) quitar `errors`
   de la respuesta pública y reflejar el fallo en un contador (`failed: n`), que es lo
   que §3 pide literalmente. El panel puede seguir recibiendo el detalle: quien decide
   es la ruta, no `syncTemplatesFromMeta`. Con su test (un insert que falla → el 200 no
   contiene el texto de Postgres).

---

# Segunda ronda — commit `80e0e9d`

**Veredicto:** APPROVED

Delta revisada: `341fc6d..80e0e9d`, 3 archivos (+108/−15):
`src/app/api/v1/templates/sync/route.ts`, su test y `docs/public-api.md`.
Nada más se movió (`git diff 6b0d768..HEAD --stat -- package.json package-lock.json
supabase messages` vacío). Worktree limpio, rama sin upstream.

## Compuerta (ejecutada por el reviewer, comando a comando, en primer plano)

- `npm run lint`: **verde** — 0 errores, 35 avisos, los mismos preexistentes.
- `npm run typecheck`: **verde** — limpio.
- `TZ=UTC npm test`: **verde** — 176 archivos, **2280** tests, 0 fallos (uno más que la
  primera ronda, el de la fuga).
- `npm run build` con las variables dummy de `docs/harness.md`: **verde** —
  `✓ Compiled successfully in 13.3s`; sigue registrando `/api/v1/templates`,
  `/api/v1/templates/[id]`, `/api/v1/templates/sync` y `/api/whatsapp/templates/sync`.
- `replay-migrations`: **n/a** — sin SQL.

## Hallazgo 1 (bloqueante) — cerrado

Comprobado a mano, camino por camino:

- Los tres sitios que meten un `PostgrestError.message` en `errors` son
  `template-sync.ts:315` (lookup), `:335` (update) y `:357` (insert), y los tres
  desembocan en el mismo array. `sync/route.ts:110-114` lo reescribe entero con
  `.map(e => ({ name, language, message: TEMPLATE_SAVE_FAILED }))`: no hay rama que
  esquive el mapeo, ni siquiera parcialmente. La constante es
  `TEMPLATE_SAVE_FAILED = 'Template could not be saved'` (`route.ts:40`).
- Ninguna otra salida de la ruta puede llevar texto del motor: `TemplateSyncError` solo
  se lanza en `template-sync.ts:218` envolviendo el error de Meta (→ `metaErrorResponse`,
  502 con `meta_code`), `WhatsAppConfigError` trae mensaje propio, y cualquier otra
  excepción cae en `toApiErrorResponse` → `respond.ts:246` `internal` /
  «Internal server error».
- El test lo verifica **sobre el cuerpo serializado**, no sobre el objeto:
  `sync/route.test.ts:218` › `una escritura fallida no devuelve el texto del motor de
  base de datos` hace `const text = await res.text()` y afirma
  `not.toContain('duplicate key')` y
  `not.toContain('message_templates_account_id_name_language_key')` sobre el JSON
  entero; luego `errors` exactamente
  `[{ name:'welcome', language:'en_US', message:'Template could not be saved' }]`,
  `{synced:2, created:0, updated:1}` (el fallo de una no aborta el resto, así que un 500
  no pasaría el test por accidente) y que el `console.error` espiado **sí** contiene el
  texto de Postgres. El doble `h.client` solo sustituye el `insert` de `welcome` y se
  resetea en `beforeEach`/`afterEach`; ningún otro `it` lo hereda (los 2280 pasan).

## Comprobaciones pedidas

1. **Nada de `PostgrestError.message` en la respuesta pública, en ningún camino**: [x]
   ver arriba (lookup / update / insert + las tres salidas de error de la ruta).
2. **El panel sigue recibiendo el detalle**: [x] `src/app/api/whatsapp/templates/sync/
   route.ts:80` devuelve `errors: result.errors` sin mapear, y el JSON
   (`{success, total, inserted, updated, errors, truncated}`) es el mismo que
   `git show 6b0d768:…:312-316`. Ese archivo no se tocó en `80e0e9d`.
3. **`console.error` sin tokens ni secretos**: [x] las seis llamadas de la feature
   (`sync/route.ts:99`, `route.ts:109`/`:259`, `[id]/route.ts:69`/`:250`/`:315`) imprimen
   el `PostgrestError` y, la nueva, `account_id`, `name` y `language`. Ninguna imprime
   `accessToken`, el `ctx` ni la URL de Graph con credenciales.
4. **Tabla de scopes**: [x] `git diff 6b0d768..HEAD -- docs/public-api.md` muestra en esa
   tabla **solo dos líneas `+`** (`templates:read`, `templates:write`) al final; las nueve
   filas previas, la cabecera y el separador salen intactos. Hallazgo 2 cerrado.
   *Aviso para quien integre*: las dos filas nuevas quedan sin alinear a propósito;
   pasar prettier por `docs/public-api.md` **después** del merge con a7.2 realineará la
   tabla de una vez.
5. **`errors` documentado**: [x] `docs/public-api.md` (sección
   `POST /api/v1/templates/sync`) enumera el campo en el ejemplo JSON y describe la forma
   en prosa: «`errors` lists the templates that could not be saved —by `name` and
   `language`, with a fixed `message`— … the reason is logged server-side, never
   returned». La spec §3 no lo pedía; está documentado, se acepta.

## Checkpoints (re-verificados sobre la delta)

- CP1 Compuerta: [x] los cuatro verdes, ejecutados por el reviewer.
- CP2 Migraciones: [x] n/a.
- CP3 Aislamiento: [x] sin consultas nuevas; el mapeo no toca ninguna.
- CP4 Tests: [x] el `it` nuevo leído, no contado.
- CP5 Dependencias: [x] `package.json`/`package-lock.json` sin cambios.
- CP6 i18n: [x] n/a — nada de interfaz.
- CP7 Next 16: [x] sin cambios de firma de handler.
- CP8 Alcance: [x] tres archivos, todos justificados por el hallazgo 1 y el 2.
- CP9 Documentación: [x] `docs/public-api.md` al día; `CHANGELOG.md` no necesitaba cambio
  (describe `{synced, created, updated, status_changes}`, que sigue siendo cierto).
- CP10 Git: [x] commit en español con prefijo `fix:` y
  `Co-Authored-By: Claude Opus 5 (1M context)`; sin upstream, nada pusheado.
- CP11 Entrante: [x] n/a.

## Hallazgos abiertos (no bloqueantes, ya anotados en la primera ronda)

1. `src/app/api/whatsapp/templates/sync/route.ts` sigue sin test propio (hallazgo 3 de la
   primera ronda). Deuda, no cambio requerido.
2. La deuda del informe del implementer (WABA por plantilla, `WHATSAPP_TEMPLATES_DRY_RUN`
   sin documentar, `/messages type=template` sin comprobar estado local, botones OTP/FLOW
   descartados en el sync) queda para el líder, fuera de a7.3.
