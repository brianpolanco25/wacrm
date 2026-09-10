# Fase 1 — Operación de la bandeja

**Peso**: 1,5 semanas · **Depende de**: fase 0

Es la fase que produce el producto que se vende: la IA atiende primero,
cede al operador libre cuando no sabe, y el equipo ve en todo momento
quién lleva cada conversación.

## Objetivo

Cerrar los cuatro huecos que hoy hacen que el circuito de atención se
rompa en silencio.

## Fuera de alcance

- Segmentar la visibilidad de los chats. La bandeja es compartida: todos
  los operadores ven todo. Solo se **indica** quién atiende.
- Cambiar el motor de IA o el mecanismo de cesión. Ambos funcionan; lo
  que se cambia es **a quién** se cede.

## 1. Elegir al operador disponible

### Problema

Existen dos caminos de asignación automática y ninguno funciona bien.

- **Cesión de la IA**: `ai_configs.handoff_agent_id` es una persona fija
  elegida en un desplegable. Nunca consulta presencia. Si esa persona
  está de vacaciones, la conversación se le asigna igual, la IA ya se
  apagó en ese hilo, y el cliente no recibe respuesta de nadie.
- **Automatizaciones**: el paso `assign_conversation` tiene un modo
  «round robin» expuesto en la interfaz cuyo código admite en su propio
  comentario que *«only ever returned the automation's author»*. Hace
  `.limit(1)` sobre los perfiles de la cuenta: asigna siempre al mismo.

Ya existe el insumo que falta: `member_presence`, con latido cada 30
segundos, donde «desconectado» se deriva de la antigüedad del último
latido en vez de depender de una escritura al cerrar la pestaña.

### Migración `042_pick_available_agent.sql`

```sql
CREATE OR REPLACE FUNCTION pick_available_agent(
  p_account_id     uuid,
  p_stale_after    interval DEFAULT '5 minutes',
  p_include_admins boolean  DEFAULT true
) RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT p.user_id
    FROM profiles p
    JOIN member_presence mp
      ON mp.user_id = p.user_id
     AND mp.account_id = p.account_id
   WHERE p.account_id = p_account_id
     AND p.account_role >= 'agent'::account_role_enum
     AND (p_include_admins OR p.account_role = 'agent')
     AND mp.status = 'online'
     AND mp.last_seen_at > now() - p_stale_after
   ORDER BY (
     SELECT count(*)
       FROM conversations c
      WHERE c.account_id  = p_account_id
        AND c.assigned_agent_id = p.user_id
        AND c.status IN ('open', 'pending')
   ) ASC,
   mp.last_seen_at DESC
   LIMIT 1;
$$;
```

Devuelve `NULL` cuando no hay nadie conectado. **`NULL` es un resultado
válido, no un error**: significa «déjala sin asignar en la cola común», y
todos los llamadores deben tratarlo así.

El desempate por `last_seen_at DESC` reparte hacia quien está más activo
cuando varios empatan a carga.

`p_stale_after` en cinco minutos por el latido de treinta segundos: da
margen a diez latidos perdidos antes de considerar a alguien ausente.

> **Nota de rendimiento.** La subconsulta de recuento corre por cada
> candidato. Con equipos de decenas de operadores es irrelevante, y el
> índice `idx_conversations_account_assignee` de la fase 0 la cubre. Si
> algún día un equipo llega a centenares, se materializa el recuento.

### Cableado

**Cesión de la IA** — `src/lib/ai/auto-reply.ts`, rama de cesión:

`ai_configs.handoff_agent_id` gana un tercer estado. Hoy son dos: una
persona concreta, o `NULL` («dejar en la cola»). Se añade `'auto'` como
valor de modo en una columna nueva `handoff_mode` con valores
`fixed | queue | auto`, dejando `handoff_agent_id` como el destino del
modo `fixed`. En modo `auto` se llama a `pick_available_agent`; si
devuelve `NULL`, se comporta como `queue`.

Se mantiene intacta la regla actual de no pisar una asignación humana ya
existente.

**Automatizaciones** — `src/lib/automations/engine.ts`, caso
`assign_conversation`: el modo `round_robin` pasa a llamar a
`pick_available_agent`. Se borra el `.limit(1)` sobre perfiles.

### Criterios de aceptación

- [ ] Con tres operadores conectados y cargas 5/2/9, la función devuelve
      el de carga 2.
- [ ] Un operador cuyo último latido tiene diez minutos no es elegible.
- [ ] Sin nadie conectado, devuelve `NULL` y la conversación queda sin
      asignar. No lanza.
- [ ] Un `viewer` nunca es elegible.
- [ ] La cesión de la IA no pisa una conversación que ya tiene humano.

## 2. Avisar al cliente antes de callarse

### Problema

En `auto-reply.ts`, cuando el modelo emite el centinela de cesión, el
texto queda vacío y la función actualiza la base de datos y retorna **sin
enviar nada**. Desde fuera, el negocio simplemente dejó de contestar.

### Cambio

Antes de retornar en la rama de cesión, enviar un mensaje de transición
configurable por cuenta.

