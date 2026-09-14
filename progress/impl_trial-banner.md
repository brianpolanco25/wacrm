# Implementación: p6.2 `trial-banner`

- **Rama:** `saas/producto` (worktree `.claude/worktrees/producto`, base `e76954c`)
- **Spec:** `progress/spec_producto.md` §2 «Banner del tiempo restante del trial»
- **Estado:** compuerta verde, pendiente de revisión.

## Commits

| SHA | Mensaje |
|---|---|
| `aed1d3b` | `feat: avisar en la cabecera cuánto queda de prueba` |

Árbol limpio tras el commit. Nada pusheado; `main`, `dev` y `feat/saas-multiempresa` intactos.

## Compuerta

| Paso | Resultado |
|---|---|
| `npm run lint` | 0 errores, 35 warnings (los mismos 35 preexistentes; ninguno en archivos tocados) |
| `npm run typecheck` | limpio |
| `TZ=UTC npm test -- --reporter=dot` | 147 archivos, 1 984 tests, todos verdes |
| `npm run build` | `✓ Compiled successfully`, 64 páginas |

Sin SQL en el diff → `replay-migrations.sh` no aplica (CP2 vacío).

## Qué hace

Mientras la suscripción de la cuenta está en `trialing`, la cabecera del dashboard muestra una
píldora ámbar a la izquierda del conmutador de tema: «Trial ends in N days», «Trial ends today»
cuando queda menos de un día, enlazada a `/billing`. La ve **todo** miembro de la cuenta
(owner, admin, agent y viewer). Desaparece en cuanto la cuenta deja de estar `trialing`: al
contratar, y también cuando la prueba caduca y la cuenta baja por la escalera de la fase 3 —
ahí el aviso lo da `BillingStatusAlert`, y dos carteles sobre lo mismo es uno de más.

## Archivos

| Archivo | Qué es |
| --- | --- |
| `src/lib/billing/trial.ts` | `trialNotice(status, trialEndsAt, now)`: toda la aritmética, pura |
| `src/lib/billing/trial.test.ts` | 8 casos de esa aritmética |
| `src/hooks/use-billing-status.ts` | el fetch de `/api/billing/status` con caché por cuenta, extraído de `billing-status-alert.tsx` |
| `src/hooks/use-billing-status.test.ts` | una petición por cuenta, clave por cuenta, TTL, fallo = desconocido |
| `src/components/billing/trial-banner.tsx` | la píldora |
| `src/components/billing/trial-banner.test.tsx` | los tres criterios del spec + a11y + coreano |
| `src/components/billing/billing-status-alert.tsx` | ahora lee del hook compartido en vez de su propio `fetch` |
| `src/components/layout/header.tsx` | monta `<TrialBanner />` (2 líneas + comentario) |
| `messages/en.json`, `messages/ko.json` | `Billing.trialEndsIn`, `Billing.trialEndsToday`, `Billing.trialChoosePlan` |
| `CHANGELOG.md` | entrada en Unreleased → Added |

Sin dependencias nuevas (CP5). Sin migraciones. Sin variables de entorno nuevas (CP9: nada que
añadir a `docs/docker.md`; `.env.local.example` no se tocó — está bloqueado por permisos y
tampoco hacía falta).

## De dónde sale `trial_ends_at`, y por qué por ahí

El spec pide leerlo «por el mismo camino que la pantalla de suscripción (f3.5), sin consulta
nueva por página». f3.5 dejó **dos** lecturas de la suscripción, y solo una sirve aquí:

- `GET /api/billing/subscription` — el panel de Ajustes → Suscripción. Está detrás de la
  sección `adminOnly` del raíl: un `agent` o un `viewer` recibe 403. Es exactamente a quien va
  dirigido el contador (el agente es el que se encuentra con que no puede enviar), así que no.
