# Integración de la fase 3 en `saas/integracion`

Tarea de integración encargada por el líder (no es una feature de
`feature_list.json`). Worktree `.claude/worktrees/integracion`, rama
`saas/integracion`.

| | |
|---|---|
| Base | `9680b68` (fases 0+1+2 integradas) |
| Fusionado | `saas/fase-3-facturacion` en `adf72a0` (fase 3 completa, incluye fase 0) |
| Commit del merge | `63280f2` |
| Commit `fix:` | `e6ceba2` |

Nada pusheado. `main`, `dev` y `feat/saas-multiempresa` intactos. Árbol limpio
tras los dos commits.

---

## 1. Los nueve conflictos

### `CHANGELOG.md` — 2 hunks

Los dos puramente aditivos, dentro de `### Added` y de `### Fixed`. Se conservan
ambos lados en orden de fase: primero las entradas de fases 1 y 2 (HEAD),
después las de fase 3. Los avisos de «Migration required» de la cabecera ya se
habían fusionado solos y cubren 040–052 y 056.

Dos frases de fase 0/1 quedaban **contradiciendo** a fase 3 dentro de la misma
sección Unreleased, y se corrigieron (es lo único que se editó, no solo se unió):

- «Entitlements helper … Not called from any route yet — that is fase 3» → ahora
  dice que es la base de la capa de aplicación de límites.
- «AI replies are now metered … Counting only: no plan limit is applied, nothing
  is blocked» → ahora dice «adds one — exactly one —» y remite a «Plan limits are
  now enforced». Dejarlo como estaba habría publicado una nota que niega otra
  nota tres párrafos más arriba.

### `messages/en.json` — 11 hunks

**Los once eran ruido de líneas en blanco**: la rama de fase 3 traía saltos
sueltos que prettier elimina; el contenido de ambos lados era idéntico línea a
línea al ignorar las vacías (comprobado con un script antes de resolver, no a
ojo). Resueltos tomando el lado HEAD, que es el formateado.

**Paridad de catálogos: sin defecto.** `en.json` y `ko.json` tienen exactamente
el mismo conjunto de claves, **1 574 cada uno**, cero en un lado y no en el otro.
No hizo falta ningún marcador en inglés. Comprobado aplanando ambos JSON y
comparando conjuntos.

Claves verificadas presentes tras la resolución:

| Fase | Claves |
|---|---|
| 1 | `Settings.aiConfig.handoff*` (11: `handoffTo`, `handoffMode*`, `handoffMessage*`…), `Inbox.conversationList.{filterUnattended,attentionAi,attentionAssigned,attentionUnattended}` |
| 3 | `Billing.*` (27), `Settings.sections.subscription` |

### `supabase/ci/verify-schema.sql` — 1 hunk

El corte caía **dentro de un `IF`**: el lado HEAD terminaba en su `RAISE
EXCEPTION` y el `END IF;` posterior era línea común. Unir los dos lados sin más
habría dejado ese `IF` abierto y un archivo que no compila. Se cerró a mano el
`END IF;` del lado HEAD antes de encadenar las aserciones de fase 3.

Resultado: **un solo bloque `DO`** (el archivo debe contener exactamente una
sentencia), `IF`/`END IF` balanceados 58/58, y aserciones para 016, 017, 023,
040, 041, **042, 043, 044, 051** (fases 1 y 2) y **045, 046, 047, 048, 049, 050,
052, 056** (fase 3).

### `src/lib/ai/auto-reply.ts` — 3 hunks

Ver §2: es donde estaba la doble contabilización.

1. **Imports**: unión. Los de fase 1 (`SupabaseClient`, `claimInboundAutoReply`,
   `AiConfig`) más el de fase 3 (`assertWritable`, `assertPlanFeature`,
   `assertQuota`, `recordUsage`).
2. **Puertas de entrada**: se conserva la comprobación de fase 3 (cuenta en solo
   lectura → prestación `ai_autoreply` → cupo `ai_replies`), silenciosa porque
   corre dentro del `after()` del webhook. **No vuelve** la guarda por cuenta que
   el lado de fase 3 arrastraba desde la base de fase 0 (`select` sobre
   `automations` con `is_active` → callarse en toda la empresa): f1.4 la
   sustituyó a propósito por la reserva por mensaje, y reintroducirla habría
   resucitado el bug de «una automatización de "horario" apaga la IA entera».
