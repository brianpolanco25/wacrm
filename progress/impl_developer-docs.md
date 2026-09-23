# a7.7 `developer-docs` — sección pública `/developers`

Rama `api/docs`, worktree `/Users/brian/Documents/Dev/projects/wacrm/.claude/worktrees/api-docs`,
base `feat/api-publica` @ `a4ce30a` (a7.1–a7.5 integradas). Spec: `progress/spec_api-publica.md`
§7 + S-A3 + S-A5. **Sin migración**, sin dependencias nuevas, sin variables de entorno nuevas.

**Estado: verde.** Compuerta ejecutada comando a comando en primer plano: `lint` 0 errores
(35 avisos, los mismos 35 preexistentes), `typecheck` limpio, **193 archivos / 2 531 tests**
(2 448 en la base + 83 nuevos), `build` correcto con las 12 rutas de la sección registradas.

## Commits

En `api/docs`, ninguno pusheado:

| Commit | Mensaje |
|---|---|
| `099aa79` | `feat: sección pública /developers con prosa en español e inglés` |
| `6cb504a` | `feat: referencia de /developers generada desde el OpenAPI` |
| `10bcc14` | `docs: enlazar /developers desde el panel y dejar public-api.md como puntero` |
| `5e996e7` | `style: deshacer el reformateo colateral de middleware.test.ts` |

54 archivos, +8 064 / −990 (las 990 bajas son casi todas `docs/public-api.md`, que pasa de 985
líneas a un puntero de 41).

## Qué entra

### Rutas (12) y layout propio

`src/app/(public)/developers/` — grupo de rutas nuevo. Su `layout.tsx` no monta nada del panel:
ni `DashboardShell`, ni `useAuth`, ni una sola consulta a Supabase. El layout raíz
(`src/app/layout.tsx`) ya monta next-intl, el tema y el script de arranque de modo claro/oscuro,
así que aquí solo se invierte lo que la sección necesita del revés: `robots: { index: true }`
frente al `noindex` global del panel.

```
/developers                       Empezar
/developers/authentication        Autenticación y scopes
/developers/conventions           Convenciones
/developers/guides                Guías (índice)
/developers/guides/templates      Enviar una plantilla de punta a punta
/developers/guides/contacts-tags  Sincronizar contactos y etiquetas
/developers/guides/exports        Exportar conversaciones
/developers/guides/webhooks       Recibir webhooks (Node, Python, PHP)
/developers/reference             Referencia (generada del OpenAPI)
/developers/webhooks              Catálogo de eventos
/developers/integrations          MCP y generación de SDKs
/developers/changelog             Changelog de la API
```

Son las 8 secciones del spec §7; «Guías» se abre en un índice más cuatro subpáginas porque cada
guía es larga y el menú lateral las lleva bien. Cada `page.tsx` son ~10 líneas: elige su slug,
lee el idioma y delega en `DocsPageView`.

### Contenido

`src/content/developers/` con un modelo de bloques tipado (`types.ts`) y la prosa en
`es/{core,guides,reference}.ts` y `en/{core,guides,reference}.ts`. Fuentes: `docs/public-api.md`
de esta rama (contrato vigente tras a7.1–a7.5), `progress/impl_integracion-api-3.md` §6,
`mcp-server/README.md` y `src/lib/webhooks/sign.ts` para los tres receptores de ejemplo.

El changelog se alimenta de **un archivo por versión** en
`src/content/developers/changelog/` (`2026-07-01-v1-0.ts`, `2026-09-15-v1-1.ts`,
`2026-09-16-v1-2.ts`) y un `index.ts` que los ordena por fecha.

### Componentes

`src/components/developers/`: `docs-shell.tsx` (cabecera con la marca Cabbity, navegación
lateral, índice de la página, disclosure para móvil con `<details>`, enlace de salto al
contenido), `locale-switch.tsx`, `doc-article.tsx` (renderizador de bloques), `inline.tsx`
(marcado en línea propio: `` `código` ``, `**fuerte**`, `[texto](/ruta)`), `code-block.tsx`
(botón copiar, sin resaltador), `changelog-view.tsx` y `openapi/`.

