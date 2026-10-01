# Spec fase 9 — Superadministrador, alta de pago obligatoria y plan ilimitado

**Estado: APROBADA por el humano el 2026-09-30** (decisiones al final).
Rama `feat/superadmin`, worktree `.claude/worktrees/superadmin`, base `main` @ 005f85a.
Pedido por el humano el 2026-09-30.

## Lo que ya existe (fase 4 §2, en producción) y se reutiliza

- `platform_admins` (055) con `is_platform_admin()`, `requirePlatformAdmin()` en `src/lib/auth/platform.ts`
  y el hook `usePlatformAdmin`. Sin semilla: el primer operador se da de alta con SQL.
- Panel en `/platform` y `/platform/[id]` (058): censo de cuentas (`platform_account_list()`), ficha
  con consumo, historial de facturación y números de WhatsApp, **suspender/reactivar** a mano.
- **Impersonación** (`POST /api/platform/impersonate`, cookie firmada, bitácora `impersonation_log`
  con motivo obligatorio ≥10 caracteres, caducidad, banner de soporte y botón de salida). Hoy es
  **solo lectura**: el operador ve la cuenta con rol efectivo `viewer` y el middleware devuelve 403 a
  cualquier POST/PUT/PATCH/DELETE fuera de `/api/platform/`.
- Catálogo `plans` (041/045/059/065): `inicio` 35, `pro` 100, `negocio` 199; `limits` jsonb con
  `null` = ilimitado; `features text[]`; `provider_plan_id_month/_year` de PayPal. Cliente PayPal en
  `src/lib/billing/paypal.ts` (`createProduct`, `createPlan`, `listProducts`, `reviseSubscription`…) y
  el bootstrap del catálogo en `scripts/paypal-bootstrap-catalog.ts` (idempotente, un id por ciclo).
- Prueba gratis: trigger `AFTER INSERT ON accounts` (046) siembra `pro`/`trialing` 14 días; la
  fecha la muestra `TrialBanner`; nada la vence. `getEntitlements()` sin fila resuelve a `pro` trialing.
- Alta: `handle_new_user()` (017) crea cuenta + perfil `owner` para cada usuario nuevo. `/signup` pide
  nombre, correo y contraseña y exige verificar el correo.

Lo que se pide encaja en ese modelo; **no** se crea un segundo sistema de roles. El panel gana una
UI propia, un dashboard, gestión de planes con PayPal, altas manuales, impersonación con escritura y
la puerta de pago obligatoria.

## Features

### s9.1 `platform-shell` — UI propia del superadmin
- Nuevo grupo de rutas `src/app/(platform)/` con **su propio layout** (servidor, `requirePlatformAdmin()`
  + `notFound()` en el layout, no en cada página): cabecera y navegación lateral distintas a las del
  inquilino (Resumen, Cuentas, Planes, Operadores), sin bandeja/contactos/pipelines. Paleta de marca
  (`--cb-*`) con un acento distinto para que se note que no es el CRM.
- Mover `/platform` y `/platform/[id]` de `(dashboard)` a `(platform)` sin cambiar URLs. El ítem
  «Plataforma» de la sidebar del CRM se mantiene como enlace de entrada.
- Tras el login, un `platform_admin` aterriza en `/platform` en vez de `/dashboard` (middleware o
  redirección en `/login`). Su cuenta de inquilino sigue existiendo y puede entrar a `/dashboard`.
- i18n es/en/ko (CP6) para todo lo nuevo; tests de render con las mocks de `platform-panel.test.tsx`.

### s9.2 `platform-dashboard` — Resumen (`/platform`)
- Migración `069_platform_metrics.sql` (solo esta feature; s9.3 usa la 070): función `platform_metrics()` (solo `service_role`, misma
  guarda que `platform_account_list`) que devuelve en un jsonb: cuentas totales y por estado de
  suscripción; altas últimos 7/30 días; **MRR** = Σ de suscripciones `active`/`past_due` con
  `price_usd_month` (o `price_usd_year/12` según ciclo, leído de `subscriptions` — añadir columna
  `billing_cycle text CHECK IN ('month','year')` si no está, rellenada por el webhook de checkout);
  ARR = MRR×12; cuentas comped (`provider = 'manual'`) aparte, **fuera del MRR**; morosos
  (`past_due`, `suspended`); números de WhatsApp conectados; mensajes salientes y entrantes del mes.
