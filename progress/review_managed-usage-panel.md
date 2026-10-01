# Review — s10.5 managed-usage-panel

**Veredicto:** APPROVED (segunda ronda, `5349031`; la primera fue CHANGES_REQUESTED)

Rama `pmd/managed-usage-panel`, HEAD `dc804ef` (1 commit) sobre `feat/precios-meta-directo` @ `74a5daa`.
El diff (16 archivos) coincide con el informe.

## Compuerta
- lint: verde (0 errores; 34 warnings preexistentes, ninguno en archivos del diff)
- typecheck: verde
- `TZ=UTC npm test`: verde (298 archivos, 4.355 tests)
- build: no ejecutado, por orden del humano (lo corre el líder sobre la rama integrada)
- replay-migrations: n/a (sin migración; Docker apagado)

## Trazabilidad criterio ↔ test
- C1 «managed: barra usados/7.000, excedente por categoría, estimado = cuota + excedente con `buildStatement` sobre el periodo en curso»: [x] `src/lib/billing/meta-usage.test.ts` › "8.200 delivered…", "is the same figure buildStatement gives…" (compara contra `buildStatement` del mismo periodo); `meta-usage/route.test.ts` › "package used over the included messages…"
- C2 «aviso 80 % y 100 % del paquete»: [x] `meta-usage.test.ts` › "the package warns at 80 % and is full at 100 %" (5599/5600/6999/7000); `meta-usage-card.test.tsx` › "package bar over the 7.000…", "80 % notice…"
- C3 «periodo = el del cron de s10.4»: [x] `meta-usage.test.ts` › describe "currentCycle" (4 its). Comprobado a mano: con ancla por delante usa `statementPeriodStart(ancla, último period_end)`, igual que `statement-cron.ts:182`; con ancla vencida empieza en el ancla, que es lo que el cron usará como inicio del siguiente estado (`statementPeriodStart(ancla+1m, ancla)`).
- C4 «managed sin barra de cuota gratis de Meta»: [x] `meta-usage-card.test.tsx` › "no Meta free-quota bar for a managed account"; la ruta managed no llama a `service_quota_usage`.
- C5 «direct: cuota gratis 1.000 por número, barra y avisos 80/100»: [x] `meta-usage.test.ts` › "the free tier of a number uses p11.3's «exhausted»…" (100 % = `serviceCapState().exhausted`, incluido `billable > 0` con <1.000: misma regla que el aviso de bandeja); `meta-usage/route.test.ts` › "per number from service_quota_usage (p11.3)…", "a number that exhausted…". Sin segundo conteo: usa `loadServiceUsage` + `serviceCapState`.
- C6 «direct: costo estimado de Meta, solo `billable`, sin multiplicador»: [x] `meta-usage.test.ts` › "only the billable deliveries, at Meta's rate, without multiplier" (7,63), "throws MetaRateMissingError rather than price a message at 0". El bloque direct no muestra cuota (fee) ni multiplicador.
- C7 «broadcast: {n} destinatarios × tarifa = US$ {x}»: [x] `broadcast-estimate/route.test.ts` › "«{n} destinatarios × tarifa de marketing» from rateFor…"; `broadcast-cost-estimate.test.tsx` › "direct: …"
- C8 «managed: cuántos entran en el paquete, cuántos a excedente y a qué precio»: [x] `broadcast-estimate/route.test.ts` › "how many fit in the package…" (toEqual del cuerpo completo, sin `unitUsd` de Meta), "a fixed price per message needs no rate"; `broadcast-cost-estimate.test.tsx` › "managed: how many fit…"
- C9 «sin tarifa: el texto lo dice y no bloquea»: [x] `broadcast-estimate/route.test.ts` › "no rate loaded…: 200 with ratePending", "a multiplier with no rate loaded…"; `meta-usage/route.test.ts` › "a missing Meta rate is «tarifa pendiente»: 200…"; `broadcast-cost-estimate.test.tsx` › "null on any failure: no line, nothing blocked".
- C10 «confirmación explícita cuando el envío genera excedente»: [ ] parcial. `broadcast-cost-estimate.test.tsx` › "step 4 disables «Enviar» until the tick…" solo hace grep del fuente de `step4-schedule-send.tsx`; no cubre el caso en que el diálogo se confirma antes de que llegue el estimado (hallazgo 1), que es justo donde la confirmación se salta.
- CP3 fuga A↔B: [x] `src/lib/security/tenant-isolation.test.ts` › "Meta usage (s10.5, service role)" (direct: RPC solo con `p_account_id = A`; managed: B con 50 entregas no entra en el paquete de A; número de B → 404), con auditoría global de consultas del rol de servicio; `meta_rates`/`meta_market_countries` exentas por ser globales (justificado).
- CP6 es/en: [x] `meta-usage-card.test.tsx` › "es and en carry the same keys and placeholders…"; verificado además a mano (33 claves, mismos placeholders).

