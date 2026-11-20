# Correcciones de la auditoría ponytail del 2026-11-20

Brian pidió la auditoría y luego «aplica las correcciones para todo» (2026-11-20). Este documento es
el spec. El detalle de cada hallazgo (caso concreto, líneas, test que falta) está en los seis
informes de esta misma carpeta (`audit-*.md`); aquí está qué hay que hacer y qué test lo prueba.

Reglas para todas las secciones:

- El arreglo más pequeño que resuelva el caso. Sin capas, opciones ni refactors que el hallazgo no pida.
- Cada hallazgo lleva al menos un test que falla sin el arreglo (el caso concreto del informe).
- Si un test existente fija el comportamiento malo, se cambia y se dice en el informe.
- Antes de tocar una función compartida, grep de todos sus llamadores.
- Si al leer el código el hallazgo resulta falso o ya resuelto, no se inventa un arreglo: se anota
  en `progress/impl_<name>.md` con la evidencia.

## A. Mensajes entrantes de WhatsApp (`p16.1`, informe `audit-whatsapp.md` 1, 2, 3, 5, 6)

Rama basada en `fix/health-chat-perf` (n15.6, aprobada y sin fusionar; toca los mismos archivos).

- **A1** `src/lib/contacts/dedupe.ts` `findExistingContact`: prefiltrar por `phone_normalized`, no
  por `phone`. Test: contacto guardado `+1 (809) 555-1234`, entrante `18095551234` → lo encuentra.
- **A2** mismo sitio: coincidencia exacta de dígitos primero; una candidata no exacta solo vale si
  es variante de prefijo troncal 0 (reusar `phoneVariants` si sirve; si no, la comprobación mínima
  equivalente). `phonesMatch` no cambia (lo usa el aviso suave del formulario). Tests:
  `18095551234` y `18295551234` son contactos distintos; `370063949836` sigue casando con
  `37063949836`. Revisar los demás llamadores de `findExistingContact` (CSV, alta manual, v1,
  coexistencia, `broadcast-core.ts`).
- **A3** `src/app/api/whatsapp/webhook/route.ts`: aislar cada `change`, cada mensaje y cada status
  en su propio try/catch (log y seguir). Un `access_token` que no descifra no impide guardar texto
  (media cae a null). Un `timestamp` ausente o no numérico no lanza. Tests: entrega con un mensaje
  malo y uno bueno → el bueno se guarda.
- **A4** misma ruta, `handleStatusUpdate`: `messages.status` solo avanza (`sending → sent →
  delivered → read`; `failed` solo desde `sending`/`sent`), con la condición en el propio UPDATE.
  Para `broadcast_recipients`, añadir `.eq('status', <estado leído>)` al UPDATE. Test: `read`
  seguido de `delivered` deja `read`.
- **A5** `src/lib/whatsapp/meta-api.ts`: un `metaFetch` de módulo que añade
  `AbortSignal.timeout(15_000)` cuando el llamador no pasa `signal` (más largo para subir/bajar
  media), usado por todos los helpers que hoy llaman `fetch` a secas. Test: un helper pasa `signal`.

## B. Cobro (`p16.2`, informe `audit-billing.md` 1, 2, 3)

- **B1** `src/lib/billing/entitlements.ts` `getEntitlements`: leer `current_period_end` y
  `cancel_at_period_end`; solo lectura cuando `(status === 'cancelled' || cancel_at_period_end)` y
  el período ya terminó (o no hay fecha). Los planes manuales no cambian. Corregir el comentario de
  `isReadOnly`. Tests: cancelada con período vigente → escribe; cancelada con período vencido → solo
  lectura; `active` + `cancel_at_period_end` vencido → solo lectura; plan manual → sin cambios.
  Revisar que `subscription-view.ts` y el checkout de «volver a contratar» siguen funcionando para
  una cuenta bloqueada así (tiene que poder pagar).
- **B2** `src/app/api/billing/subscription/route.ts` (`change_plan`) y
  `src/app/api/billing/checkout/route.ts` (POST): 409 cuando la suscripción tiene
  `meta_billing = 'managed'`. Un test por ruta.
