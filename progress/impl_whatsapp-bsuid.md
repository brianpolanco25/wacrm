# p6.5 — `whatsapp-bsuid` (fase 6, §5 de `progress/spec_producto.md`)

Rama `saas/producto`, worktree `.claude/worktrees/producto`, base `9d10709`.
Compuerta en verde (lint 0 errores / 35 avisos preexistentes, typecheck, `TZ=UTC npm test`
2065 tests en 151 archivos, build) y `scripts/replay-migrations.sh` con salida 0.

## Commits

| Commit | Hito |
|---|---|
| `a8b2fa6` | `feat: abrir el modelo de contacto al BSUID de WhatsApp` — migración 060 + `verify-schema.sql` |
| `2046b89` | `feat: identificar los entrantes de WhatsApp por BSUID` — webhook, estados de entrega, `meta-api` |
| `dc69b18` | `feat: enviar a un contacto que solo tiene BSUID` — resolutor de destinatario y los cuatro caminos de salida |
| `239317b` | `feat: enseñar y buscar contactos sin teléfono` — bandeja, contactos, API pública, catálogos, documentación |
| `50c9758` | `docs: anotar el BSUID de WhatsApp en el CHANGELOG` |

## Qué se ha hecho, por los cinco puntos de la spec

### 1. Migración `060_whatsapp_bsuid.sql`

060 estaba libre (la última era la 059). Añade `contacts.wa_user_id` y
`contacts.wa_username`, el índice **único parcial** `idx_contacts_account_wa_user_id`
sobre `(account_id, wa_user_id) WHERE wa_user_id IS NOT NULL`, relaja `phone` a NULL y lo
sustituye por `contacts_phone_or_wa_user_id_check` («teléfono o BSUID, al menos uno»).
Sin `DROP`, sin `CASCADE`, idempotente (el `ADD CONSTRAINT` va dentro de un `DO` que
consulta `pg_constraint`, porque Postgres 17 no admite `IF NOT EXISTS` ahí).

Objetos que asumían `phone NOT NULL`, revisados uno a uno y anotados en la cabecera de la
migración:

- `contacts.phone_normalized` (022) es `GENERATED ALWAYS AS regexp_replace(phone,…)`:
  con `phone` NULL da NULL, no `''`.
- `idx_contacts_account_phone_normalized` (022, ÚNICO) es parcial `WHERE phone_normalized
  <> ''`, y NULL no satisface `<> ''`. Las filas sin teléfono quedan fuera del índice, así
  que **no colisionan entre sí** (comprobado: CHECK 2 del SQL de verificación).
- `merge_duplicate_contacts()` (022) filtra igual; nunca mira una fila sin teléfono.
- `idx_contacts_phone` (001) no es único y admite NULL.
- `filter_contacts_by_tags` (025) **sí** se toca: se re-crea con la misma firma para que
  busque también por `wa_username` (con arroba o sin ella).

Aserciones nuevas en `supabase/ci/verify-schema.sql`: las dos columnas, el índice (y que
siga siendo único **y** parcial), `phone` ya no NOT NULL, la restricción CHECK, y que el
cuerpo de `filter_contacts_by_tags` siga mencionando `wa_username` (si una migración futura
lo re-creara desde la copia de la 025, el username dejaría de buscarse en silencio).

### 2. Webhook

`src/app/api/whatsapp/webhook/route.ts`:

- Tipos según la forma real del webhook: `messages[].from` pasa a opcional,
  `messages[].from_user_id` nuevo; `contacts[]` con `wa_id?`, `user_id?` y
  `profile.username?`; `statuses[]` con `recipient_id?` y `recipient_user_id?`.
- `value.contacts` **deja de ser obligatorio** para procesar el lote: su única aportación
  es el nombre de perfil y el username, y exigirla descartaba el lote entero cuando Meta la
  omitía (CP11).
- Orden de resolución del contacto (`findOrCreateContact`): **BSUID primero**, teléfono
  como complemento, y crear en último lugar. En los dos primeros casos se completa lo que
  falte —teléfono que llega tarde, BSUID de un contacto de siempre, username, nombre— con
  un `UPDATE` acotado por `id` **y** `account_id`. Ese `UPDATE` es best-effort: si el
  teléfono o el BSUID ya son de otro contacto de la cuenta, el índice único responde 23505,
  se registra y el mensaje se guarda igual.
