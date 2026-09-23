# Review — a7.7 developer-docs

**Veredicto:** CHANGES_REQUESTED

Rama `api/docs`, worktree `.claude/worktrees/api-docs`, base `a4ce30a`.
Commits revisados: `099aa79`, `6cb504a`, `10bcc14`, `5e996e7` (54 archivos, +8 064 / −990).

El trabajo es sólido: la compuerta está verde, la prosa es exacta contra el código en las 18
afirmaciones que muestreé y los tests prueban lo que dicen. Lo que bloquea es pequeño y concreto:
un criterio del spec que el propio informe declara **sin ejecutar** y un defecto de accesibilidad
de una línea que ese mismo criterio debía cazar.

## Compuerta

Ejecutada por mí, comando a comando, en primer plano, en el worktree:

- `npm run lint` — **verde**. 0 errores, 35 avisos (los mismos 35 preexistentes en `a4ce30a`;
  ninguno en archivos de la feature).
- `npm run typecheck` — **verde**, sin salida.
- `TZ=UTC npm test` — **verde**. 193 archivos, **2 531 tests**, 11,2 s.
- `npm run build` con las variables dummy de `docs/harness.md` — **verde**. Las 12 rutas de
  `/developers` aparecen registradas como `ƒ` (dinámicas por el `searchParams` del selector,
  documentado como decisión 1 y como deuda 5).
- `scripts/replay-migrations.sh` — **n/a**: el diff no toca `supabase/`.

## Trazabilidad criterio ↔ test

Criterios de `progress/spec_api-publica.md` §7, más S-A3 y S-A5.

- C1 «Test de que la referencia renderiza **todas** las operaciones del OpenAPI»: **[x]**
  `src/components/developers/openapi/model.test.ts` › «renderiza todas las operaciones del
  documento, sin perder ninguna» — `walkOperations()` recorre `doc.paths` por su cuenta y compara
  con `model.operations`: no es una lista escrita a mano, así que una operación que el modelo
  descolgara haría fallar el test. Más › «las reparte en secciones sin duplicar ni descolgar
  ninguna» y › «cubre las 37 operaciones del inventario de la fase».
  `src/components/developers/reference.test.tsx` › «pinta TODAS las operaciones del documento»
  comprueba el `id="…"` de cada una en el HTML renderizado, no un recuento.
- C2 «Ningún enlace interno de la sección está roto»: **[x]**
  `src/content/developers/links.test.ts` › «ningún enlace interno apunta a una ruta que no
  existe» — extrae los `href` de los dos idiomas (párrafos, listas, tablas, avisos, tarjetas,
  changelog) **y del menú**, y los contrasta con las rutas leídas de `src/app/**/page.tsx` por
  `appRoutes()`. Tiene además guarda propia («el árbol de la aplicación trae las rutas de la
  sección») para que el escáner no pase por vacío. Y › «%s apunta a una página que existe» sobre
  `api-keys-settings.tsx` y `webhooks-settings.tsx`.
- C3 «Sin sesión se ve; con sesión no cambia»: **[x]**
  `src/middleware.test.ts:340-377` › «middleware — /developers se sirve sin sesión»: seis rutas
  con `mockUser = null` → 200 y sin `location`; la misma con `mockUser` → igual; y el `?lang=`
  sobrevive. Comprobado a mano contra `src/middleware.ts:151`: `/developers` no está en
  `protectedPaths` y `src/app/(public)/developers/layout.tsx` devuelve `children` pelado — sin
  `DashboardShell`, sin `useAuth`, sin una sola consulta a Supabase en toda la carpeta.
- C4 «Lighthouse de accesibilidad ≥ 90 se comprueba a mano **y se anota en el informe**»:
  **[ ]** ← **no cubierto**. `progress/impl_developer-docs.md` §«Verificación manual pendiente»
  punto 7 dice literalmente «**Sin ejecutar**: anotar la puntuación aquí al hacerlo». El guion
  está escrito y es bueno; la comprobación que pide el spec no se hizo y el número no está.
  Ninguno de los siete puntos del guion está marcado como ejecutado.
