# f4.3 — `platform-admins-panel`

Spec: `docs/saas/fase-4-plataforma.md` §2 «Panel de plataforma».
Rama `saas/fase-4-plataforma`, worktree `.claude/worktrees/fase-4`.

La sesión hizo dos cosas: terminar el merge de `saas/integracion` que el líder
dejó a medias (tarea A) y construir el panel (tarea B).

## Commits

| SHA | Qué |
|---|---|
| `5ee13d5` | `Merge branch 'saas/integracion' into saas/fase-4-plataforma` — tarea A |
| `47a091c` | `feat: suspender y reactivar a mano una cuenta, con bitácora` — migración 058, capa de facturación, rutas |
| `1b989f4` | `test: fijar el panel de plataforma y la suspensión manual` |
| `1ff573c` | `feat: dar al operador un panel para ver, suspender e impersonar` — UI, i18n, docs |

Nada pusheado. `main`, `dev` y `feat/saas-multiempresa` intactos. Árbol limpio.

## Compuerta (ejecutada entera tras el último commit)

| Paso | Resultado |
|---|---|
| `npm run lint` | 0 errores, 35 avisos (todos preexistentes) |
| `npm run typecheck` | limpio |
| `TZ=UTC npm test` | 138 archivos, **1871 tests**, verdes (antes del merge: 132 / 1783) |
| `npm run build` | compila; 63 páginas; aparecen `ƒ /platform`, `ƒ /platform/[id]`, `ƒ /api/platform/accounts`, `…/[id]`, `…/[id]/hold`, `ƒ /api/platform/me` |
| `scripts/replay-migrations.sh` | desde limpio: salida 0, 001→058, `verify-schema.sql: OK` |
| `progress/checks_platform-admins-panel.sql` | 6 bloques `OK` contra el Postgres del harness |

---

# Tarea A — el merge (`5ee13d5`)

`git merge saas/integracion` (HEAD `09f71ba`, fases 0–3 + f4.2) sobre `7533aae`
(f4.4 aprobada). Seis conflictos `UU`, todos resueltos **conservando los dos
lados**.

## Qué hizo cada resolución

| Archivo | Lado f4.4 conservado | Lado integración conservado |
|---|---|---|
| `src/lib/auth/account.ts` | `impersonatedContext`, `resolveSupportSession`, `IMPERSONATED_ROLE`, el mensaje «read-only» de `requireRole` | `assertWritable` + `RequireRoleOptions.allowReadOnly` + `billingErrorPayload` en `toErrorResponse` |
| `src/app/(dashboard)/dashboard-shell.tsx` | `ImpersonationBanner` fuera del área de scroll, con su `<div>` envolvente | `BillingStatusAlert` dentro del `<main>`, bajo `AccountAccessAlert` |
| `src/app/(dashboard)/inbox/page.tsx` | `accountId` de `useAuth`, filtro `.eq('account_id')` al hidratar una conversación, `accountId` en `useRealtime` | la consulta de números conectados de f4.2 (`.eq('status','connected').limit(1)`) y la desaparición del rodeo por `profiles` |
| `src/components/settings/settings-overview.tsx` | los cuatro conteos filtrados por `account_id` (la 057 los hizo necesarios) | el `count` sobre `whatsapp_config` de f4.2, que ya venía fusionado solo |
| `src/lib/security/tenant-isolation.test.ts` | waivers de `platform_admins` y del barrido de `impersonation_log` | waiver de `plans` |
| `supabase/ci/verify-schema.sql` | aserciones de 055 y 057 | aserciones de 045–053 y 056 |

**La trampa del `verify-schema.sql`**: el corte del conflicto caía **dentro de un
`IF`** — el lado de f4.4 terminaba en su `RAISE EXCEPTION` y el `END IF;`
posterior era línea común. Unir los dos lados sin más deja un `IF` abierto y un
archivo que no compila. Se cerró a mano. Resultado: un solo bloque `DO` (el
archivo debe contener exactamente una sentencia) con `IF`/`END IF` balanceados,
83/83.

