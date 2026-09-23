# a7.3 `templates-v1` — plantillas por la API pública

Rama `api/templates`, worktree `.claude/worktrees/api-templates`, base `feat/api-publica` @ 6b0d768
(a7.1 `api-hardening` + a7.4 `webhooks-durable` ya integradas).
Spec: `progress/spec_api-publica.md` §3 + «Seguridad transversal» + S-A4 / S-A7.

> **Nota de continuidad.** La primera sesión murió por watchdog dejando el trabajo sin
> commitear. Esta segunda lo rescató: se leyó el diff entero y los tres archivos nuevos, se
> comprobó que compilaba y se commiteó como primer hito antes de seguir. Nada del trabajo
> anterior se rehízo desde cero; lo que faltaba eran las pruebas, la suite de aislamiento y la
> documentación.

## Plan (antes de escribir código)

1. `src/lib/api-keys/scopes.ts`: `templates:read` y `templates:write` al final de `API_SCOPES`
   y `SCOPE_DESCRIPTIONS` (S-A4).
2. `src/lib/rate-limit.ts`: cubo `templatesSync` 6/min por cuenta al final de `RATE_LIMITS` (S-A7).
3. Extraer la sincronización desde Meta de `src/app/api/whatsapp/templates/sync/route.ts` a
   `src/lib/whatsapp/template-sync.ts` sin cambiar el comportamiento del panel; el evento
   `template.status_updated` (a7.4) viaja con ella.
4. `src/lib/api/v1/templates.ts`: `SELECT`, serializador público, lista de variables del cuerpo,
   lectura/validación del cuerpo entrante, resolución del número (`from` / `whatsapp_config_id`).
5. Rutas: `GET|POST /api/v1/templates`, `GET|PATCH|DELETE /api/v1/templates/{id}`,
   `POST /api/v1/templates/sync`. Todas sobre `requireApiKey` + `readJsonBody`/`withIdempotency`
   + `ok`/`okList`/`fail`/`toApiErrorResponse` + `parseListParams`/`keysetFilter`/`buildPage`.
6. Tests vitest junto al código + casos de fuga en `src/lib/security/tenant-isolation.test.ts`.
7. `docs/public-api.md` (incluida la relación con `POST /api/v1/messages type=template`) y
   `CHANGELOG.md` (Unreleased).

## Commits

| SHA | Mensaje |
| --- | --- |
| `8aa9ceb` | `feat: exponer las plantillas de mensaje por la API pública` (rescate del WIP: las tres rutas, la capa común, el sync extraído, los scopes, el cubo, `MetaApiError`) |
| `b188aab` | `test: fijar el comportamiento de la sincronización extraída` |
| `8a25e18` | `test: cubrir las cinco operaciones de plantillas con Meta simulado` |
| `abae331` | `test: sumar las plantillas de /api/v1 a la suite de aislamiento` (+ el `account_id` que faltaba en el UPDATE del sync y el cuerpo vacío de `/sync`) |
| `8f5ec43` | `docs: documentar las plantillas de la API pública` |
| `341fc6d` | `test: dar tipo al doble de fetch de las pruebas de plantillas` |

Sin migración (el spec lo dice explícitamente: §3 «Sin migración»). Worktree limpio.

## Archivos

Nuevos:

- `src/lib/whatsapp/template-sync.ts` — el algoritmo de sincronización, compartido.
- `src/lib/api/v1/templates.ts` — serializador público, variables, parseo del cuerpo,
  resolución de WABA, `metaErrorResponse`.
- `src/app/api/v1/templates/route.ts`, `.../[id]/route.ts`, `.../sync/route.ts` (+ sus tests).
- `src/lib/whatsapp/template-sync.test.ts`.

Modificados:

- `src/app/api/whatsapp/templates/sync/route.ts` — se queda como cáscara: sesión, número,
  forma de la respuesta del panel. Cero cambios de comportamiento observable.