- Sin `from` ni `from_user_id` se registra y se salta **ese** mensaje; el bucle sigue con el
  resto del lote.
- Los eventos de estado se acotan a la cuenta del número por el que llegaron (la
  configuración se resuelve una vez por `change`, antes de separar estados de mensajes) y,
  cuando un `wamid` encuentra más de una fila, `recipient_user_id` —o `recipient_id`—
  decide cuál es la del destinatario. Ver «deuda/hallazgos» más abajo: esto además tapa un
  agujero de aislamiento que ya existía.

### 3. Envío

- `meta-api.ts`: las cinco familias `send*` (texto, media, plantilla, reacción,
  interactivos) aceptan `{ to?, recipient? }`. Un único helper privado, `recipientFields`,
  arma los campos: si van los dos se mandan los dos (Meta se queda con `to`); si no va
  ninguno lanza **antes** de la llamada de red.
- `src/lib/whatsapp/recipient.ts` (nuevo) decide la identidad —teléfono marcable si lo hay,
  BSUID si no— y devuelve la lista de intentos: variantes de prefijo troncal por teléfono,
  un solo intento por BSUID. Lo usan `send-message.ts`, `flows/meta-send.ts` (3 sitios),
  `automations/meta-send.ts`, `broadcast-core.ts`, `broadcast-resume.ts` y
  `/api/whatsapp/react` (que también es un envío y estaba fuera del guion del líder: sin
  tocarlo, reaccionar a un mensaje de un contacto sin teléfono fallaba con 400).
- La corrección automática del número solo se aplica cuando se envió por teléfono.
- Difusiones: `BroadcastRecipientInput` acepta `to_user_id`; la clave de deduplicación
  lleva el tipo delante para que un BSUID no colisione con un teléfono; el contacto se
  resuelve por BSUID; la reanudación marca «no entregable» solo cuando **ninguna** de las
  dos identidades sirve.
- `src/lib/whatsapp/bsuid.ts` (nuevo) tiene dos validaciones a propósito: `sanitizeBsuid`
  (permisiva, para lo que viene de Meta y para lo ya guardado — si Meta cambiara el
  prefijo, un entrante no se puede perder por eso) e `isValidBsuid` (estricta,
  `CC.<alfanum>`, para lo que teclea un tercero en la API pública).

### 4. Bandeja, contactos y API pública

- `src/lib/contacts/display.ts` (nuevo): teléfono → `@usuario` → nada. El BSUID **no se
  enseña nunca**. Lo usan la bandeja (lista y conversación), la ficha del contacto, la
  tabla de contactos, el detalle de difusión (tabla y CSV), el registro de automatizaciones
  y el panel de actividad.
- Clave `noPhone` («Sin número» / «No number» / «번호 없음») en `messages/es.json`,
  `en.json` y `ko.json`, en los cinco espacios de nombres donde se pinta (CP6).
- Búsqueda por username en los tres sitios que buscan: consulta de la lista de contactos
  (`wa_username.ilike`), `filter_contacts_by_tags` (migración 060) y el filtro en cliente de
  la bandeja. La arroba es opcional al escribir.
- `POST /api/v1/messages` acepta `to` o `to_user_id` (con los dos gana `to`);
  `GET /api/v1/contacts` devuelve `wa_username` y `wa_user_id` —sin este último el envío
  por BSUID sería inalcanzable desde fuera—. Documentado en `docs/public-api.md`.
- Exportaciones: el CSV del detalle de difusión escribe el `@usuario` cuando no hay
  teléfono, y la celda queda vacía si no hay ninguno (la columna no desaparece).
- `Contact.phone` pasa a `string | null` en `src/types`. TypeScript señaló, y se han
  arreglado, la personalización de difusiones, las iniciales de una oportunidad, el
  serializador de conversaciones de la API pública y el aviso de duplicado del formulario.

### 5. `REQUEST_CONTACT_INFO` — NO implementado (deuda 1)

Se ha evaluado y queda fuera: un botón de plantilla nuevo toca el editor de plantillas,
`template-components.ts`, `template-validators.ts`, `template-send-builder.ts`, la
sincronización con Meta y los tres catálogos. Es una feature propia, no el «si cabe» que
autorizaba la spec.