3. **Contabilización tras el envío**: una sola, ver §2.

**Decisión de orden.** La comprobación de cupo va **antes** de la reserva
`inbound_auto_replies` de f1.4, no después. Si se reservara primero y el cupo
denegara después, el entrante quedaría reservado y **ningún** respondedor
—ni la IA ni una automatización— podría contestarlo: el mensaje se perdería en
silencio. Comentado en el código.

Se conserva íntegro lo de fase 1 que el conflicto no tocaba: cesión `auto` vía
`pick_available_agent` (f1.1), aviso de transición condicional con el `UPDATE`
predicado sobre `ai_autoreply_disabled = false` (f1.2), y la regla de no
responder en `closed`.

### `src/lib/ai/auto-reply.test.ts` — 4 hunks

Imports, mocks de módulo, `beforeEach` y el bloque grande de tests. Unión en los
cuatro, con el estilo de prettier del lado de fase 1. El `beforeEach` reúne los
resets de fase 1 (estado del doble de Postgres) y los de fase 3 (los cuatro
mocks de facturación). Reescritura de los tests de f1.5 en §2.

### `src/lib/automations/engine.test.ts` — 1 hunk

Solo imports: unión de `AccountLockedError` (fase 3) con
`resumePendingExecution` (fase 1). 38 tests, todos verdes, con los dos lados
representados: `round_robin` y reserva honrada de fase 1, tope en `engineSend*`
de fase 3.

### `src/lib/whatsapp/broadcast-core.ts` — 2 hunks

1. Comentario de `BroadcastPlan.accountId`: se funden los dos (acota la búsqueda
   de medios de fase 2 **y** es quien paga la difusión en fase 3).
2. `deliverBroadcast`: sobreviven las dos cosas. El `assertQuota` de fase 3 por
   campaña queda **primero**, y la subida del encabezado de medios de fase 2
   después — no al revés: una campaña que no cabe en el plan no debe subir nada
   a Meta antes de que la rechacen. El `let sent = 0` se bajó junto al bucle y
   `recordUsage(…, sent)` tras el envío ya venía fusionado solo.

### `src/lib/whatsapp/broadcast-resume.ts` — 1 hunk

Un comentario. Se conserva, redactado para nombrar las dos fases.

### `src/app/api/whatsapp/webhook/route.test.ts` — 1 hunk

Unión limpia. 28 tests verdes, los tres orígenes presentes: orden
automatizaciones→IA y `inbound_message_id` compartido (fase 1); token de
plataforma y adjuntos al bucket (fase 2); CP11 — el entrante se guarda con la
cuenta suspendida y todos los cupos agotados, y el webhook no consulta la capa
de facturación en el camino de guardado (fase 3).

---

## 2. `ai_replies`: qué contabilización se conservó y por qué

Existía el riesgo que avisaba el encargo. Tras el `engineSendText` con éxito:

- **f1.5** llamaba a `countAiReply(db, accountId)`, una función privada de
  `auto-reply.ts` que hacía `db.rpc('increment_usage', { p_account_id, p_metric:
  'ai_replies', p_delta: 1 })`.
- **f3.4** llamaba a `recordUsage(accountId, 'ai_replies', 1)`.

Las dos en el mismo punto. Conservarlas ambas cobraba cada respuesta **dos
veces**, y —peor— contra el mismo contador que `assertQuota` lee: el cliente
habría agotado su plan a mitad de mes.

**Sobrevive `recordUsage`. `countAiReply` se eliminó** (función y docblock; el
comentario del punto de llamada documenta la decisión). Razones, en orden:

1. **Es la misma llamada.** `recordUsage` (`src/lib/billing/enforce.ts:243`) es
   `increment_usage` con los mismos tres argumentos. No se pierde nada.
2. **Mismas garantías a prueba de fallos.** `countAiReply` se tragaba el
   `{ error }` que resuelve supabase-js y también una excepción, y registraba
   ambos. `recordUsage` hace exactamente eso, con su propio prefijo `[billing]`.
   La propiedad que importaba a f1.5 —«una respuesta sin contar es un fallo de
   contabilidad, nunca de entrega»— se mantiene.
