# Integración fase 7 — `api/recursos` (a7.1) + `api/webhooks` (a7.4)

Tarea de integración; no es una feature de `feature_list.json`.
Worktree `.claude/worktrees/api-recursos`, rama `api/recursos`.
Punto de partida: `api/recursos` @ a16e2b0 (a7.1 `api-hardening`, APPROVED) y
`api/webhooks` @ 170d73e (a7.4 `webhooks-durable`, APPROVED). Base común de ambas:
`feat/api-publica` = `main` @ 3b82698.

## Plan (escrito antes de tocar nada)

1. `git merge api/webhooks` y resolver conservando ambos lados.
2. Cerrar las deudas de merge que dejaron los informes: el cubo de rate limit, el `conflict`
   sin tipar, el sujeto equivocado del CHANGELOG, la frase de `IN_FLIGHT_STALE_MS` y los
   tests de 413/415 de `POST /api/v1/webhooks`.
3. Compuerta paso a paso + replay 001–062 + los dos SQL de comprobación contra el contenedor.
4. Commits; `merge --ff-only` para que `feat/api-publica` avance.

Los cuatro pasos salieron; nada quedó bloqueado.

## Commits

| Commit | Qué es |
|---|---|
| `06050c6` | `merge:` la integración en sí, con la resolución de los tres conflictos |
| `305ca1a` | `fix:` las cuatro deudas de merge (cubo de rate limit, `conflict` tipado, dos redacciones) + el cubo de 20/min documentado en `docs/public-api.md` |
| `6b0d768` | `test:` el 413 y el 415 de `POST /api/v1/webhooks` |

`feat/api-publica` avanzó por *fast-forward* a `6b0d768` (`git merge --ff-only`, salida 0).
Nada pusheado: `git ls-remote --heads origin` no devuelve ninguna de las tres ramas.
`main` sigue en 3b82698 y `dev` en 4756a47.

## Conflictos y cómo se resolvieron

El merge tocó 60 archivos. Solo **tres** dieron conflicto; las rutas de `/api/v1/webhooks`,
los tres catálogos de mensajes y la suite de aislamiento fusionaron solas (ver abajo).

| Archivo | Por qué chocó | Resolución |
|---|---|---|
| `CHANGELOG.md` | las dos ramas añadieron viñetas al mismo `### Added`, y a7.4 metió su nota de migración **dentro** de la sección mientras a7.1 había agrupado la suya arriba | se conservan las dos listas completas (3 viñetas de a7.1 + 4 de a7.4) y la nota de la 062 sube al bloque de notas de migración, detrás de la de la 061 |
| `docs/public-api.md` (×2) | a7.4 pasó prettier al documento entero y realineó dos tablas que a7.1 también editaba | tabla de códigos de error → lado a7.1 (aporta `conflict`, `idempotency_mismatch`, `payload_too_large`, `unsupported_media_type`); tabla de eventos → lado a7.4 (aporta los ocho eventos de dominio). En cada choque el lado descartado era **solo** realineado de columnas, verificado con `git diff 3b82698 <rama> -- docs/public-api.md`. `npx prettier --check` limpio después |
| `supabase/ci/verify-schema.sql` | los bloques de la 061 y de la 062 se escribieron en el mismo punto del `DO $$` | **se conservan los dos bloques enteros**, 061 primero y 062 después, cada uno con su `END IF;`. Ninguna migración depende de la otra |

Lo que **no** chocó y conviene dejar por escrito, porque la instrucción lo daba por conflictivo:

- `src/app/api/v1/webhooks/route.ts` y `[id]/route.ts` — a7.4 no los tocó (`git diff 3b82698
  api/webhooks -- src/app/api/v1/webhooks/` son 8 archivos, todos **nuevos**: rutas hermanas
  bajo `[id]/deliveries`, `[id]/test` y `[id]/rotate-secret`). La sustitución de `request.json()`
  por `readJsonBody` que hizo a7.1 sigue en pie en las dos, comprobado por `grep`.
- `messages/{es,en,ko}.json` — fusión automática limpia; los tres cargan como JSON válido y
  `src/i18n/messages.test.ts` (paridad de claves + placeholders ICU) pasa.
- `src/lib/security/tenant-isolation.test.ts` — fusión automática; conserva el test de a7.1
  («la idempotencia de la fase 7 §1 no cruza cuentas…», línea 1295) **y** el de a7.4
  («deliveries: solo las de A; el endpoint y la entrega de B → 404…», línea 1456). No se
  descartó ningún test de ninguna rama.

