# Review — n13.1 integrations-catalog

**Veredicto:** APPROVED (ronda 2; ronda 1 fue CHANGES_REQUESTED, abajo)

Rama `feat/integraciones`, 7 commits 2dab443..ee06411 sobre `main` @ 5f64211. Worktree limpio; `main` intacto (5f64211); nada pusheado.

## Compuerta (ejecutada por el reviewer, gate dirigido)
- lint: verde (exit 0; 0 errores, 34 warnings previos, ninguno en archivos del diff)
- typecheck: verde
- vitest dirigido (`TZ=UTC`, 55 archivos: todos los `*.test.ts(x)` del diff + `src/lib/billing`, `src/components/settings`, `src/i18n`): 1202/1202 verde
- build y suite completa: no corridos (instrucción del líder; el informe declara build verde)
- replay-migrations: verde (`ok 091_integrations.sql`, `verify-schema.sql: OK`, exit 0). 091 reaplicada sobre la misma base: exit 0 y verify OK otra vez. `progress/checks_integrations-catalog.sql`: 29 PASS, exit 0.

## Trazabilidad criterio ↔ test
- R1 «4 tablas, FK RESTRICT, idempotente»: [x] replay + reaplicación + checks SQL + bloque `-- 091` en verify (cuenta 3 FK RESTRICT).
- R2 «anon/authenticated sin acceso»: [x] checks SQL (SELECT/INSERT/UPDATE/DELETE denegados) + verify (RLS, sin políticas, `has_table_privilege`).
- R3 «enabled ⇒ credential»: [x] checks SQL `account_integrations_enabled_has_credential`.
- R4 «401/403 en plataforma»: [x] `route.test.ts` de las 4 rutas + `tenant-isolation.test.ts` › "(6) the platform routes 403 the owner of A and write nothing" (tablas byte a byte iguales).
- R5 «validación de alta; 201 con is_active=false; host no literal privado»: [ ] PARCIAL. Los casos listados en el spec están cubiertos (`catalog-validate.test.ts`), pero (a) `https://[::ffff:127.0.0.1]` pasa (hallazgo 1) y (b) un POST con `is_active: true` crea la integración activa (hallazgo 2).
- R6: [x] `[id]/route.test.ts` (PATCH parcial, slug → 400, 404).
- R7: [x] `catalog-validate.test.ts` + `operations/route.test.ts` + `operations/[opId]/route.test.ts`.
- R8: [x] `validateRelativePath (R8)` + marcadores ↔ params.
- R9: [x] `catalog-validate.test.ts` (ejemplo "crear cita", 12 params inválidos, path ⇒ required, GET/DELETE sin body).
- R10: [x] `exports no DELETE (R10)` ×3; retirar no toca activaciones; R14/R30 con integración inactiva.
- R11: [x] `platform-integrations.test.tsx`, `platform-integration-editor.test.tsx`, `integration-form.test.ts`, `platform-shell.test.tsx`; páginas con `guardPlatformPage`.
- R12: [x] `plan-catalog.test.ts` (marcador `Claves de features añadidas`) + checks SQL `count = 0`.
- R13: [x] 402 en PUT y test; DELETE sin feature 200; `planAllows false`.
- R14: [x] `account/integrations/route.test.ts` › forma exacta con `toEqual`, sin cifrado/claro/`"credential"`; retirada sin activación ausente; con activación `retired: true`.
- R15: [x] `[integrationId]/route.test.ts` (`decrypt(row) === entrada`, upsert sin duplicar, 400 por `\r\n`/control/4097, 404 inactiva).
- R16: [x] `403 for agent/viewer` en PUT, DELETE y test.
- R17: [x] credencial y last4 a NULL, fila conservada, idempotente, 404 sin fila.
- R18: [x] `test/route.test.ts` + `execute.test.ts` (200/204/401/403/500/302, timeout, DNS privado, 429).
- R19: [x] `integration-card-state.test.ts` + `integrations-settings.test.tsx` (marcado estático; sin navegador, declarado).
- R20: [x] `expectNoSecretsLeaked` (console.* e `integration_calls`) en éxito/500/invalid/excepción/fallo de registro. Grep propio: `decrypt(` fuera de tests solo en `src/lib/integrations/execute.ts:246` y `:326`.
- R21: [x] `request.test.ts` (`%2E%2E%2Fadmin`, `@evil.com`, segmento de punto bloqueado).
- R22: [~] `http.test.ts` prueba el cableado (resolutor inyectado → sin fetch), pero el resolutor real deja pasar IPv4-mapped en hex (hallazgo 1).
- R23: [x] 302 a metadata → `http_error`, un solo fetch, `redirect: 'manual'`.
- R24: [x] relojes simulados, aborta a 10 000 ms.
- R25: [x] content-length grande sin `getReader`; stream > 256 KiB cortado y `cancel` llamado.
- R26: [x] 61.ª de A limitada, B pasa.
- R27: [x] `request.test.ts` (coerción y problemas) + `execute.test.ts` (JSON, texto, 500, excepción de BD sin lanzar). Ver hallazgo 3 (parámetro con nombre de `Object.prototype`).
- R28: [x] fila exacta por outcome; fallo de inserción conserva resultado y solo loguea el código.
- R29: [x] cabeceras exactas con/sin cuerpo.
- R30: [x] cinco casos `not_enabled` sin petición; slug inexistente sin fila.
- R31: [x] `tenant-isolation.test.ts` › bloque `integrations (n13.1, service role)` (1)–(6) + edición del operador; B sembrada antes que A con otra credencial; waivers con motivo; mutación documentada en el informe.
- R32: [x] `support-scope.test.ts` (PUT/DELETE/POST test block, GET pass), `middleware.test.ts`, 403 en las tres rutas; GET con `canManage: false`.
- R33: [x] `reencrypt.test.ts` (lista + fila NULL saltada); `docs/security.md`.
- R34: [x] paridad de claves es/en en los dos `*.test.tsx` + `messages.test.ts`.
- R35: [x] `git diff --name-only`: ni webhook, ni flows, automations, ai, ni `package.json`.