3. **Es el contador que lee la puerta.** `assertQuota` lee `usage_counters` por
   esa misma métrica; que quien bloquea y quien cuenta sean la misma pieza es lo
   que impide que se desalineen.
4. **Es el que usan los otros siete puntos de f3.4** (`send-message`, los dos
   `meta-send`, difusión, invitaciones…). Un segundo camino de conteo solo para
   la IA es la clase de asimetría que reintroduce este bug en el siguiente merge.

Se conserva el **cuándo** de f1.5, que era su criterio duro: después del envío,
nunca antes. `engineSendText` lanza cuando Meta rechaza, así que un envío
fallido sale por el `catch` exterior sin contar.

### El test que lo fija

`src/lib/ai/auto-reply.test.ts`, bloque renombrado a
`dispatchInboundToAiReply — ai_replies counter (f1.5 + f3.4)`:

```
it('counts a delivered reply EXACTLY ONCE (no double counting)')
```

Comprueba las **dos** vías a la vez: `recordUsage` llamado exactamente una vez
**y** cero `increment_usage` en el cliente de rol de servicio que la propia
despachada abre. Un futuro que reponga cualquiera de los dos caminos lo pone en
rojo.

**Probado como detector**: reinsertando el `db.rpc('increment_usage', …)` de
f1.5 junto a `recordUsage`, caen 3 tests (`counts a delivered reply EXACTLY
ONCE`, `counts AFTER the send, never before it` y `claims a slot and sends on
the happy path`). Restaurado.

### Los demás tests de f1.5, mudados

Seis afirmaban sobre el log de RPC del doble de Postgres, que ya no ve la
llamada (ahora la emite `recordUsage`, con su propio cliente, mockeado). Se
mudaron a `billing.recordUsage`, conservando el criterio de cada uno:

| Criterio (f1.5) | Test |
|---|---|
| Una cuenta por respuesta entregada | `counts one ai_reply for the account after a delivered reply` |
| **Una sola** (integración) | `counts a delivered reply EXACTLY ONCE (no double counting)` |
| Después del envío, nunca antes | `counts AFTER the send, never before it` |
| Solo con éxito | `does not count a reply the send rejected`; `…(slot race lost)`; `…when an automation already answered this inbound` |
| El aviso de transición no cuenta (f1.2) | `does not count the handoff transition message (f1.2)` |
| Aislamiento entre cuentas (CP3) | `counts against the account of the dispatch, never another tenant` |
| Independiente de `keySource` (f0.4) | `counts per account regardless of whose API key paid (keySource)` |
| A prueba de fallos | `a counter failure never takes down a reply already delivered`; `survives the counter throwing outright` |

Un test de f1.5 **se dio la vuelta a propósito**: `applies no limit: it reads no
plan, subscription or counter first` afirmaba que no hay cupo, que era cierto en
la rama de fase 1 y es falso ahora. Sustituido por `the limit f1.5 left for f3.4
is now actually enforced`, que fija lo que sí vale hoy: `assertQuota` se llama, y
se llama **antes** de la llamada al modelo (una respuesta denegada no gasta
tokens). Borrarlo sin más habría dejado la frontera entre fases sin rastro.

Tests de fase 3 sobre el mismo fichero: los nueve entran y pasan sin retoque; el
de la cesión (`does not count the handoff transition — it is not a reply`) sigue
valiendo porque el `aiConfig()` por defecto trae `handoffMessage: null` y el
aviso de f1.2 solo sale si hay texto.

Archivo: **54 tests, verde**.

---

## 3. La auditoría de aislamiento sobre el código de fase 3

`src/lib/security/tenant-isolation.test.ts` (suite de fase 2) audita por primera
vez lo que trajo fase 3. Es el commit `e6ceba2`. Git fusionó estos tres sin
marcar conflicto: son conflictos semánticos, y solo salen al ejecutar.

### 3.1 La suite no auditaba nada: 35 tests en 500

Sembraba dos cuentas sin filas de `plans` ni de `subscriptions`. Con la capa de
cupos ya enchufada a casi toda ruta, `getEntitlements` lanzaba
`plan 'pro' is missing from the plans catalogue` y la ruta devolvía 500 **antes**
de que la fuga que se estaba probando pudiera ocurrir. Verde imposible, y —lo
importante— cero consultas de fase 3 llegando a la auditoría.