- `GET /api/billing/status` — creada en f3.5/§5 para el banner de morosidad, **abierta a
  cualquier miembro** (`getCurrentAccount`, sin suelo de rol), filtrada por `ctx.accountId`
  sobre RLS, y resuelve el estado por `getEntitlements` —la misma capa con la que el servidor
  aplica la escalera—. Devuelve `status` y `trialEndsAt` y ninguna cifra de dinero ni id de
  proveedor. Es esta.

Para que el banner no añada una petición por página, el `fetch` que `BillingStatusAlert` tenía
en su `useEffect` se convirtió en `use-billing-status.ts`, calcado de `use-ai-account-status.ts`
(f1.3): caché de módulo **con clave por `accountId`**, deduplicación de peticiones en vuelo y
TTL de 30 s. El aviso de morosidad y el contador de la cabecera montan en el mismo commit de
React y entre los dos cuestan **una** llamada a `/api/billing/status` por cuenta.

Descartado ampliar el resumen de cuenta de `use-auth` (`fetchAccountSummary`): `accounts` y
`subscriptions` son tablas distintas, así que habría sido una segunda consulta igual, pero
además desde el navegador y por PostgREST, duplicando en el cliente la lógica de
`getEntitlements` que el servidor ya tiene resuelta. El hook compartido cuesta lo mismo y no
duplica reglas.

## Decisiones donde el spec era ambiguo

1. **Redondeo de los días: hacia arriba.** El spec fija los extremos («N días», «hoy» con menos
   de un día) pero no el medio. Con `Math.floor`, una prueba de 14 días leería «13 días» un
   milisegundo después de crearse — mal en el único momento en que todo el mundo mira. Con
   `Math.ceil` el error máximo es de unas horas de optimismo a mitad de prueba. Va `ceil`, y
   por debajo de 24 h el número se sustituye por «hoy». Consecuencia: la serie va 3 → 2 → hoy;
   el singular «1 day» solo sale en el instante exacto de las 24 h, pero la forma plural ICU
   está en el catálogo y hay test que la fija.
2. **`trialing` sin `trial_ends_at`** (la columna es nullable): no se muestra nada. No hay
   fecha que prometer y no se inventa una.
3. **El reloj viaja con el dato (`readAt`).** React 19 prohíbe llamar a `Date.now()` en el
   render y el lint del compilador lo caza («Cannot call impure function during render»). En
   vez de meter el reloj en un `useEffect` —que habría hecho el componente intestable con
   `renderToStaticMarkup`, el único método de render que hay en este repo— el `fetch` sella
   cada snapshot con el instante en que llegó y el banner es función pura de su entrada.
   Efecto secundario conocido: una pestaña abierta durante horas conserva el número con el que
   se pintó hasta el siguiente montaje. Es granularidad de día y el aviso de morosidad de al
   lado ya se comportaba así.
4. **Sitio dentro de la cabecera:** píldora compacta en el grupo de la derecha, no franja a
   ancho completo. La franja sobre la cabecera está reservada a `ImpersonationBanner`, que
   avisa de algo de otra naturaleza (estás mirando datos ajenos). En pantallas estrechas se
   oculta el «Choose a plan» y se conserva la cuenta atrás, que es lo que informa.
5. **`role="status"` + `aria-live="polite"`** como el precedente de `impersonation-banner.tsx`:
   aparece sin recargar la página, así que hay que anunciarlo.

## Criterios ↔ tests