## Criterio ↔ test

| Criterio (spec §5 / encargo del líder) | Test |
|---|---|
| Entrante sin `from` con `from_user_id` crea contacto, conversación y mensaje | `src/app/api/whatsapp/webhook/route.test.ts` › «un entrante sin `from` pero con `from_user_id` crea contacto, conversación y mensaje» |
| …y el BSUID puede venir solo en `contacts[].user_id` | idem › «el BSUID llega solo en `contacts[].user_id` y basta» |
| Se guarda el `username`; sin nombre de perfil el contacto se llama `@usuario` | idem › «sin nombre de perfil, el contacto se llama «@usuario»» |
| Un contacto por teléfono recibe su BSUID sin duplicarse | idem › «un contacto que ya existe por teléfono recibe su BSUID sin duplicarse» |
| Un contacto por BSUID recibe el teléfono cuando Meta lo incluye | idem › «un contacto nacido por BSUID recibe el teléfono cuando Meta lo incluye» |
| …sin pisar un teléfono ya guardado | idem › «no pisa un teléfono ya guardado con el que trae el webhook» |
| Sin ninguna identidad: se descarta ese mensaje, no el lote (CP11) | idem › «un mensaje sin ninguna identidad se descarta sin tumbar el resto del lote» |
| Estados casados por `recipient_user_id` cuando no hay `recipient_id` | idem › «un estado sin `recipient_id` avanza la fila de difusión igualmente» |
| …y el destinatario desempata varias filas con el mismo `wamid` | idem › «con varias filas para el mismo wamid, gana la del destinatario del evento» |
| El espejo sobre `messages` se acota a la cuenta | idem › «el espejo sobre `messages` se acota a las filas de la cuenta» |
| Fuga entre cuentas: entrante por BSUID compartido | `src/lib/security/tenant-isolation.test.ts` › «un entrante por BSUID en el número de A casa con el contacto de A, no con el de B (mismo wa_user_id)» |
| Fuga entre cuentas: estado con `wamid` compartido | idem › «un estado de entrega del wamid compartido solo mueve la fila de A» |
| Fuga entre cuentas: `POST /api/v1/messages` con `to_user_id` | idem › «POST /messages con `to_user_id` escribe al contacto de A, no al de B (fase 6 §5)» |
| `meta-api` manda `to`, `recipient`, o los dos; falla sin ninguno | `src/lib/whatsapp/meta-api.test.ts` › describe «destinatario del envío» (5 tests, incluido «vale para las cinco familias de envío, no solo para el texto») |
| Regla de elección de identidad y lista de intentos | `src/lib/whatsapp/recipient.test.ts` (12 tests) |
| Responder desde la bandeja a un contacto sin teléfono envía con `recipient` | `src/lib/whatsapp/send-message.test.ts` › «responde con `recipient` cuando el contacto solo tiene BSUID» |
| Con las dos identidades manda el teléfono | idem › «con teléfono y BSUID manda el teléfono: es la identidad estable» + `broadcast-core.test.ts` › «con teléfono y BSUID en la misma fila, manda el teléfono» |
| Sin ninguna identidad, 400 y no se envía nada | idem › «sin ninguna de las dos identidades es un 400 y no se envía nada» |
| Difusión con destinatarios sin teléfono | `src/lib/whatsapp/broadcast-core.test.ts` › «acepta `to_user_id` y planifica el envío por `recipient`» y «envía por `recipient` en la entrega» |
| `to_user_id` inválido no tumba la campaña | idem › «rechaza un BSUID con formato imposible, sin tumbar la campaña» |
| `/api/v1/messages` acepta `to` o `to_user_id`, valida el formato | `src/lib/whatsapp/resolve-conversation.test.ts` › describe «resolveConversationForTarget — BSUID» (5 tests) |
| Búsqueda y presentación por `@usuario` / «Sin número» | `src/lib/contacts/display.test.ts` (12 tests) |
| Contacto por BSUID en la API pública, acotado por cuenta | `src/lib/api/v1/contacts.test.ts` › «busca por BSUID y no exige teléfono» y «rechaza un BSUID con formato imposible con un 400 que lo nombra» |
| Los tests existentes con teléfono siguen verdes | 2065 tests, 0 fallos |