- `src/lib/api-keys/scopes.ts`, `src/lib/rate-limit.ts` — añadidos **al final** de las listas,
  como pidió el líder, para no chocar con `api/recursos`.
- `src/lib/whatsapp/meta-api.ts` — `MetaApiError` (mismo `message` que antes; añade `status`,
  `code`, `type`).
- `src/lib/api/v1/body.ts` — opción `allowEmpty` (ver «Decisiones»).
- `src/lib/security/tenant-isolation.test.ts` — imports y bloque **al final del archivo**.
- `docs/public-api.md`, `CHANGELOG.md` — añadidos al final de sus listas/secciones.

## Criterios de aceptación ↔ tests

| Criterio (spec §3) | Archivo | `it(...)` |
| --- | --- | --- |
| `GET /templates` paginado | `src/app/api/v1/templates/route.test.ts` | `pagina por keyset: la segunda página continúa donde acabó la primera` |
| …filtro `status` (y valor inválido → 400) | ídem | `rechaza un estado que no existe en lugar de devolver una lista vacía`, `una plantilla sin variables sale con la lista vacía, no sin el campo` |
| …filtros `language` / `category` | ídem | `filtra por idioma y por categoría sin distinguir mayúsculas` |
| …filtro `search` (nombre y cuerpo) | ídem | `busca en el nombre y en el cuerpo, y nunca cruza de cuenta` |
| Devuelve estado de Meta, componentes, `rejection_reason`, `quality_score` | `src/app/api/v1/templates/[id]/route.test.ts` | `expone las variables {{1}}…{{n}} del cuerpo en orden de índice, con su ejemplo` (+ el `toMatchObject` del mismo `it`) |
| **Test: `GET /templates/{id}` expone las variables `{{1}}…{{n}}` en orden** | ídem | `expone las variables {{1}}…{{n}} del cuerpo en orden de índice, con su ejemplo` |
| `POST` crea y envía a Meta (201, `PENDING`) | `src/app/api/v1/templates/route.test.ts` | `valida, envía a Meta el cuerpo de componentes y guarda la fila en PENDING` |
| `PATCH` edita y reenvía | `src/app/api/v1/templates/[id]/route.test.ts` | `hereda lo que no viene en el cuerpo y reenvía a Meta los componentes completos`, `un `null` explícito sí borra el componente` |
| `DELETE` borra en Meta y en local | ídem | `borra en Meta solo esta traducción y luego la fila local` |
| Errores de Meta → `meta_error` 502 con código público | `route.test.ts` / `[id]/route.test.ts` / `sync/route.test.ts` | `un rechazo de Meta sale como meta_error 502 con su código público y no escribe nada`, `un rechazo de Meta sale como meta_error 502 y queda anotado en la fila`, `un error de Meta sale como meta_error 502 sin filtrar el token` |
| `whatsapp_config_id`/`from` opcional como en `/messages` | `route.test.ts`, `[id]/route.test.ts`, `sync/route.test.ts` | `acepta `from` con el phone_number_id del cliente y usa esa WABA`, `un `from` que no es de la cuenta es 400 y no se envía nada a Meta`, `un `?from=` de otra cuenta no presta su WABA para el borrado`, `acepta un cuerpo para elegir el número y rechaza uno ajeno` |
| `POST /templates/sync` devuelve `{synced, created, updated, status_changes}` | `sync/route.test.ts` | `sincroniza sin cuerpo y devuelve el recuento con los cambios de estado` |
| **Test: el cubo de `sync` responde 429 con `Retry-After`** | ídem | `responde 429 con Retry-After a partir de la llamada 7 del minuto` |
| …y es **por cuenta** (S-A7) | ídem | `el cubo es por cuenta: agotarlo en una no bloquea a la otra` |
| Emite `template.status_updated` al detectar cambio de estado | `src/lib/whatsapp/template-sync.test.ts`, `sync/route.test.ts`, `tenant-isolation.test.ts` | `emite `template.status_updated` solo cuando Meta movió la revisión`, `sincroniza sin cuerpo y devuelve el recuento…`, `POST /templates/sync rewrites A's catalogue only` |
| **Test: Meta simulado (fetch mock) de crear/editar/borrar/sync** | los cuatro archivos | todo el conjunto: `global.fetch` es el doble en todos |
| **Test: fuga entre cuentas** | `src/lib/security/tenant-isolation.test.ts` | `GET /templates lists A's and never B's same-named one`, `GET/PATCH/DELETE on B's template id are 404 and touch neither B nor Meta`, `POST /templates submits under A's WABA even when B has the same name`, `POST /templates/sync rewrites A's catalogue only` |
| …y en las suites por ruta | `route.test.ts`, `[id]/route.test.ts`, `sync/route.test.ts`, `template-sync.test.ts` | `el mismo par que tiene OTRA cuenta sí se puede crear`, `el id de la otra cuenta es 404, no 403 ni la fila`, `escribe solo dentro de la cuenta de la clave`, `actualiza la fila de la cuenta, no la homónima de la otra` |
| Sync compartido con el panel sin cambiar su comportamiento | `src/lib/whatsapp/template-sync.test.ts` | los 7 `it` del archivo (paginación, alta/actualización, normalización, 502, tope de 20 páginas, error por plantilla) |
| Escrituras con `Content-Type` obligatorio y tope de 1 MiB | `route.test.ts`, `sync/route.test.ts` | `exige Content-Type JSON como toda escritura de /api/v1`, `acepta `Content-Type: application/json` con el cuerpo vacío` |
| `bad_request` con el nombre del campo | `route.test.ts` | `devuelve el fallo del validador con el campo, no un 500` |