- Ruta `GET /api/platform/metrics` y tarjetas + una serie de altas por semana (últimas 12) en el
  Resumen. Sin librerías nuevas de gráficas: barras en CSS/SVG propio (CP5).
- El censo actual pasa a `/platform/accounts`; `/platform` es el Resumen.

### s9.3 `plans-admin` — planes y sincronización con PayPal (`/platform/plans`)
- Listado y edición de `plans`: nombre, precios mes/año, `limits` (formulario por métrica, con
  «ilimitado» = `null`), `features` (checkboxes del inventario real), `is_public`, `sort_order`;
  crear plan nuevo (id slug); no se borran planes con suscripciones (se despublican).
- Rutas `GET/POST /api/platform/plans`, `PATCH /api/platform/plans/[id]`, todas con
  `requirePlatformAdmin()` y rol de servicio (la tabla no tiene política de escritura y así sigue).
- **Sincronizar con PayPal**: botón por plan y ciclo. Reutiliza `createProduct`/`createPlan`/
  `listProducts` del bootstrap (el script queda como está para uso por CLI). Reglas:
  - Ciclo sin `provider_plan_id_*` → se crea el plan en PayPal y se guarda el id.
  - Cambio de precio con id existente → PayPal no permite reescribir un plan con suscriptores: se
    crea un **plan nuevo** en PayPal con el precio nuevo, se sustituye el id en `plans` y el id
    anterior se archiva en `plan_provider_history` (migración `070_plan_provider_history.sql`: plan_id, cycle, provider_plan_id,
    price, replaced_at, replaced_by). Los suscriptores existentes siguen en su plan de PayPal al
    precio antiguo (mismo criterio que la 065); la ficha del plan lo dice.
  - Estado visible por plan: «sin publicar», «sincronizado», «precio desincronizado» (precio en
    `plans` ≠ precio con que se creó el id, guardado en la tabla de historial).
- `PAYPAL_ENV` se muestra en la página (sandbox/live) para no confundir bases.

### s9.4 `platform-provisioning` — crear recursos desde el panel
- **Crear empresa**: nombre + correo del propietario. Se invita al propietario por correo (Supabase
  `auth.admin.inviteUserByEmail` con el rol de servicio); al aceptar, `handle_new_user()` crea su
  cuenta y el panel la renombra. Opcional: plan asignado a mano (ver abajo).
- **Asignar plan a mano** (comped) desde la ficha: elegir plan, `provider = 'manual'`, `status =
  'active'`, sin `provider_subscription_id`; motivo obligatorio y bitácora (`impersonation_log`
  con `action = 'plan_override'`, ampliando el CHECK de la 058 en la migración
  `071_platform_provisioning.sql`, que también guarda las columnas de la empresa que el panel edite). Es lo que pone el plan ilimitado a
  la empresa del humano en producción sin tocar la base a mano.
- **Operadores** (`/platform/operators`): listar `platform_admins`, conceder por correo de un
  usuario existente, revocar (no a uno mismo). Escritura solo con rol de servicio.
- **Añadir miembro** a una cuenta desde su ficha (reutiliza la invitación de la fase 0/`redeem_invitation`).
- Todo con `requirePlatformAdmin()`, filtrado por `account_id`, test de fuga A↔B (CP3).
- **Caché**: `next.config.ts` pone `Cache-Control: public, s-maxage=300` a todo lo que no es `/api`; las
  páginas `/platform*` llevan datos de todos los clientes y deben salir con `private, no-store` siempre
  (hoy solo durante una sesión de soporte). Deuda detectada en la revisión de s9.1; se cierra aquí con test.