- C5 «Textos de interfaz en es/en/ko» (CP6): **[x]** `src/i18n/messages.test.ts` (suite
  existente: paridad de claves, sin huérfanas, mismos argumentos ICU). Verificado además por mi
  cuenta sobre los tres catálogos: paridad total, **35 claves `Developers.*`** idénticas en los
  tres, cero desajustes de placeholders, y `Settings.webhooks.docsLink` traducida en los tres.
- C6 «Prosa en es/en, fuera de `messages/*.json`» (S-A5): **[x]**
  `src/content/developers/links.test.ts` › «%s tiene una página por entrada del menú», «%s nombra
  los tres grupos del menú», «%s traduce cada línea del changelog». Comprobado a mano: ninguna
  clave de `Developers.*` pasa de 80 caracteres — son etiquetas de cromo, no prosa.
- C7 «Selector de idioma sobre la misma página»: **[x]**
  `src/components/developers/docs-shell.test.tsx` › «ofrece los dos idiomas en el selector, sobre
  la misma página» (`/developers/guides/exports` y `…?lang=en`) y › «cambia la prosa del menú al
  elegir inglés, sin cambiar la interfaz» (prosa `en`, cromo `es`).
- C8 «Bloques de código con botón copiar, sin resaltador externo» (S-A3): **[x]**
  `docs-shell.test.tsx` › `DocArticle` › «pinta tablas, avisos y bloques de código»;
  `reference.test.tsx` › «pinta el curl de ejemplo y el botón de copiar».
- C9 «Changelog alimentado por un archivo de contenido por versión»: **[x]**
  `changelog-view.test.tsx` (5 casos) sobre los tres archivos de
  `src/content/developers/changelog/`.
- C10 «Sin dependencias nuevas» (S-A3): **[x]** `package.json` y `package-lock.json` no aparecen
  en `git diff a4ce30a..HEAD --stat`. Sin markdown ni MDX: `src/components/developers/inline.tsx`
  es un parser propio de tres marcas, sin `dangerouslySetInnerHTML` en toda la carpeta.

No hay `progress/checks_developer-docs.sql` y no hace falta: la feature no toca SQL ni ningún
servicio externo.

## Exactitud del contenido (muestreo contra el código)

18 afirmaciones concretas contrastadas contra la rama, **todas correctas**:

| # | Afirmación de la prosa | Contrastada contra |
|---|---|---|
| 1 | Los doce scopes y qué permite cada uno | `src/lib/api-keys/scopes.ts` — `API_SCOPES` y `SCOPE_DESCRIPTIONS`, uno a uno |
| 2 | «No existe `broadcasts:read`» | `impl_integracion-api-3.md` §6 filas 18-19 y el fixture |
| 3 | 402 `feature_unavailable`/`quota_exceeded`/`plan_limit_reached`, 403 `account_read_only` | `src/lib/billing/enforce.ts:78,102,178,187` |
| 4 | La API está en Pro y Negocio, no en Inicio | `supabase/migrations/041_billing_model.sql:219,227,235` (`features` con `api`/`webhooks`) |
| 5 | Tope de cuerpo 1 MiB → 413 | `src/lib/api/v1/body.ts:31` `MAX_BODY_BYTES` |
| 6 | Por encima de 10 000 mensajes la exportación directa da 409 | `src/lib/exports/conversations.ts:62` `SYNC_MESSAGE_LIMIT` |
| 7 | Cubos 120/min por clave, `exports` 10/h, `templatesSync` 6/min, `webhookAction` 20/min, los tres **por cuenta** | `src/lib/rate-limit.ts:164,199,207,217` y sus comentarios |
| 8 | Escalera 1 min / 5 min / 30 min / 2 h / 12 h, cinco reintentos más el inicial, luego `dead` | `src/lib/webhooks/queue.ts:42-51` (`RETRY_BACKOFF_MS`, `MAX_ATTEMPTS = 6`) |
| 9 | A los 15 fallos seguidos el destino se autodesactiva | `queue.ts:33` `MAX_CONSECUTIVE_FAILURES` |
| 10 | Historial de entregas 30 días; archivos de exportación 7 días; `download_url` de 15 min | `queue.ts:53`, `src/lib/exports/jobs.ts:59,62` |
| 11 | Cabeceras `X-Wacrm-Event/-Webhook-Id/-Delivery-Id/-Attempt/-Signature` y «no se siguen redirecciones» | `queue.ts:380-389` (`redirect: 'manual'`) |
| 12 | Paginación keyset, `?limit=` 50 por omisión y 100 máximo, cursor opaco | `src/lib/api/v1/pagination.ts:20-21` |
| 13 | `Idempotency-Key` de 1 a 255, TTL 24 h, reserva abandonada a los 2 min, alcance clave+ruta+query, solo se guardan 2xx | `src/lib/api/v1/idempotency.ts:86-101` y su cabecera |
| 14 | Los 11 eventos y el `data` exacto de cada uno | `src/lib/webhooks/events.ts:15-84` — coincide campo por campo |
| 15 | Variables del servidor MCP y que `WACRM_ENABLE_BROADCASTS` exige `WACRM_ENABLE_WRITES` | `mcp-server/src/config.ts:27-54` |
| 16 | Forma de la respuesta de `GET /api/v1/me` | `src/app/api/v1/me/route.ts:26-29` — el JSON de ejemplo es el real |
| 17 | 50 `tag_ids` por llamada; `POST /tags` es buscar-o-crear sin distinguir mayúsculas (200 vs 201) | `src/app/api/v1/contacts/[id]/tags/route.ts:36`, `src/app/api/v1/tags/route.ts:7-8,122` |
| 18 | Caducidad 30/90/365 o nunca; rotación con 24 h de gracia | `src/components/settings/api-keys-settings.tsx:111`, `src/lib/api-keys/keys.ts:105,114` |

**Los tres receptores de ejemplo** (`src/content/developers/es/guides.ts`, sección
`guides/webhooks`) implementan exactamente lo que hace `src/lib/webhooks/sign.ts`: HMAC-SHA256 del
secreto sobre `` `${t}.${rawBody}` ``, hex, comparación en tiempo constante
(`crypto.timingSafeEqual` con guarda de longitud en Node, `hmac.compare_digest` en Python,
`hash_equals` en PHP) y tolerancia de repetición de 300 s, que es el valor por omisión de
`verifySignatureHeader`. Los tres insisten en el cuerpo crudo (`express.raw`, `request.get_data()`,
`php://input`), que es justo donde se equivoca la gente. Sin peros.

**Fixture ↔ inventario**: las 37 operaciones de `openapi/fixture.ts` coinciden una a una con el
inventario de `progress/impl_integracion-api-3.md` §6 —mismo método, misma ruta, mismo scope— y
las siete marcadas `x-idempotent` son exactamente las siete que el inventario marca «sí»
(`POST /messages`, `/broadcasts`, `/tags`, `/contacts/{id}/tags`, `/templates`, `PATCH
/templates/{id}`, `POST /exports`). `GET /api/v1/me` es la única con `scopes: []`.

**El puente a a7.6** es de verdad una línea:
`src/components/developers/openapi/source.ts:23-25` es un `return OPENAPI_FIXTURE` y el único
importador del fixture fuera de los tests; `reference/page.tsx` solo importa de `source.ts`.

## Checkpoints

- CP1 Compuerta: **[x]** — verde, ejecutada por mí (arriba).
- CP2 Migraciones: **[x]** n/a — sin SQL.
- CP3 Aislamiento: **[x]** n/a — la sección no consulta Supabase; no hay un solo
  `supabaseAdmin()` en el diff.
- CP4 Tests: **[ ]** — todo cubierto salvo C4 (Lighthouse), ver arriba.
- CP5 Sin dependencias nuevas: **[x]** — `package.json` intacto.
- CP6 i18n: **[x]** — 35 claves `Developers.*` + `Settings.webhooks.docsLink` en es/en/ko, mismas
  claves, mismos placeholders, prosa fuera de los catálogos.