## Deudas cerradas

| Deuda | Origen | Qué se hizo |
|---|---|---|
| `WEBHOOK_ACTION_RATE_LIMIT` fuera de `RATE_LIMITS` | `impl_webhooks-durable.md` §Deuda 1 | pasa a `RATE_LIMITS.webhookAction` en `src/lib/rate-limit.ts` (mismo valor: 20/min por cuenta), con su comentario explicando por qué es por cuenta y no por clave. Se borra de `src/lib/webhooks/manage.ts` y se actualizan los **seis** puntos de uso: `src/app/api/v1/webhooks/[id]/{test,rotate-secret,deliveries/[deliveryId]/retry}/route.ts` y los tres equivalentes bajo `src/app/api/account/webhooks/`. `grep -rn WEBHOOK_ACTION_RATE_LIMIT src/` ya no encuentra nada |
| `fail('conflict', …, 409)` escrito a mano | `impl_webhooks-durable.md` §Deuda 2 | `src/app/api/v1/webhooks/[id]/deliveries/[deliveryId]/retry/route.ts` pasa a `throw conflict('…')`, el constructor tipado de `respond.ts`; el `catch` lo mapea por `toApiErrorResponse` y el código sale de `ApiErrorCode`, no de una cadena. El test existente («409 cuando ya estaba en cola», que además comprueba `error.code === 'conflict'`) sigue verde sin tocarlo |
| `CHANGELOG.md:428` con el sujeto equivocado | `review_api-hardening.md` 2.ª ronda, hallazgo 1 | «A key rotation that died mid-flight no longer blocks the `Idempotency-Key`…» → «A **request** that died mid-flight no longer blocks **its** `Idempotency-Key`…» |
| `idempotency.ts:91` prometía un techo global | `review_api-hardening.md` 2.ª ronda, hallazgo 2 | «twice the longest handler **the app allows**» → «twice the longest handler **of the ones wrapped in this helper**», y se nombra explícitamente `POST /api/whatsapp/broadcast/{id}/resume` (`maxDuration = 300`) como el contraejemplo, con la regla de qué hacer si algún día se envuelve un handler más largo |
| sin test de 413/415 en `POST /api/v1/webhooks` | `review_api-hardening.md` 2.ª ronda, hallazgo 5 | dos `it` nuevos en `src/app/api/v1/webhooks/route.test.ts`, patrón de `contacts/route.test.ts` |

### Fuera de la lista, pero del mismo merge

`docs/public-api.md` §Rate limits solo hablaba de los 120/min por clave. Las tres acciones
caras de webhooks que introdujo a7.4 responden 429 a las 20/min **por cuenta**, y eso no
estaba en el contrato publicado. Se documenta en tres líneas junto al resto de los límites.
Es el mismo commit `305ca1a`; lo considero parte de mover el cubo, no alcance nuevo.

## Criterio ↔ test (lo añadido aquí)

| Qué se afirma | Test |
|---|---|
| `POST /api/v1/webhooks` rechaza 1 MiB + 1 con 413 `payload_too_large` **y no inserta** | `src/app/api/v1/webhooks/route.test.ts` › `POST /api/v1/webhooks — guardas de cuerpo compartidas` › «rechaza un cuerpo de 1 MiB + 1 con 413 y no registra nada» |
| `POST /api/v1/webhooks` rechaza `text/plain` y la falta de `Content-Type` con 415 `unsupported_media_type` **y no inserta** | mismo archivo › «rechaza text/plain con 415, y la falta de Content-Type también» |

Los dos construyen bytes de verdad (no un `Content-Length` falseado) y afirman
`mocks.state.inserted === null`, que es lo que distingue un tope aplicado durante la lectura
de uno aplicado después de bufferizar. El resto de la trazabilidad de la fase la conservan
`progress/impl_api-hardening.md` y `progress/impl_webhooks-durable.md`, que siguen siendo
válidos: el merge no cambia ningún criterio de aceptación.

## Compuerta

Ejecutada por mí, paso a paso, en primer plano, en el worktree, sobre `6b0d768`:

| Paso | Resultado |
|---|---|
| `npm run lint` | **verde** — 0 errores, 35 avisos (los mismos preexistentes de las dos ramas) |
| `npm run typecheck` | **verde** |
| `TZ=UTC npm test` | **verde** — **172 archivos, 2 232 tests**, 0 fallos |
| `npm run build` (variables dummy de `docs/harness.md`) | **verde** — «✓ Compiled successfully in 8.6s» |

