# f4.2 `multi-number` — informe de implementación

**Rama**: `saas/fase-4-multinumero` (worktree `.claude/worktrees/fase-4-multinumero`,
base `saas/integracion` @ `e6ceba2`).
**Spec**: `docs/saas/fase-4-plataforma.md` §1, apartado «Varios números por empresa».
**Plan ejecutado**: `progress/plan_embedded-signup.md` §0, §6, §7, §9 (filas 4, 4b, 4c, 4d,
5b y el extra de aislamiento), §12 (riesgos 1, 2 y 9).

## Compuerta

| Paso | Resultado |
|---|---|
| `npm run lint` | 0 errores, 38 avisos (todos preexistentes; los dos de `whatsapp-config.tsx` y `settings-overview.tsx` son la dependencia `user` del efecto, que ya estaba) |
| `npm run typecheck` | limpio |
| `TZ=UTC npm test` | 121 archivos, **1585 tests**, todos verdes (antes: 120 / 1554) |
| `npm run build` | compila; 58 páginas |
| `scripts/replay-migrations.sh` | salida 0, `verify-schema.sql: OK` |
| `progress/checks_multi-number.sql` | 7 bloques `OK`, ejecutados contra el Postgres del harness |

## Commits

Tres, en este orden (ver `git log saas/fase-4-multinumero`):

1. `feat: permitir varios números de WhatsApp por empresa` — migración 053, aserciones en
   `verify-schema.sql`, `resolve-config.ts` + test, tipos.
2. `feat: enrutar envío, difusiones y recepción por número` — los 8 `.single()`, el sellado
   del webhook, `from` de la API pública, `whatsapp_config_id` de las difusiones, y los
   tests de §9 filas 4b/4c/4d.
3. `feat: gestionar la lista de números en Ajustes` — rutas de configuración, UI de lista +
   formulario, selector del asistente de difusiones, i18n, suite de aislamiento, docs.

---

## 1. Censo de las 23 consultas del plan §0 — destino de cada una

Cerrado con `grep -rn "from('whatsapp_config')" src/ | grep -v test`: **cero `.single()`**
fuera de… en realidad cero `.single()` en absoluto sobre esa tabla, ni siquiera en
`resolve-config.ts` (el resolvedor usa `maybeSingle` en los cuatro pasos, porque «no hay
fila» es una respuesta legítima en todos ellos, no un error).

