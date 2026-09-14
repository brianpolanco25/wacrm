# Review — p6.2 trial-banner

**Veredicto:** APPROVED

Rama `saas/producto`, worktree `.claude/worktrees/producto`, base `e76954c`, commit único
`aed1d3b`, árbol limpio. Diff: 11 archivos, +652/−40, ninguno fuera de lo que justifica
§2 del spec.

## Compuerta

Ejecutada por mí, paso a paso, en el worktree:

- `npm run lint`: **verde** — 0 errores, 35 warnings, todos preexistentes y ninguno en
  archivos del diff.
- `npm run typecheck`: **verde** — `tsc --noEmit` sin salida.
- `TZ=UTC npm test -- --reporter=dot`: **verde** — 147 archivos, 1 984 tests, 0 fallos.
- `npm run build` (con las variables dummy de `ci.yml`): **verde** — `✓ Compiled successfully
  in 9.4s`, 64 rutas. El único warning es el de `turbopack.root`, preexistente.
- `replay-migrations`: **n/a** — el diff no toca `supabase/`.

## Trazabilidad criterio ↔ test

Criterios de `progress/spec_producto.md` §2. Tests leídos, no solo listados.

- **C1 «`trialing` + `trial_ends_at` a 5 días → banner con "5 días" y enlace a `/billing`»**:
  [x] `src/components/billing/trial-banner.test.tsx` › `counts the days left and links to
  /billing while trialing` — renderiza con `trialEndsAt = NOW + 5·DAY` y `readAt = NOW`, y
  afirma las tres cosas: `Trial ends in 5 days`, `href="/billing"` y el `Choose a plan`.
  La aritmética por debajo está fijada aparte en `src/lib/billing/trial.test.ts` ›
  `counts the days left while the subscription is trialing` (`{kind:'days', days:5}`) y
  `rounds up to the whole day…` (4,5 días → 5; 5 días menos 1 ms → 5).
- **C2a «`active` → sin banner»**: [x] `trial-banner.test.tsx` › `renders nothing once the
  account contracted a plan` — mismo estado salvo `status:'active'`, `toBe('')` sobre el
  markup completo. Reforzado por `trial.test.ts` › `says nothing once the account contracted
  a plan` y por `says nothing on the %s rung…` (`past_due`, `suspended`, `cancelled`,
  `expired`), más `renders nothing on any rung of the dunning ladder` a nivel de componente.
- **C2b «`trialing` vencido pero no procesado → "hoy"»**: [x] `trial-banner.test.tsx` ›
  `says "today" when the trial ran out but the row still says trialing` — `trialEndsAt =
  NOW − 2·DAY`, afirma `Trial ends today` y `not.toContain('days')`. Origen en `trial.ts:53-56`
  (`remaining < DAY_MS` → `{kind:'today'}`) con dos tests: `says "today" with less than a full
  day left` (0,4 días) y `still says "today" when the deadline already passed…` (−3 días).
- **C3 «Textos en los catálogos exigidos por CP6»**: [x] `trial-banner.test.tsx` ›
  `is translated, not English with a Korean shell (CP6)` — renderiza en `ko`, exige el texto
  coreano real y `not.toContain('Billing.')` (una clave ausente en next-intl se pinta como
  keypath, así que esa aserción es la que muerde). Paridad de claves en
  `src/i18n/messages.test.ts` (compara los conjuntos de claves en ambos sentidos, verde).
- **«Sin consulta nueva por página»** (requisito del cuerpo de §2): [x]
  `src/hooks/use-billing-status.test.ts` › `hits the endpoint once per account, however many
  banners ask` — dos llamadas concurrentes (los dos consumidores montan en el mismo commit)
  más una tercera posterior, `toHaveBeenCalledTimes(1)`; cubre a la vez la deduplicación
  en vuelo (`inFlight`) y la caché por TTL.
- Verificación manual: ninguna dependiente de Meta/PayPal. Las dos comprobaciones visuales
  del informe (§«Verificaciones manuales pendientes») son las correctas y están escritas
  como guion reproducible; no hay jsdom ni e2e en el repo, así que nada más es exigible.
  `progress/checks_trial-banner.sql` no aplica: el diff no lee ni escribe base nueva.