- CP7 Next 16: **[x]** — `searchParams: Promise<…>` con `await`, según
  `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/page.md:73-83`; grupo
  de rutas `(public)`; `robots` en `Metadata`; `generateMetadata` con las mismas props.
- CP8 Alcance: **[x]** — el diff no sale de §7: rutas y componentes de la sección, contenido,
  los tres catálogos, el enlace del panel en `webhooks-settings.tsx`, `docs/public-api.md` como
  puntero, `README.md` y `CHANGELOG.md`. `5e996e7` deshace el reformateo colateral de
  `middleware.test.ts`: el diff final de ese archivo son 50 líneas añadidas al final, cero
  modificadas. La deuda vista fuera está anotada, no arreglada.
- CP9 Documentación: **[x]** — `CHANGELOG.md` `[Unreleased]` actualizado; ninguna variable de
  entorno nueva, así que `docs/docker.md` no procede; el informe coincide con el diff salvo el
  detalle del hallazgo 5.
- CP10 Git: **[x]** — cuatro commits en `api/docs`, en español, con prefijo; nada pusheado.
- CP11 Lo entrante nunca se bloquea: **[x]** n/a — la feature no toca el webhook de WhatsApp.

## Hallazgos (archivo:línea)

1. **`progress/impl_developer-docs.md:154-159` — Lighthouse de accesibilidad sin ejecutar.**
   El spec §7 lo pide como criterio («se comprueba a mano y se anota en el informe»), y el informe
   lo declara pendiente. Ninguno de los siete puntos del guion manual consta como ejecutado.
   Bloqueante: es un criterio de aceptación, no una recomendación.

2. **`src/components/developers/docs-shell.tsx:149` — falta `lang` en la prosa.**
   El layout raíz pone `<html lang={locale}>` con el idioma de la **instancia**
   (`src/app/layout.tsx:88-93`), pero el idioma de la prosa lo elige el visitante con `?lang=`.
   En una instancia en español leyendo `?lang=en` —o en cualquier instancia en coreano, donde la
   prosa siempre cae a inglés (`src/content/developers/nav.ts:19`)— el documento declara un
   idioma y el contenido está en otro: un lector de pantalla lo pronuncia con la fonética
   equivocada de punta a punta (WCAG 3.1.1/3.1.2). Es un `lang={locale}` en el `<main>` y en el
   `<nav>` del menú, que también lleva títulos de página traducidos. El informe da esto por hecho
   («`lang`/`hrefLang` en el selector», línea 158), pero en `locale-switch.tsx:49` solo está
   `hrefLang`, que describe el destino del enlace, no el idioma del texto de esta página.

3. **`src/content/developers/es/guides.ts:419` (y `en/guides.ts` equivalente) — falta el techo de
   250 000 mensajes del camino asíncrono.** La guía documenta el tope de 10 000 del camino
   directo pero no `ASYNC_MESSAGE_LIMIT`
   (`src/lib/exports/conversations.ts:74`): un encargo que lo supere queda `failed` con un
   mensaje que dice cómo partirlo con `from`/`to`. Es contrato visible para el cliente y la
   página de exportaciones es el único sitio donde cabe.

4. **`src/components/settings/webhooks-settings.tsx:63` — la etiqueta del enlace no describe su
   destino.** `WEBHOOK_DOCS_URL = '/developers/webhooks'` (el catálogo de eventos), pero
   `messages/es.json:1829` lo rotula «Cómo verificar la firma y manejar reintentos» y el comentario
   de las líneas 57-62 habla de «la guía… receptores de ejemplo en Node, Python y PHP», que es
   `/developers/guides/webhooks`. O el enlace apunta a la guía, o la etiqueta dice lo que hay en
   el catálogo. El enlace no está roto —el test de enlaces del panel pasa— pero incumple la
   promesa que hace al usuario.