## Verificaciones contra base real

`progress/checks_whatsapp-bsuid.sql`, ejecutado contra el Postgres del harness
(`KEEP=1 scripts/replay-migrations.sh`), 9 comprobaciones, todas OK:

1. Alta por BSUID sin teléfono (con `phone_normalized` NULL).
2. Dos contactos sin teléfono conviven en la misma cuenta — el índice único parcial de la
   022 no los enfrenta.
3. El mismo BSUID dos veces en una cuenta → `unique_violation`.
4. El mismo BSUID en otra cuenta sí se acepta: el índice es `(account_id, wa_user_id)`.
5. Casado de un contacto por teléfono al que llega su BSUID, sin duplicar (una sola fila
   con las dos identidades).
6. Teléfono completado a posteriori en un contacto nacido por BSUID; `phone_normalized` se
   regenera sola.
7. Fila sin ninguna de las dos identidades → `check_violation`.
8. El `UPDATE` que dejaría una fila sin identidad también se rechaza.
9. `filter_contacts_by_tags` encuentra por username, con arroba y sin ella.

Nota para quien lo repita: el guion **no** inserta cuentas a mano. `on_auth_user_created`
crea cuenta, perfil y membresía por cada alta en `auth.users`, y `idx_accounts_one_per_owner`
(017) admite una sola cuenta por dueño; el guion da de alta dos usuarios y lee las cuentas
que el trigger creó.

## Verificación manual pendiente (depende de Meta)

Nada de lo que sigue se puede automatizar: hace falta tráfico real de WhatsApp.

1. **Un WhatsApp con nombre de usuario escribe al número de pruebas.**
   - Preparación: una cuenta de WhatsApp personal con nombre de usuario activado que
     **no** haya hablado con el número de pruebas en 30 días y que no tenga el número en su
     agenda. Confirmar en Meta → WhatsApp Manager que el número de pruebas está suscrito al
     webhook de esta instalación.
   - Paso 1. Escribir «hola» desde ese WhatsApp.
     Esperado: en los logs del webhook **no** aparece ningún descarte; en la bandeja sale
     una conversación nueva cuyo encabezado es el nombre de perfil y, bajo él, `@usuario`
     (nunca un número). En `contacts` la fila tiene `phone = NULL`, `wa_user_id` con formato
     `CC.…` y `wa_username` sin arroba.
   - Paso 2. Responder desde el compositor de la bandeja.
     Esperado: el mensaje llega al móvil. En la llamada a Meta (log de red o
     `messages.message_id` devuelto) el cuerpo lleva `recipient` y **no** `to`.
   - Paso 3. Mirar los recibos de entrega.
     Esperado: la burbuja pasa a «entregado» y luego a «leído»; el webhook de estado trae
     `recipient_user_id` y no `recipient_id`.
   - Paso 4. Buscar en Contactos por el nombre de usuario, con arroba y sin ella.
     Esperado: el contacto aparece en los dos casos. En la columna Teléfono se lee
     `@usuario`.
   - Paso 5. Que ese mismo WhatsApp comparta su número (compartir contacto) y vuelva a
     escribir.
     Esperado: **no** se crea un segundo contacto; la fila de siempre gana el teléfono y la
     columna pasa a enseñarlo. La conversación es la misma.
   - Paso 6 (el camino inverso). Con un contacto que ya existía por teléfono, que escriba
     desde un WhatsApp con nombre de usuario dentro de la ventana de 30 días.
     Esperado: su fila gana `wa_user_id` y `wa_username`; sigue habiendo un solo contacto.
2. **Difusión a un destinatario sin teléfono.** `POST /api/v1/broadcasts` con
   `{ "to_user_id": "<BSUID del contacto>" }`. Esperado: 202, la fila de
   `broadcast_recipients` pasa a `sent` y el móvil recibe la plantilla.

## Decisiones donde el spec era ambiguo

- **`recipient` y `to` juntos.** La spec dice «en lugar de o además de `to`; si van ambos
  gana `to`». `meta-api.ts` manda los dos cuando el llamante da los dos (fiel a Meta), pero
  el resolutor de destinatario nunca los manda juntos: elige uno. Así el comportamiento no
  depende de cómo se comporte Meta ante la ambigüedad.