Recuento: 47 `it` nuevos — 43 en las suites propias (7 en `template-sync.test.ts`, 15 en
`templates/route.test.ts`, 13 en `templates/[id]/route.test.ts`, 8 en
`templates/sync/route.test.ts`) y 4 en la de aislamiento.

## Verificaciones contra base real

**No aplica.** La feature no toca SQL (§3: «Sin migración»), así que no hay nada que
`scripts/replay-migrations.sh` pueda comprobar que no comprueben ya los tests. El aislamiento
entre cuentas —que en otras features pediría Postgres— se comprueba con
`src/lib/security/fake-supabase.ts`, que evalúa las consultas de verdad contra dos cuentas
sembradas y es el mecanismo que el repo ya usa para esto. No se creó
`progress/checks_templates-v1.sql` por la misma razón.

## Compuerta

Los cuatro comandos, por separado y en primer plano, desde el worktree:

| Comando | Resultado |
| --- | --- |
| `npm run lint` | 0 errores, 35 avisos (todos preexistentes, ninguno en archivos de esta feature) |
| `npm run typecheck` | limpio |
| `TZ=UTC npm test` | 176 archivos, **2279 tests**, 0 fallos |
| `npm run build` (con las variables de `docs/harness.md`) | `✓ Compiled successfully`; registra `/api/v1/templates`, `/api/v1/templates/[id]` y `/api/v1/templates/sync` |

`scripts/replay-migrations.sh`: no ejecutado, sin SQL tocado.

## Verificación manual pendiente (depende de Meta)

Todo lo que toca la Graph API de verdad. Guion, con una WABA de pruebas y una clave con
`templates:read templates:write`:

```bash
export K="Bearer wacrm_live_…"; export H="https://<tu-crm>"

# 1. alta — debe volver 201 con status PENDING y un meta_template_id real
curl -sS -X POST "$H/api/v1/templates" -H "Authorization: $K" \
  -H 'Content-Type: application/json' -H 'Idempotency-Key: manual-1' \
  -d '{"name":"harness_probe_01","language":"en_US","category":"Utility",
       "body_text":"Hi {{1}}, your order {{2}} is on its way.",
       "sample_values":{"body":["Ada","A-123"]},"footer_text":"Reply STOP to opt out"}'
# 1b. repetir el MISMO comando: debe volver idéntico con Idempotent-Replayed: true

# 2. en WhatsApp Manager, comprobar que la plantilla aparece «En revisión».
#    Esperar a que Meta la apruebe (minutos u horas).

# 3. sincronizar — synced>=1, y status_changes con PENDING → APPROVED
curl -sS -X POST "$H/api/v1/templates/sync" -H "Authorization: $K"
#    Con un webhook registrado para `template.status_updated`, debe llegar
#    una entrega con ese mismo cuerpo (Ajustes → Webhooks → Entregas).

# 4. el cubo: siete llamadas seguidas; la séptima, 429 con Retry-After
for i in $(seq 1 7); do
  curl -sS -o /dev/null -w '%{http_code} ' -X POST "$H/api/v1/templates/sync" -H "Authorization: $K"
done; echo   # esperado: 200 200 200 200 200 200 429

# 5. edición — 200, status vuelve a PENDING, y en WhatsApp Manager el pie
#    de página SIGUE ahí aunque no se haya mandado (herencia del PATCH)
ID=$(curl -sS "$H/api/v1/templates?search=harness_probe_01" -H "Authorization: $K" | jq -r .data[0].id)
curl -sS -X PATCH "$H/api/v1/templates/$ID" -H "Authorization: $K" \
  -H 'Content-Type: application/json' \
  -d '{"body_text":"Hi {{1}}, order {{2}} shipped today.","sample_values":{"body":["Ada","A-123"]}}'

# 6. envío — con la plantilla APPROVED, `params` en el orden de `variables`
curl -sS -X POST "$H/api/v1/messages" -H "Authorization: $K" -H 'Content-Type: application/json' \
  -d '{"to":"+<tu-número>","type":"template",
       "template":{"name":"harness_probe_01","language":"en_US","params":["Ada","A-123"]}}'

# 7. borrado — 200, y en WhatsApp Manager desaparece SOLO esta traducción
curl -sS -X DELETE "$H/api/v1/templates/$ID" -H "Authorization: $K"
```

Dos cosas que solo se ven contra Meta de verdad y conviene mirar en el paso 1: que una
plantilla con **cabecera de imagen** (`header_type: "image"` + `header_media_url` de un objeto
propio del bucket) llegue con su `header_handle` —es el único camino que usa
`uploadResumableMedia` y necesita `META_APP_ID`—, y que el `meta_code` del 502 sea el que
documenta Meta (probar con un `name` duplicado a propósito).

## Decisiones donde el spec era ambiguo

1. **Dónde vive la sincronización.** El spec pide `POST /api/v1/templates/sync` y que no se
   duplique lógica de Meta, pero no dice dónde ponerla. Se extrajo a
   `src/lib/whatsapp/template-sync.ts` y las dos rutas (panel y API) quedan como cáscaras. La
   alternativa —que la ruta de la API llamara a la del panel— habría arrastrado la
   autenticación por sesión; y dos copias habrían divergido en lo peor posible: una plantilla
   que el panel marca APPROVED y la API no.

2. **Si Meta rechaza el alta, no se escribe nada.** El panel deja un borrador visible para que
   el usuario lo corrija en la interfaz. Un cliente de API no tiene dónde verlo y se le
   quedaría una fila fantasma ocupando el par `(name, language)`, que es único por cuenta. El
   spec dice «201, estado PENDING» y no habla del fallo; se eligió no escribir.

3. **`PATCH` hereda en vez de parchear.** Meta REEMPLAZA los componentes en cada edición. Un
   parcheo literal borraría el pie de página o los botones que el cliente no mencionó. Se
   hereda de la fila y se exige `null` explícito para quitar algo. Está documentado.

4. **`name` y `language` inmutables en `PATCH`** (400). Meta trata cada par como una plantilla
   distinta: «renombrar» sería crear otra, y la fila local perdería su correspondencia con
   `meta_template_id`.

