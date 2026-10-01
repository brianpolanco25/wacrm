# Review — p11.1 meta-payment-method-check

**Veredicto:** APPROVED

## Compuerta
- lint / typecheck / test / build: según el informe del implementer, verde (267 archivos, 3816 tests); la corre el líder en paralelo y la anota aparte. No se re-ejecuta aquí (instrucción explícita de la tarea).
- replay-migrations: verde. Ejecutado por mí: `KEEP=1 scripts/replay-migrations.sh "$(pwd)"` → exit 0, aplica 001–076 + 079 (077/078 reservadas y aún no existen, consistente con design.md), `verify-schema.sql: OK`, la 079 se reaplica sin error (NOTICE "already exists, skipping").
- `progress/checks_meta-payment-method-check.sql` ejecutado por mí contra el contenedor de replay (`docker exec -i … psql … < checks_meta-payment-method-check.sql`): exit 0, `ROLLBACK`, NOTICEs "R1 ok", "R2 ok" (×2), "R3 ok", "index ok". Confirma: CHECK rechaza `foo`; `authenticated` no puede forjar `ok`/error ni en UPDATE ni en INSERT y `label` sí cambia (el disparador no se come columnas ajenas); RLS de la 017 aísla A de B; `service_role` sí escribe; cambiar `waba_id` o `access_token` desde `authenticated` pone las tres a NULL; una renovación de token con `service_role` NO las resetea; el índice parcial tiene el predicado esperado.

## Trazabilidad criterio ↔ test
- R1 (CHECK, idempotencia): [x] migración 079 (`DO` con `IF NOT EXISTS`) + `checks_…sql` "R1 ok" + `verify-schema.sql` bloque `-- 079 --` (leído, aserta columnas/CHECK/índice/disparador).
- R2 (solo servicio escribe): [x] `checks_…sql` "R2 ok" (ambas mitades) — leído y ejecutado contra base real.
- R3 (cambio de waba_id/token invalida): [x] `checks_…sql` "R3 ok" — leído y ejecutado; incluye el caso de que la renovación de token con `service_role` NO resetea (distinción correcta con R2).
- R4 (clasificación + petición): [x] `payment-method.test.ts` `classifyFundingResponse` (ok / missing ×3 / unknown ×6, leído) y `fetchWabaPaymentStatus` (URL exacta `…/waba-a?fields=id,primary_funding_id`, método GET, `Authorization: Bearer`, `AbortSignal` de 5s); `meta-api.test.ts` para `getWabaFundingInfo`.
- R5 (permisos → unknown, un solo warn): [x] `payment-method.test.ts` `it.each([10,200,100])`, leído: asegura `warnSpy` una vez y `errorSpy` cero.
- R6 (secretos): [x] `payment-method.test.ts` "trunca a 500… nunca escribe el token" y "el token no llega a BD ni consola" — leídos, comprueban `consoleText()` y el payload de `update`.
- R7 (alta): [x] `embedded-signup/route.test.ts`, orden `['exchange','payment']` verificado (línea 699), casos ok/missing/fetch rechazado sin cambiar código HTTP.
- R8 (guardado manual): [x] `config/route.test.ts`, mismos casos + "nothing is checked when the save is refused" (orden tras `assertWritable`).
- R9 (barrido, límite, cadencias): [x] `payment-method.test.ts` "elige solo los vencidos…" (límites 59/61 min, 5/6 h, 23/24 h — leído, boundary exacto) y "como mucho 25 por pasada"; `cron/route.test.ts` bloque `payments` aditivo.
- R10 (fallo no para el barrido): [x] `payment-method.test.ts` dos variantes (fetch rechazado, check inyectado que lanza) + `cron/route.test.ts` "si el barrido de pagos lanza, el cron responde 200 con el resto intacto".
- R11/R12 (botón, rol admin, 429, fuga A↔B): [x] `config/payment-status/route.test.ts` — 401/403/429/200, "404 for B's number from A's session: no fetch, no UPDATE" leído: confirma `fetchMock` sin llamar y sin `update` en el log.
- R13 (interruptor): [x] cubierto en los cuatro puntos de uso (`payment-method.test.ts`, `payment-status/route.test.ts` 409, `billing/status/route.test.ts` banner null).
- R14/R19 (billing/status sin llamar a Meta, fuga A↔B): [x] `billing/status/route.test.ts`, leído: usa el cliente de sesión (`ctx.supabase`, no `supabaseAdmin`) con `.eq('account_id', …)` explícito; el mock de prueba aplica el filtro y el test de fuga verifica que el filtro de B nunca se manda.
- R15–R17 (banner rojo/suave): [x] `meta-payment-alert.test.tsx` (destructive vs default, enlace `_blank`/`noopener`, singular/plural) + `payment-method.test.ts` combinaciones de `metaPaymentBanner`.
- R18 (managed): [x] `metaBillingOf` (5 casos) + `billing/status/route.test.ts` "a managed account gets no banner even with a missing number" — y en ese caso el código ni siquiera consulta `whatsapp_config` (test "Nothing to decide, so nothing is read").
- R20 (Ajustes): [x] `payment-status-badge.test.tsx` (4 estados, fecha, botón habilitado/deshabilitado, oculto en managed) + `config/route.test.ts` GET `publicNumber` con los 3 campos nuevos y sin `access_token`/`verify_token`.
- R21 (ficha superadmin): [x] `accounts.test.ts` (select con los campos, sin `access_token`, `.eq('account_id', A)`) + `platform-account-detail.test.tsx` (missing en cuenta `managed` — confirma que SÍ se ve, a diferencia del badge de Ajustes) + ruta nueva con su propio test de fuga A↔B.
- R22 (entrante no cambia): [x] `webhook/route.test.ts` nuevo `it.each(['missing','unknown'])`, leído: confirma upsert + RPC de bump sin tocar `webhook/route.ts` (confirmado también por `git diff --stat`, el archivo no aparece).
- R23 (no bloquea envíos): [x] `metaPaymentBanner` "no lee ni devuelve readOnly"; `enforce.ts`/`entitlements.ts`/rutas de envío ausentes del diff (confirmado por `git diff --stat`).
- R24 (i18n es/en): [x] `meta-payment-alert.test.tsx` recorre las 19 claves nuevas (`Billing.metaPayment.*` ×5, `Settings.whatsapp.payment*` ×7, `Platform.payment*` ×8 con solape de 7) y compara placeholders ICU; verificado también por mí con un script aparte (las 19 claves existen en ambos catálogos, mismos placeholders ICU — el único "mismatch" de mi primer chequeo fue un falso positivo de mi propio regex, no del código).

