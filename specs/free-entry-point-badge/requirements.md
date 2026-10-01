# p11.6 `free-entry-point-badge`: requisitos

**Fase 11** (`feature_list.json`, `sdd: true`). Redactada el 2026-10-01 por `spec_author`.
Base de lectura: `feat/precios-meta-directo` @ be8ca0f (worktree
`.claude/worktrees/precios-meta-directo`, con s10.1, s10.2 y p11.1 integradas).
i18n: `es` (por defecto) y `en`, sin `ko` (s9.9, CP6). El humano puso una regla: ninguna conexión
de red fuera de la máquina. Los payloads de Meta de los tests son sintéticos y lo que exige un
anuncio real va en el guion manual (§Guion manual).

## Contexto

Si un cliente escribe desde un anuncio Click to WhatsApp (CTWA), Meta abre una «ventana de punto
de entrada gratis» de 72 h y no cobra los mensajes del negocio en esa conversación. La spec de la
fase 10 la nombra (`progress/spec_facturacion-gestionada.md`, decisión 3: «los de la ventana de
72 h») y s10.1 ya guarda `pricing_type = 'free_entry_point'` en `message_charges`
(`src/lib/whatsapp/message-charges.ts`, `KNOWN_PRICING_TYPES`). Pero ese dato llega **después**
de enviar, en el estado de entrega. Hoy el webhook (`src/app/api/whatsapp/webhook/route.ts`,
`interface WhatsAppMessage`) no declara ni lee `referral`, así que el operador no puede saber
**antes** de responder que esa conversación está dentro de la ventana gratis.

En el repo **no hay documentación de Meta** sobre la forma de `referral` ni sobre las reglas
exactas de la ventana. Todo lo que dependa de eso es un supuesto (S-E1…S-E5 en `design.md`) y el
diseño se inclina siempre a **no** mostrar la insignia cuando hay duda. Mostrar «gratis» cuando no
lo es le cuesta dinero al cliente; no mostrarla cuando sí lo es solo le quita un aviso.

## Criterios de aceptación de partida (nota de la feature y encargo del líder)

- **A1** Guardar el referral de Click to WhatsApp del mensaje entrante en la conversación: origen
  (`entry_point_source`), momento (`entry_point_at`) y fin de la ventana gratis
  (`free_window_until` = entrada + 72 h), todos anulables. Migración **082**.
- **A2** El webhook los rellena cuando el entrante trae `referral`, y no rompe nada cuando no lo
  trae (CP11).
- **A3** La bandeja muestra «Ventana gratis hasta {hora}», en la lista y en la cabecera de la
  conversación, mientras `free_window_until > now()`.
- **A4** Decidir qué pasa con las cuentas `managed`.
- **A5** La lógica es una función pura con test, hay test de fuga A↔B (CP3) y las claves están en
  es y en (CP6).

## Requisitos (EARS)

### Almacenamiento

- **R1** (A1) El sistema debe tener en `conversations` las columnas anulables
  `entry_point_source text`, `entry_point_at timestamptz`, `free_window_until timestamptz` y
  `entry_point_referral jsonb`, creadas por `supabase/migrations/082_conversation_entry_point.sql`
  de forma idempotente.
  *Verificación:* `scripts/replay-migrations.sh` sale 0 con la 082 aplicada dos veces; aserción
  nueva en `supabase/ci/verify-schema.sql`.
- **R2** (A1) Cuando se escriba en `entry_point_source` un valor distinto de NULL, `ctwa_ad`,
  `ctwa_organic` o `ctwa_other`, el sistema debe rechazar la escritura con una violación de CHECK.
  *Verificación:* SQL en `progress/checks_free-entry-point-badge.sql`, `UPDATE … SET
  entry_point_source = 'foo'`, que espera el error `23514`.
- **R3** (A1) Cuando se escriba un `free_window_until` sin `entry_point_at`, o posterior a
  `entry_point_at + interval '72 hours'`, el sistema debe rechazar la escritura con una violación
  de CHECK.
  *Verificación:* SQL en `checks_…sql` con dos casos que fallan y uno de exactamente 72 h que pasa.
- **R4** (CP11) Al aplicarse, la migración 082 no debe reescribir ni recorrer `conversations`:
  columnas sin `DEFAULT` y CHECK `NOT VALID`, con `SET lock_timeout = '5s'` como en la 075.
  *Verificación:* revisión del SQL y `checks_…sql`, que consulta
  `pg_constraint.convalidated = false` para los dos CHECK.