**Formato**: `settings-overview.tsx` se pasó por prettier (solo cambió el bloque
en conflicto; el resto del archivo ya estaba formateado). `account.ts`,
`dashboard-shell.tsx` e `inbox/page.tsx` **no**: f4.4 los escribió con comillas
dobles a propósito y pasarlos por prettier habría metido ~200 líneas de churn
ajeno (CP8). En `inbox/page.tsx` sí se normalizaron a comillas simples las
líneas que venían del lado de f4.4, porque el resto del archivo usa simples y
mezclarlas dentro de la misma función era peor.

## El test que tuvo que ceder

`src/lib/auth/account-impersonation.test.ts` probaba `requireRole('owner')`
**fuera** de una sesión de soporte. Tras la fase 3 eso llama a `assertWritable`,
que llama a `getEntitlements`, que construye un cliente de Supabase real → murió
con `supabaseUrl is required`. Se dobla `@/lib/billing/enforce` como hace
`account.test.ts`, **y además se registra la cuenta por la que pregunta**, con
dos aserciones nuevas:

- dentro de la sesión, `requireRole('agent'|'admin'|'owner')` se rechaza por
  «solo lectura» **antes** de consultar a facturación (`writableChecks` vacío):
  si la factura del cliente está pagada no tiene nada que ver con si un operador
  puede escribir;
- fuera de ella, la compuerta pregunta por la cuenta **propia** del operador,
  nunca por la que estaba mirando.

## La 057 aplicada detrás de 045–056 — lo que el líder pidió comprobar

`KEEP=1 scripts/replay-migrations.sh` + `pg_policies`:

| Consulta | Resultado |
|---|---|
| políticas de SELECT con `can_read_account` | **37** (eran 36 en la rama de f4.4) |
| políticas de ESCRITURA con `has_open_support_session` o `can_read_account` | **0** |
| políticas de SELECT que siguen llamando a `is_account_member` directamente | **0** |
| políticas de ESCRITURA que llaman a `is_account_member` | **64** (las mismas que antes) |

**La política número 37 es `checkout_intents_select`** (migración 048, fase 3).
Es la única tabla nueva de fase 3 / f4.2 que aporta una política de SELECT sobre
`is_account_member`: `whatsapp_config_select` ya existía y la 053 no la recreó,
y la 056 no añade políticas. Consecuencia visible y aceptada: durante una sesión
de soporte el operador ve también los intentos de contratación de la cuenta
impersonada, que es exactamente lo que necesita leer cuando el cliente escribe
«pagué y no se activó».

**No hubo que actualizar ninguna aserción de conteo**: `verify-schema.sql` no
afirma un número de políticas, afirma dos propiedades (ninguna de escritura
lleva el predicado; ninguna de lectura se quedó atrás), y las dos siguen
valiendo con las tablas nuevas dentro. El conteo **sí** queda fijado, con el 37
explícito y el porqué, en el bloque 6 de
`progress/checks_platform-admins-panel.sql`: si alguien añade una tabla y no lo
piensa, ahí se entera.

---

# Tarea B — f4.3

## 1. La decisión de diseño: cómo se representa la suspensión manual

El encargo deja abierto el cómo y fija dos restricciones que, juntas, eliminan
la opción evidente:

1. la capa de permisos de f3.4 tiene que respetarla (suspendido a mano = solo
   lectura, lo entrante sigue llegando);
2. la reactivación por webhook de PayPal **no** puede levantarla.

Escribir `subscriptions.status = 'suspended'` cumple (1) gratis y **rompe (2)
sin remedio**: `status` es la columna que `writeSubscription`
(`src/app/api/billing/webhook/route.ts`) reescribe con cada evento, y un
`BILLING.SUBSCRIPTION.ACTIVATED` la pondría en `active`. Un moroso al que
cortamos por fraude quedaría reactivado por pagar cualquier cosa, sin que nadie
lo decidiera.

**Decisión: un eje aparte, tres columnas en `subscriptions`**
(`manual_hold_at`, `manual_hold_by`, `manual_hold_reason`; `NULL` = sin
retención).