Tokens de marca `--cb-*` vía las utilidades que declara `globals.css` (`bg-brand`,
`text-brand-ink`, `border-line`, `text-positive`) para los acentos, y tokens de modo
(`bg-background`, `bg-card`, `bg-card-2`, `text-muted-foreground`, `border-border`) para las
superficies, que es lo que hace que el modo oscuro funcione solo.

### Referencia generada

`src/components/developers/openapi/`:

- `types.ts` — subconjunto tipado de OpenAPI 3.1 (incluye `type: ['string','null']` de 3.1,
  `webhooks`, `security`, `$ref`).
- `model.ts` — funciones puras: `resolveRef`, `typeLabel`, `flattenSchema`, `scopesOf`,
  `operationAnchor`, `buildReference`. Aquí se decide todo; el JSX solo pinta.
- `render.tsx` — `ReferenceView` y `referenceToc`.
- `fixture.ts` — documento OpenAPI 3.1 realista con **las 37 operaciones** del inventario de
  `progress/impl_integracion-api-3.md` §6, sus scopes, qué escrituras aceptan `Idempotency-Key`,
  los cubos propios y una sección `webhooks` con cinco eventos.
- `source.ts` — **el único punto de contacto con a7.6.**

## La línea que hay que cambiar al integrar a7.6

`src/components/developers/openapi/source.ts`, función `getOpenApiDocument()`:

```ts
// hoy
export function getOpenApiDocument(): OpenApiDocument {
  return OPENAPI_FIXTURE;
}

// al fusionar api/openapi
import { buildOpenApiDocument } from '@/lib/api/v1/openapi';
export function getOpenApiDocument(): OpenApiDocument {
  return buildOpenApiDocument() as OpenApiDocument;
}
```

Nada más. La página (`src/app/(public)/developers/reference/page.tsx`) importa solo de
`source.ts`, y el renderizador se prueba contra un documento cualquiera, no contra el nuestro:
si el generador real difiere en detalles (rutas con o sin `/api/v1`, scopes en `security` en vez
de en `x-scopes`, `allOf`), el modelo ya los cubre y hay test de cada caso. **No se tocó
`src/lib/api/v1/openapi/**` ni `mcp-server/**`.**

## Criterios ↔ tests

