# Review — p6.1 rebrand-cabbity

**Veredicto:** APPROVED

Rama `saas/producto`, worktree `.claude/worktrees/producto`, HEAD `e76954c`, base `0e85b2d`.
Un solo commit, árbol limpio. Diff: 14 archivos, +210/−27.

## Compuerta

Ejecutada por mí, paso a paso, en el worktree y sobre el árbol commiteado:

- `npm run lint` → **verde** (0 errores, 35 warnings, todos preexistentes y ninguno en
  archivo tocado por esta feature).
- `npm run typecheck` → **verde** (sin salida).
- `TZ=UTC npx vitest run --reporter=dot` → **verde**: 144 archivos, 1958 tests, 0 fallos.
  Coincide con el informe (base: 142/1947 → +2 archivos, +11 tests).
- `npm run build` con las variables dummy de `ci.yml` → **verde**, exit 0.
- `scripts/replay-migrations.sh` → **n/a**: el diff no toca `supabase/`.

Comprobación sobre el artefacto del build, no sobre el informe:

```
grep -ho "<title>[^<]*</title>" .next/server/app/*.html | sort -u
→ <title>404: This page could not be found.</title>   (página de error de Next)
→ <title>500: This page couldn't load</title>         (idem)
→ <title>Cabbity CRM</title>                          (login, signup, forgot-password)
```

## Trazabilidad criterio ↔ test

Criterios de `progress/spec_producto.md` §1.

- **C1 «`grep -rniE "wa ?crm" src messages` no devuelve ningún texto visible; los restos son
  identificadores técnicos justificados uno a uno en el informe»**: [x]
  - Catálogos: `src/i18n/brand.test.ts` › `brand in messages/en.json > mentions no retired
    product name` y su gemelo `ko` (`describe.each`). Leído: aplana el catálogo entero de forma
    recursiva y exige que **ninguna** cadena case `/wa\s?crm/i`, devolviendo las claves ofensoras
    en el `expect` para que el fallo sea legible. No es un test de existencia: recorre las 1659
    claves reales del archivo en disco. Reejecutado aparte: 6/6 en verde.
  - Refuerzo: `spells the brand the same way everywhere it appears` exige ≥1 mención y que toda
    cadena con `/cabbity/i` contenga exactamente `Cabbity CRM` — cierra la puerta a «Cabbity»,
    «cabbity crm» o «Cabbity Crm».
  - Restos en `src/` y `docs/docker.md`: corrí el grep yo y **contrasté las 34 líneas una a una
    con la lista del informe**. Coinciden exactamente, sin sobrantes ni faltantes, y ninguna es
    texto visible: prefijo `wacrm_live_` (`src/lib/api-keys/keys.ts:25`), cabeceras
    `X-Wacrm-*` (`src/lib/webhooks/deliver.ts:118-120`, `sign.ts`), cookies
    `wacrm_support_*` (`src/lib/auth/support-cookie.ts:15,50`), separación de dominio del HMAC
    (`src/lib/auth/impersonation.ts:105`), claves de `localStorage` (`src/lib/themes.ts:28,48`,
    `src/app/(dashboard)/inbox/page.tsx:28`, `src/components/flows/flow-editor-shell.tsx:50`),
    `requestId` de idempotencia de PayPal, etiqueta de imagen Docker
    (`docs/docker.md:305,307`) y comentarios de código. Las justificaciones son correctas:
    cambiar cualquiera desloguea usuarios, invalida claves o duplica el catálogo de PayPal.
- **C2 «Test que fija el título/metadata con "Cabbity CRM"»**: [x]
  `src/app/layout.test.ts` › `titles the app "Cabbity CRM" by default` (`title.default`),
  `appends the brand to every per-page title` (`title.template === '%s — Cabbity CRM'` y además
  la sustitución real `'Inbox — Cabbity CRM'`) y `carries no trace of the previous name`
  (serializa el objeto `metadata` completo y exige que no case `/wa\s?crm/i`, así que cubre
  también `description`, `openGraph`, etc.). Leído: importa el `metadata` real de
  `src/app/layout.tsx`, no una copia. Los dos `vi.mock` (`next/font/google`, `./globals.css`)
  son módulos que no resuelven fuera del compilador de Next y no participan en ninguna
  aserción; el `<title>` extraído del build confirma el mismo valor de punta a punta.
- **Marca en PayPal (parte de §1: «nombre del producto en PayPal»)**: [x]
  `src/app/api/billing/checkout/route.test.ts` › `shows the product's brand on PayPal's approval
  screen` fija `createSubscription(...).brandName === 'Cabbity CRM'`. Verifiqué el cableado:
  `route.ts:246` pasa `brandName: BRAND_NAME` y `src/lib/billing/paypal.ts:362` lo mapea a
  `brand_name` del payload de PayPal — el test prueba el valor que el suscriptor ve, no una
  constante suelta.
  `src/lib/billing/paypal-bootstrap-catalog.test.ts` › `defaults the product name to the visible
  brand` y `names the brand in every plan description` (6 descripciones, cada una con
  `Cabbity CRM` y sin `/wa\s?crm/i`). Añade `keeps the idempotency keys on their original prefix`,
  que blinda `wacrm-sandbox-inicio-month-v1` contra un rebrand entusiasta — la regresión que
  habría duplicado los planes en PayPal. Bien pensado.