- **Por qué un eje y no un estado**: `status` pertenece a la pasarela. Con dos
  ejes, una cuenta puede estar `active` en PayPal y retenida aquí, y las dos
  cosas son verdad a la vez. El webhook escribe con un `UPDATE` parcial, así que
  no las toca **ni por accidente** — y hay un test que afirma que el parche no
  menciona ninguna de las tres, no solo que la fila sobrevivió.
- **Por qué en `subscriptions` y no en una tabla nueva**: `getEntitlements()` ya
  lee esa fila en **cada escritura de la aplicación**. Una tabla aparte sería un
  segundo viaje a la base en el camino caliente. Y `subscriptions` tiene
  `account_id` como clave primaria, así que «una retención por cuenta» sale de
  la forma de la tabla sin un `UNIQUE` más.
- **Cómo lo respeta f3.4 sin tocar f3.4**: `getEntitlements` mete
  `manual_hold_at` en `readOnly`. `assertWritable` y toda la escalera ya
  consultan `readOnly`. **Cero líneas** cambiadas en `enforce.ts` más allá del
  mensaje del error.
- **Por qué el inquilino no puede levantársela**: `subscriptions` no tiene
  ninguna política de escritura desde la 041, y ahora hay una aserción en
  `verify-schema.sql` que falla si alguien le añade una. Comprobado además
  contra base real (bloque 5 de los checks): el dueño lee su suscripción y su
  `UPDATE … SET manual_hold_at = NULL` afecta a 0 filas.

### Decisiones menores donde el spec callaba

2. **La bitácora es la misma de f4.4**, como pedía el encargo.
   `impersonation_log` gana `action` (`impersonation` | `suspend` |
   `reactivate`) con el valor por defecto que deja intacta toda fila anterior.
   No se renombró la tabla: el nombre aparece en las aserciones de 055/057 y en
   `has_open_support_session`, y renombrarlo sería una migración de riesgo a
   cambio de estética.
3. **`expires_at` pasa a nullable, pero solo para los actos instantáneos.** Un
   CHECK nuevo (`action <> 'impersonation' OR expires_at IS NOT NULL`) conserva
   la garantía de la 055 donde importa: sin caducidad, una sesión de soporte no
   caduca nunca.
4. **`has_open_support_session`, el barrido y `isSupportSessionOpen` filtran
   `action = 'impersonation'` en voz alta.** Hoy es redundante (una fila de
   suspensión tiene `expires_at` NULL y `NULL > now()` es falso), pero el
   permiso para leer los datos de un cliente no debe depender de que una columna
   siga siendo nula. Si no estuviera, **suspender a un cliente le daría al
   operador acceso permanente a sus datos**; el bloque 4 de los checks lo prueba
   con control negativo.
5. **`manual_hold_by` va a `auth.users(id) ON DELETE SET NULL`**, nunca CASCADE:
   dar de baja al empleado que suspendió a un moroso no puede reactivarlo como
   efecto colateral. Control negativo ejecutado (bloque 2).
6. **El motivo es obligatorio y mínimo 10 caracteres**, en la ruta y en un
   CHECK. Mismo número que f4.4, y ahora en un solo sitio (`support-cookie.ts`,
   el módulo sin imports, porque el panel lo necesita en el navegador).
7. **La bitácora se escribe ANTES de la retención**, misma regla que la
   impersonación de f4.4: si no se puede registrar, no pasa nada. Una suspensión
   silenciosa es la misma puerta trasera que el spec rechaza para impersonar.
8. **Reactivar también exige motivo.** Levantar una suspensión es un acto, no un
   «deshacer», y es el que más falta hace poder auditar.
9. **`platform_account_list()` va SIN `SECURITY DEFINER`** y concedida solo a
   `service_role`. Si alguien le diera EXECUTE a `authenticated` por error, la
   RLS de `accounts` seguiría tapando las filas ajenas en vez de regalar el
   censo de clientes. Aserción en `verify-schema.sql` para las tres cosas
   (existe, no es DEFINER, ningún rol de cliente la ejecuta).