| Criterio del spec §7 | Test |
|---|---|
| La referencia renderiza **todas** las operaciones del OpenAPI | `src/components/developers/reference.test.tsx` → `ReferenceView` › «pinta TODAS las operaciones del documento» (compara contra el modelo, no contra una lista escrita a mano) |
| …y el modelo no pierde ninguna por el camino | `src/components/developers/openapi/model.test.ts` › «renderiza todas las operaciones del documento, sin perder ninguna» (recorre el documento por su cuenta) y «las reparte en secciones sin duplicar ni descolgar ninguna» |
| …sobre un documento realista | mismo archivo › «cubre las 37 operaciones del inventario de la fase» |
| Ningún enlace interno de la sección está roto | `src/content/developers/links.test.ts` › «ningún enlace interno apunta a una ruta que no existe» — saca los `href` de los dos idiomas (párrafos, listas, tablas, avisos, tarjetas, changelog) **y del menú**, y los compara con las rutas leídas de `src/app/**/page.tsx` |
| …incluidos los del panel hacia aquí | mismo archivo › «%s apunta a una página que existe» sobre `api-keys-settings.tsx` y `webhooks-settings.tsx` |
| Sin sesión se ve; con sesión no cambia | `src/middleware.test.ts` › «middleware — /developers se sirve sin sesión»: seis rutas sin usuario → 200 sin `location`, la misma ruta con usuario → igual, y el `?lang=` sobrevive |
| Textos de interfaz en es/en/ko | `src/i18n/messages.test.ts` (suite existente): paridad de claves, sin huérfanas, mismos argumentos ICU. Las claves nuevas son `Developers.*` y `Settings.webhooks.docsLink` |
| Prosa en es/en (S-A5) | `src/content/developers/links.test.ts` › «%s tiene una página por entrada del menú», «%s nombra los tres grupos del menú», «%s traduce cada línea del changelog» |
| Selector de idioma sobre la misma página | `src/components/developers/docs-shell.test.tsx` › «ofrece los dos idiomas en el selector, sobre la misma página» y «cambia la prosa del menú al elegir inglés, sin cambiar la interfaz» |
| Bloques de código con botón copiar | `docs-shell.test.tsx` › `DocArticle` › «pinta tablas, avisos y bloques de código»; `reference.test.tsx` › «pinta el curl de ejemplo y el botón de copiar» |
| Changelog alimentado por archivo de versión | `src/components/developers/changelog-view.test.tsx` (5 casos: todas las versiones con su ancla, cambio de idioma, etiquetas del tipo de cambio, índice) |
| Marcado en línea (no hay markdown, S-A3) | `src/components/developers/inline.test.tsx` (9 casos, incluido «no interpreta marcas dentro de un tramo de código») |
| Robustez del renderizador ante otro documento | `model.test.ts` › `scopesOf` (4 casos), `typeLabel` (5), `resolveRef` y esquemas recursivos (3: `$ref` remoto/roto, recursión, `allOf`) |

83 tests nuevos en 6 archivos. No hay comprobaciones contra base real: esta feature no toca SQL
(no hay `progress/checks_developer-docs.sql`) ni ningún servicio externo.

## Verificación manual pendiente (guion)

No hay e2e en el repo, así que lo visual y la accesibilidad se comprueban a mano. Guion, en
orden, con `npm run dev` y **sin sesión** (ventana privada):

1. **Pública.** `http://localhost:3000/developers` → carga la sección, sin barra lateral del
   panel y sin redirección a `/login`. Repetir en `/developers/reference`.
2. **Selector.** Pulsar «English» → la URL gana `?lang=en` y la prosa cambia; navegar a
   «Guides» desde el menú → el idioma se mantiene; pulsar un enlace dentro del texto → también.
3. **Modo oscuro.** Con sesión, cambiar el modo en el panel y volver a `/developers`: superficies,
   bloques de código, tablas y avisos legibles en los dos modos. (El modo lo fija el script de
   arranque del layout raíz, que esta sección hereda.)
4. **Responsive.** A 375 px: el menú lateral desaparece y queda el desplegable «Secciones»;
   las tablas y los bloques de código hacen scroll horizontal sin desbordar la página.
5. **Copiar.** En cualquier bloque, pulsar «Copiar» → el portapapeles tiene el código y la
   etiqueta pasa a «Copiado» durante dos segundos. (Necesita `localhost` o https.)
6. **Teclado.** Tab desde arriba → aparece «Saltar al contenido» y lleva al `<main>`; el menú
   lateral es recorrible y la página actual se anuncia (`aria-current="page"`).
7. **Lighthouse ≥ 90 de accesibilidad** sobre `/developers` y `/developers/reference`.
   **Ejecutado en la segunda ronda**: 0,96 y 0,97. Ver §«Segunda ronda» → «Lighthouse».
   Lo que estaba puesto para ayudar: un solo `h1` por página y jerarquía `h2`/`h3` sin
   saltos, `aria-label` en las tres navegaciones, `aria-hidden` en los iconos decorativos,
   `<time dateTime>` en el changelog, `scope="col"` en las tablas y `hrefLang` en los enlaces
   del selector.

   > **Corrección de la primera ronda.** Esta línea decía «`lang`/`hrefLang` en el selector».
   > El `hrefLang` sí estaba (`locale-switch.tsx:50`), pero describe el idioma del DESTINO del
   > enlace, no el de esta página: no había ningún `lang` que declarara el idioma de la prosa.
   > Lo señaló el hallazgo 2 de la revisión y se arregla en la segunda ronda (`e653dd5`).