## Decisiones humanas D1–D6
- D1 declarativo: [x] filas + un ejecutor; sin código por integración.
- D2 feature `integrations` apagada: [x] (checks SQL count = 0; tampoco en ilimitado/gestionado — ver decisión 1 del informe).
- D3 soporte bloqueado: [x] middleware + `assertNotSupportSession`.
- D4 sin punto de uso: [x] `executeIntegrationOperation` sin llamador de producción.
- D5 desactivar borra credencial: [x].
- D6 10 s / 256 KiB / 60 por min por cuenta: [x] (`types.ts`, `RATE_LIMITS.integrationCall`).

## Checkpoints
- CP1: [x] lint/typecheck/vitest dirigido verdes por el reviewer; build no corrido por instrucción del líder.
- CP2: [x] 091 idempotente (reaplicada), aserciones en verify, replay 0. CASCADE solo desde `accounts` (convención: borrado de la empresa entera); hacia `integrations`, RESTRICT.
- CP3: [x] `account_integrations`/`integration_calls` siempre con `account_id`; único cruce = recuento del operador, con waiver.
- CP4: [ ] R5 parcial (hallazgos 1 y 2).
- CP5: [x] `package.json` sin cambios.
- CP6: [x] mismas claves es/en.
- CP7: [x] `params: Promise<…>` y segmento estático vs `[id]` citados contra `node_modules/next/dist/docs/`.
- CP8: [x] fuera del design solo tests de guardas (billing, i18n, middleware), justificados en el informe.
- CP9: [x] CHANGELOG Unreleased; sin variables nuevas; informe coincide con el diff. (Menor: el CHANGELOG llama a la feature «Cabbity app integrations» y el texto real es «Integrations with other apps».)
- CP10: [x] 7 commits en español con prefijo y Co-Authored-By; nada pusheado.
- CP11: [x] nada en el camino de entrada.

## Hallazgos (archivo:línea), priorizados