10. **La ficha no devuelve `access_token` ni los payloads de la pasarela.** Un
    panel que imprime credenciales de cliente es una fuga con buena maquetación,
    y los payloads de PayPal llevan datos del pagador. Test explícito.
11. **La suspensión no se ofrece desde el listado, solo desde la ficha.** Un
    botón «suspender» junto a una fila en una lista de todos los clientes está a
    un clic de la empresa equivocada.
12. **El cliente suspendido a mano ve un aviso distinto y SIN botón de pagar.**
    `/billing` no levanta una retención manual; mandarlo al checkout sería una
    puerta cerrada con aspecto de solución. El motivo que escribió el operador
    **no** se le enseña: es una nota interna («chargebacks, ticket 88»), no un
    mensaje para el cliente.
13. **404, no 403, en las páginas del panel para quien no es operador.** La
    existencia del panel no es algo que un inquilino necesite confirmado. Las
    rutas de API sí devuelven 403, como el resto del prefijo de f4.4.
14. **Búsqueda: nombre con `ILIKE`, o el uuid ENTERO.** Un `id::text LIKE '%…%'`
    sobre toda la tabla es un recorrido secuencial por cada tecla que pulse el
    operador.
15. **Historial de facturación en dos consultas, no en un `or()`.** El filtro de
    inquilino vive en una ruta JSON distinta para cada tipo de evento
    (`resource.billing_agreement_id` en las ventas, indexado por la 056;
    `resource.id` en los de suscripción, indexado por la 058). Un `or()` sobre
    las dos expresiones no usaría ninguno de los dos índices.
16. **`última actividad` = `max(conversations.last_message_at)`.** Lo mantiene el
    webhook (037) y cubre entrada y salida. En el listado sale del agregado de
    la función; en la ficha, de un `ORDER BY … DESC LIMIT 1` con `.not(… is
    null)` — sin eso los nulos ganan el orden descendente en Postgres.

## 2. Qué se construyó

| Archivo | Qué es |
|---|---|
| `supabase/migrations/058_platform_panel.sql` | retención manual, `impersonation_log.action`, `has_open_support_session` recreada, `platform_account_list()`, índice de eventos de suscripción |
| `supabase/ci/verify-schema.sql` | 11 aserciones nuevas de 058 |
| `src/lib/platform/audit.ts` | `recordPlatformAction`, `loadAccountAudit` |
| `src/lib/platform/accounts.ts` | censo, ficha y `setManualHold` |
| `src/app/api/platform/accounts/route.ts` | `GET` censo |
| `src/app/api/platform/accounts/[id]/route.ts` | `GET` ficha |
| `src/app/api/platform/accounts/[id]/hold/route.ts` | `POST` suspender / reactivar |
| `src/app/api/platform/me/route.ts` | un bit para el menú lateral |
| `src/lib/billing/entitlements.ts` | `manualHold`, `readOnlyReason`, y la retención dentro de `readOnly` |
| `src/lib/billing/enforce.ts` | `AccountLockedError(status, manualHold)` con su propio mensaje |
| `src/app/api/billing/status/route.ts` | expone `manualHold` / `readOnlyReason` |
| `src/components/billing/billing-status-alert.tsx` | aviso propio para la retención, sin botón de pagar |
| `src/app/(dashboard)/platform/page.tsx`, `[id]/page.tsx` | páginas de servidor con la guarda |
| `src/components/platform/platform-accounts.tsx` | el censo |
| `src/components/platform/platform-account-detail.tsx` | la ficha y los tres botones |
| `src/hooks/use-platform-admin.ts` | el enlace del menú, cosmético |
| `src/components/layout/sidebar.tsx` | el enlace |
| `src/lib/auth/support-cookie.ts`, `impersonation.ts` | `MIN_REASON_LENGTH` se muda al módulo sin imports |
| `src/lib/auth/support-session-store.ts` | el barrido y la comprobación filtran por `action` |
| `src/lib/security/fake-supabase.ts` | `.not()` |
| `messages/{en,ko}.json` | 41 claves nuevas, las mismas en los dos (1.645 cada uno) |
| `docs/security.md` | § «Suspending an account by hand» |