### Lectura del referral (pura)

- **R5** (A1, A2) Cuando un mensaje entrante traiga `referral` como objeto, el sistema debe
  derivar el origen con `parseReferral`: `source_type === 'ad'` da `ctwa_ad`,
  `source_type === 'post'` da `ctwa_organic` y cualquier otro valor, o su ausencia, da
  `ctwa_other`.
  *Verificación:* vitest de `parseReferral`, un caso por rama.
- **R6** (A2) Cuando `referral` no exista, sea `null`, una cadena, un número o un array, el
  sistema debe devolver `null` desde `parseReferral` sin lanzar.
  *Verificación:* vitest con cada forma.
- **R7** (seguridad, tamaño) Cuando el sistema guarde `entry_point_referral`, debe conservar solo
  las claves `source_type`, `source_id`, `source_url`, `headline` y `ctwa_clid` que sean cadena,
  cada una truncada a 500 caracteres, y descartar todo lo demás (`body`, URLs de media, objetos
  anidados).
  *Verificación:* vitest que pasa un referral con claves extra, una cadena de 2.000 caracteres y
  un `source_id` numérico, y comprueba el objeto resultante.
- **R8** (A1) Cuando el origen sea `ctwa_ad` y el `timestamp` del mensaje sea un entero válido de
  segundos que no esté más de 5 minutos en el futuro, el sistema debe fijar
  `entry_point_at = timestamp` y `free_window_until = timestamp + 72 h` con
  `computeEntryPoint`.
  *Verificación:* vitest con reloj inyectado: timestamp válido y el límite exacto de 72 h.
- **R9** (conservador, S-E2) Cuando el origen sea `ctwa_organic` o `ctwa_other`, el sistema debe
  guardar el origen y `entry_point_at` con `free_window_until = NULL`.
  *Verificación:* vitest de `computeEntryPoint`.
- **R10** (conservador, deuda `route.ts:635`) Cuando el `timestamp` no sea numérico, sea
  negativo o caiga más de 5 minutos en el futuro, el sistema debe usar la hora de recepción como
  `entry_point_at` y dejar `free_window_until = NULL`, sin lanzar.
  *Verificación:* vitest con `'abc'`, `''`, `'-1'` y `now + 1 h`.

### Webhook

- **R11** (A2) Cuando el webhook guarde por primera vez (no repetición) un mensaje entrante con
  `referral` válido, el sistema debe actualizar las cuatro columnas de esa conversación con un
  `UPDATE` filtrado por `id` y `account_id`, y solo si el `entry_point_at` guardado es NULL o
  anterior al nuevo.
  *Verificación:* vitest en `src/app/api/whatsapp/webhook/route.test.ts` (o en el test del
  módulo nuevo): la conversación queda con `ctwa_ad` y `free_window_until` = timestamp + 72 h;
  un segundo entrante con referral más antiguo no la pisa.
- **R12** (A2) Cuando Meta reenvíe un mensaje que ya existe (`insertedRows` vacío, la frontera de
  idempotencia de la 037), el sistema no debe tocar las columnas de punto de entrada.
  *Verificación:* vitest que repite el mismo payload y cuenta las escrituras en `conversations`.
- **R13** (A2) Cuando el entrante no traiga `referral`, el sistema no debe escribir en las
  columnas de punto de entrada y una ventana abierta antes debe seguir igual.
  *Verificación:* vitest con un entrante sin referral sobre una conversación con
  `free_window_until` en el futuro.
- **R14** (CP11) Cuando falle la actualización del punto de entrada (error de Supabase o
  excepción), el sistema debe registrar una línea `console.error` sin el contenido del mensaje y
  seguir el resto del procesamiento (bump, flujos, automatizaciones, IA, webhooks salientes); el
  mensaje queda guardado y el webhook responde 200.
  *Verificación:* vitest que hace fallar ese `update` y comprueba que existe la fila de
  `messages`, que se llamó `bump_conversation_on_inbound` y el 200.
- **R15** (CP11) Cuando la cuenta esté en solo lectura (`past_due` vencido o `manual_hold`), el
  sistema debe guardar igual el entrante con referral y su punto de entrada.
  *Verificación:* vitest en `route.test.ts` con la cuenta en solo lectura.
- **R16** (CP3) Cuando entre un mensaje con referral por un número de la cuenta A, el sistema no
  debe modificar ninguna conversación de la cuenta B, aunque B tenga un contacto con el mismo
  teléfono.
  *Verificación:* caso nuevo en `src/lib/security/tenant-isolation.test.ts`. El
  `unscopedServiceRoleQueries` del audit no reporta el `update` nuevo.