1. **[Bloqueante, SSRF]** `src/lib/integrations/catalog-validate.ts:133` y `src/lib/webhooks/ssrf.ts` (`isPrivateOrReservedIp`, regex de IPv4-mapped) — el parser WHATWG serializa `[::ffff:127.0.0.1]` como `[::ffff:7f00:1]` y `[::ffff:169.254.169.254]` como `[::ffff:a9fe:a9fe]`; la regex solo reconoce la forma con puntos. Comprobado ejecutándolo: `validateIntegrationInput({base_url:'https://[::ffff:127.0.0.1]/api',…})` → `ok: true` (guarda `https://[::ffff:7f00:1]/api`), `isForbiddenHost` → false, `isDeliverableUrl` → true para loopback y metadata. Incumple R5 («host no literal privado») y vacía R22 en tiempo de llamada. Solo un platform_admin fija `base_url`, así que el riesgo en esta feature es medio; pero el mismo helper protege los **webhooks de cliente** (`webhooks:manage`), donde la vía sí es explotable por un admin de cuenta → vulnerabilidad preexistente que conviene escalar aparte.
2. **[Bloqueante, R5]** `src/lib/integrations/catalog-validate.ts:351` — `is_active` se acepta en modo `create` y `POST /api/platform/integrations` (`route.ts:89`) lo escribe: el alta puede nacer activa y visible para todos los clientes. R5: «éxito → 201 con `is_active = false`». Falta test.
3. **[Bloqueante, bug]** `src/lib/integrations/request.ts:150-168` — `values` es un `{}` normal y `PARAM_NAME_RE` (`catalog-validate.ts:52`) admite `toString`, `constructor`, `valueOf`, `hasOwnProperty`…; un parámetro opcional omitido con ese nombre lee la función heredada: el query sale como `constructor=function Object() { [native code] }` o se manda un cuerpo y `Content-Type` sin parámetros de cuerpo.
4. [No bloqueante, decisión humana] `src/app/api/platform/integrations/[id]/route.ts:102` — cambiar `base_url`, `auth_scheme` o `auth_header_name` de una integración con activaciones hace que la siguiente llamada mande la credencial descifrada de cada cuenta al origen/cabecera nuevos, sin aviso ni reset. Proponer al humano: bloquear el cambio de origen con activaciones, o desactivarlas, o al menos confirmar en la UI.
5. [No bloqueante] `src/lib/integrations/account.ts:37` — `validateCredential` acepta caracteres > U+00FF (comillas tipográficas al pegar); undici rechaza la cabecera y el resultado es `unreachable`, no 400. Rechazar `/[^\x20-\x7e]/` (o > 0xFF) en la entrada.
6. [No bloqueante] `src/lib/platform/integrations.ts:81-85` — el recuento `accountsEnabled` trae todas las filas activas; PostgREST corta en `max_rows` (1000) en silencio.
7. [No bloqueante] `src/lib/integrations/http.ts:168-171` — 2xx con JSON inválido → `http_error` con status 200 (contradictorio para n13.2); valorar un outcome propio.
8. [No bloqueante] `src/app/api/account/integrations/[integrationId]/test/route.ts:48` — «Probar» gasta el mismo cubo de 60/min que los flows y el `Retry-After` es fijo a 60 s; considerar un cubo por usuario para la prueba (`RATE_LIMITS.adminAction`) además del de cuenta.
9. [Deuda conocida] DNS rebinding (`http.ts:115` resuelve y `fetch` vuelve a resolver): ya documentada; relevante cuando n13.2 devuelva cuerpos a flows.

## Decisiones del informe (juicio)
- 1 (ilimitado/gestionado sin `integrations`, guardas filtradas por marcador): aceptada; mecánicamente necesaria y coherente con D2. **Confirmar con el humano** si el plan ilimitado de operadores debe traerla.
- 2, 3 (textos sin «Cabbity», etiquetas idénticas): aceptadas.
- 4 (prefijo + no-normalización, `.` codificado): aceptada, más estricta que el spec.
- 5 (`last4` solo con ≥ 12 caracteres; rechazar espacios en bordes): aceptada.
- 6, 7 (prueba sobre retirada → 404; prioridad de estados): aceptadas.
- 8 (429 con Retry-After 60): aceptable; ver hallazgo 8.
- 9 (AbortController propio): aceptada.
- 10 (PATCH completo desde la UI): aceptada.
- 11 (`key` editable): aceptable para n13.1, pero n13.2 debe referirse por id o congelar `key` con uso; anotarlo en el spec de n13.2.
- 12 (semilla TEST-NET-3): aceptada.

## Cambios requeridos
1. Reconocer IPv4-mapped en hex (`::ffff:XXXX:XXXX`, y de paso `::XXXX:XXXX` compatible y `64:ff9b::/96`) como privado. Lo correcto es corregir `isPrivateOrReservedIp` en `src/lib/webhooks/ssrf.ts` con test (arregla también webhooks) — fuera del alcance literal de n13.1: **el líder decide** si se autoriza aquí o va en una feature de seguridad aparte; si no se autoriza, como mínimo `isForbiddenHost` debe rechazar todo literal IPv6 IPv4-mapped/compatible, y `http.ts` igual antes de `fetch`. Tests en `catalog-validate.test.ts` y `http.test.ts` con `https://[::ffff:127.0.0.1]` y `https://[::ffff:169.254.169.254]`.
2. En `validateIntegrationInput(…, 'create')` ignorar o rechazar `is_active` (o forzar `false` en `createIntegration`); test en `route.test.ts`: POST con `is_active: true` → fila con `is_active = false`.
3. En `buildIntegrationRequest` leer con `Object.hasOwn(values, name)` (o `values` con `Object.create(null)` en `validateCallParams`); test con un parámetro opcional `constructor`/`toString` omitido → sin query ni cuerpo.
4. (Recomendado, mismo ciclo) hallazgo 5.

