# Review — p11.2 pricing-texts-kb

**Veredicto:** APPROVED

## Compuerta
- lint / typecheck / `TZ=UTC npm test` / build: **no ejecutados por mí** (instrucción explícita del líder:
  los corre él cuando la máquina esté libre). El informe del implementer declara verde (270 archivos /
  3.834 tests, build con `ƒ /precios`). Sí ejecuté los archivos de test afectados directamente con
  `vitest run` y los 15 tests nuevos/tocados que toqué pasan:
  - `src/components/pricing/pricing-page.test.tsx`, `src/lib/billing/public-plans.test.ts`,
    `src/i18n/included-wording.test.ts` → 15/15 verdes.
  - `src/lib/billing/enforce.test.ts`, `src/app/(auth)/login/page.test.tsx`, `src/i18n/messages.test.ts`
    → 44/44 verdes.
  - `src/i18n/brand.test.ts`, `src/i18n/icu-safety.test.ts` → 8/8 verdes.
  Pendiente: la compuerta completa (lint/typecheck/test/build) la confirma el líder.
- replay-migrations: **n/a** — el diff no toca `supabase/migrations` (confirmado por `git diff --stat`).

## Alcance del diff (`be8ca0f..63a145f`, worktree `pmd-pricing-texts`)
```
CHANGELOG.md                                 |   6 +
messages/en.json                             |  91 ++++++++-
messages/es.json                             |  91 ++++++++-
src/app/(auth)/login/page.test.tsx           |  18 ++
src/app/(auth)/login/page.tsx                |   7 +
src/app/(public)/precios/page.tsx            |  12 ++
src/components/billing/plan-picker.tsx       |  66 ++++++-
src/components/pricing/pricing-page.test.tsx | 109 +++++++++++
src/components/pricing/pricing-page.tsx      | 269 +++++++++++++++++++++++++++
src/i18n/included-wording.test.ts            |  53 ++++++
src/i18n/messages.test.ts                    |   2 +
src/lib/billing/enforce.test.ts              |  11 ++
src/lib/billing/enforce.ts                   |   7 +-
src/lib/billing/public-plans.test.ts         | 121 ++++++++++++
src/lib/billing/public-plans.ts              |  93 +++++++++
15 files changed, 940 insertions(+), 16 deletions(-)
```
Un solo commit (`63a145f`), en español, con prefijo `feat:`, `Co-Authored-By` presente (CP10 OK).
`package.json`/`package-lock.json` sin diff (CP5 OK). Nada fuera de lo que justifica la nota de la
feature: página pública, FAQ, `PlanPicker`, texto de `enforce.ts`, enlace del login, KB (CP8 OK).

## Cifras de Meta — contrastadas contra `progress/spec_facturacion-gestionada.md`
Cifras permitidas por el spec: 1.000 mensajes de servicio gratis por número y mes desde 2026-10-01;
RD en «Resto de Latinoamérica» 0,0113 servicio/utilidad y 0,0740 marketing; ventana de 72 h; migración 076.

- `messages/es.json` y `messages/en.json` (`Pricing.free.*`, `Pricing.example.body`,
  `Pricing.faq.freeQuota/negocio/rates`, bloque `Billing.metaFreeService`): leí el namespace `Pricing`
  completo en ambos catálogos (es: líneas 2624-2697; en: 2624-2695) y el bloque `Billing` tocado
  (líneas ~1953-1969). Solo aparecen 1.000 / 3.000 (= 3×1.000) / 0,0113 / 0,0740 / 72 h / fecha
  1-oct-2026. Ninguna otra cifra de Meta (no otros países, no el multiplicador 2,5 ni la cuota de
  7.000/1.036 del plan `gestionado` de la fase 10).
- `pricing-page.test.tsx` › "lists the three public plans..." tiene
  `expect(html).not.toMatch(/gestionado|ilimitado|1\.036/i)` — guarda explícitamente contra la fuga del
  plan oculto y de su cifra (1.036 USD/mes, fase 10).
- `progress/ai_cabbity-conocimiento.md` (fuera del worktree, en el checkout principal), sección nueva
  «Cabbity CRM: qué cobra Cabbity y qué cobra Meta» (líneas 344-394): mismas cifras (1.000 / 3.000 /
  0,0113 / 0,0740 / 72 h / 1-oct-2026), formato pregunta/respuesta (8 preguntas), sin plan `gestionado`.
- `public-plans.ts`: `META_FREE_SERVICE_PER_NUMBER = 1000`.

## Precios y catálogo público — contrastados contra migraciones reales
- `public-plans.ts`: Inicio 35/350, Pro 100/1000, Negocio 199/1990; límites (`operators`,
  `messages_out`, `ai_replies`, `broadcast_recipients`, `numbers`) iguales campo a campo al `INSERT`
  de `041_billing_model.sql` (líneas 212-233). Precios finales iguales al efecto acumulado de
  `059_plan_inicio_35.sql` (Inicio→35/350) y `065_plan_pro_100.sql` (Pro→100/1000); Negocio no se
  tocó tras la 041 (199/1990), correcto.
