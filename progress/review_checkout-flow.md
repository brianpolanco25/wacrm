# Review — f3.2 checkout-flow (re-revisión tras la corrección)

**Veredicto:** APPROVED

Rango revisado: `d44d68e..e564f47` (`aec16df` + la corrección `e564f47`), worktree
`.claude/worktrees/fase-3` limpio en `e564f47`. 20 archivos, +2685/-16 sobre f3.1.
`package.json`/`package-lock.json` **no** aparecen en el diff.

## Compuerta

Ejecutada por mí en el worktree, no leída del informe:

- `npm run lint` — **verde**: 0 errores, 37 avisos (la línea base exacta; el
  `eslint-disable` muerto se fue con el `try/catch` de `plan-picker`).
- `npm run typecheck` — **verde**.
- `TZ=UTC npm test` — **verde**: 88 archivos, **937** pruebas (+3 sobre las 934 de
  `aec16df`, que son exactamente las tres nuevas). `route.test.ts` solo: 25/25.
- `npm run build` (variables dummy de CI) — **verde**; `/billing` y `/billing/return`
  siguen prerenderizándose.
- `scripts/replay-migrations.sh <worktree>` — **verde**, `ok 048…`, `ok 049…`,
  `verify-schema.sql: OK`. Idempotencia comprobada por mí reaplicando **049 dos veces**
  y **048** sobre la base ya migrada: exit 0 y `verify-schema.sql: OK` después.
- `progress/checks_checkout-flow.sql` — **ejecutado por mí** contra el contenedor del
  harness: `BEGIN/DO/ROLLBACK ×5`, exit 0, partes A–E.

### Controles negativos que corrí yo (no del informe)

| Mutación en la base migrada | Resultado |
| --- | --- |
| reaplicar `019_invitation_rpcs.sql` (deshace 049) + parte E | `ERROR: an abandoned checkout blocked the invitation: 23503 … "checkout_intents_account_id_fkey"` |
| ídem + `verify-schema.sql` | `ERROR: redeem_invitation() does not handle checkout_intents; the RESTRICT FK of 048 will break invitation redemption (migration 049)` |
| restaurar 049 → checks + verify-schema | verde otra vez (`schema verification passed`) |

O sea: la parte E y la aserción de CI son detectores reales, no decoración.

## Los seis cambios requeridos, uno a uno

1. **FK `RESTRICT` vs `redeem_invitation()`** — **cerrado**.
   `049_redeem_invitation_checkout_intents.sql`, `CREATE OR REPLACE`, idempotente.
   Dif del cuerpo contra 019: **solo** las dos líneas esperadas —
   `UNION ALL SELECT 1 FROM checkout_intents WHERE account_id = … AND status <> 'pending'`
   en la comprobación de vacío (049:134-135) y
   `DELETE FROM checkout_intents … AND status = 'pending'` antes del `DELETE FROM accounts`
   (049:159-160). Nada más cambió del cuerpo de 019 (verificado con `diff` de las dos
   definiciones). Aserción nueva en `verify-schema.sql:148-158` (`prosrc … LIKE '%checkout_intents%'`),
   que yo hice fallar con la mutación de arriba. Caso en base real: parte E con los tres
   escenarios (control, `pending` → acepta y la fila se va con la cuenta, `activated` →
   23505 y la cuenta, el intento y la invitación siguen en pie), ejecutada por mí.
   Comentario de `048:68-87` corregido y **exacto**: comprobé que `041` de esta rama sigue
   con `ON DELETE CASCADE` en 041:61 y 041:84 y que `324f087` de `saas/fase-0-cimientos`
   es el que los pasa a `RESTRICT`. La FK se mantiene `RESTRICT` por decisión del líder:
   no lo reabro.
2. **Fallar cerrado al no poder leer `subscriptions`** — **cerrado**.
   `route.ts:88-98` define `SubscriptionReadError`; `loadSubscription` (`route.ts:116-121`)
   lanza en vez de devolver `null`, y la llamada de `POST` (`route.ts:217`) ocurre **antes**
   de `createSubscription` (`route.ts:232`), así que el 500 sale sin tocar PayPal.
   Test leído: `route.test.ts` › «500s instead of contracting when the subscription cannot
   be read» — `selectFailure = 'subscriptions'`, y afirma las tres cosas:
   `status === 500`, **`expect(createSubscription).not.toHaveBeenCalled()`** y
   `db.checkout_intents` vacío. Es detector: con el código viejo `null` →
   `alreadyContracted(null) === false` → se llamaría a PayPal y el test caería.