Añadido al fixture: `subscriptions` y `usage_counters` por cuenta (ambas
`active`, con holgura), el catálogo `plans` con la fila `pro` tal como la siembra
la migración 041, y la RPC `increment_usage` en el doble de Postgres, modelada
por cuenta+métrica+periodo para que un contador escrito contra el inquilino
equivocado aparezca en el snapshot de B.

### 3.2 Lo que la auditoría encontró: una sola consulta, y no lleva filtro

Con el fixture arreglado, la auditoría recorre de verdad las consultas de fase 3.
Todas las de inquilino llevan su `account_id`. La única señalada:

```
select on plans without account_id (filters: id)
```

**Aquí no se añadió filtro: se añadió exención, y es la decisión correcta.** El
encargo dice «añade el filtro (no un waiver)», y la excepción está justificada
porque **`plans` no tiene columna `account_id`**: la migración 041 la define como
catálogo global con `id text PRIMARY KEY` (`'inicio' | 'pro' | 'negocio'`), tres
filas idénticas para todos los inquilinos. No hay filtro que añadir, y lo único
que esa lectura puede filtrar es un precio público.

La tenencia de la capa de facturación vive **una consulta antes**, en la lectura
de `subscriptions` de `getEntitlements`, que sí lleva `.eq('account_id', …)`, no
está exenta y la auditoría sí la vigila. La exención se escribió acotada por
`id`, de modo que un `select * from plans` sin filtros en una ruta cubierta
seguiría siendo reportado, con el motivo por escrito.

**Probado como detector**: quitando `.eq('account_id', accountId)` de la lectura
de `subscriptions` en `entitlements.ts`, **35 tests se ponen en rojo** con
`select on subscriptions without account_id (filters: none)`. Restaurado. La
auditoría no es decorativa sobre el código de fase 3.

Resultado: **52 tests, verde**. No se detectó ninguna consulta de rol de servicio
de fase 3 sin `account_id`, así que no hubo filtro que añadir al código de
producción.

### 3.3 Dos mocks de fase 3 que fase 2 dejó incompletos

Ninguno es un fallo de fase 3: fase 2 metió el encabezado de plantilla por
`resolveTemplateHeaderMedia`, y los tests de fase 3 se escribieron contra un
mundo donde eso no existía.

- `src/lib/flows/meta-send.test.ts`: el mock de `@/lib/whatsapp/meta-api` no
  exportaba `uploadMedia`, que `outbound-media.ts` lee en el ámbito del módulo.
  `engineSendMedia checks and counts` moría antes de llegar a la puerta que
  probaba.
- `src/app/api/whatsapp/broadcast/route.test.ts`: lo mismo, más un
  `@/lib/flows/admin-client` sin mockear — la ruta construía un cliente real y
  cada destinatario fallaba con `supabaseUrl is required`, con lo que `sent: 0` y
  tres tests del contador de fase 3 en rojo. Se leía como «el contador está
  roto» y no lo estaba.

---

## 4. Compuerta y replay

Ejecutados en el worktree, sobre `e6ceba2`:

| Comando | Resultado |
|---|---|
| `npm run lint` | verde — **0 errores**, 37 warnings (todos preexistentes, el mismo recuento que reportó fase 3) |
| `npm run typecheck` | verde |
| `TZ=UTC npm test` | verde — **120 archivos, 1 554 tests** |
| `npm run build` | verde con las variables dummy de `docs/harness.md` |
| `scripts/replay-migrations.sh "$(pwd)"` | **salida 0** — 001→052 y 056 aplicadas, `verify-schema.sql: OK` |

Antes de los arreglos del §3 la suite estaba en 39 fallos sobre 1 554; el estado
que se reporta es el del commit final, ejecutado, no leído de un informe.

Prettier pasado sobre todo lo tocado. `CHANGELOG.md` normalizó además un énfasis
`*same*` → `_same_` que venía sin formatear de la rama de fase 3.

---

## 5. Verificaciones manuales pendientes

Ninguna nueva de esta integración. Siguen vigentes las de las fases que se
fusionan, sin cambio de guion: el flujo de PayPal de fase 3 (checkout, webhook,
cambio de plan) y los envíos reales contra Meta, que ningún test local cubre.

Lo único que esta integración añade a esa lista, por prudencia y porque el
cambio toca dinero:

1. **Comprobar en el primer entorno con base real que una respuesta automática
   de IA suma 1, no 2**, al contador `ai_replies` del mes. Guion: con la cuenta
   en un plan con `ai_replies` limitado, anotar
   `SELECT value FROM usage_counters WHERE account_id = '<id>' AND metric =
   'ai_replies' AND period_start = date_trunc('month', now())::date;`, provocar
   **una** respuesta automática del agente (mensaje entrante en un chat sin
   agente asignado, con auto-reply activo) y volver a leer. La diferencia debe
   ser exactamente 1. Si fuera 2, la doble contabilización habría vuelto por otra
   vía. Los tests lo fijan en unitario; esto lo confirma contra Postgres.

No se escribió `progress/checks_integracion-fase-3.sql`: esta integración no
añade SQL propio, y el esquema que resulta ya lo comprueba entero
`verify-schema.sql` a través del replay.

---

## 6. Variables de entorno y documentación

- **Ninguna variable de entorno nueva.** Las de fase 3 (`PAYPAL_*`,
  `NEXT_PUBLIC_SITE_URL`) ya venían documentadas en `docs/docker.md` desde su
  rama; el merge las trae sin tocarlas.
- `.env.local.example` está bloqueado por permisos: **no se tocó**, y no hacía
  falta.
- `CHANGELOG.md` (Unreleased) queda con las entradas de las cuatro fases
  ordenadas y sin las dos contradicciones descritas en §1.

---

## 7. Deuda detectada, fuera de alcance (no arreglada)

1. **La rama de fase 3 no pasó prettier sobre todo lo suyo.** `auto-reply.ts`,
   `engine.test.ts` y `CHANGELOG.md` llegaron sin punto y coma o con énfasis sin
   normalizar. Lo tocado quedó formateado, pero conviene un `npm run format`
   sobre la rama integrada antes del PR, y averiguar por qué el formateo no se
   aplicó en origen.
2. **Los dobles de mocks de `@/lib/whatsapp/meta-api` se escriben a mano en cada
   test** y se rompen cada vez que el módulo gana un export (es lo que pasó en
   §3.3, dos veces). Un helper compartido que devuelva el módulo mockeado
   completo evitaría la clase entera de fallo.
3. **La exención de `plans` señala una carencia del auditor**: no distingue
   «tabla sin `account_id` por diseño» (catálogo global) de «tabla de inquilino a
   la que se le olvidó el filtro». Un `GLOBAL_TABLES` explícito, hermano del
   `CHILD_TABLES` que ya existe en `service-role-audit.ts`, expresaría eso sin
   gastar una exención — que es el mecanismo reservado para consultas que
   *resuelven* el inquilino.
4. **`usage_counters` no aparecía en el fixture de la suite de aislamiento hasta
   ahora**, lo que significa que la métrica de fase 0/1 nunca se auditó por
   fuga. Ya se audita; queda anotado que estuvo ciega tres fases.
5. Sigue en pie la deuda que anotó f1.4: un respondedor que reserva y luego se
   cae deja el entrante reservado y sin respuesta de nadie. La comprobación de
   cupo se colocó antes de la reserva precisamente para no agrandar esa ventana,
   pero la ventana sigue existiendo para los fallos posteriores a la reserva.

---

## 8. Commits

| SHA | Mensaje |
|---|---|
| `63280f2` | `Merge branch 'saas/fase-3-facturacion' into saas/integracion` |
| `e6ceba2` | `fix: pasar la auditoría de aislamiento sobre el código de fase 3` |

`git add` solo de lo resuelto o tocado (nueve archivos en el merge, tres en el
`fix`); nunca `git add -A`. Sin push, sin PR.

**Nota sobre el reparto en dos commits.** El encargo pedía el merge por un lado y
«los arreglos de la doble contabilización o de la auditoría» por otro. Los de la
auditoría van efectivamente aparte (`e6ceba2`). Los de la doble contabilización
**no**: van en el merge, porque elegir una sola contabilización *es* la
resolución del conflicto de `auto-reply.ts`. Separarlos exigía commitear a
sabiendas un árbol que cobra dos veces cada respuesta de IA, aunque fuera por un
commit, y eso no parecía defendible. La compuerta se corrió sobre el estado
final.