## Decisiones donde el spec no cerraba

1. **El idioma de la prosa viaja en `?lang=`, no en un segmento de ruta.** Así cada página tiene
   **una** ruta: el panel enlaza `/developers` sin saber en qué idioma lee el visitante, y el
   selector solo cambia el parámetro. Se omite cuando coincide con el idioma de la instancia
   (el caso de casi todo el mundo), así que las URL que se comparten quedan limpias. Efecto
   colateral: las páginas se renderizan bajo demanda (`ƒ` en el build) en vez de estáticas.
2. **Dos dimensiones de idioma, a propósito.** La prosa sigue al visitante (`?lang=`); la
   interfaz —copiar, «Secciones», «En esta página», etiquetas de la referencia— sigue a la
   instancia y sale de `messages/{es,en,ko}.json` (CP6). El spec pide «menú» en los catálogos:
   las etiquetas del menú **son los títulos de las páginas**, que son prosa y tienen que seguir
   al selector; si salieran del catálogo, una instancia en coreano enseñaría un menú en coreano
   apuntando a páginas en inglés. Lo que sí está en los tres catálogos es todo el resto del
   cromo (`Developers.ui.*`, `Developers.reference.*`, `Developers.changelog.*`) y los nombres
   de los grupos del menú están en el contenido, por idioma.
3. **Los nombres de idioma del selector no se traducen** («Español», «English»): un selector que
   enseña «Spanish» a quien busca español no sirve. Son constantes en `locale-switch.tsx`, no
   claves de catálogo.
4. **El fixture describe las 37 operaciones, no cuatro de ejemplo.** Mientras a7.6 no se fusione,
   el fixture es lo que un cliente ve en `/developers/reference`: una referencia de juguete sería
   una página que miente. Con las 37 la página es honrada desde el primer día y el cambio de
   `source.ts` al integrar no altera lo que el lector ya leía.
5. **`GET /api/v1/openapi.json` aparece como código, nunca como enlace.** Esa ruta la crea a7.6 y
   en esta rama no existe: enlazarla sería un enlace roto (y el test de enlaces lo cazaría). Al
   integrar se puede convertir en enlace en las páginas «Referencia» e «Integraciones».
6. **Las anclas (`id` de los `h2`) son distintas en español y en inglés** (`#crear` / `#create`).
   El selector no arrastra el fragmento —un enlace renderizado en servidor no lo conoce—, así que
   no se pierde nada; unificarlas obligaría a poner anclas en inglés en la prosa española.
7. **La página «Empezar» no lleva captura de pantalla** (el spec la menciona). Producir una
   exigía arrancar la aplicación y añadir un binario al repositorio; en su lugar va la ruta
   exacta del panel y los cuatro pasos numerados. Si se quiere la captura, es un añadido de un
   archivo en `public/` y un bloque `image` nuevo en el modelo de contenido.
8. **La tabla de códigos de error incluye los de facturación** (`feature_unavailable`,
   `quota_exceeded`, `plan_limit_reached`, `account_read_only`), que `docs/public-api.md` no
   documentaba. Salen de `src/lib/api/v1/respond.ts` y `src/lib/billing/enforce.ts`, con sus
   estados reales (402 los tres primeros, 403 el último).
9. **Los planes que incluyen la API son Pro y Negocio**, leído de la semilla de
   `supabase/migrations/041_billing_model.sql` (`features` incluye `api` y `webhooks`); Inicio no.
10. **Las versiones del changelog son editoriales.** La API no numera versiones en el código, así
    que se derivaron de la historia de la fase: v1.0 (2026-07-01, base), v1.1 (2026-09-15,
    a7.1 + a7.4), v1.2 (2026-09-16, a7.2 + a7.3 + a7.5 + a7.6 + a7.7).