- **Verificación manual (PayPal)**: [x] guion de 3 pasos en el informe (bootstrap con sandbox,
  Catalog › Products, checkout desde `/billing`). Es lo correcto: el catálogo local está vacío
  y no hay nada que consultar en Postgres, así que no procede `checks_rebrand-cabbity.sql`.

## Checkpoints

- **CP1 Compuerta**: [x] los cuatro pasos en verde, ejecutados por mí.
- **CP2 Migraciones**: [x] n/a — sin SQL.
- **CP3 Aislamiento**: [x] n/a — ninguna consulta nueva ni tocada; el diff de
  `checkout/route.ts` y de las dos rutas de WhatsApp cambia solo literales de texto.
- **CP4 Tests**: [x] ver trazabilidad; los tests nuevos prueban el criterio, no la existencia.
- **CP5 Sin dependencias nuevas**: [x] `git diff 0e85b2d..HEAD -- package.json package-lock.json`
  está **vacío**. El `name: "wacrm"` del paquete sigue intacto, como exige S-P1.
- **CP6 i18n**: [x] `en.json` y `ko.json` con **1659 claves cada uno y conjunto idéntico**
  (diferencia simétrica vacía, comprobada aplanando ambos árboles). No existe `messages/es.json`
  y no se ha añadido uno parcial — correcto para esta feature; `es` llega en p6.4 (S-P3).
  Las 7 claves tocadas se movieron en los dos catálogos a la vez.
- **CP7 Next 16**: [x] comprobado en
  `node_modules/next/dist/docs/01-app/03-api-reference/04-functions/generate-metadata.md`:
  `title.default` (L219-228) y `title.template` (L241-260) siguen siendo la API vigente, con la
  regla de que `default` es obligatorio cuando hay `template` (L286) — el layout la cumple.
  Además el cambio en `layout.tsx` es de valores, no de forma: no introduce API nueva.
- **CP8 Alcance**: [x] los 14 archivos caen dentro de §1. Revisé el diff línea a línea: **no hay
  reformateo**. `src/app/layout.tsx` cambia 2 líneas y `invite-member-dialog.tsx` 3 (una de ellas
  un comentario), conservando las comillas dobles y el orden de clases preexistentes. La decisión
  de no pasarles prettier —y anotar la deriva como deuda en vez de arreglarla— es exactamente lo
  que pide CP8. La única ampliación de superficie es exportar `DEFAULT_PRODUCT_NAME` en
  `scripts/paypal-bootstrap-catalog.ts`, mínima y justificada: el valor vivía inline en `main()`,
  que vitest no carga.
- **CP9 Documentación**: [x] `CHANGELOG.md` bajo `## [Unreleased]` (L12) con dos entradas en
  `### Changed`, incluida la nota operativa de fijar `PAYPAL_PRODUCT_NAME=wacrm` para quien ya
  tenga catálogo. `docs/docker.md:174` actualiza el valor por defecto documentado. Sin variables
  de entorno nuevas. El informe `progress/impl_rebrand-cabbity.md` coincide con el diff en los
  14 archivos y en las cifras de la compuerta.
- **CP10 Git**: [x] commit en `saas/producto`, mensaje en español con prefijo `feat:` y
  `Co-Authored-By`. Nada pusheado (`origin/main..HEAD` incluye el commit → sigue local).
  `feat/saas-multiempresa` sigue en `0e85b2d` y `main` en `46a0999`: intactos.
- **CP11 Lo entrante nunca se bloquea**: [x] n/a — el webhook de WhatsApp no se toca.

## Hallazgos (archivo:línea)

Ninguno bloqueante. Tres observaciones:

1. `src/app/api/account/invitations/route.ts:135` — `https://wacrm.tech` es el único resto que
   sí llega a los ojos de un usuario (el enlace de invitación, cuando no se puede derivar la URL
   base). El informe lo justifica como dominio real del sitio de marketing en otro repositorio;
   comparto el criterio —apuntar a un dominio inexistente sería peor que la incoherencia de
   marca— pero conviene que el humano lo tenga presente como tarea de infraestructura, no de
   código.
2. `src/i18n/brand.test.ts:14` — la red de regresión cubre `messages/` pero no las cadenas de
   marca que viven en TypeScript: los dos 409 de
   `src/app/api/whatsapp/config/route.ts:385` y `embedded-signup/route.ts:233`, y el
   `'our Cabbity CRM account'` de `src/components/settings/invite-member-dialog.tsx:138,167`.
   Nada las fija; un rebrand futuro podría dejarlas atrás. Refuerza la deuda nº 2 del informe
   (un `BRAND` exportado desde `src/lib/`), que suscribo.
3. `src/app/layout.tsx:26` — `description` conserva «Self-hostable CRM template for WhatsApp.».
   No nombra el producto, así que el criterio del grep se cumple, y el test
   `carries no trace of the previous name` la cubre por serializar el `metadata` entero. La
   decisión de dejarla es correcta para esta feature.

## Cambios requeridos

Ninguno.