| Criterio del spec | Test | Archivo |
| --- | --- | --- |
| `trialing` + `trial_ends_at` a 5 días → «5 días» y enlace a `/billing` | `counts the days left and links to /billing while trialing` | `src/components/billing/trial-banner.test.tsx` |
| `active` → sin banner | `renders nothing once the account contracted a plan` | idem |
| `trialing` vencido sin procesar → «hoy» | `says "today" when the trial ran out but the row still says trialing` | idem |
| Textos en los dos catálogos (CP6) | `is translated, not English with a Korean shell (CP6)` | idem |
| — (refuerzos) | `renders nothing while the status is unknown`, `renders nothing on any rung of the dunning ladder`, `announces itself to assistive technology`, `uses the ICU singular on the exact one-day boundary (en)` | idem |
| Aritmética de los días | `counts the days left…`, `rounds up to the whole day…`, `says "1 day" on the last full day`, `says "today" with less than a full day left`, `still says "today" when the deadline already passed…`, `says nothing once the account contracted a plan`, `says nothing on the %s rung…` (4 estados), `says nothing when there is no account, no status or no deadline` | `src/lib/billing/trial.test.ts` |
| «sin consulta nueva por página» | `hits the endpoint once per account, however many banners ask` | `src/hooks/use-billing-status.test.ts` |
| Aislamiento del dato en el cliente | `keys the cache by account, so a support session never reuses the other company` | idem |
| El banner se va solo al contratar | `re-reads after the TTL, so contracting a plan drops the banner on its own` | idem |
| Fallo de red no inventa estado | `resolves to unknown — not to a state — when the read fails`, `does not cache a failure: the next mount retries` | idem |
| El sello de reloj | `stamps the snapshot with the clock it was read at` | idem |

Paridad de catálogos: `src/i18n/messages.test.ts` (verde) — las tres claves nuevas están en
`en.json` y `ko.json`.

## CP3 — aislamiento

El diff no añade ninguna consulta con `supabaseAdmin()`. La única lectura es
`GET /api/billing/status`, que ya existía: cliente SSR con RLS del usuario **y** filtro
explícito `.eq('account_id', ctx.accountId)`. En el navegador, la caché del hook está indexada
por `accountId` y ese id es el efectivo (`useAuth().accountId`), es decir el de la cuenta
impersonada durante una sesión de soporte — mismo criterio que el resto del panel desde la 057.
Test de no-reutilización entre cuentas: `keys the cache by account…`.

## CP11 — lo entrante nunca se bloquea

El diff solo toca componentes de cliente y un hook de cliente. Ninguna ruta de webhook, ningún
guardia de escritura.

## Verificaciones manuales pendientes

Ninguna que dependa de Meta o PayPal. Dos comprobaciones visuales que ningún test estático
cubre (no hay jsdom ni e2e en el repo), con guion:

1. **Se ve y enlaza.** Con una cuenta en prueba (las semillas de `046_seed_trials.sql` dejan
   una), `npm run dev` → entrar al dashboard → la píldora ámbar aparece a la izquierda del
   conmutador de tema y al pulsarla se llega a `/billing`. Estrechar la ventana por debajo de
   `sm`: la cuenta atrás sigue visible, el «Choose a plan» desaparece, y ni el título de página
   ni el menú de cuenta se desbordan.
2. **Se va al contratar.** Completar el checkout de un plan en local; volver al dashboard y
   esperar 30 s (el TTL) o navegar con recarga: la píldora ya no está, y no la sustituye ningún
   otro aviso mientras la suscripción esté sana.

## Deuda detectada, no arreglada

- `src/components/layout/header.tsx` no está formateado según el prettier del repo (comillas
  dobles, clases de Tailwind sin ordenar): pasarle `prettier --write` produce un diff de ~180
  líneas. Se **revirtió** ese reformateo y la edición quedó en 5 líneas, para no esconder la
  feature dentro de un cambio de estilo (CP8). El archivo entero pide una pasada de formato en
  un commit aparte; el mismo caso, mucho más pequeño, hay en `billing-status-alert.tsx`, donde
  prettier sí reflujo tres líneas del ternario que ya estaban dentro de mi diff.
- `src/i18n/messages.test.ts` solo compara **claves**, no marcadores ICU. `trialEndsIn` usa
  plural en inglés y no en coreano (que no tiene formas plurales), lo cual es correcto, pero
  nada impide que una futura traducción pierda un `{days}`. p6.4 amplía ese test para `es`
  según el spec; añadir ahí la comprobación de placeholders sería el momento.
- El contador no se refresca solo en una pestaña abierta muchas horas (ver decisión 3). Si
  alguna vez importa, el arreglo es un `setInterval` horario en el hook, no en el componente.

---

## Ronda de estilo (pedida por el humano)