5. **`src/components/developers/openapi/fixture.ts:1540` — la sección `webhooks` describe 5 de los
   11 eventos.** `/developers/webhooks` documenta los once de
   `src/lib/webhooks/events.ts:15-26`; la referencia, generada del fixture, enseña cinco. Un
   lector que compare las dos páginas ve una contradicción. Contradice la decisión 4 del informe
   («una referencia de juguete sería una página que miente»), que se cumplió al pie para las 37
   operaciones y no para los eventos. Completar los seis que faltan es mecánico y sale gratis:
   `WEBHOOK_EVENT_DATA_FIELDS` ya tiene los campos de cada uno.

Nada que objetar en lo demás. Ninguna consulta con rol de servicio (no hay ninguna), sin SQL, sin
dependencias, `robots: { index: true, follow: true }` solo en
`src/app/(public)/developers/layout.tsx:18` y en `docsMetadata`
(`src/components/developers/docs-page-view.tsx:46`), con el `robots: { index: false }` global de
`src/app/layout.tsx:30` intacto. Las decisiones 1 (idioma en `?lang=`), 2 (títulos del menú como
prosa, cromo en los catálogos) y 7 (sin captura en «Empezar») están bien razonadas y **no**
contradicen S-A5: el supuesto pide «menú, botones» en los tres catálogos y lo que está en
`Developers.ui.*` es exactamente eso; los títulos de página tienen que seguir al selector o una
instancia en coreano enseñaría un menú en coreano apuntando a páginas en inglés. Las acepto.

## Cambios requeridos

1. Ejecutar Lighthouse (modo escritorio, DevTools) sobre `/developers` y `/developers/reference`
   y **anotar las dos puntuaciones** en `progress/impl_developer-docs.md`. Si alguna baja de 90,
   arreglar lo que señale antes de volver a pedir revisión. De paso, recorrer los puntos 1-6 del
   guion manual y marcarlos.
2. `src/components/developers/docs-shell.tsx:149` — poner `lang={locale}` en el `<main>` y en el
   `<nav>` del menú lateral (y en el `<details>` de móvil, que repite el mismo `NavList`).
   Corregir de paso la línea 158 del informe, que afirma un `lang` que no existe.
3. `src/content/developers/{es,en}/guides.ts`, página `guides/exports` — documentar el techo de
   **250 000 mensajes** del camino asíncrono y qué pasa al superarlo (`failed` + cómo partir el
   encargo con `from`/`to`).
4. `src/components/settings/webhooks-settings.tsx:63` — decidir una de las dos: apuntar
   `WEBHOOK_DOCS_URL` a `/developers/guides/webhooks`, o reescribir `Settings.webhooks.docsLink`
   en los tres catálogos para que describa el catálogo de eventos.
5. `src/components/developers/openapi/fixture.ts:1540` — añadir los seis eventos que faltan
   (`conversation.created`, `conversation.closed`, `conversation.assigned`, `contact.created`,
   `contact.updated`, `contact.tag_removed`) con el `data` de
   `src/lib/webhooks/events.ts:52-84`, para que la referencia y el catálogo digan lo mismo
   mientras a7.6 no se fusione.

Los cinco son locales y no tocan la arquitectura: 2-5 son de minutos, y el 1 es abrir el
navegador. Cuando estén, esto se aprueba.

---

# Segunda ronda

**Veredicto:** APPROVED

Commits revisados sobre `5e996e7`: `e653dd5`, `53dcb4e`, `547aae2`, `489c261`, `073ac07`
(10 archivos, +211 / −10). Worktree limpio, nada pusheado (`git branch -r --contains HEAD`
vacío), los cinco commits en español con prefijo y `Co-Authored-By`.

## Compuerta

Ejecutada por mí, comando a comando, en primer plano, en el worktree:

- `npm run lint` — **verde**. 0 errores, 35 avisos (los mismos 35 preexistentes).
- `npm run typecheck` — **verde**, sin salida.
- `TZ=UTC npm test` — **verde**. 193 archivos, **2 535 tests** (4 nuevos), 9,5 s.
- `npm run build` con las variables dummy de `docs/harness.md` — **verde**; las 12 rutas de
  `/developers` siguen registradas como `ƒ`.