5. **Categoría `Authentication` refusada en `POST` y `PATCH`** (400, con la alternativa en el
   mensaje: crearla en WhatsApp Manager y traerla con `/sync`). Esas plantillas exigen el flujo
   de OTP de Meta, con campos (`otp_type`, `code_expiration_minutes`, botones OTP) que ni
   `template-validators.ts` ni `template-components.ts` saben construir. Aceptarlas habría sido
   prometer algo que rebota en Meta.

6. **`PATCH` sin `withIdempotency`.** El spec solo exige idempotencia donde ya la había (a7.1).
   Repetir la misma edición es idempotente por naturaleza —el resultado es el mismo conjunto de
   componentes— y Meta ya limita a 10 ediciones por 30 días. `POST` sí va envuelto: crear dos
   veces sería un 409 de Meta y gastaría una de las 100 creaciones por hora de la WABA.

7. **El cuerpo de `/sync` es opcional, incluso con `Content-Type: application/json`.** Su
   cuerpo solo sirve para elegir el número. `curl -X POST -H 'Content-Type: application/json'`
   sin `-d` es la forma natural de llamar a algo así, y con las reglas de a7.1 daba 400.
   Se añadió `readJsonBody(request, { allowEmpty: true })` — **opt-in explícito**: ninguna otra
   escritura de `/api/v1` cambia, y el resto de controles (415, 413, objeto en la raíz) siguen
   valiendo para `/sync`. Es el único retoque a la capa común de a7.1.

8. **`DELETE` elige número por query (`?from=`), no por cuerpo.** Un `DELETE` con cuerpo es
   legal pero lo maltratan proxies y clientes.

9. **El `UPDATE` del sync lleva `account_id`.** Lo encontró la auditoría de la suite de
   aislamiento, no un caso escrito a mano: iba solo por `id`. Estaba a salvo por derivación (el
   id salía de una búsqueda ya acotada) y bajo RLS en el panel, pero desde la API pública lo
   ejecuta el rol de servicio y esa red no existe. Cuesta nada.

10. **`MetaApiError` conserva `error.code`.** El spec pide «errores de Meta como `meta_error`
    (502) con su código público». `throwMetaError` lanzaba un `Error` pelado. La subclase
    mantiene el mismo `message`, así que ningún llamador existente cambia de comportamiento.

11. **Serialización.** La forma pública no incluye `account_id` (redundante: la fija la clave)
    ni `user_id` (columna de auditoría interna; identificaría a una persona ante un tercero).
    `variables` es un campo derivado, no una columna.

## Variables de entorno

**Ninguna nueva.** `docs/docker.md` y `.env.local.example` no se tocan.

`WHATSAPP_TEMPLATES_DRY_RUN` la reutilizan las rutas nuevas, pero ya existía (la usan
`/api/whatsapp/templates/submit` y `/api/whatsapp/templates/[id]`). Ver «Deuda».

## Deuda detectada fuera de alcance (no arreglada)

1. **Las plantillas son por WABA en Meta y `UNIQUE(account_id, name, language)` aquí.** Una
   cuenta con números bajo WABA distintas no puede expresar a qué WABA pertenece cada
   plantilla: `from`/`whatsapp_config_id` sirve para ELEGIR contra qué WABA se opera, pero la
   fila local no la guarda. Heredado del panel (fase 4 §1), anotado en el comentario de
   `resolveTemplateWaba`. Arreglarlo pide migración y quedaba fuera de §3 («sin migración»).

2. **`WHATSAPP_TEMPLATES_DRY_RUN` no está documentada en ningún sitio.** Existe desde antes en
   dos rutas del panel y ahora en dos de la API; no aparece en `docs/docker.md`, en
   `docs/security.md` ni en `.env.local.example`. Documentarla es trabajo de quien haga el
   repaso de variables, no de esta feature.