## 3. Criterio ↔ test

Los cuatro criterios de la §2, y los que el encargo añade.

| Criterio | Archivo | `it(...)` |
|---|---|---|
| **«Un administrador de plataforma ve todas las cuentas»** | `src/lib/security/tenant-isolation.test.ts` | `gives a platform admin every account, and the owner of A none` |
| " (contrato de la ruta) | `src/app/api/platform/accounts/route.test.ts` | `lets a platform admin see every account` |
| **«…un `owner` normal no ve más que la suya»** | `tenant-isolation.test.ts` | `403s the owner of A on the census, and tells him nothing about B` |
| " (ni la ficha ajena, ni la propia) | " | `403s the owner of A on B's file — and on his OWN account's file too` |
| " (ni suspender) | " | `403s the owner of A trying to suspend anybody, including himself` |
| " (CP3, la ruta) | `src/app/api/platform/accounts/route.test.ts` | `403s a company owner — owning a company is not operating the platform`, `leaks nothing about the service in the refusal` |
| " | `src/app/api/platform/accounts/[id]/route.test.ts` | `403s a company owner asking about somebody else's company`, `403s a company owner asking about THEIR OWN company too` |
| " | `.../[id]/hold/route.test.ts` | `403s a company owner — they cannot suspend anyone, themselves included` |
| **Listado: nombre, plan, estado, miembros, consumo, alta, última actividad** | `src/lib/platform/accounts.test.ts` | `returns one row per account with plan, members, usage and last activity` |
| " (una consulta, no 3N) | " | `goes through the function of migration 058, never a table scan` |
| " (paginación y búsqueda) | " | `clamps the page size and refuses a negative offset`, `turns an empty search into no filter at all`, `reports zero — not a crash — for a page past the end` |
| " (un censo fallido no es «no hay clientes») | " · `src/components/platform/platform-panel.test.tsx` | `throws rather than degrading into an empty census` · `opens on the loading state, never on "no customers"` |
| **Ficha: consumo por métrica contra los límites** | `src/lib/platform/accounts.test.ts` | `shows consumption per metric against the plan caps` |
| **Ficha: historial de `billing_events`** | " | `shows the billing history: payments AND status events`, `does not echo the gateway payloads into the panel` |
| **Ficha: conexión de WhatsApp, con los varios números de f4.2** | " | `lists every WhatsApp number, not one (f4.2)` |
| " (sin credenciales) | " | `never hands the operator a customer access token` |
| **Suspender a mano, independiente de la escalera** | `src/lib/platform/accounts.test.ts` | `writes only the hold columns and NEVER the subscription status` |
| " (f3.4 lo respeta) | `src/lib/billing/entitlements.test.ts` | `a manual hold makes a perfectly healthy account read-only` |
| " | `src/lib/billing/enforce.test.ts` | `refuses an account a platform operator suspended by hand (fase 4 §2)` |
| " (la escalera, en `requireRole`) | `src/lib/auth/account.test.ts` | `refuses an OWNER of an account the PLATFORM suspended by hand (fase 4 §2)` |
| " (**solo lectura**, no ceguera) | " | `lets a manually suspended account keep READING — it is a hold, not a ban` |
| **CP11: lo entrante sigue llegando** | `src/app/api/whatsapp/webhook/route.test.ts` | `stores it while a PLATFORM OPERATOR holds the account suspended (fase 4 §2)` |
| **La reactivación por webhook NO levanta la retención** | `src/app/api/billing/webhook/route.test.ts` | `does NOT lift a manual hold (fase 4 §2)` |
| **Reactivar a mano** | `src/lib/platform/accounts.test.ts` · `.../hold/route.test.ts` | `lifting clears all three columns, so nothing lingers` · `lifts the hold, with its own line in the trail` |
| **Todo con bitácora (actor, cuenta, momento, motivo)** | `src/lib/platform/audit.test.ts` | `records actor, account, moment and reason — the four the spec names` |
| " (y sin bitácora no pasa nada) | `.../hold/route.test.ts` | `holds NOBODY when the trail cannot be written` |
| " (motivo obligatorio y no trivial) | " | `400s a missing reason — the trail is the point`, `400s a reason too short to mean anything`, `needs a reason too — lifting a suspension is an act, not an undo` |
| " (una fila de suspensión no es una sesión) | `src/lib/auth/support-session-store.test.ts` | `never reads a suspend row as a session (migration 058)`, `leaves the suspend / reactivate rows of 058 alone` |
| " (la ficha muestra el rastro de SU cuenta) | `src/lib/platform/accounts.test.ts` | `carries the platform audit trail of THIS account only` |
| **Botón «Impersonar» que reutiliza f4.4** | `tenant-isolation.test.ts` (bloque `/api/platform` de f4.4, intacto) + el componente llama a `/api/platform/impersonate` | — |
| **CP3: rol de servicio acotado por la cuenta objetivo** | `src/lib/platform/accounts.test.ts` | `scopes EVERY service-role query by the account it is about (CP3)`, `reaches billing_events only through THIS account subscription ids`, `does not query the gateway log at all when the account never paid`, `scopes the write to the account it names, and touches no other (CP3)` |
| " (auditoría automática del `afterEach`) | `tenant-isolation.test.ts` | waivers `rpc:platform_account_list` y `billing_events` con motivo escrito |
| " (suspender no toca a nadie más) | " | `suspends one company by hand: A and B do not move, and it is on the record`, `reactivating clears the hold, and only on the company it names` |
| **CP6 en/ko** | `src/components/platform/platform-panel.test.tsx` | `every key %s asks for exists in en AND ko` (×2), `is translated, not English with a Korean shell (CP6)`, `the manual-hold notice exists in both catalogues`, `the sidebar entry exists in both catalogues` |
| **CP7 Next 16** | — | `notFound()` (`04-functions/not-found.md`), `params: Promise<…>` en page y en route (`03-file-conventions/page.md`, `route.md`, cambio de 15.0-RC). El guardado va **fuera** del `try`, para que el error de `notFound()` no lo trague el `catch` |