| Archivo (línea original) | Antes | Ahora |
|---|---|---|
| `api/whatsapp/webhook/route.ts:163` | `select('id, verify_token')` sin filtro | **sin cambios** (bucle de verificación del modo autoalojado; es de f4.1) |
| " `:196` | `update(verify_token)` por `id` | **sin cambios** (es de f4.1) |
| " `:313` | `.eq('phone_number_id')` | **sin cambios**; es el resolvedor de inquilino y lo protege el UNIQUE de la 013 |
| `api/whatsapp/config/route.ts` GET | `.eq('account_id').maybeSingle()` | lista ordenada `is_default DESC, created_at ASC` → `numbers[]`; verifica contra Meta el predeterminado o el de `?config_id=` |
| " POST, fila existente | `.eq('account_id').maybeSingle()` | lista filtrada por `id` (si viene `config_id`) o por `phone_number_id` |
| " POST, conflicto entre cuentas | `.eq('phone_number_id').neq('account_id')` | **conservado literal**; solo se **movió por delante** de la compuerta de plan (ver «Decisiones», 2) |
| " POST, conteo del tope | `count` excluyendo la fila editada | igual, con la exclusión por `id` intacta (semántica de f3.4) |
| " POST, escritura | `update().eq('account_id')` / `insert` | `update().eq('id').eq('account_id')` / `insert` con `is_default` y promoción en dos pasos |
| " DELETE | `.delete().eq('account_id')` | `?id=` **obligatorio**; borra una fila y promueve al superviviente más antiguo |
| `api/whatsapp/config/verify-registration/route.ts:59` | `.maybeSingle()` por cuenta | `?config_id=` o el predeterminado |
| `api/whatsapp/config/[id]/route.ts` | — | **ruta nueva**: `PATCH` (nombre, espejo de multimedia, hacer predeterminado) y `DELETE` |
| `api/whatsapp/broadcast/route.ts:229` | `.single()` | `resolveWhatsAppConfig` con el `whatsapp_config_id` **de la campaña** |
| `api/whatsapp/react/route.ts:93` | `.single()` | por conversación |
| `api/whatsapp/media/[mediaId]/route.ts:53` | `.single()` | predeterminado (deuda 1) |
| `api/whatsapp/templates/sync/route.ts:139` | `.single()` | predeterminado (deuda 2) |
| `api/whatsapp/templates/submit/route.ts:143` | `.single()` | predeterminado (deuda 2) |
| `api/whatsapp/templates/[id]/route.ts:143, :287` | `.single()` ×2 | predeterminado (deuda 2) |
| `lib/whatsapp/send-message.ts:262` | `.single()` | `resolveWhatsAppConfig({configId, conversationId, withToken})` |
| " `:280` | auto-reparación CBC→GCM por `id` | **movida a `resolve-config.ts`**, y ahora también filtra por `account_id` |
| `lib/whatsapp/broadcast-core.ts:118` | `.single()` | elección del llamante, y se **congela** en la fila de la difusión |
| `lib/whatsapp/broadcast-resume.ts:209` | `.single()` | `broadcast.whatsapp_config_id`, nunca el predeterminado |
| `lib/whatsapp/resolve-conversation.ts:59` | `.select('id').maybeSingle()` | resolvedor; y **sella** el número en la conversación que crea |
| `lib/flows/meta-send.ts:87, :197, :363` | `.single()` ×3 | por conversación |
| `lib/automations/meta-send.ts:139` | `.single()` | por conversación |
| `lib/api/v1/contacts.ts:78` | `.select('user_id').maybeSingle()` | `.order('created_at').limit(1)` — solo es el usuario de auditoría |
| `components/settings/whatsapp-config.tsx` | `.maybeSingle()` | lista ordenada |
| `components/settings/settings-overview.tsx:125` | `.maybeSingle()` | `count` |
| `app/(dashboard)/inbox/page.tsx:204` | `.select('status').maybeSingle()` | `.eq('status','connected').limit(1)` |
| `lib/whatsapp/reencrypt.ts:26` | tabla entera | **sin cambios** |

---

## 2. Criterio ↔ test

Los dos criterios de la §1 que toca esta feature. Los otros tres (registro integrado, firma,
suscripción de la WABA) son de f4.1.

| Criterio | Archivo | `it(...)` |
|---|---|---|
| **«Una empresa con varios números envía por el que elige…»** | `src/lib/whatsapp/resolve-config.test.ts` | `1. an explicit config_id wins over everything else` · `2. otherwise the conversation's own number, not the default` · `3. a thread with no number sealed falls back to the default` · `3b. with no conversation at all, the default` · `4. with the default deleted by hand, the oldest survivor` · `5. an account with no numbers raises the message it always raised` |
| ídem, fuga entre cuentas (CP3) | " | `a config_id from another account is a 404, never that account's row` · `a conversation_id from another account never yields B's number` · `an account with no numbers does not inherit another account's` · `translates the public phone_number_id into this account's row id` |
| ídem, envío (§9 fila 4b) | `src/lib/whatsapp/send-message.test.ts` | `sends through the conversation's own number, not the account default` · `sends through the number the caller named, when it names one` · `a number that is not this account's is a 404, and nothing is sent` |
| ídem, difusiones (§9 fila 4c) | `src/lib/whatsapp/broadcast-resume.test.ts` | `uses the campaign's frozen number even when another one is the default` · `falls back to the default for a campaign created before migration 053` · `names the cause when the number the campaign used was disconnected` |
| **«…y recibe correctamente en todos»** (§9 fila 4d) | `src/app/api/whatsapp/webhook/route.test.ts` | `stores messages arriving on either number of the same account` · `seals the conversation with the number the customer wrote to` · `does not rewrite the seal when the number has not changed` |
| **«El modo autoalojado sigue funcionando»** (§9 fila 5b) | `src/app/api/whatsapp/config/route.test.ts` | los 9 `it` del archivo corren **sin ninguna variable de plataforma**: el camino manual completo (verificar → cifrar → registrar → suscribir → guardar) sigue verde |
| Tope `numbers` de §7 (a) | `src/app/api/whatsapp/config/route.test.ts` | `a 1-number plan can re-save the number it already has` · `lets a 1-number plan swap its number: editing the row is not a second number` |
| Tope `numbers` de §7 (b) | " | `402s the same account on a SECOND, different number` (afirma `metric`, `limit`, `used` y `upgradeUrl`) |
| Fuga en las rutas nuevas (extra de §9) | `src/lib/security/tenant-isolation.test.ts` | `GET lists only A's numbers` · `PATCH on B's number → 404 and B is untouched` · `DELETE on B's number → 404 and B still has it` · `PATCH renames A's own number and leaves B's default alone` · `DELETE ?id= on the collection route only removes A's row` · `DELETE without an id refuses rather than wiping every number` |
| Cifrado: la auto-reparación no cruza cuentas | `src/lib/whatsapp/resolve-config.test.ts` | `self-heals a legacy CBC ciphertext by id, scoped to the account` |
| CP11 (lo entrante no se bloquea) | `src/app/api/whatsapp/webhook/route.test.ts` | el bloque `billing never blocks what comes in (CP11)` sigue verde con el sellado añadido |