## Checkpoints
- CP1: [x] según informe (267 archivos / 3816 tests, 0 lint, 0 typecheck, build con rutas nuevas listadas); lo confirma el líder en paralelo.
- CP2: [x] migración 079 idempotente, aserciones en `verify-schema.sql` para columnas/CHECK/índice/disparador, replay en verde (verificado por mí), sin `CASCADE`.
- CP3: [x] todo `supabaseAdmin()`/rol de servicio nuevo filtra por `id` + `account_id` (`recordPaymentStatus`, `checkAndRecordPaymentStatus`, el barrido); tests de fuga A↔B en `payment-status/route.test.ts`, `platform/.../payment-status/route.test.ts`, `tenant-isolation.test.ts`, `billing/status/route.test.ts`. El barrido del cron (`sweepPaymentStatus`) lee entre cuentas por diseño pero escribe con `id`+`account_id` de la fila leída (test "cada escritura lleva el id y el account_id de su fila"); no está cubierto por `tenant-isolation.test.ts` (igual que `renewExpiringTokens`), así que no exige waiver ahí.
- CP4: [x] cada R tiene test leído (ver tabla); lo que exige base real tiene SQL ejecutado por mí; lo que depende de Meta real queda en el guion manual de `requirements.md`, reproducido en el informe.
- CP5: [x] `package.json`/`package-lock.json` sin cambios (`git diff` vacío).
- CP6: [x] 19 claves nuevas en `es.json` y `en.json`, mismos placeholders ICU; sin `ko.json` (test dedicado).
- CP7: [x] el nuevo route handler de plataforma usa `context: { params: Promise<{ id: string }> }`, el mismo patrón que el `route.ts` hermano (`accounts/[id]/route.ts`) ya existente en la rama.
- CP8: [x] `git diff --stat 194e4e6..HEAD` no toca `webhook/route.ts`, `enforce.ts`, `entitlements.ts`, `billing-status-alert.tsx` ni rutas de envío; todo lo demás está justificado por una fila de la tabla de "puntos de enganche" del diseño.
- CP9: [x] CHANGELOG (Unreleased, con nota de `--include-all`), `docs/docker.md` con `META_PAYMENT_CHECK_DISABLED` y el aviso explícito de que S-M1/S-M2 siguen sin verificar; informe coincide con el diff.
- CP10: [x] 2 commits en español con prefijo (`feat:`/`chore:`) y `Co-Authored-By`; sin push (confirmado, no hay remoto configurado para empujar en esta sesión y el informe lo declara).
- CP11: [x] `cron/route.ts` envuelve `sweepPaymentStatus` en `try/catch` propio (defensa adicional a que la función ya no lanza) y el test "si el barrido de pagos lanza, el cron responde 200 con el resto intacto" lo prueba; el webhook entrante no se toca.