- **B3** `src/lib/billing/statement-cron.ts`: `due_at` se cuenta desde `max(period_end, ahora)`.
  Test: emisión una semana después del corte → `due_at` = emisión + 3 días, la cuenta no nace vencida.

## C. Base de datos: privilegios (`p16.3`, informe `audit-auth.md` 1, 2, 3, 5)

Una sola migración `098_audit_privilege_hardening.sql`, idempotente, con sus aserciones en
`supabase/ci/verify-schema.sql` y SQL de comprobación en `progress/checks_<name>.sql` ejecutado
contra el Postgres del harness (`KEEP=1 scripts/replay-migrations.sh`).

- **C1** `enforce_profile_privilege_columns`: bloquear también el cambio de `email` para
  `current_user = 'authenticated'`. Antes, confirmar con grep que ningún cliente de navegador
  actualiza `profiles.email` (si alguno lo hace, parar y reportar `blocked`). Comprobación: como
  `authenticated`, `UPDATE profiles SET email` falla; `full_name` sigue pudiendo cambiarse.
- **C2** `DROP POLICY profiles_insert`. Antes, confirmar con grep que ningún cliente inserta en
  `profiles` con la sesión del usuario. Comprobación: `handle_new_user` sigue creando el perfil.
- **C3** `REVOKE ALL ... FROM PUBLIC, anon, authenticated` + `GRANT EXECUTE ... TO service_role`
  para `record_webhook_failure`, `_bcast_bump`, `recompute_broadcast_counts`,
  `merge_duplicate_contacts` y la función de fusión de conversaciones de la migración 036.
  Comprobar que los triggers de difusión siguen funcionando (son SECURITY DEFINER) y que
  `src/lib/webhooks/queue.ts` llama con rol de servicio. Aserciones `has_function_privilege`.
- **C4** Políticas INSERT/UPDATE/DELETE de `storage.objects` para `chat-media` (023) y los buckets
  de 020 (flow media): añadir `AND p.account_role <> 'viewer'`. Las de SELECT no se tocan.
  Comprobación: un `viewer` no puede borrar; un `agent` sí.

## D. IA (`p16.4`, informe `audit-ai.md` 1, 2)

- **D1** `src/lib/ai/tools/prompt.ts`: los ids solo salen de resultados de herramientas de esta
  conversación (quitar «or given by the customer»). `src/lib/ai/tools/loop.ts`: antes de ejecutar
  una operación con un parámetro id en la ruta (o `patient_id`), ese valor tiene que aparecer en un
  resultado `ok` de una herramienta de esta conversación; si no, la herramienta devuelve al modelo
  un error que le dice que lo busque primero, y no se ejecuta. Reusar la evidencia por conversación
  que ya existe para `requires_prior`. La operación `list_patients` no se ofrece al bot (una marca
  de política comprobada donde se arma el toolset). Cuidado con no romper el flujo normal:
  `lookup_patient` → `list_appointments` → `cancel_appointment` con ids devueltos tiene que seguir
  pasando. Tests: id tecleado por el cliente → no se ejecuta; id devuelto por una herramienta → sí.
- **D2** `src/lib/ai/auto-reply.ts`: releer `assigned_agent_id`, `ai_autoreply_disabled` y `status`
  justo antes de `claim_ai_reply_slot` y salir sin enviar si alguna puerta ya no pasa. En la rama de
  handoff, el UPDATE que asigna agente lleva `.is('assigned_agent_id', null)`. Tests: asignación
  hecha durante la generación → no se envía; handoff no pisa una asignación hecha durante la generación.

## E. Motores y webhooks salientes (`p16.5`, informe `audit-engines.md` 1, 2, 3, 4, 5)

- **E1** `src/app/api/automations/engine/route.ts`: `delete context.conversation_id`. Test en
  `engine/route.test.ts`.
- **E2** `src/lib/automations/steps-tree.ts` `replaceSteps`: antes de borrar los pasos, marcar
  `failed` las filas `pending` de `automation_pending_executions` de esa automatización (con un
  motivo legible en el log si la tabla lo permite). Si el insert falla tras el borrado, no dejar la
  automatización vacía sin avisar: devolver el error como hoy y documentarlo; no se pide transacción.
  Test: guardar con una ejecución aparcada → queda `failed`, no se reanuda.