---

## Ronda 2

**Veredicto final:** APPROVED

Commits 7093949, 02093ff, 4ec171d, 42c3f47, c91a215 sobre ee06411. Worktree limpio.

### Compuerta (ejecutada por el reviewer)
- lint: verde (0 errores, 34 warnings previos). typecheck: verde.
- vitest dirigido (`TZ=UTC`, 39 archivos: todos los `*.test.ts(x)` del diff de la feature + `src/lib/webhooks` + `src/lib/automations`, consumidores de `ssrf.ts`): 870/870 verde.
- replay: n/a (sin SQL nuevo; 091 sin cambios desde la ronda 1).

### Hallazgos de la ronda 1
1. SSRF IPv4 incrustado en IPv6 — **resuelto**. `src/lib/webhooks/ssrf.ts` (`ipv6Groups` + `embeddedV4`) normaliza a 8 grupos y evalúa el IPv4 de IPv4-mapped (hex y puntos), IPv4-compatible (incluye `::1` → `0.0.0.1`) y NAT64 `64:ff9b::/96`; `64:ff9b:1::/48` y una IPv6 ilegible cuentan como reservadas (falla cerrado). `src/lib/integrations/http.ts:117-125` aplica además `isForbiddenHost` antes del resolutor. Tests leídos: `ssrf.test.ts` (14 formas privadas, mismas formas públicas permitidas, `isDeliverableUrl` con `[::ffff:127.0.0.1]`/`[::ffff:169.254.169.254]`), `catalog-validate.test.ts` (5 `base_url`), `http.test.ts` (literal bloqueado sin `fetch` aunque el resolutor diga sí). Arregla también los webhooks de cliente (autorizado por el líder; consumidores de webhooks/automations en verde).
2. Alta activa (R5) — **resuelto**. `catalog-validate.ts:355` rechaza `is_active: true` en `create` y no lo copia; `src/lib/platform/integrations.ts` `createIntegration` fuerza `is_active: false`. Tests: `route.test.ts` › POST con `is_active: true` → 400 sin fila; con `false` → fila inactiva; formulario sin `is_active`.
3. Miembros heredados — **resuelto**. `request.ts` `ownValue` con `hasOwnProperty` en path y query/body. `request.test.ts` › `parameters named like Object.prototype members` (constructor/toString/valueOf omitidos → sin query ni cuerpo).
4. Cambio de destino de la credencial — **resuelto** (opción «confirmar y desactivar en todas»). `[id]/route.ts`: cambio de origen, esquema o cabecera con activaciones → 409 `integration_in_use` sin escribir; con `reset_activations: true` borra credencial/last4/prueba en todas y guarda. Tests en `[id]/route.test.ts` (5 casos) y `tenant-isolation.test.ts` (waivers nuevos con motivo, escritura cruzada solo del operador). **Decisión de producto a confirmar por el humano.** Riesgos residuales menores: el reset y el update no son atómicos (si el update falla tras el reset, las cuentas quedan desactivadas, que es el lado seguro) y una activación que entre entre el recuento y el reset se resetea igual por el `.eq('is_enabled', true)` del update.
5. Credencial no ASCII — **resuelto**. `account.ts:41` `/[^\x20-\x7e]/` → 400; tests de comillas tipográficas, tilde y NBSP.

Nota CP9 de la ronda 1 (nombre en CHANGELOG): corregida.

### Deuda que queda (no bloqueante, anotada en el informe)
Hallazgos 6 (`accountsEnabled` sujeto a `max_rows`), 7 (2xx con JSON inválido → `http_error`), 8 (cubo por usuario para «Probar»), 9 (DNS rebinding); decisión 11 (`key` editable) a recoger en el spec de n13.2. Pendiente del humano: plan ilimitado sin `integrations` (decisión 1) y política del hallazgo 4. Guion manual (httpbin) pendiente de humano.

### Checkpoints (ronda 2)
CP1 [x] (gate dirigido; build no corrido por instrucción) · CP2 [x] · CP3 [x] · CP4 [x] · CP5 [x] · CP6 [x] (claves nuevas `Platform.integrations.errors.inUse*` en es/en, paridad en verde) · CP7 [x] · CP8 [x] (`ssrf.ts` fuera del alcance original, autorizado por el líder) · CP9 [x] · CP10 [x] · CP11 [x].