## Decisiones del implementer — veredicto
1. **Ruta `POST /api/platform/accounts/[id]/payment-status` sin `impersonation_log`.** Aceptada: `requirePlatformAdmin()` corre antes de tocar la base (confirmado en el código), la lectura y escritura usan `accountId: id` de la URL (no de ningún otro origen), y el test "404 for B's number under A's URL: no fetch, no write" confirma la fuga A↔B cerrada. Es diagnóstico puro (no cambia plan, acceso ni datos del cliente) y el barrido del cron la reescribe sola; razonable no forzar otra migración al CHECK de la 071 solo para esto.
2. **Filtro del barrido con `.or()` + `and(...)` anidado.** Sintaxis correcta de PostgREST (`or=(a,and(b,c))`, forma estándar y documentada, no afectada por los cambios de Next 16/React 19). Lo confirma además que `src/lib/security/fake-supabase.ts` — archivo que esta feature NO toca, ya usado por otras rutas del repo — trae un parser genérico de `.or()`/`and()` anidado (`parseOrExpression`/`parseClause`) que reproduce la gramática real de PostgREST, y los tests de `sweepPaymentStatus` pasan contra él con los boundary cases correctos (missing 59min no entra, 61min sí; unknown 5h no, 6h sí; ok 23h no, 24h sí). No hace falta un guion `psql` aparte: la sintaxis en sí es estándar de PostgREST, no un supuesto de Meta.
3. **Botón del cliente con `requireRole('admin')` sin `allowReadOnly`.** Confirmado en `src/lib/auth/account.ts`: sin esa opción, un rol por debajo del mínimo en modo lectura cae en el bloqueo (403). Lectura literal del spec (R11 no pide `allowReadOnly`); el barrido sigue comprobando esas cuentas igual. Aceptada.
4. **`/api/billing/status` selecciona `meta_billing` por nombre.** Confirmado: la 076 (`subscriptions.meta_billing text NOT NULL DEFAULT 'direct'`) está en esta rama (`git log` muestra `076_meta_rates.sql` aplicada en el replay). Aceptada, con la advertencia ya escrita en el informe: no es cherry-pickable sin la 076.
5. **`META_PAYMENT_CHECK_DISABLED=1` → `payment_status: null` en alta/guardado, 409 en el botón, banner null.** Cubierto por test en los cuatro puntos de uso (ver R13 arriba).

## Hallazgos (archivo:línea)
Ninguno bloqueante. Dos observaciones menores, ya anotadas como deuda por el propio implementer y sin impacto en el veredicto:
1. `progress/impl_meta-payment-method-check.md:114` — durante una sesión de soporte, si la RLS no deja ver los números de la cuenta suplantada, `/api/billing/status` (con el cliente de la sesión) mostraría "sin banner" en vez de reflejar el estado real. Es un fallo seguro (a "nada", no a un falso rojo) y queda fuera del alcance de p11.1; no bloquea.
2. `.env.local.example` no se tocó (permiso denegado al implementer, como estaba previsto); falta añadir `# META_PAYMENT_CHECK_DISABLED=1` comentada — lo hace el humano, según la nota de alcance del CLAUDE.md del repo.

## Cambios requeridos
Ninguno.