- Columna nueva `ai_configs.handoff_message text`, con texto por defecto
  sembrado en la migración y editable en Ajustes → IA.
- Se envía con `engineSendText`, marcado como generado por IA.
- **No consume cupo de respuesta** (`claim_ai_reply_slot`): es un acuse,
  no una respuesta.
- Si el envío falla, se registra y se continúa. La cesión debe ocurrir
  igual: perder el aviso es molesto, perder la asignación es grave.
- Si la cuenta deja el mensaje vacío, no se envía nada — comportamiento
  actual, elegido a propósito.

### Criterios de aceptación

- [ ] Al ceder, el cliente recibe exactamente un mensaje de transición.
- [ ] Ese mensaje no incrementa `ai_reply_count`.
- [ ] Con el mensaje vacío no se envía nada y la cesión ocurre igual.
- [ ] Si el envío falla, la conversación queda cedida y asignada.

## 3. Ver quién atiende, en la lista

### Problema

`src/components/inbox/conversation-list.tsx` no muestra la asignación:
en sus 504 líneas no hay una sola referencia a `assigned` ni a
`profiles`, y el único avatar por fila es el del contacto.

Peor: mientras la IA atiende un hilo, `assigned_agent_id` es `NULL`, así
que **un chat que lleva la IA se ve idéntico a uno que nadie ha tocado**,
y a uno que la IA cedió y nadie recogió. Los tres casos son visualmente
indistinguibles y el tercero es el que muere en silencio.

### Cambio

Tres estados por fila, no dos:

| Estado | Condición |
|--------|-----------|
| **IA atendiendo** | cuenta con IA activa y respuesta automática · `assigned_agent_id IS NULL` · `NOT ai_autoreply_disabled` |
| **Operador X** | `assigned_agent_id` presente, con su punto de presencia |
| **Sin atender** | ninguna de las anteriores |

Los datos ya viajan: `ai_autoreply_disabled` viene en cada fila del
`CONVERSATION_SELECT`, y el estado de IA de la cuenta es una consulta
única que el banner del hilo ya hace y cachea. **No añade consultas por
conversación.**

Se añade además un filtro **«Sin atender»** en la cabecera de la lista.
Es el que convierte el indicador en herramienta: sin él, ver el estado no
ayuda a actuar sobre la cola.

### Criterios de aceptación

- [ ] Los tres estados se distinguen a simple vista, sin abrir el chat.
- [ ] Al asignar desde el hilo, la fila de la lista cambia al instante
      para el resto del equipo, por el canal de tiempo real que ya
      existe sobre `conversations`.
- [ ] El filtro «Sin atender» devuelve los chats sin operador **y sin
      IA**, incluidos los cedidos que nadie recogió.
- [ ] Con la IA desactivada en la cuenta, el estado «IA atendiendo» no
      aparece nunca.
- [ ] Textos en español e inglés.

## 4. La automatización que apaga la IA sin avisar

### Problema

En `auto-reply.ts` hay una guarda que consulta si la cuenta tiene alguna
automatización activa con disparador `new_message_received` o
`keyword_match`, y si existe **una sola**, la IA se calla en **toda la
cuenta**.

La intención es correcta —no responder dos veces al mismo cliente— pero
el alcance es equivocado: es global, no por conversación. Crear una
automatización de palabra clave para contestar «horario» deja al agente
de IA mudo en todos los chats de la empresa, en silencio y sin ninguna
señal en la interfaz.

Para un producto cuya propuesta es «la IA atiende primero», esto es una
trampa que se activa sola.

### Cambio

Sustituir la guarda global por una comprobación por mensaje: la IA se
abstiene solo si una automatización **respondió a este mensaje concreto**.
El motor de automatizaciones ya se despacha para el mismo entrante, así
que puede dejar constancia de si envió algo, y la IA la consulta.

Como red de seguridad hasta que eso esté probado en producción, se añade
un aviso visible en Ajustes → IA cuando existan automatizaciones que
puedan solaparse, con enlace a la lista.

### Criterios de aceptación

- [ ] Con una automatización de palabra clave activa que **no** coincide
      con el mensaje entrante, la IA responde.
- [ ] Con una que **sí** coincide y responde, la IA no responde.
- [ ] El cliente nunca recibe dos respuestas automáticas al mismo
      mensaje.

## Resumen de cambios

| Migración | Contenido |
|-----------|-----------|
| `042_pick_available_agent.sql` | RPC de selección por carga y presencia |
| `043_ai_handoff_mode.sql` | `handoff_mode`, `handoff_message` en `ai_configs` |

| Archivo | Cambio |
|---------|--------|
| `src/lib/ai/auto-reply.ts` | modo `auto` de cesión · mensaje de transición · guarda por mensaje |
| `src/lib/automations/engine.ts` | `round_robin` real |
| `src/components/inbox/conversation-list.tsx` | indicador de tres estados · filtro |
| `src/components/settings/ai-config.tsx` | selector de modo · mensaje · aviso de solapamiento |
| `messages/es.json`, `messages/en.json` | textos nuevos |