- `scripts/replay-migrations.sh` — **n/a**: sigue sin tocar `supabase/`.

## Los cinco cambios requeridos

1. **Lighthouse — hecho.** Acepto la medición por CLI como equivalente a DevTools (decisión del
   líder). Comprobado por mí lo que era comprobable: `package.json` y `package-lock.json` **no
   aparecen** en `git diff a4ce30a..HEAD --stat` (`npx --yes` no dejó rastro), `lighthouse` no está
   en `package.json`, `pgrep -fl 'next start'` no devuelve nada y el 3123 no tiene nadie
   escuchando (`lsof -nP -iTCP:3123 -sTCP:LISTEN` vacío); `/Applications/Brave Browser.app` existe.
   Las dos páginas del criterio quedan en **0,96** y **0,97**, por encima de 0,90. El guion manual
   queda con los puntos 4 y 5 (responsive a 375 px y portapapeles) declarados pendientes de humano,
   que es honesto: ninguno de los dos es criterio del spec.
2. **`lang` de la prosa — hecho.** `docs-shell.tsx:144` (`<nav>`), `:156` (`<div>` del `<details>`)
   y `:161` (`<main id="docs-content">`) llevan `lang={locale}`. Dejar el `<summary>` fuera está
   bien razonado: su texto sale de `messages/*.json` y sigue al `<html lang>`. Test leído:
   `docs-shell.test.tsx` › «declara el idioma de la prosa en el contenido y en el menú» exige
   `<main id="docs-content" lang="en"` **y** exactamente 3 apariciones de ` lang="en"` **y** cero
   de ` lang="es"` con una instancia en español; el espacio inicial del regex descarta de verdad
   los `hreflang="…"` del selector (en ` hreflang="en"` el carácter previo a `lang` es `f`). El
   caso simétrico está en › «declara español cuando la prosa se lee en español». La corrección del
   informe está puesta en el punto 7 del guion, con el matiz `hrefLang` ≠ `lang` explicado.
3. **Techo de 250 000 — hecho**, en `es/guides.ts:398-401` y `en/guides.ts:391-394`, aviso
   `tone: 'warn'` en `guides/exports`. Contrastado contra el código, correcto en los tres puntos:
   el número es `ASYNC_MESSAGE_LIMIT = 250_000` (`src/lib/exports/conversations.ts:74`); la cadena
   citada es literalmente la de `ExportTooLargeError` (`:307`); y el encargo acaba en `failed` sin
   archivo a medias porque `jobs.ts:328-341` construye el documento entero **antes** de subirlo y
   el `catch` de `:367-379` propaga el mensaje del cliente a `markFailed`. Sin test, y es la
   decisión correcta: atar prosa traducida a una constante acopla más de lo que protege.
4. **Enlace del panel — hecho.** `webhooks-settings.tsx:63` pasa a `/developers/guides/webhooks`.
   Esa guía tiene «2. El esquema de firma» y «3. Reintentos y duplicados», que es exactamente lo
   que promete `Settings.webhooks.docsLink` en los tres catálogos («Cómo verificar la firma y
   manejar reintentos» / «How to verify the signature and handle retries» / el equivalente coreano),
   así que mover el enlace en vez de reescribir tres traducciones es la salida buena. Los catálogos
   quedan intactos (no aparecen en el diff de esta ronda). El destino lo cubre
   `links.test.ts:129-143`, que **lee el archivo** y contrasta cada `'/developers…'` contra
   `appRoutes()`: sigue valiendo para la ruta nueva sin tocar el test.