### s9.5 `impersonation-write` — soporte con escritura
- Hoy la sesión de soporte es `viewer` y el middleware bloquea mutaciones. Se pasa a rol efectivo
  **`admin`** (no `owner`: no puede borrar la cuenta, transferir propiedad ni tocar facturación/
  PayPal del cliente) y el middleware deja pasar las mutaciones **cuando la cookie de soporte es
  válida**, registrando cada una en `impersonation_actions` (log_id, método, ruta, momento, status; migración
  `072_impersonation_actions.sql`).
- El banner cambia de «solo lectura» a «estás actuando como soporte en <cuenta>»; la bitácora de la
  ficha muestra las acciones de cada sesión.
- Realtime y `use-auth` ya filtran por cuenta efectiva (f4.4); revisar que las rutas que escriben con
  el cliente de sesión del operador usen `getCurrentAccount()` y no `user.id` (la red de regresión de
  `support-session-view.test.ts` se amplía a escrituras).

### s9.6 `paid-onboarding` — sin demos: perfil + PayPal antes de entrar
- Migración `073_no_trial.sql`: `trial_period()` deja de sembrar `trialing`; el trigger de la 046
  siembra `plan_id = 'inicio'`, `status = 'incomplete'` (nuevo valor del CHECK), sin `trial_ends_at`.
  `getEntitlements()` sin fila → `incomplete`, `readOnly`. **Lo entrante nunca se bloquea** (CP11).
- `/onboarding` (dentro de `(dashboard)` pero sin sidebar): paso 1 datos de la empresa (nombre,
  país, teléfono, sector, tamaño) → `accounts` + columnas nuevas en la 073; paso 2 elegir plan y
  ciclo → PayPal (reutiliza `PlanPicker` y `/api/billing/checkout`); paso 3 esperando al webhook
  (`/billing/return` ya existe). Al activarse, entra.
- Puerta: el middleware manda a `/onboarding` a todo usuario cuya cuenta esté `incomplete` o sin
  datos de empresa, salvo: `platform_admins`, cuentas con suscripción `active`/`past_due` en gracia/
  `provider = 'manual'`, y miembros invitados a una cuenta que ya paga (la invitación absorbe la
  cuenta personal, como hoy). `/api/whatsapp/webhook`, `/api/v1`, crons y `/api/platform` exentos.
- Se retira `TrialBanner` y los textos de «prueba» del catálogo/login/signup (i18n es/en/ko).
- Datos existentes: la 073 pasa TODA fila `trialing` a `incomplete` (con `trial_ends_at = NULL`): las
  cuentas que hoy están en prueba ven la puerta de pago en su próximo login. Decisión del humano.

### s9.7 `unlimited-plan-and-seed` — plan ilimitado y semilla local
- Migración `074_plan_ilimitado.sql`: plan `ilimitado` (`is_public = false`, todos los `limits` a
  `null`, todas las features, `price 0`, `sort_order 99`, sin PayPal). Asignación **idempotente** a la
  cuenta cuyo propietario es `brianmpolanco@gmail.com` (`provider = 'manual'`, `active`); si el
  usuario no existe en esa base, 0 filas y no falla. En producción es una sola `db push`.
- `supabase/seed.sql` (lo corre `supabase db reset --local` por defecto; CI usa `--no-seed` y
  `replay-migrations.sh` no lo toca, así que no entra en ninguna compuerta):
  - usuario `brianpolancodisenos@gmail.com` / `bcmp1994` en `auth.users` con `email_confirmed_at`
    (hash con `crypt(..., gen_salt('bf'))`) + fila en `platform_admins`;
  - usuario `brianmpolanco@gmail.com` / `bcmp1994` (solo desarrollo) con la cuenta en
    `ilimitado`/`active`;
  - un cliente de ejemplo en `inicio`/`incomplete` para probar la puerta de pago.
- La contraseña del seed **no se usa en producción**: allí el usuario se crea desde el panel de
  Supabase y la 071 / un `INSERT` en `platform_admins` le da el rol. `docs/security.md` lo documenta.

### s9.8 `invite-accept` — aceptar invitación y fijar contraseña (añadida tras s9.4)
- Hallazgo de s9.4: `auth.admin.inviteUserByEmail` no soporta PKCE y devuelve los tokens en el
  fragmento de la URL (flujo implícito); el cliente de navegador del repo es PKCE y lo rechaza. Además
  no existen `/auth/callback` ni `/reset-password`, aunque `forgot-password` ya redirige a esta última.
  Sin esto, el propietario invitado desde el panel y el miembro invitado por correo aterrizan sin
  sesión y sin contraseña.