Tests reajustados (fixtures, no expectativas): `broadcast-core.test.ts`,
`resolve-conversation.test.ts`, `flows/meta-send.test.ts`, `automations/meta-send.test.ts`,
`api/v1/broadcasts/route.test.ts`, `api/whatsapp/broadcast/route.test.ts`. Todos por la misma
razón: sus dobles de Supabase devolvían el número por `.single()`, y ahora la resolución pasa
por `maybeSingle()` (predeterminado) o por dos saltos (conversación → número).

## 3. Verificaciones contra base real

`progress/checks_multi-number.sql`, ejecutado con `KEEP=1 scripts/replay-migrations.sh` y
`docker exec … psql -v ON_ERROR_STOP=1`. Los siete bloques imprimen `OK`; cualquier fallo
aborta la transacción, así que no hay verde silencioso. Todo va dentro de un `BEGIN … ROLLBACK`.

1. Una cuenta admite **dos** números — si el `UNIQUE(account_id)` de la 017 siguiera ahí, el
   segundo `INSERT` fallaría con 23505 en esa misma línea.
2. El índice parcial `whatsapp_config_one_default_per_account` **rechaza** un segundo
   predeterminado en la misma cuenta.
3. Y sí acepta el orden «limpiar y luego marcar», que es exactamente el de `promoteDefault`.
4. `UNIQUE(phone_number_id)` de la 013 **sigue** rechazando que otra cuenta reclame un número
   ya usado (regresión del issue #136).
5. Borrar un número deja **vivas** la conversación y la campaña, con la columna a `NULL`: las
   dos FK son `ON DELETE SET NULL` (CP2).
6. `idx_conversations_account_contact` (036) sigue imponiendo una conversación por contacto.
7. La RLS de la 017 da los **dos** números a un miembro de la cuenta y **cero** al de la otra.

Dos trampas encontradas al escribirlo, ambas anotadas en el propio archivo porque cuestan una
hora si se repiten: el disparador `on_auth_user_created` ya crea cuenta y perfil (y
`idx_accounts_one_per_owner` impide crear otra), y `auth.uid()` en esta imagen lee
`request.jwt.claim.sub` en singular — ponerlo como JSON completo deja el uid a `NULL` y la RLS
devuelve cero filas **para todos**, que es un falso verde perfecto.

## 4. Verificaciones manuales pendientes (plan §10, pasos 6 y 7)

Nada de esto se simula: hace falta Meta real, dos números productivos y un móvil.

**Paso 6 — dos números, entrada y salida.**
1. En Ajustes → WhatsApp, «Añadir número» y conectar un segundo número con sus credenciales.
   Comprobar que la lista muestra dos tarjetas y que solo una lleva la insignia
   «Predeterminado».
2. Desde un WhatsApp real, escribir **al número A**. El mensaje aparece en la bandeja.
   En la base: `SELECT whatsapp_config_id FROM conversations WHERE contact_id = …` debe ser
   el id del número A.
3. Responder desde la bandeja y comprobar **en el móvil del cliente** que la respuesta llega
   desde el número A (no desde el predeterminado, si A no lo es).
4. Desde el mismo móvil, escribir ahora **al número B**. Debe entrar en la **misma**
   conversación (036 se mantiene) y `whatsapp_config_id` debe pasar a ser el de B.
5. Responder otra vez y comprobar en el móvil que ahora la respuesta sale **por B**.
6. Marcar B como predeterminado, abrir un contacto **sin conversación previa** y enviarle una
   plantilla: debe salir por B.

**Paso 7 — difusión con número elegido, pausa y reanudación.**
1. Con dos números conectados, abrir el asistente de difusiones. En el paso 4 debe aparecer
   el selector «Send from» (no aparece con un solo número).
2. Elegir el número **no predeterminado** y lanzar la campaña a dos o tres destinatarios
   propios.
3. Verificar en la base: `SELECT whatsapp_config_id FROM broadcasts WHERE id = …` es el
   elegido, no el predeterminado.
4. Cerrar la pestaña a media campaña (el bucle de envío vive en el navegador) para dejar
   destinatarios en `pending`.
5. **Cambiar el predeterminado al otro número** desde Ajustes — es el paso que hace la prueba
   valer algo.
6. Reanudar la campaña desde su ficha. Comprobar en el móvil de un destinatario que el
   remitente **no cambió**: sigue siendo el número con el que empezó.
7. Comprobar que la ventana de 24 h no se reinició: la conversación en el móvil del cliente
   sigue siendo un único hilo con el mismo remitente.

**Extra (riesgo del plan §12.2, mismo paso):** desconectar el número con el que se lanzó una
campaña y reanudarla. Debe dar `whatsapp_not_configured` con el texto «The WhatsApp number
this broadcast was sent from is no longer connected…», **no** salir por otro número.

## 5. Decisiones donde el plan era ambiguo

1. **`broadcasts.whatsapp_config_id` se escribe en un `UPDATE` posterior al RPC**, no como
   octavo parámetro de `create_broadcast_with_recipients`. La función de la 037 es
   `SECURITY DEFINER`, su firma aparece por nombre en cuatro líneas de `GRANT`/`REVOKE`, y
   ampliarla costaría una migración de riesgo para ahorrar una escritura. Si el proceso muere
   entre las dos, la columna queda `NULL` y una reanudación cae al predeterminado — que es lo
   que hacía **toda** campaña anterior a la 053, no un modo de fallo nuevo. Comentado en el
   archivo.
2. **El conflicto entre cuentas (409) pasó por delante de la compuerta de plan (402)** en
   `POST /api/whatsapp/config`. Con el tope `numbers` ya real, intentar reclamar el número de
   otra empresa desde una cuenta con el cupo lleno devolvía «actualiza tu plan», que manda al
   cliente al checkout por un problema que el dinero no resuelve. Es además el orden que el
   plan §1.3 fija para `POST /api/whatsapp/embedded-signup` (pasos 2 y luego 3), así que las
   dos rutas quedan iguales. Un test de la suite de aislamiento lo fija.
3. **`DELETE /api/whatsapp/config` exige `?id=`** y responde 400 sin él, en vez de seguir
   borrando todo. Con un número era la intención; con tres es una catástrofe a un clic. La UI
   ya manda el id.
4. **Editar un número exige nombrarlo** (`config_id`). Sin él, guardar un `phone_number_id`
   distinto es, por definición, un número nuevo y consume cupo. La ruta empareja por
   `phone_number_id` cuando no hay `config_id`, que es lo que mantiene verde el camino
   «reconectar mi propio número» de los clientes que no conocen ids.
5. **Un `config_id` que no es de la cuenta responde 404, nunca «creo una fila»**: un id mal
   tecleado no puede acabar añadiendo un número en silencio, y un id de otra cuenta no puede
   resolver aquí (CP3).
6. **Borrar el predeterminado promueve al superviviente más antiguo**, en las dos rutas de
   borrado. Sin eso, la cuenta quedaría sin predeterminado y todo envío sin destinatario
   explícito caería al paso 4 del resolvedor (la red de seguridad), que funciona pero no es
   una invariante que quiera sostener nadie.
7. **El paso 2 del resolvedor cae al predeterminado si el `whatsapp_config_id` sellado ya no
   existe.** La FK es `SET NULL`, así que es una carrera, no un residuo; fallar el envío ahí
   sería peor que mandarlo por el predeterminado.
8. **El interruptor de espejo de multimedia pasó a ser por número.** Antes escribía
   `.eq('account_id')`, que con varios números lo habría cambiado en todos a la vez.
9. **La UI abre en la lista, no en el formulario.** El formulario aparece con «Añadir número»
   o «Editar». El banner de estado de registro y el diagnóstico se movieron dentro de esa
   vista, porque un banner único para *n* números miente sobre al menos uno.
10. **`GET /api/whatsapp/config` sigue verificando contra Meta un solo número** (el
    predeterminado, o el de `?config_id=`). Verificar *n* números en cada carga de Ajustes
    serían *n* viajes a Graph. Los metadatos de los demás salen de las columnas nuevas
    `display_phone_number` / `verified_name`, que el GET y el POST refrescan al pasar.
11. **`docs/public-api.md` no se pasó por prettier.** El archivo no estaba formateado y
    prettier reescribía ~60 líneas ajenas (tablas y comas finales del bloque `jsonc`), lo que
    habría enterrado el cambio real. La sección añadida sigue el estilo del archivo. El resto
    de lo tocado sí lleva `npx prettier --write`.

## 6. Variables de entorno nuevas

**Ninguna.** f4.2 no añade ni consume variables de entorno; las tres del plan §11
(`META_APP_ID`, `META_CONFIG_ID`, `META_GRAPH_VERSION`) son de f4.1. `docs/docker.md` no se
toca, y `.env.local.example` (bloqueado a los agentes) tampoco tenía nada que recibir.

## 7. Deuda detectada, fuera de alcance — no arreglada

1. **Descarga de multimedia entrante por el predeterminado.**
   `GET /api/whatsapp/media/[mediaId]` solo conoce un id de medio de Meta; no hay conversación
   en la URL de la que sacar el número. Usa el predeterminado, lo cual es correcto mientras
   los números compartan WABA (el token de cualquier número de una WABA descarga cualquier
   medio de esa WABA) y falla cuando no. Arreglarlo bien pide llevar el `conversation_id`
   hasta cada `<img src>` de la bandeja. Comentado en el archivo.
2. **Plantillas por WABA.** `message_templates` es `UNIQUE(account_id, name, language)` y en
   Meta las plantillas son por WABA. Las cuatro rutas de plantillas resuelven al
   predeterminado, con el comentario puesto. Arreglarlo exige una columna `waba_id` en
   `message_templates` y repensar la unicidad. Decisión del plan §6.7, confirmada aquí.
3. **Conversaciones no se parten por número.** El índice `(account_id, contact_id)` de la 036
   se mantiene: un contacto que escribe a dos números de la misma empresa sigue teniendo una
   conversación, y el hilo se resella con el último número usado. Partirlas reintroduciría la
   ambigüedad de lectura del issue #363 y obligaría a revisar cada `.eq('contact_id')` del
   repositorio.
4. **El bucle de verificación del `GET` del webhook sigue intacto** (`route.ts` L160–212),
   incluida la reescritura oportunista a GCM disparada por un `GET` **no autenticado**. Es
   trabajo de f4.1 (plan §5); se deja anotado porque es una escritura en base que cualquiera
   que adivine un token de verificación puede provocar.
5. **El asistente de difusiones envía desde el navegador.** Cerrar la pestaña deja la campaña
   a medias y hay que reanudarla a mano. No es nuevo, pero ahora tiene una consecuencia extra:
   es el camino por el que la columna `whatsapp_config_id` de la difusión gana su valor, y el
   paso 7 del guion manual depende de ello.
6. **`registrationProbe` y el estado de conexión son de un solo número.** La cabecera de la
   página sigue mostrando un estado global (el del predeterminado). Con muchos números
   convendría un estado por tarjeta verificado en diferido; hoy cada tarjeta muestra su
   `status` y su `registered_at` guardados, y «Verificar con Meta» consulta el número abierto.

## 8. Notas para el revisor

- El `UNIQUE(phone_number_id)` de la 013 **no se ha tocado**, y hay una aserción explícita en
  `verify-schema.sql` que falla si alguien lo retira; su pérdida devolvería el issue #136.
- La migración 053 es idempotente: `DROP CONSTRAINT IF EXISTS`, `CREATE … IF NOT EXISTS`,
  `ADD COLUMN IF NOT EXISTS`, y los dos rellenos filtran por el estado que ya escribirían.
- No hay dependencias nuevas (CP5). `package.json` intacto.
- Textos nuevos en `messages/en.json` y `messages/ko.json` con las mismas 21 claves (CP6).
- API de Next comprobada en `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/route.md`
  para la ruta dinámica nueva (`context.params` es una promesa desde 15.0; se usa igual que en
  `templates/[id]/route.ts`) (CP7).