## Cómo obtiene `trial_ends_at` (sin consulta por página)

Correcto y bien argumentado. El dato sale de `GET /api/billing/status`, la lectura que f3.5
dejó **abierta a cualquier miembro** (`getCurrentAccount`, sin suelo de rol); descartar
`/api/billing/subscription` es acertado: es `adminOnly` y devolvería 403 a los `agent` y
`viewer`, que son justo el público del contador. El `fetch` que `BillingStatusAlert` tenía en
su `useEffect` se extrajo a `src/hooks/use-billing-status.ts` con caché de módulo, deduplicación
y TTL de 30 s, calcado de `use-ai-account-status.ts`. Resultado: el aviso de morosidad y la
píldora del trial cuestan **una** petición por cuenta, no dos, así que la feature resta una
consulta respecto a la base en vez de añadirla.

Descartar ampliar `fetchAccountSummary` de `use-auth` está bien justificado (`accounts` y
`subscriptions` son tablas distintas, y por PostgREST habría que reimplementar `getEntitlements`
en el navegador).

## CP3 — aislamiento

- El diff **no añade ninguna consulta**, ni con `supabaseAdmin()` ni con cliente RLS.
- La única lectura, preexistente, es `src/app/api/billing/status/route.ts:36-42`: cliente SSR
  del usuario (`ctx.supabase`) **con** `.eq('account_id', ctx.accountId)` sobre RLS. Verificado
  en el archivo, no en el informe.
- La capa que hay detrás, `getEntitlements` (`src/lib/billing/entitlements.ts:195-202`), sí usa
  `supabaseAdmin()`, y filtra `.eq('account_id', accountId)`; la segunda consulta de esa función
  es al catálogo global `plans`, que no es dato de inquilino. Preexistente y conforme.
- En el cliente, la caché está indexada por `accountId` y ese id es el **efectivo**
  (`use-auth.tsx:561`, `accountId: effectiveAccount`), o sea el de la cuenta impersonada durante
  una sesión de soporte. Test de no reutilización entre cuentas:
  `use-billing-status.test.ts` › `keys the cache by account, so a support session never reuses
  the other company` (dos cuentas → dos peticiones).

## Cuentas sin fila de suscripción y estados distintos de `trialing`

- **Sin fila**: `getEntitlements` cae a `status = 'trialing'` con `trialEndsAt = null`
  (`entitlements.ts:207-209` y `:245`). `trialNotice` devuelve `null` cuando no hay fecha
  (`trial.ts:49`), así que **no se pinta nada**. Fijado en `trial.test.ts` ›
  `says nothing when there is no account, no status or no deadline` (incluye `null`, `undefined`
  y una fecha no parseable). Decisión correcta: sin fecha no hay promesa que hacer.
- **Otros estados**: `trial.ts:47` corta con `status !== 'trialing'`; cubierto para `active` y
  para los cuatro peldaños de la escalera.
- **Estado desconocido** (lectura fallida o antes de que llegue): `fetchBillingStatus` resuelve
  `null` y no lo cachea; el banner no pinta nada. Tests `resolves to unknown — not to a state —
  when the read fails` y `does not cache a failure: the next mount retries`.

## Convivencia con la franja de impersonación (f4.4) y el aviso de solo lectura (f3.4)

Sin solape, comprobado en el árbol de montaje `src/app/(dashboard)/dashboard-shell.tsx:62-75`:
`ImpersonationBanner` es una franja a ancho completo **fuera** del área de scroll y por encima
de la cabecera; `Header` va debajo; `BillingStatusAlert` va dentro de `<main>`, sobre la página.
La píldora vive en el grupo derecho de la cabecera (`header.tsx:77`), junto a `ModeToggle`. Los
dos grupos del `header` llevan `min-w-0`, el título `truncate` y la píldora `truncate` +
`shrink-0` en icono y sufijo, con el «Choose a plan» oculto por debajo de `sm`: el desbordamiento
está atendido. Además, trial y escalera son excluyentes por estado, así que el aviso de f3.4 y
la píldora no compiten por el mismo mensaje.