- Página `/auth/callback` (o el patrón que documente `@supabase/ssr` para el flujo implícito y PKCE a la
  vez: leer `node_modules/@supabase/ssr` y la doc de Supabase Auth) que establece la sesión desde el
  fragmento o el `code`, y `/reset-password` (fijar/cambiar contraseña con `auth.updateUser`) a la que
  llegan tanto la invitación como la recuperación. Tras fijar contraseña: operador → `/platform`,
  invitado a una cuenta → `/join/<token>` si hay invitación pendiente, resto → onboarding/dashboard.
- Documentar en `docs/docker.md` las URLs de redirección que hay que dar de alta en Supabase Auth.
- Tests de la página (fragmento, `code`, error, sesión ya abierta) y del destino. Sin migración.

### s9.9 `drop-korean` — quitar el coreano (pedida el 2026-09-30)
- `messages/ko.json` entró el 2026-07-12 sin que el humano lo pidiera; CP6 obligaba a paridad es/en/ko y
  cada feature añadía coreano. Decisión del humano: **fuera**. Idiomas: `es` (por defecto) y `en`.
- Borrar `messages/ko.json`; quitar `ko` de `src/i18n/*` (locales, `request.ts`, tipos), del selector de
  idioma si existe, de `next-intl` config y de cualquier `Accept-Language`/cookie de locale; ajustar el
  test de paridad (`src/i18n/messages.test.ts`) y todo test que cargue `ko.json` (grep `ko.json`,
  `'ko'`, `ko:`); `CHECKPOINTS.md` CP6 pasa a «es + en»; `docs/`, `CLAUDE.md`/`AGENTS.md` si lo citan,
  y los agentes de `.claude/agents/*.md` y `.opencode/agent/*.md` que digan «es/en/ko». Sin migración.
- Test: paridad es/en; `ko` no es locale válido (cae a `es`).

### s9.10 `local-font` — fuente local en vez de Google Fonts (pedida el 2026-09-30)
- `src/app/layout.tsx` usa `Inter` de `next/font/google`, que descarga la fuente en cada build; el humano
  prohíbe conexiones externas. Sustituir por `next/font/local` con los woff2 de Inter (variable, latin y
  latin-ext) en `src/app/fonts/`, mismo `variable: --font-sans` y `display: swap`; `layout.test.ts`
  mockea `next/font/local`. Licencia OFL de Inter junto a los archivos. Documentar en `docs/docker.md`
  que el build ya no necesita red. Sin dependencias nuevas. Los archivos los aporta el humano o se
  obtienen con UNA descarga autorizada explícitamente.

### s9.11 `platform-shell-fixes` — dos bugs de la prueba local (2026-09-30)
1. **Scroll de página en `/platform`**: `platform-overview.tsx` pone `className="sr-only"` en el `<table>` de
   datos del gráfico semanal. En un `<table>`, `height:1px`/`overflow:hidden` de `sr-only` no aplican y, al ser
   `position:absolute` sin ancestro posicionado, la tabla (699→979 px medidos) se sale del shell `h-screen
   overflow-hidden` y estira el documento: la página hace scroll y el sidebar se corta. Arreglo: envolver la
   tabla en `<div className="sr-only">` (o `relative` en el contenedor de la tarjeta). Test de que el
   `<table>` no lleva `sr-only` directo / el wrapper sí.
2. **Hydration mismatch de `ModeToggle`**: `useTheme` lee el modo del DOM/localStorage en el cliente; el
   servidor pinta «Sun / Cambiar al modo dark» y el cliente «Moon / … light». El CRM no lo sufre porque
   `DashboardShell` no renderiza la cabecera en servidor (spinner hasta `loading=false`); `PlatformFrame` sí.
   Arreglo en `mode-toggle.tsx`: elegir icono y etiqueta solo tras montar (`useSyncExternalStore` con snapshot
   de servidor, o `mounted` por `useEffect`), con el mismo tamaño de botón para no saltar; o
   `suppressHydrationWarning` NO (esconde el síntoma sin arreglar el texto). Test de que el primer render
   coincide con el del servidor.