- `public-plans.test.ts` parsea con regex el `INSERT` real de la 041 y todos los `UPDATE plans SET
  price_usd_month...` de las migraciones reales (recorridas en orden), y compara contra la constante.
  No es un test vacuo: si una migración de catálogo futura no actualiza `public-plans.ts`, la compuerta
  rompe. `expect(prices.get('inicio')?.month).toBe(35)` y `...pro...toBe(100)` guardan contra que el
  regex no vea nada y el test pase por casualidad.
- "3 números = 3.000 gratis" solo en Negocio: `metaFreeServiceFor(3) = 3000`; en la UI,
  `freePerNumberNote` solo se renderiza si `limits.numbers > 1` (`pricing-page.tsx:119`) — Inicio y Pro
  tienen 1 número, así que no la ven. Test: `html.match(/con los \d+ números del plan son/g)).toHaveLength(1)`.

## Página `/precios`
- `src/app/(public)/precios/page.tsx`: wrapper simple → `PricingPage`/`pricingMetadata`.
- No está en `protectedPaths` de `src/middleware.ts:166` → pública, sin sesión necesaria.
- `robots: { index: true, follow: true }` igual que `src/app/(public)/developers/layout.tsx:18`
  (coherente con las demás públicas).
- Enlazada desde `/login` (patrón p8.1): `<Link href="/precios">` tras `/developers`, separado por
  " · "; test `login/page.test.tsx` › "LoginPage → /precios" comprueba orden y label en ambos catálogos.
- Sin datos de inquilinos: usa `PUBLIC_PLANS` (constante) y los catálogos de `messages/*.json`; no hay
  `supabaseAdmin()` ni ninguna consulta a Supabase en `pricing-page.tsx` ni `public-plans.ts`
  (`grep supabaseAdmin` → sin resultados). CP3 n/a (no hay consulta con rol de servicio nueva).
- Render es/en probado con contenido real (no solo snapshot): números, FAQ completo (7 entradas vía
  `PRICING_FAQ`), metadatos (`pricingMetadata`). Leí `pricing-page.test.tsx` completo: no es vacuo.
- `searchParams: Promise<{...}>` verificado contra
  `node_modules/next/dist/docs/01-app/01-getting-started/03-layouts-and-pages.md` (convención exacta
  de Next 16: `searchParams` como `Promise`, `await` dentro de la función). CP7 OK.

## `/billing` (PlanPicker) y `enforce.ts`
- `plan-picker.tsx`: solo añade `NumbersLines` (números de WhatsApp + cuota gratis de Meta) y una nota
  con enlace a `/precios`; no cambia ninguna lógica de selección/cambio de plan existente.
- `Billing.limitMessagesOut/aiReplies/broadcastRecipients` reescritos como «incluidos al mes» /
  "included per month"; `usageOf` pasa de `"{used} de {limit}"` a `"{used} de {limit} incluidos"`
  (y el equivalente en inglés); mismos placeholders ICU en ambos catálogos.
- `enforce.ts`: el único cambio es el string de `error` en `billingErrorPayload` para
  `QuotaExceededError`. `code`, `upgradeUrl`, `metric`, status HTTP: sin cambios (diff completo leído).
  Test nuevo (`enforce.test.ts` › "p11.2: words the quota...") comprueba el texto nuevo y que ya no
  contiene "allowance"/"raise this limit"; el test previo que exige `/upgrade/i` sigue siendo válido
  porque el texto nuevo conserva "upgrade". CP11 OK: no se toca ninguna ruta de guardado de mensajes
  entrantes ni el webhook de WhatsApp.

## Frases prohibidas (`included-wording.test.ts`)
Leí el test completo: recorre **todas** las hojas de string de `messages/es.json` y `messages/en.json`
(no solo `Pricing`/`Billing`) contra una lista de regex acordada (líneas 13-29) que apunta a frasear los
mensajes como un muro («límite de mensajes», «máximo de mensajes», «hasta N mensajes», «message limit»,
«raise this limit»...), sin prohibir «límite» suelto (p.ej. «Sin límite» sigue siendo válido). No es
vacuo: pasa sobre el árbol completo con `leaves()` y sí falla si aparece una de las frases.

## i18n — paridad es/en
- `Pricing` (91 líneas insertadas en cada catálogo): mismas claves, mismos placeholders ICU
  (`{price}`, `{count}`, `{numbers}`, `{free}`, `{perNumber}` con `plural`), mismo orden de FAQ
  (`PRICING_FAQ`). Comparé ambos bloques completos (es: 2624-2697; en: 2624-2695).
- `Billing.limitNumbers`, `metaFreeService`, `metaNote`, `metaNoteLink`, `usageDesc`, `usageOf`: mismas
  claves y placeholders en ambos catálogos.