11. **`robots.ts` y `sitemap.ts` no existen en el repo**, así que no había nada que ampliar. Lo
    que sí se hizo es lo equivalente: el layout de la sección declara `robots: { index: true,
    follow: true }`, que invierte el `noindex` global del layout raíz solo para estas rutas.
12. **`docs/public-api.md` conserva el archivo** (no se borra) porque `README.md`, `docs/mcp.md`,
    `mcp-server/README.md` y el `CHANGELOG` lo enlazan: queda como puntero de 41 líneas a
    `/developers` y a `/api/v1/openapi.json`, con la tabla de qué hay en cada sitio.

## Variables de entorno

**Ninguna nueva.** `docs/docker.md` no se tocó por lo mismo. `.env.local.example` está bloqueado
por permisos: no se tocó y tampoco había nada que añadir.

## Deuda detectada fuera de alcance

1. **`README.md` no está formateado con prettier** (ya lo estaba antes; `npx prettier --check
   README.md` falla también sobre `a4ce30a`). El cambio de esta feature son 4 líneas en el estilo
   del archivo; reformatearlo entero habría escondido el cambio real.
2. **`src/middleware.test.ts` tampoco está formateado** (comillas dobles). Se anota porque el
   commit `5e996e7` deshace un reformateo accidental: quien pase prettier sobre ese archivo
   generará 231 líneas de ruido.
3. **La tabla de herramientas MCP de «Integraciones» no está atada a `mcp-server/`.** Si allí se
   añade una herramienta (a7.6 prevé actualizar el servidor con tags, plantillas y exportaciones),
   esta página no se entera. Un test que leyera `mcp-server/src/**` y comparara los nombres sería
   barato, pero toca una carpeta que esta feature tiene prohibida.
4. **`docs/mcp.md` sigue describiendo `docs/public-api.md` como la referencia.** Con el puntero
   nuevo el enlace sigue llevando a algo correcto, pero la frase envejeció; no se tocó porque no
   está en el alcance de §7.
5. **Las rutas de la sección son dinámicas** (`ƒ`) por el `searchParams` del selector. Si algún
   día importa el coste, la salida es mover el idioma a una cookie o a un segmento y recuperar el
   prerenderizado; hoy la sección es HTML sin datos y el coste es el de renderizar prosa.
6. **`CHANGELOG.md` de la rama sigue acumulando la fase entera en `[Unreleased]`** (ya lo hacía):
   la entrada de esta feature se añadió al final de `### Added`, respetando el orden en que se
   fueron integrando a7.1–a7.5.

---

# Segunda ronda — respuesta a `CHANGES_REQUESTED`

Revisión atendida: `progress/review_developer-docs.md`. Los cinco «Cambios requeridos» están
hechos. Rama `api/docs`, base de esta ronda `5e996e7`, **sin tocar los commits anteriores**.

**Estado: verde.** Compuerta ejecutada comando a comando en primer plano, en el worktree:
`lint` 0 errores (35 avisos, los mismos 35 preexistentes), `typecheck` limpio,
**193 archivos / 2 535 tests** (4 nuevos), `build` correcto con las variables dummy de
`docs/harness.md`. Sin SQL, así que `replay-migrations.sh` no procede.

## Commits nuevos

| Commit | Mensaje | Cambio de la revisión |
|---|---|---|
| `e653dd5` | `fix: declarar el idioma de la prosa en /developers` | 2 |
| `53dcb4e` | `docs: documentar el techo de 250 000 mensajes del encargo de exportación` | 3 |
| `547aae2` | `fix: apuntar el enlace de webhooks del panel a la guía que promete` | 4 |
| `489c261` | `feat: completar los once eventos de webhook en la referencia` | 5 |
| `073ac07` | `fix: dar contraste AA a las etiquetas de /developers en modo oscuro` | 1 (lo que salió al medir) |