### Insignia en la bandeja

- **R17** (A3) El sistema debe exponer la función pura
  `freeWindowUntil(conversation, nowMs, metaBilling)`, que devuelve el `Date` de
  `free_window_until` solo si es una fecha válida estrictamente posterior a `nowMs` y
  `metaBilling === 'direct'`. En cualquier otro caso devuelve `null`.
  *Verificación:* vitest de `src/lib/inbox/free-window.ts`: futura, pasada, igual a `now`, NULL,
  cadena inválida, `managed`, `undefined`.
- **R18** (A3) Mientras `freeWindowUntil` no sea `null` para una conversación, el sistema debe
  mostrar en su fila de la lista de la bandeja (`ConversationItem` de
  `src/components/inbox/conversation-list.tsx`) una insignia con el texto `Inbox.freeWindow.badge`
  («Ventana gratis hasta {until}») y un `title` con `Inbox.freeWindow.tooltip`.
  *Verificación:* vitest con `renderToStaticMarkup` de `FreeWindowBadge` (texto, `title`,
  `data-free-window`) y test de la función de R17.
- **R19** (A3) Mientras `freeWindowUntil` no sea `null` para la conversación abierta, el sistema
  debe mostrar la misma insignia en la cabecera de `src/components/inbox/message-thread.tsx`,
  junto al temporizador de sesión de 24 h.
  *Verificación:* el mismo test del componente, más una revisión del diff que muestre el montaje
  en la cabecera.
- **R20** (A3) Cuando pase `free_window_until` con la bandeja abierta, el sistema debe quitar la
  insignia en menos de 60 s sin recargar: un reloj por componente con `setInterval` de 60 s,
  sin un intervalo por fila.
  *Verificación:* vitest del hook de reloj con temporizadores falsos (`vi.useFakeTimers`).
- **R21** (A4, decisión) Cuando la cuenta sea `managed` (`useBillingStatus()?.metaBilling ===
  'managed'`), o mientras `metaBilling` no se conozca, el sistema no debe mostrar la insignia. Los
  datos se guardan igual. Motivo: en `managed` Cabbity cuenta todos los mensajes entregados, también
  los gratis para Meta (decisión 3 de la fase 10), así que la ventana no le ahorra nada al cliente.
  *Verificación:* vitest de R17 con `managed` y `undefined`.
- **R22** (A5, CP6) El sistema debe tener las claves `Inbox.freeWindow.badge` y
  `Inbox.freeWindow.tooltip` en `messages/en.json` y `messages/es.json`, con el mismo placeholder
  `{until}`.
  *Verificación:* `src/i18n/messages.test.ts` e `icu-safety.test.ts` en verde.

### Alcance

- **R23** (CP8) El sistema no debe exponer las columnas nuevas en la API pública `/api/v1` ni
  usarlas en automatizaciones, flujos, IA, facturación o `enforce.ts`.
  *Verificación:* revisión del diff. `src/lib/api/v1` no cambia.

## Guion manual (requiere un anuncio CTWA real; lo hace el humano)

1. Con la 082 aplicada, crear un anuncio Click to WhatsApp de prueba en el Business Manager hacia
   un número conectado, tocarlo desde un teléfono propio y enviar el mensaje prellenado.
2. `select entry_point_source, entry_point_at, free_window_until, entry_point_referral from
   conversations where id = '<id>';` Debe dar `ctwa_ad`, la hora del mensaje, +72 h y un
   `entry_point_referral` con `source_type = 'ad'`. Si `source_type` llega con otro valor, anotarlo
   (S-E1).
3. Responder desde la bandeja antes de 24 h y comprobar en `message_charges` que la respuesta trae
   `pricing_type = 'free_entry_point'` y `pricing_billable = false` (S-E2, S-E3).
4. Comprobar en `message_charges` si la ventana gratis empieza al recibir el clic o al enviar la
   primera respuesta (S-E3): un mensaje enviado a las 71 h del clic debe salir `free_entry_point`.
   Si Meta la cuenta desde la respuesta, la insignia termina **antes** de lo real, que es el
   lado seguro, y el humano decide si se ajusta.
5. Repetir con un clic desde una publicación orgánica (`post`) y con un botón de la página de
   Facebook: la conversación guarda `ctwa_organic` y sin insignia. Anotar si Meta marca esos
   mensajes `free_entry_point` (S-E2) para decidir si se amplía.