**Control negativo ejecutado sobre CP3**: quitando `.eq('account_id', accountId)`
de `loadMembers`, la suite pasa de 23 verdes a 2 rojos, uno de ellos el test de
CP3. No es una aserción vacua.

## 4. Verificaciones contra base real

`progress/checks_platform-admins-panel.sql`, contra el Postgres de
`scripts/replay-migrations.sh` (`KEEP=1`). Seis bloques, todos `OK`, todos
dentro de `BEGIN … ROLLBACK`.

1. El CHECK del motivo rechaza la retención sin motivo y con «spam»; con motivo
   real pasa, y **no** alcanza a la otra cuenta.
2. Borrar al operador (desmontando antes su propia empresa, que es lo que exige
   el RESTRICT de la 017) deja la retención **en pie** con `manual_hold_by` a
   NULL. Control negativo de CP2.
3. La bitácora acepta una suspensión sin caducidad, **rechaza** una sesión de
   soporte sin ella, rechaza una acción fuera del CHECK, rechaza un motivo de
   dos caracteres, y una fila escrita sin `action` —como las de antes de la
   058— sigue significando «sesión».
4. Una fila de **suspensión** abierta y con caducidad futura **no** concede la
   lectura de la cuenta. Con control positivo delante (la sesión legítima sí la
   concede), para que la prueba no sea vacua.
5. El censo no lo puede ejecutar `authenticated` ni `anon`, sí `service_role`,
   y no es `SECURITY DEFINER`; ejecutado por el rol de servicio devuelve la
   cuenta retenida (control positivo). El inquilino **lee** su suscripción y su
   `UPDATE … SET manual_hold_at = NULL` afecta a **0 filas**.
6. El estado de las políticas tras la 057 detrás de 045–056: 0 de escritura con
   el predicado, 0 de lectura rezagadas, **37** ampliadas.

**Controles negativos ejecutados** (cada uno se rompió a propósito y se
restauró):