### Replay de migraciones

`scripts/replay-migrations.sh "$(pwd)"` → **EXIT=0**, 62 migraciones aplicadas (001→062, con
la 061 y la 062 seguidas) y `verify-schema.sql: OK`. Es la primera vez que las dos migraciones
de la fase corren en la misma base: ninguna depende de la otra y el bloque fusionado del
`verify-schema.sql` comprueba los dos juegos de objetos.

### SQL contra base real

Con `KEEP=1` y `docker exec … psql -U postgres -v ON_ERROR_STOP=1`:

- `progress/checks_api-hardening.sql` → **EXIT=0**, los 7 bloques en `NOTICE … OK`
  (defecto de `expires_at`, 23505 del índice único, convivencia entre claves de API,
  `authenticated` ve 0 filas, `service_role` ve 3, alcance del CASCADE, uso del índice de purga).
- `progress/checks_webhooks-durable.sql` → **EXIT=0**, bloques A–E y
  `checks_webhooks-durable: OK` (CHECK de `status`, RLS real, reclamo optimista, cascadas,
  índice parcial del barrido).

### Sobre el recuento de tests

172 archivos coincide exactamente con lo que hay en el árbol (`git ls-tree … | grep -c
'\.test\.tsx\?$'`): 153 en `main` @ 3b82698, +7 de a7.1, +12 de a7.4. El total de **tests**
(2 232) no cuadra con la suma ingenua de los dos informes porque `impl_webhooks-durable.md`
cita una base de «155 archivos / 2 103» que no corresponde a 3b82698 (ahí hay 153). El número
que doy es el que imprime vitest en esta rama, medido por mí; los de cada rama por separado
los reportaron sus agentes.

## Verificaciones manuales pendientes

Se heredan enteras de los dos informes; el merge no cierra ninguna ni añade ninguna.

1. **Cron en un despliegue** (de a7.4): `curl -H "x-cron-secret: $WEBHOOK_CRON_SECRET"
   https://<host>/api/webhooks/cron` cada minuto; comprobar que `scanned/attempted/delivered/
   purged` avanzan en el JSON. Sin la variable, 503 a propósito.
2. **Ida y vuelta con un receptor real** (de a7.4): alta en Ajustes → Webhooks contra
   webhook.site, «Probar», verificar la firma con el fragmento de `docs/public-api.md`; apagar
   el receptor, etiquetar un contacto, ver la entrega `failed` con `next_attempt_at` a +1 min,
   encender y comprobar que el barrido la entrega.
3. **SSRF con DNS cambiante** (de a7.4): dominio que resuelva público y se repunte a 10.x entre
   el alta y la entrega.
4. **Nuevo, de este merge — el 429 de 20/min ahora es compartido de verdad.** Antes del merge
   el cubo se llamaba `webhookAction:<accountId>` desde una constante duplicada por módulo; sigue
   llamándose igual, así que el comportamiento no cambia. Guion: con una clave de API, llamar 20
   veces a `POST /api/v1/webhooks/{id}/test` y comprobar que la 21.ª es 429 con `Retry-After`;
   después, **desde el panel** (Ajustes → Webhooks → Probar, que es cookie, no clave de API),
   comprobar que también está agotado — es el mismo cubo por cuenta. Automatizado en los tests
   de cada ruta por separado; lo que no cubre el mock es que las seis rutas comparten llave.

## Decisiones donde había margen

1. **Prettier no se re-corrió sobre `docs/public-api.md` entero.** El conflicto venía de que
   a7.4 formateó el documento; al quedarme con el lado de a7.1 en la primera tabla podía haber
   dejado el archivo fuera de formato. `npx prettier --check docs/public-api.md` sale limpio,
   así que no hay ruido de formato mezclado con contenido en el diff del merge.
2. **`fail()` sigue aceptando `code: string`.** Tentaba estrecharlo a `ApiErrorCode` y tipar de
   golpe sus 46 puntos de uso, pero hay un `fail('meta_error', …)` que no está en el enum, así
   que estrecharlo obligaría a decidir sobre un código que no es de esta tarea. Se tipa solo lo
   que pedía la deuda (el `conflict` de la ruta de reintento) y lo demás queda anotado abajo.