- `src/i18n/messages.test.ts` (paridad general), `icu-safety.test.ts`, `brand.test.ts`: corridos y
  verdes (8/8). `Pricing.who.cabbityTitle`/`metaTitle` añadidos a `IDENTICAL_TO_SOURCE_OK` como nombres
  de marca («Cabbity CRM», «Meta»), justificado.
- Sin coreano añadido (CP6 cumplido: `ko` sigue retirado desde s9.9).

## Checkpoints
- CP1 Compuerta: pendiente de confirmación del líder (ver arriba); tests relevantes corridos y verdes.
- CP2 Migraciones: n/a, sin SQL.
- CP3 Aislamiento: n/a, sin consulta nueva con rol de servicio.
- CP4 Tests: [x] cada criterio de la nota tiene test real, leído por mí (no solo existencia).
- CP5 Sin dependencias nuevas: [x] `package.json`/`package-lock.json` sin diff.
- CP6 i18n: [x] paridad es/en confirmada clave a clave en lo tocado; sin `ko`.
- CP7 Next 16: [x] `searchParams: Promise<...>` contrastado con `node_modules/next/dist/docs/`.
- CP8 Alcance: [x] diff limitado a lo que la nota de la feature justifica.
- CP9 Documentación: [x] `CHANGELOG.md` (Unreleased) actualizado; sin variables de entorno nuevas
  (no hay diff en `docs/docker.md`, consistente); informe del implementer coincide con el diff real.
- CP10 Git: [x] commit único, español, prefijo `feat:`, `Co-Authored-By`; nada pusheado.
- CP11 Entrante nunca se bloquea: [x] `enforce.ts` es cambio de texto únicamente, sin tocar lógica de
  bloqueo ni la ruta del webhook de WhatsApp.

## Trazabilidad criterio ↔ test
- «Qué cobra Meta / qué cobra Cabbity» en es y en: [x] `pricing-page.test.tsx` › "says what Cabbity
  charges and what Meta charges..." (es) y "renders the same page in English with ?lang=en".
- «Solo planes públicos, nunca gestionado/ilimitado»: [x] idem (`not.toMatch(/gestionado|ilimitado/i)`)
  y `public-plans.test.ts` › "never publishes a hidden plan".
- «3 números = 3.000 gratis solo en Negocio»: [x] `pricing-page.test.tsx` › "explains that 3 numbers
  are 3.000 free service messages on Negocio (es)" + aserción de recuento de apariciones (1 sola vez).
- «Mensajes como incluidos, no muro»: [x] `pricing-page.test.tsx` › "words the plan messages as
  included (es)"; `included-wording.test.ts` (frases prohibidas, todo el árbol de ambos catálogos);
  `enforce.test.ts` › "p11.2: words the quota...".
- «Catálogo de /precios = migraciones (041/059/065)»: [x] `public-plans.test.ts`, anclado con regex
  real sobre los archivos SQL, no vacuo.
- «Enlace desde el login»: [x] `login/page.test.tsx` › "LoginPage → /precios" (2 `it`).
- «Paridad i18n»: [x] `messages.test.ts`, `icu-safety.test.ts`, `brand.test.ts` verdes; comparación
  manual de los bloques `Pricing` y `Billing` en ambos catálogos.
- «Base de conocimiento, formato P/R, sin cifras no permitidas»: [x] verificado leyendo
  `progress/ai_cabbity-conocimiento.md` líneas 344-394.

## Hallazgos (archivo:línea)
1. `src/components/pricing/pricing-page.tsx:70` (`pricingMetadata`) — `title: t('seoTitle')` devuelve
   el título completo con marca («Precios de Cabbity CRM» / «Cabbity CRM pricing»). El layout raíz
   (`src/app/layout.tsx:81-84`) define `title.template = '%s — Cabbity CRM'`, y `/precios` no tiene un
   `layout.tsx` propio que lo anule (a diferencia de ningún caso en el repo, pero comparado con el
   patrón de `/developers`: sus páginas usan títulos cortos sin marca — `src/content/developers/es/reference.ts:11,37,166`,
   p.ej. «Webhooks» — precisamente para que el template añada el sufijo una sola vez). El resultado real
   en el `<head>` sería «Precios de Cabbity CRM — Cabbity CRM» (es) / «Cabbity CRM pricing — Cabbity CRM»
   (en): marca duplicada. El test (`pricing-page.test.tsx` › "titles the page...") solo comprueba el
   valor que devuelve `pricingMetadata()`, no el `<title>` final ya fusionado con el layout, así que no
   lo atrapa. Es un defecto cosmético de SEO/UX, no de datos ni de comportamiento — no bloqueante por sí
   solo, pero vale la pena que el humano decida si lo corrige (quitar «de Cabbity CRM»/«Cabbity CRM» de
   `seoTitle` y dejar que el template lo añada, o quitar el template para esta página).

## Cambios requeridos (si aplica)
Ninguno bloqueante. El hallazgo 1 es una mejora opcional, no impide aprobar.

---
APPROVED