3. **`POST /api/v1/messages` con `type=template` no comprueba el estado local.** Enviar una
   plantilla `PENDING` o `REJECTED` va a Meta y vuelve como 502. Se podría cortar antes con una
   lectura de `message_templates`, pero es un cambio de comportamiento de a7.1/fase anterior y
   tiene su contrapartida (una fila local desfasada bloquearía un envío que Meta aceptaría).
   Documentado como está.

4. **Botones OTP y FLOW se descartan en silencio en la sincronización.** Heredado tal cual de
   la ruta del panel (`parseButtons` solo conoce QUICK_REPLY, URL, PHONE_NUMBER y COPY_CODE).
   Una plantilla de Meta con esos botones se guarda sin ellos. Está fijado por test
   (`normaliza categoría, calidad y cabecera como lo hacía la ruta del panel`) para que el
   comportamiento sea deliberado y visible, no para bendecirlo.

## Archivos bloqueados

`.env.local.example` está bloqueado por permisos. No hizo falta tocarlo: esta feature no añade
variables de entorno.

---

# Segunda ronda (review CHANGES_REQUESTED)

Review de partida: `progress/review_templates-v1.md`. Un solo cambio requerido (hallazgo 1,
bloqueante) más un aviso de formato (hallazgo 2). Esta ronda también murió por watchdog la
primera vez: el trabajo estaba sin commitear en el worktree, se rescató leyendo el diff,
comprobando que compilaba y commiteándolo antes de seguir.

## Commit

- `80e0e9d` — `fix: no filtrar el texto de Postgres en el sync de plantillas`.
  Tres archivos: `src/app/api/v1/templates/sync/route.ts`,
  `src/app/api/v1/templates/sync/route.test.ts`, `docs/public-api.md`.

## Hallazgo 1 (bloqueante) — resuelto

**Qué pasaba.** `POST /api/v1/templates/sync` devolvía `errors: result.errors` tal cual, y
cada `message` es el `PostgrestError.message` literal que produce `template-sync.ts`
(`lookupErr`, `updErr`, `insErr`): nombres de constraint
(`message_templates_account_id_name_language_key`), de columna y de tabla. En el panel eso lo
leía un admin de la propia cuenta; por `/api/v1` es esquema interno en manos de un tercero, y
«Seguridad transversal» del spec lo prohíbe.

**Opción elegida: (a) del review**, mensaje fijo por plantilla. Razón: §3 dice que el sync
«no aborta por una plantilla que falla», y un contador `failed: n` a secas (opción b) le
quita al integrador lo único accionable —CUÁL plantilla no entró—, que es justo lo que no es
esquema interno. Se conserva el par `(name, language)` y el `message` pasa a ser la constante
`TEMPLATE_SAVE_FAILED = 'Template could not be saved'`.

**Dónde se decide.** En la ruta, no en `syncTemplatesFromMeta`: la librería sigue devolviendo
el detalle y el panel (`/api/whatsapp/templates/sync`) lo sigue recibiendo sin cambios, igual
que antes de la extracción. `template-sync.test.ts` sigue afirmando el texto crudo a nivel de
librería, que es lo correcto.

**Dónde queda el detalle.** `console.error` por plantilla fallida, con `account_id`, `name` y
`language` delante, antes del `ok(...)`.

| Criterio del review | Test |
| --- | --- |
| Un insert que falla → el 200 no contiene el texto de Postgres | `src/app/api/v1/templates/sync/route.test.ts` › `una escritura fallida no devuelve el texto del motor de base de datos` |

Ese `it` hace, sobre el cuerpo de la respuesta ya serializado (`res.text()`, no el objeto):

1. `expect(text).not.toContain('duplicate key')` y
   `.not.toContain('message_templates_account_id_name_language_key')` — la comprobación de
   fuga de verdad, sobre el JSON entero y no sobre un campo concreto.