- **E3** `src/lib/webhooks/queue.ts`: `claimDelivery` mueve `next_attempt_at` a ahora + 2 ×
  timeout de entrega; `markFailed`/`markDelivered` filtran por `attempt`. Tests: fila reclamada no
  aparece como vencida; un intento viejo no pisa el resultado de uno nuevo.
- **E4** `src/lib/automations/engine.ts` `time_of_day`: la hora se calcula con
  `Intl.DateTimeFormat` en la zona `cfg.timezone` (IANA, opcional) y, si falta, en la de la variable
  de entorno `AUTOMATION_DEFAULT_TIMEZONE`; sin ninguna de las dos, se comporta como hoy. Zona
  inválida → como si faltara. Documentar la variable en `docs/docker.md`. Sin campo nuevo en el
  constructor; solo el texto de ayuda del operando dice que la zona es la del servidor salvo
  configuración (`messages/es.json` y `en.json`). Tests con hora fija para Santo Domingo.
- **E5** `src/lib/flows/engine.ts` `advanceFromNodeKey`: `Set` de nodos visitados en la llamada;
  al repetir uno, la ejecución falla sin enviar otra vez. Test: `A → A` envía una vez.

## F. Cliente (`p16.6`, informe `audit-lean.md` 1, 2)

- **F1** `src/components/inbox/message-thread.tsx`: `key={conversation.id}` en `<MessageComposer>`.
  Test de componente si el repo ya tiene el patrón (`*.test.tsx`); si no, anotar la comprobación manual.
- **F2** `src/hooks/use-broadcast-sending.ts`: un helper local que pagina con `.range()` (páginas
  de 1000, orden estable) en las lecturas sin límite de audiencia, etiquetas, exclusión y relectura
  de destinatarios; trocear los `.in('id', …)` como ya hace la línea ~147; si la consulta de
  exclusión falla, lanzar (no enviar). Sacar la lógica a funciones puras testeables si hace falta
  para el test. Tests: 2 500 contactos → 2 500 destinatarios; error en exclusión → no se envía.

## G. Limpieza (`p16.7`, informes `audit-lean.md` 5, 6, 11, 12 y `audit-auth.md` 8) — después de A–F

- **G1** Copiar `node_modules/shadcn/dist/tailwind.css` a `src/app/shadcn.css`, importarlo desde
  `globals.css`, quitar `shadcn` de `dependencies` y los `overrides` que solo existían por su
  subárbol (comprobar con el lockfile cuáles), regenerar `package-lock.json` con `npm install`.
  `tsconfig.json` excluye `mcp-server`; CI añade un paso que construye `mcp-server` con sus propias
  dependencias. La compuerta completa tiene que seguir verde.
- **G2** Un solo `supabaseAdmin()` (`src/lib/auth/admin-client.ts`); los otros tres archivos lo
  reexportan y las tres copias en rutas se sustituyen por el import. Un solo `UUID_RE`/`isUuid`
  exportado (la variante estricta), usado en los 23 sitios.
- **G3** Borrar código muerto confirmado con grep en todo el árbol: leyenda de
  `src/components/tremor/bar-chart.tsx` y `use-on-window-resize.ts`, `ui/separator.tsx`,
  `platform-placeholder.tsx` (y su test), `assertNever`, `assertMessageTemplate`,
  `COEXISTENCE_FEATURE_TYPE`, los cinco SVG de `public/` sin referencias. No tocar las
  exportaciones sueltas de `src/components/ui`.
- **G4** Plantillas: las secuencias editar / borrar / enviar de
  `src/app/api/whatsapp/templates/**` y `src/app/api/v1/templates/**` pasan a funciones compartidas
  en `src/lib/whatsapp/`; cada ruta se queda con su autenticación y su formato de respuesta. Las
  escrituras del panel pasan a filtrar por `account_id`. Los tests existentes de ambas rutas siguen
  verdes sin cambiar sus aserciones de comportamiento.