## Checkpoints
- CP1: [x] lint/typecheck/test verdes ejecutados por mí; build no ejecutado por orden del humano.
- CP2: [x] n/a, sin SQL.
- CP3: [x] Toda consulta nueva con `supabaseAdmin()` filtra por `account_id` (`subscriptions`, `statements`, `message_charges` x2, `whatsapp_config` x2, RPC `service_quota_usage`); las tarifas son globales. Test de fuga presente.
- CP4: [ ] C10 sin test que pruebe el comportamiento (ver hallazgo 1).
- CP5: [x] `package.json`/lock sin cambios.
- CP6: [x] es/en con las mismas claves y placeholders; sin `ko`.
- CP7: [x] Route handlers `GET(request: Request)` con `NextResponse.json`, conforme a `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/route.md`.
- CP8: [x] Solo archivos justificados por §s10.5 (panel, rutas, paso 4, i18n, tests, CHANGELOG).
- CP9: [x] CHANGELOG (Unreleased) actualizado; sin variables nuevas; informe coincide con el diff.
- CP10: [x] Un commit en español con prefijo `feat:` y `Co-Authored-By`; nada pusheado.
- CP11: [x] Nada toca el webhook ni las rutas de envío; ninguna guarda de servidor nueva. La casilla es solo del diálogo del cliente; estimado fallido o pendiente → `null`/`ratePending` y el envío sigue.

## Hallazgos (archivo:línea)
1. `src/components/broadcasts/step4-schedule-send.tsx:164-179,397` — la casilla depende de `costEstimate`, que se pide sin estado de carga. Mientras el fetch está en vuelo `costEstimate` es `null` → `needsOverageConsent(null) === false` → «Enviar ahora» del diálogo queda habilitado sin casilla. Una cuenta gestionada con 100 mensajes restantes y una audiencia de 5.000 puede confirmar en esa ventana y mandar 4.900 de excedente sin la confirmación explícita que pide el spec. Lo mismo al cambiar de número: el estimado anterior sigue en estado hasta que llega el nuevo.
2. `src/app/api/billing/broadcast-estimate/route.ts:129-138` — cuenta `managed` sin `meta_pricing` válido: devuelve `remaining: 0`, así que todos los destinatarios salen como excedente («0 entran en tu paquete… 200 van a excedente») y el diálogo exige la casilla de excedente. Son cifras inventadas: no se sabe ni el tamaño del paquete ni el precio, y el panel de la misma cuenta dice «precio no configurado» (`pricing_missing`).
3. (no bloqueante) `src/lib/billing/meta-usage.ts:137-143` — si el ancla queda a más de un mes por delante, `statementPeriodStart(cutAt)` > ahora y `buildStatement` lanza `RangeError` (`statements.ts:205`), que `managedUsageOf` no captura → 500 y el bloque desaparece; en el estimado del broadcast el paquete sale entero. Con los flujos actuales el ancla no pasa de `now + 1 mes`, pero acotar `start` a `<= asOf` cuesta una línea.
4. (no bloqueante) `src/lib/billing/meta-usage.ts:284` — `countPackage` ordena solo por `delivered_at`, sin el desempate por `wamid`/`id` de `buildStatement` (`statements.ts:218-225`). Con dos entregas en el mismo milisegundo en el borde del paquete, el reparto por categoría en estado «tarifa pendiente» puede no coincidir con el del corte.
5. (no bloqueante) `src/components/broadcasts/broadcast-cost-estimate.tsx:55` — `templateCategory` duplica `asBroadcastCategory` (`meta-usage.ts:424`).
6. (no bloqueante) `src/app/api/billing/broadcast-estimate/route.ts:127` — para un único número (paquete usado) pagina todas las filas de `message_charges` del ciclo y carga `loadAccountNumbers`, que no se usa.
7. (no bloqueante) `src/components/billing/meta-usage-card.tsx:37` — el tipo `DirectUsage` se declara solo en el cliente; la ruta devuelve un literal sin tipar.