- **Qué identidad manda.** El teléfono, siempre que sea marcable. Es la que sobrevive a que
  el usuario quite su nombre de usuario y la que este producto lleva usando desde el primer
  día. Un teléfono guardado pero no marcable (basura de una importación) **no** bloquea el
  envío si hay BSUID: se cae a él.
- **Validación del BSUID en dos niveles** (permisiva hacia dentro, estricta hacia fuera):
  ver §3. El motivo es CP11: si Meta emitiera mañana un prefijo distinto, un entrante no se
  puede perder por una expresión regular nuestra.
- **El BSUID no se enseña en la interfaz.** Son hasta 130 caracteres opacos. Sí sale en la
  API pública (`wa_user_id`), porque sin él un cliente externo no podría usar `to_user_id`.
- **El nombre de usuario se guarda sin arroba.** La arroba es decoración de la interfaz;
  guardarla obligaría a recortarla en cada búsqueda.
- **Desempate de estados, no filtro.** Cuando el `wamid` encuentra varias filas, la
  identidad del evento elige; si no resuelve, se toma la primera. Nunca excluye la única
  coincidencia: desempatar no puede costar una actualización.
- **El alta manual y la importación CSV siguen exigiendo teléfono.** Un humano que teclea
  un contacto no tiene el BSUID de nadie; el BSUID solo lo emite Meta.

## CP7 (Next 16)

No se estrena ninguna API del framework. Las rutas tocadas
(`/api/whatsapp/webhook`, `/api/whatsapp/react`, `/api/v1/messages`) conservan la firma de
sus manejadores y el `after()` del webhook tal y como estaban; los cambios son del cuerpo
hacia dentro. Se ha comprobado en `node_modules/next/dist/docs/` que `after` sigue
importándose de `next/server` y que un manejador de ruta sigue devolviendo `Response` /
`NextResponse`, que es todo lo que este diff usa.

## Variables de entorno nuevas

Ninguna. `docs/docker.md` no cambia. `.env.local.example` está bloqueado por permisos y
tampoco habría hecho falta tocarlo.

## Deuda detectada (no arreglada)

1. **Botón `REQUEST_CONTACT_INFO` en plantillas** (punto 5 de la spec): ver arriba. Es la
   vía que Meta da para pedir el teléfono cuando un flujo lo necesita —exportar contactos,
   facturar— y hoy no existe. Feature propia.
2. **`notify_conversation_assigned()` (migración 027)** resuelve el nombre del contacto con
   `COALESCE(NULLIF(name,''), phone)`. Con un contacto sin teléfono ni nombre, la
   notificación dice «…a conversation with a contact» en vez del `@usuario`. Degrada con
   elegancia (ya tenía ese `COALESCE`), y arreglarlo obliga a copiar una función de 60
   líneas a una migración nueva. Fuera de alcance.
3. **`POST /api/v1/contacts` sigue exigiendo `phone`.** El helper interno ya sabe crear por
   BSUID (lo usan las difusiones), pero la ruta no lo expone. No estaba en el encargo.
4. **La búsqueda por `wa_username` es un `ILIKE '%…%'` sin índice.** Igual que la de
   `name` / `email` / `phone` de siempre; si la lista de contactos crece, las cuatro piden
   el mismo remedio (trigramas), no solo esta.
5. **El texto del aviso de duplicado y el `aria-label` de la tabla** usan el nombre del
   contacto sin traducir el hueco en algunos idiomas; preexistente, no se ha tocado.

## Hallazgo fuera del guion, sí arreglado (y por qué)

El espejo de estados de entrega actualizaba `messages` con
`.update({status}).eq('message_id', status.id)` **sin acotar por cuenta**, y
`broadcast_recipients` igual. El propio código advertía (comentario de la migración 009) de
que los ids de Meta se repiten entre números: dos empresas con un `wamid` coincidente se
movían los contadores la una a la otra. Como esta feature obligaba a tocar esa función de
todos modos —para leer `recipient_user_id`— se ha acotado a la cuenta del número por el que
llegó el evento, con test de fuga. Queda anotado aquí porque estrictamente es un arreglo de
aislamiento (CP3) y no parte de §5; deshacerlo sería reintroducir el agujero.