10 archivos, +211 / −10.

## Cambio 1 — Lighthouse de accesibilidad

**Ejecutado.** No a mano en DevTools: no hay Chrome instalado en la máquina, así que se midió
con el CLI de Lighthouse sobre el **build de producción**, en headless, apuntando
`CHROME_PATH` al Chromium que sí hay (Brave). `npx --yes` es efímero: **no añade nada a
`package.json` ni a `package-lock.json`** (ambos siguen sin aparecer en el diff).

```bash
# build con las variables dummy de docs/harness.md, luego:
npx next start -p 3123 &        # servidor de producción, se mata al terminar
export CHROME_PATH="/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"
npx --yes lighthouse http://localhost:3123/developers \
  --only-categories=accessibility --chrome-flags="--headless=new" \
  --output=json --output-path=/tmp/lh-developers.json --quiet
```

Lighthouse 13.4.1, HeadlessChrome/144. `categories.accessibility.score`:

| Página | Antes | Después | Criterio ≥ 0,90 |
|---|---|---|---|
| `/developers` | 0,96 | **0,96** | cumple |
| `/developers/reference` | 0,97 | **0,97** | cumple |
| `/developers/changelog` (extra) | 0,96 | **1,00** | cumple |

Las dos que pide el spec pasaban ya en la primera medición, así que el arreglo de contraste no
era obligatorio; se hizo porque **la medición destapó 178 fallos reales de contraste en modo
oscuro** en componentes de esta feature (182 en total en las tres páginas, contando los 4 de
enlaces que son deuda de la aplicación), y dejarlos medidos y sin arreglar habría sido peor que
no medir. Detalle, agrupado por par de colores (`audits.color-contrast.details.items`):

| Dónde | Par | Ratio | Instancias | Estado |
|---|---|---|---|---|
| `Chip tone="warn"` («requerido») de la referencia | `#e7000b` sobre `#2f0f14` | 3,67:1 | 148 | **arreglado** |
| Etiqueta de método `post` | `#26704b` sobre `#12201e` | 2,79:1 | 12 | **arreglado** |
| Etiquetas `patch`/`put` | `#9d6008` sobre `#3c3017` | 2,52:1 | 4 | **arreglado** |
| Etiquetas de tipo de cambio del changelog | `#26704b` / `#9d6008` | 3,05 / 3,17:1 | 14 | **arreglado** |
| Enlaces de la prosa (`text-primary`) | `#7834e8` sobre `#05070b` | 3,31:1 | 2 por página | **deuda, ver abajo** |

La causa de los cuatro primeros es la misma: los tonos `--cb-token-*` (marca, positivo) están
tallados para superficies claras y **no tienen variante oscura** (`globals.css:274-291` los
declara solo en `:root`), así que pintar el TEXTO con ellos cae por debajo del 4,5:1 de WCAG AA
en cuanto el fondo es oscuro. El arreglo es el criterio que ya seguía la etiqueta `get`: **el
hue va en el fondo y el contraste en el texto** (`text-foreground`, que sí sigue al modo). Las
etiquetas se siguen distinguiendo por su tinte. Tras el cambio, `reference` y `changelog` no
tienen un solo fallo de contraste propio.

Guion manual, recorrido en esta ronda contra el servidor de producción en `localhost:3123`:

1. **Pública** — **[x]** `curl` sin cookies a `/developers`, `/developers/reference`,
   `/developers/guides/webhooks` y `/developers/changelog`: los cuatro `200` y `redirect_url`
   vacío. El HTML no trae ni una marca del panel (`DashboardShell`, `data-sidebar`): 0
   coincidencias.
2. **Selector** — **[x]** `/developers/guides/exports?lang=en` devuelve
   `<main id="docs-content" lang="en">` y los enlaces del menú conservan el parámetro
   (`href="/developers/guides/webhooks?lang=en"`).