### s9.12 `impersonate-no-reason` — entrar sin motivo y sin ruido (pedida el 2026-09-30)
- Decisión del humano: **abrir una sesión de soporte no exige motivo**. La bitácora se conserva íntegra
  (actor, cuenta, momento, caducidad); si el operador no escribe nada, `reason` se rellena con un texto
  fijo («Acceso del operador desde la consola de plataforma»), que cumple el CHECK ≥10 de la 055 sin tocar
  la migración. El motivo **sigue siendo obligatorio** para suspender/reactivar, asignar plan a mano,
  invitar miembros y conceder/revocar operadores.
- UI: en la ficha, el botón «Abrir una sesión de soporte» siempre activo; el campo Motivo pasa a opcional
  para esa acción (texto de ayuda que lo diga) y sigue obligatorio para las demás.
- `PresenceHeartbeat` (`src/components/presence/presence-heartbeat.tsx`) no llama a `touch_presence`
  mientras hay sesión de soporte (la 072 lo bloquea y sale `console.error`). Revisar otros efectos del
  CRM que escriban en el perfil/cuenta del operador durante la sesión (notificaciones leídas,
  preferencias) y silenciarlos igual.

### s9.13 `support-readonly-rpcs` — RPCs de lectura durante el soporte (deuda de s9.12)
- La guarda de cliente de s9.5 («Not available during a support session…») bloquea toda `rpc()` del
  navegador durante la sesión, incluida `filter_contacts_by_tags`, que solo lee. Resultado: el operador no
  puede filtrar contactos por etiqueta mientras ayuda a un cliente.
- Arreglo: lista explícita de RPCs de solo lectura permitidas durante la sesión (derivada de las
  migraciones: funciones `STABLE`/`SELECT` sin escritura, acotadas por `account_id` o por RLS de lectura
  de la 057), y seguir bloqueando las que escriben (`touch_presence`, marcar notificaciones, etc.). Test
  que recorra las `rpc('…')` del código cliente y clasifique cada una (permitida / bloqueada) sin dejar
  ninguna sin decidir.

## Orden y ramas

s9.1 → s9.2 y s9.3 en paralelo (ramas hijas `platform/dashboard`, `platform/plans`) → s9.4 →
s9.5 → s9.6 → s9.7 (semilla al final, cuando el esquema está cerrado). Migraciones 069 (s9.2), 070 (s9.3),
071 (s9.4), 072 (s9.5), 073 (s9.6), 074 (s9.7). s9.8 (sin migración) tras s9.4, antes de s9.6. s9.2 y s9.3 en ramas hijas `platform/dashboard` y `platform/plans` desde
`feat/superadmin` @ 785c3ae; claves i18n en sub-namespaces propios (`Platform.metrics`, `Platform.plans`) y
aserciones de `verify-schema.sql` en bloques propios al final, para que el merge sea trivial.
Implementers en Opus, uno por feature; reviewer en Opus por feature; compuerta completa +
`scripts/replay-migrations.sh` por migración. Merge a `main`, push y `db push` los hace el humano.

## Decisiones del humano (2026-09-30)

1. Impersonación **con escritura** (rol efectivo `admin`, cada mutación en la bitácora) — s9.5.
2. Contraseñas solo en el seed local; en producción el usuario se crea en el panel de Supabase y la
   migración concede `platform_admins` por correo. `brianmpolanco@gmail.com` también lleva
   `bcmp1994` en el seed.
3. Las cuentas hoy en `trialing` pasan a `incomplete` y ven la puerta de pago en su próximo login.
4. «Cualquier recurso» = empresas, propietarios, miembros, planes y operadores desde el panel; el
   resto se hace impersonando con escritura.
5. Cambio de precio: plan nuevo en PayPal, los suscriptores actuales siguen al precio viejo. Sin
   botón de migración.
6. Perfil obligatorio: nombre de empresa, país, teléfono, sector y tamaño del equipo.