5. **Los once eventos — hecho.** `fixture.ts` añade los seis que faltaban en el orden de
   `WEBHOOK_EVENTS`. Contrastado campo por campo contra `src/lib/webhooks/events.ts:66-76`: los
   `data` de los seis coinciden con `WEBHOOK_EVENT_DATA_FIELDS`. Y ahora hay dos tests leídos que
   lo aten en vez de confiar en el ojo: `model.test.ts` › «describe TODOS los eventos de
   `WEBHOOK_EVENTS`, en su orden» (`model.webhooks.map(h => h.event)` igual a `WEBHOOK_EVENTS`,
   importado del código, no copiado) y › «el `data` de cada evento trae los campos que emite el
   código» (parsea el `example` y compara las claves de `data` con
   `WEBHOOK_EVENT_DATA_FIELDS[evento]`). Un evento nuevo en el código rompe aquí.

## `073ac07` — contraste AA en modo oscuro

Dentro de alcance y sin efecto global, comprobado: `git diff 5e996e7..HEAD -- src/app/globals.css`
está **vacío**; ningún token `--cb-*` cambia. El diff se limita a `METHOD_STYLES` y al `Chip`
`warn` de `openapi/render.tsx` y a `KIND_STYLES` de `changelog-view.tsx`, dos componentes que solo
monta `/developers`. El criterio —el tinte en el fondo, el contraste en `text-foreground`— es el
que ya usaba `get`, así que la sección queda coherente consigo misma. Las dos deudas nuevas (7 y 8
del informe: `text-primary` como color de enlace y el icono de «Copiado») están anotadas, no
arregladas, que es lo que pide CP8.

## Checkpoints (revisados sobre el árbol final)

- CP1 Compuerta: **[x]** verde, ejecutada por mí.
- CP2 Migraciones: **[x]** n/a — sin SQL.
- CP3 Aislamiento: **[x]** n/a — ni un `supabaseAdmin()` en el diff de la feature.
- CP4 Tests: **[x]** — C4 (Lighthouse) ya tiene número medido y anotado; C-nuevos (lang, eventos)
  con test leído. Los diez criterios de la primera ronda siguen cubiertos.
- CP5 Sin dependencias nuevas: **[x]** — manifiestos intactos también tras la medición.
- CP6 i18n: **[x]** — esta ronda no añade ni una clave; los tres catálogos sin cambios.
- CP7 Next 16: **[x]** — la ronda no toca API de framework (solo JSX y datos).
- CP8 Alcance: **[x]** — 10 archivos, todos de `/developers` salvo la constante de
  `webhooks-settings.tsx` (que el hallazgo 4 pedía) y `CHANGELOG.md`.
- CP9 Documentación: **[x]** — `CHANGELOG.md` `[Unreleased]` suma la línea del `lang` y del
  contraste; el informe coincide con el diff que he leído.
- CP10 Git: **[x]** — cinco commits en `api/docs`, con `Co-Authored-By`, nada pusheado.
- CP11 Lo entrante nunca se bloquea: **[x]** n/a.

## Hallazgos

Ninguno bloqueante. Los cinco de la primera ronda están cerrados.

## Nota para la integración con a7.6 (no exige cambio)

a7.6 está dejando `servers[0].url = '/api/v1'` con las claves de `paths` **sin** el prefijo. El
fixture de a7.7 asume lo contrario: `servers[0].url = 'https://tu-dominio.example.com'`
(`fixture.ts:421`) y claves **con** prefijo (`'/api/v1/me'`, `fixture.ts:463`, y así las 37). El
renderizador concatena en crudo —`const url = \`${server ?? ''}${path}\`` en `model.ts:333`— y
además deriva el ancla de la ruta (`operationAnchor(method, path)`, `model.ts:299-305`). Al cambiar
`source.ts` por el generador real, sin ajuste: (a) el curl de ejemplo saldría como `"/api/v1/me"`,
una URL relativa que curl no sabe resolver, y (b) las anclas pasarían de `#get-api-v1-me` a
`#get-me`. Nada de la prosa enlaza esas anclas hoy (`grep 'reference#'` en `src/content/developers`
no devuelve nada), así que (b) no rompe enlaces; (a) sí necesita que quien integre componga la URL
absoluta (host del documento + `servers[0].url` + clave de `paths`). La sección `webhooks` no
sufre: va indexada por nombre de evento, no por ruta.