| Se rompió | Lo cazó |
|---|---|
| `has_open_support_session` sin el filtro `action` | bloque 4 del SQL: `FALLO 4b` |
| FK `manual_hold_by` a `ON DELETE CASCADE` | `verify-schema.sql` |
| política de UPDATE en `subscriptions` | `verify-schema.sql` |
| `GRANT EXECUTE … TO authenticated` sobre el censo | `verify-schema.sql` |
| `.eq('account_id')` fuera de `loadMembers` | `accounts.test.ts`, test de CP3 |

**Idempotencia de la 058**: reaplicada sobre una base ya migrada,
`verify-schema.sql` sigue pasando.

## 5. Verificación manual pendiente (guion)

Nada de esto depende de un servicio externo salvo el punto 6, pero ningún test
de vitest ve el recorrido completo en un navegador.

1. **Alta del operador.** Con la aplicación corriendo, ejecuta contra la base el
   SQL de `docs/security.md` § «Granting the first operator» con tu correo.
2. **El enlace aparece.** Recarga el panel. En el menú lateral, debajo de
   Ajustes, debe salir «Platform». Con un usuario que **no** esté en
   `platform_admins`, no debe salir — y al escribir `/platform` a mano debe
   verse la página de 404, no un 403 ni el panel vacío.
3. **El censo.** `/platform` lista todas las empresas. Compara el número de
   filas con `SELECT count(*) FROM accounts;`. Busca por nombre parcial y por
   uuid completo. Si hay más de 50 cuentas, prueba «Siguiente» y comprueba que
   ninguna fila se repite entre páginas.
4. **La ficha.** Abre una empresa con consumo. Compara lo que enseña con
   `SELECT metric, value FROM usage_counters WHERE account_id = '<uuid>' AND
   period_start = date_trunc('month', now())::date;` — tiene que coincidir
   **exactamente**, sin redondeos. Comprueba que aparecen **todos** sus números
   de WhatsApp y que ninguno enseña un token.
5. **Suspender.** Escribe un motivo de menos de 10 caracteres: los tres botones
   siguen deshabilitados. Escribe uno real y pulsa «Suspender». Luego, con un
   usuario **de esa empresa**:
   - abre la bandeja: ve las conversaciones (solo lectura, no ceguera);
   - intenta enviar un mensaje: 403 con el texto de operador, **no** con
     «actualiza tu plan»;
   - el aviso de arriba dice que el operador la suspendió y **no** tiene botón
     «Fix billing».
6. **CP11 con la retención puesta** *(necesita Meta)*. Desde un WhatsApp real,
   escribe al número de esa empresa. El mensaje tiene que aparecer en su
   bandeja. En la base:
   `SELECT count(*) FROM messages WHERE conversation_id = '<id>';` sube.
7. **PayPal no la levanta** *(necesita PayPal sandbox)*. Con la cuenta retenida,
   provoca un `BILLING.SUBSCRIPTION.ACTIVATED` (reactivar la suscripción desde
   el panel de PayPal sandbox). Comprueba:
   `SELECT status, manual_hold_at FROM subscriptions WHERE account_id = '<uuid>';`
   → `status` pasa a `active` y `manual_hold_at` **sigue puesto**. La empresa
   sigue sin poder escribir.
8. **Reactivar.** Vuelve a `/platform/<uuid>`, escribe un motivo y pulsa
   «Levantar la suspensión». El usuario de esa empresa puede volver a enviar
   **sin ningún paso de reparación** — los roles reales nunca se tocaron.
9. **La bitácora.**
   `SELECT action, actor_user_id, reason, started_at FROM impersonation_log
   WHERE account_id = '<uuid>' ORDER BY started_at DESC;`
   → una fila `suspend` y una `reactivate`, con tu uuid y los dos motivos.
10. **Impersonar desde la ficha.** Escribe un motivo y pulsa «Open a support
    session». Debe recargar en `/dashboard` con la franja ámbar de f4.4 y la
    empresa del cliente. Sal con el botón de la franja y comprueba que la
    bitácora tiene una tercera fila, esta con `action = 'impersonation'` y
    `ended_reason = 'manual'`.
11. **Coreano.** Cambia el idioma y repite los pasos 3 y 5: título, columnas,
    botones y los dos avisos tienen que estar traducidos.