3. **Modo oscuro** — **[x] parcial.** Lighthouse renderizó las tres páginas **en modo oscuro**
   (fondo `#05070b` en el informe) y, tras el arreglo, sin fallos de contraste propios. Lo que
   sigue pendiente de ojo humano es el juicio estético, no la legibilidad medida.
4. **Responsive a 375 px** — **[ ]** pendiente: hace falta un navegador de verdad.
5. **Copiar** — **[ ]** pendiente: el portapapeles necesita interacción real.
6. **Teclado** — **[x] parcial.** El enlace de salto está en el HTML y es el primer elemento
   enfocable (`href="#docs-content"`, «Saltar al contenido»), y `aria-current="page"` marca la
   página del menú (test). El recorrido con Tab de verdad sigue siendo cosa del humano.
7. **Lighthouse** — **[x]**, tabla de arriba.

El servidor de producción se levantó y se mató dentro de esta sesión; el puerto 3123 queda
libre y no hay ningún proceso `next start` vivo.

## Cambio 2 — `lang` de la prosa

`src/components/developers/docs-shell.tsx`: `lang={locale}` en el `<main>`, en el `<nav>`
lateral y en el `<div>` del `<details>` de móvil, que repite el mismo `NavList`. El `<summary>`
queda fuera a propósito: su texto («Secciones») es cromo y sale de `messages/*.json`, o sea que
sigue al idioma de la instancia, que es el que declara el `<html lang>` del layout raíz.

Verificado en el HTML servido: `/developers` en una instancia en español trae cuatro
` lang="es"` (`<html>`, `<main>`, `<nav>`, `<div>` del desplegable) y `?lang=en` mueve los tres
de dentro a `en` sin tocar el del `<html>`.

## Cambio 3 — techo de 250 000 mensajes

`src/content/developers/{es,en}/guides.ts`, página `guides/exports`, aviso nuevo justo debajo de
la lista de `filters`: el número, que al superarlo el encargo termina en `failed` con el `error`
que el cliente va a leer literalmente («This export exceeds 250,000 messages»,
`ExportTooLargeError`, `src/lib/exports/conversations.ts:304-312`), que no se escribe un archivo
a medias, y la salida: partir por fechas con `from`/`to`, un encargo por tramo.

## Cambio 4 — el enlace del panel

`WEBHOOK_DOCS_URL` pasa de `/developers/webhooks` (catálogo de eventos) a
`/developers/guides/webhooks` (la guía con firma, reintentos y receptores en Node, Python y
PHP). Se eligió mover el enlace y no reescribir la etiqueta porque el comentario de al lado ya
describía la guía y porque `Settings.webhooks.docsLink` dice exactamente lo que hay en ella en
los tres catálogos; reescribir tres traducciones para describir una página peor habría sido el
camino largo hacia el sitio equivocado. **Los tres catálogos quedan intactos.**

## Cambio 5 — los once eventos en la referencia

`src/components/developers/openapi/fixture.ts`: añadidos `conversation.created`,
`conversation.closed`, `conversation.assigned`, `contact.created`, `contact.updated` y
`contact.tag_removed`, en el orden de `WEBHOOK_EVENTS` y con el `data` exacto de
`src/lib/webhooks/events.ts`. Verificado en el HTML servido: los once anclas
`id="webhook-…"` están en `/developers/reference`.

## Criterios ↔ tests (lo nuevo de esta ronda)