**Petición:** «el banner de trial no se ve bien en tema oscuro y el color no va con el del
tema». Cambio acotado a los colores de `trial-banner.tsx`; lógica, textos, tamaño y forma
intactos.

**Plan:** (1) confirmar cómo se selecciona el modo oscuro en este repo; (2) cambiar los ámbar
fijos por los tokens de acento (`primary-soft`, `primary-soft-2`, `primary`) y neutros
(`foreground`) de `globals.css`, siguiendo la convención que ya usan otras píldoras; (3) test
de regresión que fije el criterio; (4) compuerta; (5) CHANGELOG y este informe.

### Qué cambió

`src/components/billing/trial-banner.tsx`, solo colores (tamaño, forma redondeada, textos,
lógica, `role`/`aria-live` y el recorte en `sm` intactos):

| Antes | Ahora |
|---|---|
| `border-amber-500/40` | `border-primary-soft-2` |
| `bg-amber-500/15` | `bg-primary-soft` |
| `hover:bg-amber-500/25` | `hover:bg-primary-soft-2` |
| `text-amber-900 dark:text-amber-100` | `text-foreground` |
| icono sin color | `text-primary` |

Es el mismo vocabulario que la píldora `admin` de `src/components/settings/settings-chip.tsx`
(`border-primary-soft-2 bg-primary-soft`), que tiene exactamente esta forma y tamaño.

### Las dos causas del problema

1. **El ámbar no era del tema.** El acento es una elección por cuenta y hay cinco
   (`violet` por defecto, `emerald`, `cobalt`, `amber`, `rose`, en `globals.css`). Un ámbar fijo
   chocaba con cuatro de los cinco. El ámbar venía copiado de la franja de impersonación, donde
   sí es semántico (aviso), no decorativo.
2. **`dark:` está muerto en este repo.** `globals.css` declara
   `@custom-variant dark (&:is(.dark *))`, pero **nadie pone la clase `.dark`**: el modo se
   selecciona con `data-mode` en `<html>` (script de arranque de `src/app/layout.tsx`, líneas
   66-75, y `src/hooks/use-theme.tsx`). O sea, `dark:text-amber-100` no se aplicaba nunca y en
   modo oscuro el texto quedaba en `text-amber-900` (casi negro) sobre la cabecera oscura. Esa
   es la mitad «no se ve bien» de la queja. Los tokens no tienen ese problema: los redefine el
   propio bloque de modo.

### Decisión donde el encargo era ambiguo

El encargo proponía «texto `text-foreground` con el icono **y el enlace** en `text-primary`»
y `border-border`. Me desvié en dos puntos, con medida:

- **El «Choose a plan» se queda en `text-foreground`** (con su subrayado, que es lo que lo
  marca como enlace). Calculé el contraste WCAG real de `--primary` sobre el relleno
  `--primary-soft` (12 % del acento compuesto sobre `--background`) para los cinco acentos por
  los dos modos: va de **2,13:1** (amber en claro) a 5,34:1, con **2,58:1 en el defecto**
  (violet + oscuro). Texto de 12 px pide 4,5:1. Con `--foreground` ningún par baja de
  **10,10:1**. Script en
  `/tmp/.../scratchpad/contrast.py`, reproducido en la tabla de abajo. El icono sí conserva
  `text-primary`: es decorativo (la cuenta atrás dice lo mismo en palabras), así que le aplica
  el umbral de no-texto, y es el toque de acento que pedía la queja junto al relleno y el borde.
- **Borde `border-primary-soft-2` en vez de `border-border`**, para que la píldora sea la misma
  que la del chip `admin` y el acento se lea también en el contorno. `border-border` también
  funcionaba; esto es convención existente del repo.