## Checkpoints

- CP1 Compuerta: [x] los cuatro pasos ejecutados por mí, verdes.
- CP2 Migraciones: [x] n/a, el diff no toca `supabase/`.
- CP3 Aislamiento: [x] ver arriba; sin consultas nuevas, filtro verificado, test de no
  reutilización entre cuentas.
- CP4 Tests: [x] los tres criterios con test leído; 8 casos de aritmética, 8 de componente,
  8 de hook.
- CP5 Sin dependencias nuevas: [x] `package.json` y `package-lock.json` no aparecen en el diff.
- CP6 i18n: [x] `Billing.trialEndsIn`, `Billing.trialEndsToday`, `Billing.trialChoosePlan` en
  `en.json` y `ko.json` con la misma clave; no se crea `es.json`. Plural ICU correcto en inglés
  (`{days, plural, =1 {day} other {days}}` → «1 day» / «5 days», fijado por
  `uses the ICU singular on the exact one-day boundary (en)`); el coreano no lleva plural, que
  es lo correcto para ese idioma, y conserva el marcador `{days}`.
- CP7 Next 16: [x] la única API de framework nueva es `next/link`; contrastado con
  `node_modules/next/dist/docs/01-app/03-api-reference/02-components/link.md` — uso directo
  `<Link href="/billing">` con props reenviadas al `<a>`, sin `legacyBehavior` ni `<a>` anidado.
- CP8 Alcance: [x] los 11 archivos caen dentro de §2. La edición de `header.tsx` son 5 líneas;
  el implementer revirtió a conciencia el reformateo de prettier (~180 líneas) para no esconder
  la feature en un cambio de estilo, y lo anotó como deuda en vez de arreglarlo. Correcto.
- CP9 Documentación: [x] `CHANGELOG.md` (Unreleased → Added) con una entrada que describe lo
  que hace el cambio; sin variables de entorno nuevas, así que `docs/docker.md` no aplica;
  `progress/impl_trial-banner.md` existe y **coincide con el diff** (contrasté tabla de archivos,
  commits y resultados de compuerta).
- CP10 Git: [x] un commit en `saas/producto`, mensaje en español con prefijo `feat:` y
  `Co-Authored-By`; nada pusheado; `main` sigue en `46a0999` y `feat/saas-multiempresa` en
  `0e85b2d`.
- CP11 Lo entrante nunca se bloquea: [x] el diff son dos componentes de cliente, un hook de
  cliente y dos catálogos; ninguna ruta de webhook ni guardia de escritura.

## Hallazgos (archivo:línea)

Ninguno bloqueante. Tres observaciones, todas menores:

1. `messages/en.json:1885` — `"Trial ends in {days} {days, plural, =1 {day} other {days}}"`
   repite el argumento en vez de usar `#` dentro del plural
   (`{days, plural, =1 {# day} other {# days}}`). Renderiza correcto —el test lo fija— pero es
   una forma que invita a que una traducción futura pierda la concordancia. Cosmético.
2. `src/lib/billing/entitlements.ts:225-241` + `src/components/billing/trial-banner.tsx:48` —
   una cuenta en `trialing` con `manual_hold_at` (retención manual de f4.2) vería a la vez la
   píldora del trial en la cabecera y el aviso de cuenta retenida en la página. Son dos mensajes
   distintos en sitios distintos, no una duplicación del mismo aviso, y el spec no lo contempla;
   lo dejo anotado, no lo exijo.
3. `src/hooks/use-billing-status.ts:120-131` — el efecto solo depende de `accountId`, así que el
   TTL por sí solo no repinta una pestaña ya montada: hace falta un remontaje. En el camino real
   no importa (volver de PayPal es una carga de documento completa, que reinicia la caché de
   módulo), y el propio informe lo declara en su decisión 3. Sin acción.

## Cambios requeridos

Ninguno.