| Qué prueba | Archivo › `it` |
|---|---|
| El `<main>` declara el idioma de la prosa cuando difiere del de la instancia, y el menú y el desplegable también (3 contenedores, sin contar los `hreflang=`) | `src/components/developers/docs-shell.test.tsx` › `DocsShell` › «declara el idioma de la prosa en el contenido y en el menú» |
| …y declara español cuando la prosa se lee en español | mismo archivo › «declara español cuando la prosa se lee en español» |
| La referencia describe **todos** los `WEBHOOK_EVENTS`, en su orden: un evento nuevo en el código rompe aquí en vez de quedarse fuera en silencio | `src/components/developers/openapi/model.test.ts` › `buildReference — cobertura` › «describe TODOS los eventos de `WEBHOOK_EVENTS`, en su orden» |
| El `data` de cada ejemplo trae exactamente las claves de `WEBHOOK_EVENT_DATA_FIELDS` | mismo archivo › «el `data` de cada evento trae los campos que emite el código» |

El enlace del panel (cambio 4) no necesita test nuevo: `src/content/developers/links.test.ts` ›
«`src/components/settings/webhooks-settings.tsx` apunta a una página que existe» ya lee la
constante del archivo y la contrasta con las rutas reales, así que cubre el destino nuevo.
El techo de 250 000 (cambio 3) es prosa; lo que lo ata al código es el comentario que cita la
constante, no un test: un test que comparase el número con `ASYNC_MESSAGE_LIMIT` tendría que
leer la cadena traducida en dos idiomas, y ese acoplamiento cuesta más de lo que vale.

## Verificación manual pendiente (lo que queda para el humano)

Solo los puntos 4 y 5 del guion (responsive a 375 px y el botón de copiar), que necesitan un
navegador con manos. Todo lo demás está ejecutado arriba. Si se quiere repetir la medición de
accesibilidad en un Chrome de verdad, el comando exacto es el del bloque de arriba quitando
`CHROME_PATH`.

## Decisiones de esta ronda

1. **Lighthouse con Brave como Chromium.** No hay Chrome en la máquina y Lighthouse acepta
   `CHROME_PATH`; Brave es Chromium 144 y el motor que mide el contraste (axe) es el mismo. Se
   anota porque un número medido en otro navegador no es exactamente el número de DevTools,
   aunque para la categoría de accesibilidad —que es DOM y color, no red— la diferencia es nula.
2. **Se arregló el contraste aunque las dos páginas ya pasaban de 90.** Ver arriba: la medición
   destapó 182 fallos en las tres páginas y 178 eran de componentes de esta feature. El alcance del arreglo se
   quedó en `src/components/developers/`: no se tocó ni un token de `globals.css`, que es
   paleta de marca y afecta a toda la aplicación.
3. **El enlace del panel se movió, la etiqueta no.** Razonado en el cambio 4.
4. **El `*` de «campo requerido» de la referencia se deja en `text-brand-ink`.** Lighthouse lo
   midió y no lo marca; es un solo carácter junto al nombre del campo, que sí va en
   `text-foreground`.

## Variables de entorno

**Ninguna nueva**, tampoco en esta ronda. `docs/docker.md` sigue sin tocarse.
`.env.local.example` está bloqueado por permisos: no se tocó y no había nada que añadir.

## Deuda detectada fuera de alcance (añadidos de esta ronda)

7. **`text-primary` como color de enlace no llega a AA en modo oscuro.** `#7834e8` sobre
   `#05070b` es 3,31:1 (medido). Es el acento por defecto de la aplicación y aparece en **87
   archivos** de `src/`, no solo en `/developers`: el arreglo es del token (una variante de
   `--primary` para modo oscuro, o `--primary-link`), no de esta sección, y cambiarlo aquí solo
   habría hecho que la documentación desentonara con el resto. Es lo único que queda entre 0,96
   y 1,00 en `/developers` y `/developers/reference`.
8. **El icono de confirmación de «Copiado» usa `text-positive`** (`code-block.tsx:71`), que es
   el mismo tono sin variante oscura que se acaba de quitar de las etiquetas. Lighthouse no lo
   marca porque es un icono, no texto, pero en modo oscuro se ve flojo. Se deja porque va
   acompañado de la palabra «Copiado», que sí contrasta, y porque el arreglo de verdad es el
   token del punto 7.