3. **`activated` sin intento que lo respalde** — **cerrado**. `route.ts:376-379`:
   `matchesAttempt = intent ? sub?.provider_subscription_id === intent.provider_subscription_id : !subscriptionId`.
   Test leído: › «does not call an attempt we never recorded activated» (suscripción
   `active` por `I-PREVIOUS`, `?subscription_id=I-UNKNOWN` → `intent: null`,
   `activated: false`). Con la condición vieja (`!intent || …`) daba `true`: detector.
4. **Rechazo de `load()` en `plan-picker.tsx`** — **cerrado**. `plan-picker.tsx:62-78`:
   `fetch` + `res.json()` dentro de `try/catch`, `!res.ok` convertido en `throw`, y el
   `catch` hace `toast.error` + `setPlans([])` (mismo trato). Sin test automático: el repo
   no tiene jsdom ni testing-library y CP5 prohíbe añadirlas; cubierto por `typecheck`,
   lectura del diff y paso 11 del guion manual. Aceptado.
5. **Nombre del plan en `Billing.return.activeBody`** — **cerrado**. `GET` devuelve
   `planName` (`route.ts:381-383`, `loadPlanName` en 322-345, lectura del catálogo público
   sin ámbito de cuenta porque `plans` no tiene `account_id` y su política es
   `FOR SELECT TO authenticated USING (true)`, 041:116-119); `checkout-return.tsx:62-69`
   lo usa con fallback a `planId`. Test leído: › «reports the plan by name, not by id»
   (`planId: 'pro'`, `planName: 'Pro'`).
6. **Informe** — **cerrado**. Dice 26 claves y son **26** (contadas por mí: `en.json` y
   `ko.json`, 1495 claves cada uno, 0 huérfanas en cualquier sentido, 26 bajo `Billing`,
   0 cadenas coreanas idénticas al inglés). La deuda `middleware.ts` → `proxy.ts` está
   anotada en «Deuda detectada fuera de alcance» con la cita de
   `01-app/02-guides/upgrading/version-16.md:625-648`, sin tocar el archivo.

## Trazabilidad criterio ↔ test

Los criterios de §2 ya trazados en la revisión anterior siguen cubiertos por los mismos
tests (el diff de la corrección no borró ni debilitó ninguno; las dos únicas líneas tocadas
del mock, `if (op === 'insert' || res.error) return res;` en `single`/`maybeSingle`, solo
propagan el error inyectado). Repaso de lo que cambió o quedaba abierto:

- C «§2.1–4 elegir plan, crear la suscripción, devolver el enlace»: [x]
  `route.test.ts` › «creates the PayPal subscription and hands back its approval link» +
  `paypal.test.ts` › «posts the plan with our correlation id and returns the approval link».
- C «La URL de retorno no activa nada»: [x] › «activates nothing by being called»,
  › «does not touch subscriptions — only the webhook activates», › «exposes only POST and
  GET»; reforzado ahora por › «does not call an attempt we never recorded activated».
- C «Sin prorrateo / no abrir una segunda suscripción»: [x] › «409s instead of opening a
  second paid subscription», › «lets a trialing account contract», `checkout.test.ts`
  `alreadyContracted` (3), **y ya sin la reserva del hallazgo 2**: › «500s instead of
  contracting when the subscription cannot be read».
- C «`account_id` del contexto, nunca del cuerpo» / aislamiento (CP3): [x] › «ignores an
  account_id supplied by the caller», › «keeps two accounts checking out at once apart»,
  › «never shows another account its checkout», › «reuses the intent when PayPal replays…»;
  parte A del SQL, ejecutada.
- C «Idempotencia del `PayPal-Request-Id`»: [x] `checkout.test.ts` (ventana de 10 min, sin
  colisiones entre cuentas) + parte B en base real.
- C «Aceptar una invitación no se rompe por el checkout» (nuevo, de la corrección): [x]
  `progress/checks_checkout-flow.sql` parte E + `verify-schema.sql`, ejecutados por mí.
- C «Todo el flujo probado en el sandbox de PayPal»: [~] guion manual de 12 pasos
  (incluye la trampa del paso 6 y los pasos 11 y 12 de la corrección). Correcto para esta fase.
- C «Cerrar el navegador tras aprobar activa igualmente»: [~] la mitad de f3.2 está probada
  (intento registrado + `custom_id = account_id`); la otra mitad es f3.3.

## Checkpoints