2. `errors` es exactamente `[{ name: 'welcome', language: 'en_US', message: 'Template could
   not be saved' }]`.
3. `{ synced: 2, created: 0, updated: 1 }` — el fallo de una plantilla no abortó el resto (si
   el test solo mirase el texto, un 500 lo pasaría igual).
4. El detalle no se perdió: el `console.error` espiado sí contiene el mensaje de Postgres.

**Cómo se provoca el fallo.** El doble `requireApiKey` del archivo ya inyectaba `h.db.admin`;
se añadió `h.client`, que cuando no es `null` sustituye a ese cliente por un envoltorio que
delega en el `FakeDatabase` real salvo para el `insert` de la plantilla `welcome`, donde
devuelve `{ data: null, error: { message: <texto de Postgres> } }`. Así el resto del
catálogo se sincroniza de verdad contra el fake y solo esa escritura falla. `h.client` se
resetea en `beforeEach` y en `afterEach` (con `vi.restoreAllMocks()` para el espía de
`console.error`), de modo que ningún otro `it` del archivo hereda el doble.

## Hallazgo 2 (aviso) — resuelto

La tabla de scopes de `docs/public-api.md` vuelve **byte a byte** al alineado de `6b0d768`
para las nueve filas que ya estaban, y las dos nuevas (`templates:read`, `templates:write`)
van al final sin realinear la tabla. Comprobado con
`git show 6b0d768:docs/public-api.md | sed -n '55,72p'` contra el archivo actual: las líneas
de cabecera, separador y filas preexistentes son idénticas. El merge con `api/recursos`
(a7.2), que añade `tags:read`/`tags:write` a esa misma tabla, queda en dos líneas.

**Consecuencia a tener presente:** `npx prettier --write docs/public-api.md` volvería a
realinear la tabla entera. Por eso ese archivo **no** se pasó por prettier en esta ronda; los
dos archivos de código sí estaban ya formateados (prettier no es parte de la compuerta de CI:
`lint → typecheck → test → build`). Quien integre a7.2 y a7.3 puede dejar que prettier
realinee **después** del merge, no antes.

También se ajustó el párrafo de `docs/public-api.md` que describía `errors`: ahora dice que
lista las plantillas que no se pudieron guardar por `name` y `language`, con un `message`
fijo, y que el motivo se registra en el servidor y nunca se devuelve.

## Hallazgo 3 — no tocado, a propósito

El review lo marca como «anotado, no es cambio requerido»: la cáscara del panel
`src/app/api/whatsapp/templates/sync/route.ts` sigue sin test propio, como antes de la
extracción. Queda como deuda; arreglarlo se sale del alcance de esta feature.

## Compuerta (segunda ronda)

Ejecutada en el worktree, comando por comando, en primer plano, sobre `80e0e9d`:

- `npm run lint`: **verde** — 0 errores, 35 avisos, los mismos preexistentes que anotó el
  reviewer (ninguno en archivos de esta feature).
- `npm run typecheck`: **verde** — limpio.
- `TZ=UTC npm test`: **verde** — 176 archivos, **2280** tests (uno más que la primera ronda:
  el de la fuga), 0 fallos.
- `npm run build` con las variables dummy de `docs/harness.md`: **verde** —
  `✓ Compiled successfully in 10.3s`; sigue registrando `/api/v1/templates`,
  `/api/v1/templates/[id]` y `/api/v1/templates/sync`.
- `replay-migrations`: **n/a**. `git diff 6b0d768..HEAD --stat -- supabase` sigue vacío.

## Sin cambios en el resto del informe

Ni variables de entorno nuevas, ni i18n (la feature no añade texto de interfaz), ni SQL, ni
dependencias. `CHANGELOG.md` ya describía la respuesta del sync como
`{synced, created, updated, status_changes}`, que es lo que sigue siendo cierto; no hizo falta
tocarlo. `.env.local.example` sigue bloqueado por permisos y sigue sin hacer falta.