| modo | acento | `text-foreground` sobre la píldora | `text-primary` sobre la píldora |
|---|---|---|---|
| oscuro | violet (defecto) | 15,10 | 2,58 |
| oscuro | emerald | 11,93 | 3,79 |
| oscuro | cobalt | 13,28 | 3,28 |
| oscuro | amber | 10,10 | 4,49 |
| oscuro | rose | 12,55 | 3,56 |
| claro | violet | 15,50 | 5,34 |
| claro | emerald | 15,80 | 2,93 |
| claro | cobalt | 15,65 | 3,74 |
| claro | amber | 16,06 | 2,13 |
| claro | rose | 15,73 | 3,27 |

### Criterio ↔ test

| Criterio | Test |
|---|---|
| El color sale de los tokens del tema, no de un ámbar fijo | `src/components/billing/trial-banner.test.tsx` → `it('is painted with the theme tokens, not a hardcoded accent')` (exige `bg-primary-soft` y `text-foreground`, prohíbe `amber` y cualquier `dark:`) |
| Nada de la lógica ni de los textos cambió | Los 8 `it` previos del mismo archivo siguen verdes sin tocarlos |

### Verificación contra artefacto real (no hay base de datos en juego)

Sin SQL en el diff → `replay-migrations.sh` no aplica. En su lugar comprobé que las cuatro
utilidades **existen de verdad** en el CSS que emite el build (Tailwind 4 las genera desde el
`@theme inline` de `globals.css`; una clase inventada no habría dado error en ningún paso de la
compuerta):

```
.bg-primary-soft{background-color:var(--primary-soft)}
.border-primary-soft-2{border-color:var(--primary-soft-2)}
.hover\:bg-primary-soft-2:hover{background-color:var(--primary-soft-2)}
.text-primary{color:var(--primary)}
```

### Compuerta (ronda de estilo)

| Paso | Resultado |
|---|---|
| `npx prettier --check` (3 archivos tocados) | limpio |
| `npm run lint` | 0 errores, 35 warnings (los mismos 35 preexistentes) |
| `npm run typecheck` | limpio |
| `TZ=UTC npm test -- --reporter=dot` | 151 archivos, 2 066 tests, todos verdes |
| `npm run build` | `✓ Compiled successfully` |

### Verificación manual pendiente

Una, visual, que ningún test estático cubre (no hay jsdom ni e2e):

1. `npm run dev`, entrar al dashboard con una cuenta en prueba. Con el conmutador de la
   cabecera, alternar claro/oscuro: la píldora se lee en los dos y el relleno se tiñe del
   acento. En Ajustes → Apariencia, recorrer los cinco acentos: la píldora cambia de color con
   ellos y en ninguno se pierde la cuenta atrás. Estrechar por debajo de `sm`: sigue sin
   desbordar la cabecera.

### Deuda detectada, no arreglada (ronda de estilo)

- **Toda utilidad `dark:` del repo es código muerto**, por lo mismo que se explicó arriba: el
  modo va por `data-mode`, no por la clase `.dark` que espera `@custom-variant`.
  `grep -ro "dark:[a-zA-Z0-9/_.[-]*" src | wc -l` da **51 ocurrencias en 17 archivos**; cada
  una es un par de colores del que solo se aplica la mitad clara. Fuera de alcance aquí, pero es un barrido que
  merece su propia tarea: o se añade `dark` a `classList` junto a `data-mode`, o se cambia el
  `@custom-variant` a `&:is(html[data-mode="dark"] *)`, que arregla las doscientas de una vez.
- `src/components/settings/settings-chip.tsx` y `src/components/settings/settings-rail.tsx`
  pintan `text-primary` sobre `bg-primary-soft`: el mismo ~2,6:1 del defecto que evité aquí.
  Son etiquetas cortas y no las toco, pero si alguna vez se audita el contraste, están ahí.
- `settings-chip.tsx` documenta que los ámbar/esmeralda de estado son «semánticos, a propósito
  no tokenizados». Es defendible para «ok/warn»; lo que no encajaba era usarlos para algo que
  no es un estado de alerta, como esta cuenta atrás.

### Commit (ronda de estilo)

| SHA | Mensaje |
|---|---|
| `d9eef86` | `fix: teñir el aviso de prueba con el acento del tema` |