- CP1 Compuerta: [x] verde, ejecutada por mí (lint/typecheck/test/build + replay).
- CP2 Migraciones: [x] 048 y 049, números fijados por el líder, idempotentes (reaplicadas
  por mí), 6+1 aserciones en `verify-schema.sql`, replay 0, ningún `CASCADE` nuevo. El
  hallazgo 1 de la revisión anterior queda cerrado por 049 y verificado en base real.
- CP3 Aislamiento: [x] las únicas consultas con `supabaseAdmin()` son el insert
  (`route.ts:261-272`, `account_id: ctx.accountId`) y la relectura 23505
  (`route.ts:285-290`, `.eq('account_id', ctx.accountId)`). `loadPlanName` usa
  `ctx.supabase` (RLS) sobre `plans`, tabla sin `account_id`. Tests de fuga leídos.
- CP4 Tests: [x] cada cambio requerido con test o SQL leído por mí; base real ejecutada.
- CP5 Dependencias: [x] `package.json` intacto.
- CP6 i18n: [x] paridad total en/ko (1495 claves cada uno), 26 bajo `Billing`, sin claves
  nuevas en la corrección.
- CP7 Next 16: [x] `Suspense` por `useSearchParams` correcto (el build prerenderiza las dos
  páginas). La deprecación `middleware.ts` → `proxy.ts` es preexistente y ahora está
  anotada como deuda en el informe, que es lo que pedía el hallazgo 6.
- CP8 Alcance: [x] lo añadido por la corrección (049, route, dos componentes,
  verify-schema, CHANGELOG) lo justifica el rechazo anterior; `019` **no** se editó.
- CP9 Documentación: [x] `CHANGELOG.md` con el aviso de aplicar 049 junto con 048 y dos
  entradas en «Fixed»; informe actualizado y fiel al diff.
- CP10 Git: [x] dos commits en `saas/fase-3-facturacion`, en español con prefijo y
  `Co-Authored-By`; nada pusheado; `main` y `feat/saas-multiempresa` intactos.
- CP11 Entrante: [x] no aplica.

## Hallazgos (archivo:línea) — ninguno bloqueante

1. `supabase/migrations/049_redeem_invitation_checkout_intents.sql:134` — **deuda de
   merge, no de esta feature.** Cuando entre `324f087` de fase 0, `subscriptions` y
   `usage_counters` pasarán también a `ON DELETE RESTRICT` y tendrán exactamente el mismo
   choque con `redeem_invitation()` que 049 acaba de cerrar para `checkout_intents`; la
   lista de «¿está vacía?» (049:122-137) no las incluye. Hoy es inofensivo (nada escribe
   esas tablas en esta rama: `increment_usage` no tiene un solo llamador en `src/`, y una
   fila en `subscriptions` implica un intento no `pending`, que 049 ya rechaza con 23505).
   **Pero f3.4, cuando empiece a contar consumo, tiene que ampliar esa lista o volverá el
   23503.** Para el líder, no para el implementer de f3.2.
2. `supabase/migrations/049_…sql:122-160` — carrera estrecha y benigna: entre la
   comprobación `status <> 'pending'` y el `DELETE … status = 'pending'`, el webhook (rol
   de servicio) podría mover el intento a `activated`; el `DELETE FROM accounts` daría
   entonces 23503 y **toda** la redención haría rollback. Falla cerrado y no pierde datos;
   solo quedaría un error crudo en un caso de milisegundos. No merece bloquear.
3. `src/app/api/billing/checkout/route.ts:381-383` — `loadPlanName` se ejecuta en **cada**
   sondeo del `GET` en cuanto existe fila en `subscriptions`, aunque `activated` sea
   `false` y el nombre no se use. Una fila por 4 s por pestaña; nit de eficiencia.
4. `src/components/billing/plan-picker.tsx:66-77` — el `catch` unifica «respuesta
   rechazada», «sin red» y «JSON inválido» bajo el mismo `loadFailed`. Es lo que se pidió;
   se anota solo porque el mensaje ya no distingue un 500 del servidor de estar sin red.

## Cambios requeridos

Ninguno.

## Nota de procedimiento

Lancé el skill `code-review` a nivel `high` sobre `d44d68e..e564f47`; no devolvió resultado
dentro de esta sesión. La revisión de código de arriba es manual y propia: diff completo de
`e564f47` leído línea a línea, `diff` de las dos definiciones de `redeem_invitation()`,
lectura de los tres tests nuevos, y los controles negativos en base real listados en la
compuerta.