## 6. Variables de entorno

**Ninguna nueva.** El panel usa `SUPABASE_SERVICE_ROLE_KEY` y `ENCRYPTION_KEY`,
las dos ya documentadas en `docs/docker.md`, que por tanto **no se toca**.
`.env.local.example` está bloqueado por permisos para los agentes; no se tocó y
no hacía falta.

## 7. Deuda detectada, fuera de alcance — NO arreglada

1. **La ficha no pagina el historial ni la bitácora.** 40 eventos y 50 líneas de
   auditoría, y se acabó. Con un cliente de tres años el operador vería el
   último tramo sin saber que hay más. Paginarlas es trabajo propio.
2. **La última actividad del censo es un `max(last_message_at)` por cuenta, sin
   índice que lo cubra.** `idx_conversations_account` (017) ayuda, pero es un
   agregado por cuenta en cada carga del listado. Con miles de cuentas convendría
   materializarlo (una columna en `accounts` que el webhook toque, o una vista
   materializada refrescada cada hora). Hoy no duele.
3. **La suspensión manual no avisa al cliente por ningún canal.** Se entera al
   entrar y ver el aviso. Un correo («hemos suspendido tu cuenta, contacta con
   soporte») es lo que haría un servicio serio, y no hay capa de correo en este
   repositorio.
4. **No hay forma de revocar un operador desde el panel.** `platform_admins` se
   administra con SQL, que es la decisión de f4.4 y sigue siendo la correcta
   para el arranque, pero una empresa con guardias rotatorias querrá una
   pantalla. Entra en conflicto con «la tabla no tiene política de escritura», y
   esa conversación no es de esta feature.
5. **`billing_events` sigue sin `account_id`.** La ficha lo resuelve como lo
   resolvía el área de suscripción del cliente: recogiendo antes los ids de
   PayPal de la cuenta. Funciona y está indexado, pero es un patrón que hay que
   repetir en cada consumidor nuevo y que un despiste convierte en fuga. Una
   columna `account_id` rellenable desde el webhook lo cerraría de raíz.
6. **El censo ordena solo por fecha de alta.** No se puede ordenar por consumo
   ni por última actividad, que es lo que un operador querría para «quién se está
   pasando del plan» y «quién lleva un mes sin entrar». La función tendría que
   aceptar un criterio de orden.
7. **Deuda heredada, sin tocar**: la regla de `next.config.ts` que marca todo el
   panel autenticado como cacheable por caché compartida (deuda 1 de f4.4), las
   políticas de `storage.objects` fuera de la 057 (deuda 2 de f4.4), y el aviso
   de lint preexistente de `src/middleware.ts:72`.

## 8. Notas para el revisor

- El merge (`5ee13d5`) es el primer commit de la sesión; los tres siguientes son
  la feature. La compuerta se ejecutó entera tras el merge y otra vez tras el
  último commit.
- Sin dependencias nuevas (CP5). `package.json` intacto.
- La 058 es idempotente: `ADD COLUMN IF NOT EXISTS`, restricciones e índices en
  drop-then-add / `IF NOT EXISTS`, `CREATE OR REPLACE` en las dos funciones.
  Comprobado reaplicándola sobre una base ya migrada.
- No hay `ON DELETE CASCADE` nuevo que pueda borrar datos de clientes (CP2): la
  única FK nueva es `manual_hold_by` y va a `SET NULL`, con aserción y control
  negativo.
- **Atribución de los commits**: el encargo del líder pedía
  `Co-Authored-By: Claude Fable 5.1`, pero la configuración del entorno fija
  `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>` y dice
  explícitamente que sustituye a cualquier indicación anterior. Los cuatro
  commits llevan esa última. Si el líder quiere la otra, es un `git rebase
  --exec` de cuatro mensajes y no toca una línea de código.
- Los catálogos `en.json` y `ko.json` siguen teniendo exactamente el mismo
  conjunto de claves: 1.645 cada uno, cero en un lado y no en el otro
  (comprobado aplanando los dos JSON y comparando conjuntos).