3. **La nota de migración de la 062 sube al bloque de notas.** a7.4 la había dejado dentro de
   `### Added`, entre viñetas; a7.1 había agrupado la de la 061 con las otras seis notas de
   migración de la versión. Una de las dos convenciones tenía que ganar y gana la que ya seguían
   las seis notas anteriores.
4. **La ruta del panel (`/api/account/webhooks/…/retry`) conserva su 409 con
   `NextResponse.json({ error: '…' })`.** No pasa por el sobre de `/api/v1` (es la API interna
   del panel, otro contrato); tiparla con `ApiErrorCode` sería cambiarle la forma de respuesta
   a la UI. Fuera de alcance.

## Variables de entorno

Ninguna nueva en esta tarea. La que introdujo a7.4, `WEBHOOK_CRON_SECRET`, sigue documentada en
`docs/docker.md` y `docs/security.md`, y sigue **pendiente de que el humano la añada a
`.env.local.example`**: ese archivo está bloqueado por permisos para los agentes. Acumulado
con `ENCRYPTION_KEY_PREVIOUS`, `META_WEBHOOK_VERIFY_TOKEN`, `PAYPAL_WEBHOOK_ID` y
`AUTOMATION_CRON_SECRET` de fases anteriores.

## Deuda que sigue abierta (no la arreglé)

De `impl_webhooks-durable.md`, siguen vivas las deudas 3 a 8 — ninguna era de merge:

3. **Equidad acotada a la ventana de barrido** (`selectFairBatch` reparte sobre 500 filas).
4. **La purga no está acotada por lote** (`purgeOldDeliveries` borra todo lo de >30 días).
5. **Las cabeceras de entrega siguen diciendo `X-Wacrm-*`** con la marca retirada; renombrarlas
   rompería a todos los receptores.
6. **El alta y la edición de contactos desde el panel siguen siendo escrituras directas del
   navegador**, así que `contact.updated` solo sale de `PATCH /api/v1/contacts/{id}`.
7. **El primer intento de entrega corre dentro de `after()`**: si el proceso muere ahí, la fila
   queda `pending` vencida y la recoge el barrido siguiente (correcto, pero sin cron no hay
   barrido siguiente).

De `review_api-hardening.md` 2.ª ronda, siguen vivos los hallazgos 3, 4 y 6:

- **H3 — dos relojes.** `IN_FLIGHT_STALE_MS` compara `Date.now()` del proceso con un
  `created_at` que pone Postgres. Un desfase >2 min entre app y base convierte una reserva viva
  en «abandonada». El reviewer la mandó a la lista de a7.2/a7.4; sigue ahí.
- **H4 — `release()` y el `UPDATE` de la respuesta identifican la fila por
  `(account_id, api_key_id, idempotency_key)`, no por el `id` reservado.** Tras una adopción, un
  proceso original que reviva tarde podría borrar o sobrescribir la fila del adoptante. Ventana
  estrechísima; se cierra capturando el `id` del `INSERT`. Deuda de a7.2 si se toca el helper.
- **H6 — `api-keys-settings.tsx:652` enseña el texto del servidor sin traducir** en el toast de
  rotación. Patrón preexistente del archivo.

Y una del alcance de la fase, no mía:

- **`src/components/settings/api-keys-settings.tsx` enlaza a `/developers`**, una página que no
  existe hasta a7.7. Aceptada por el reviewer de a7.1; si a7.7 se cae del alcance, ese enlace es
  un 404 dentro de Ajustes.

Detectado por mí en esta integración, y **no arreglado** por estar fuera de alcance:

- **`fail()` acepta cualquier cadena como código de error** (`code: string`), de modo que el
  contrato «`error.code` es estable y machine-matchable» de `docs/public-api.md` lo sostiene la
  disciplina, no el compilador. Hay ya un código fuera de `ApiErrorCode` en uso
  (`fail('meta_error', …)`), que además no está en la tabla publicada. Estrechar la firma es un
  cambio de una línea más la decisión sobre `meta_error`; le corresponde a quien cierre la fase.

## Estado de ramas al terminar

```
main              3b82698   (intacto)
dev               4756a47   (intacto)
api/webhooks      170d73e   (intacto; ya integrado)
api/recursos      6b0d768   ← merge + 2 commits
feat/api-publica  6b0d768   ← fast-forward, salida 0
```

Worktree limpio, nada pusheado, ningún otro worktree tocado.