## Cambios requeridos
1. `step4-schedule-send.tsx`: llevar el estado del estimado (`loading | ready | failed`) y, mientras esté en vuelo para el reach/número actual, no habilitar la confirmación (o no abrir el diálogo); con `failed` se envía como hoy (CP11: un fallo no bloquea). Al cambiar `whatsAppConfigId`/reach, invalidar el estimado anterior antes de pedir el nuevo. Sacar la regla a una función pura (p. ej. `canConfirmSend(estimateState, consent)`) y probarla con un test de comportamiento, no con un grep del fuente: en carga → no confirma; con excedente sin casilla → no; con casilla → sí; fallido → sí; sin excedente → sí.
2. `broadcast-estimate/route.ts:129`: con `cycle.pricing === null` devolver un estado propio (p. ej. `pricingMissing: true`, sin `inPackage`/`overage` inventados) y que `needsOverageConsent` devuelva `false` en ese caso; el texto del paso 4 dice que el precio no está configurado. Test en `broadcast-estimate/route.test.ts` y en `broadcast-cost-estimate.test.tsx`.

## Segunda ronda

Commit `5349031` (`fix:`, en español, con `Co-Authored-By`), 11 archivos, solo los de la feature.

### Compuerta
- lint: verde (0 errores, 34 warnings preexistentes; ninguno en archivos del diff)
- typecheck: verde
- `TZ=UTC npx vitest run` sobre los 5 archivos de test tocados + `tenant-isolation.test.ts`: 6 archivos, 202 tests, verde
- suite completa y build: no ejecutados, por orden del líder; replay-migrations: n/a

### Cambios requeridos
1. [x] Confirmación en vuelo. `broadcast-cost-estimate.tsx` añade `EstimateState`, `estimateKey`, `estimateStateFor` y `canConfirmSend`; `step4-schedule-send.tsx` guarda la respuesta con la clave (reach|número|categoría) con que se pidió, así que una respuesta de otra clave cuenta como `loading` y deja de valer la cifra vieja; el botón del diálogo pasa a `disabled={!canSend}` y muestra «Calculando el costo del envío…». Tests de comportamiento leídos, en `broadcast-cost-estimate.test.tsx` › «when the dialog may send (step 4)»: en vuelo o con el reach contándose → no; otra clave → `loading`; excedente sin casilla → no y con casilla → sí; `failed` → sí (CP11); sin excedente, direct o sin precio → sí. Lo único que queda como grep del fuente es el cableado `disabled={!canSend}`, y la lógica ya está probada en la función pura.
2. [x] Gestionada sin precio. `broadcast-estimate/route.ts:130-139` devuelve `ManagedPricingMissingEstimate` (`pricingMissing: true`, sin `remaining`/`inPackage`/`overage`); `needsOverageConsent` devuelve `false` y `OverageConsentText` no pinta nada; texto propio `cost.managedPricingMissing`. Tests: `broadcast-estimate/route.test.ts` › «no valid price policy…» (`toEqual` del cuerpo exacto) y `broadcast-cost-estimate.test.tsx` › «a managed account without a price set up…».
3. [x] Hallazgo 3, por decisión del líder. `managedUsageOf` captura el `RangeError` y devuelve `state: 'no_period'` con los incluidos y la cuota, sin importes; la tarjeta muestra `metaUsage.noPeriod`. Tests: `meta-usage.test.ts` › «a cycle that starts in the future…», `meta-usage-card.test.tsx` › «no cycle in progress yet…», `broadcast-estimate/route.test.ts` › «an anchor more than a month ahead…» (paquete entero, sin 500).

### i18n
- [x] `loading`, `managedPricingMissing` y `noPeriod` están en es y en con los mismos placeholders (`{start}`).

### Observaciones (no bloqueantes)
- `meta-usage.ts:664`: `catch (err instanceof RangeError)` también recogería el `RangeError` de fecha inválida de `statements.ts:154` y lo mostraría como «sin periodo en curso». No hay riesgo con los datos que vienen de `currentCycle`, pero conviene comprobar `start > asOf` antes de llamar en lugar de capturar.
- Si el fetch del estimado se queda colgado sin resolver ni fallar, el diálogo no confirma. Es aceptable: el navegador acaba cerrando la petición y entonces pasa a `failed`.
- Los hallazgos 4 a 7 quedan anotados como deuda en el informe, por decisión del líder.

### Checkpoints de esta ronda
- CP4: [x] (C10 ya tiene tests de comportamiento). El resto sin cambios respecto a la primera ronda: CP1 sin build, por orden; CP3, CP5–CP11 [x].
