# p11.5 `utility-in-window-warning` — requisitos

**Fase 11** (`feature_list.json`, `sdd: true`). Redactada el 2026-10-01 por `spec_author`.
Base de lectura: `feat/precios-meta-directo` @ be8ca0f. Solo UI + una función pura; sin migración,
sin ruta nueva, sin red. i18n: `es` (defecto) y `en`; sin `ko` (CP6).

## Contexto

Con la ventana de atención abierta (el cliente escribió hace menos de 24 h) un texto normal es un
mensaje de servicio: entra en los 1.000 gratis por número y mes y, pasados, se cobra a tarifa de
utilidad. Una plantilla de **utilidad** enviada en esa misma ventana se cobra a tarifa de utilidad
y no entra en la cuota gratis; una de **marketing** se cobra a tarifa de marketing, la más cara
(0,0740 frente a 0,0113 en RD, `progress/spec_facturacion-gestionada.md`). Es decir: en la ventana,
el texto cuesta lo mismo o menos. **Esta regla es un supuesto sin verificar (S-U1, `design.md`)**:
el texto final del aviso y si se avisa también por utilidad dependen de él.

Dónde se configura un paso que manda plantilla:

- **Automatizaciones**: el paso `send_template` (`src/components/automations/automation-builder.tsx`,
  `SendTemplateFields`). Es donde aplica el aviso.
- **Flujos**: el motor de flujos no tiene nodo de plantilla. La unión `FlowNodeConfig` de
  `src/lib/flows/types.ts` solo admite `start`, `send_message`, `send_buttons`, `send_list`,
  `send_media`, `collect_input`, `condition`, `set_tag`, `handoff` y `end`, todos de texto libre o
  interactivos. El constructor de flujos no cambia; la función pura sirve para cuando haya nodo de
  plantilla.

## Criterios de aceptación de partida (nota de la feature + encargo del líder)

- **A1** Aviso no bloqueante en el builder cuando un paso manda una plantilla `utility` (o
  `marketing`) y lo anterior garantiza ventana abierta.
- **A2** La categoría se saca de la plantilla sincronizada (`message_templates.category`).
- **A3** Texto del aviso con la regla de Meta marcada como supuesto a verificar.
- **A4** Solo UI + una función pura testeable; sin migración.
- **A5** i18n es/en; CP11 no aplica (no toca el webhook), se comprueba por diff.

## Requisitos (EARS)

### Función pura (`src/lib/automations/template-window.ts`)

- **R1** (A1) Cuando se evalúe una automatización, el sistema debe considerar que la ventana está
  **garantizada abierta** al empezar solo si el disparador es `new_message_received`,
  `first_inbound_message`, `keyword_match`, `interactive_reply` o `new_contact_created` (los cinco
  que dispara un entrante en `src/app/api/whatsapp/webhook/route.ts`); con `conversation_assigned`,
  `tag_added` o `time_based`, nunca.
  *Verificación:* `src/lib/automations/template-window.test.ts`: los ocho disparadores con un único
  paso `send_template` de utilidad.
- **R2** (A1) Cuando un paso esté precedido por pasos `wait`, el sistema debe sumar su duración (con
  la misma conversión que `waitMs` de `src/lib/automations/engine.ts`: minutos, horas, días, mínimo
  1 s) y considerar la ventana garantizada abierta solo si la suma es menor que
  `SAFE_WINDOW_MS` = 23 h (margen de 1 h sobre las 24 h por el retraso del cron).
  *Verificación:* `template-window.test.ts`: `wait 22 h` → aviso; `wait 23 h` → sin aviso;
  `wait 1 day` → sin aviso; dos `wait` de 12 h → sin aviso; `wait 90 minutes` → aviso.
- **R3** (A1) Cuando un paso esté dentro de una rama de `condition`, el sistema debe sumar las esperas
  de su ámbito padre hasta la condición y las de la rama anteriores a él; y para los pasos del ámbito
  padre que van después de la condición, debe sumar la espera **máxima** de las dos ramas.
  *Verificación:* `template-window.test.ts`: plantilla en la rama `yes` tras `wait 2 h` dentro de la
  rama y `wait 21 h` en el padre → sin aviso; plantilla tras la condición con `wait 30 h` en la rama
  `no` → sin aviso; con ramas sin esperas → aviso.
- **R4** (A1, A2) Cuando un paso `send_template` esté en ventana garantizada abierta, el sistema
  debe devolver para su `cid` `'utility'` si la plantilla elegida (por `template_name` + `language`,
  como `SendTemplateFields`) tiene `category = 'Utility'`, y `'marketing'` si es `'Marketing'`; con
  `'Authentication'`, plantilla no encontrada entre las sincronizadas o sin elegir, no debe devolver
  nada.
  *Verificación:* `template-window.test.ts`: las tres categorías, nombre igual en dos idiomas con
  categorías distintas (gana el idioma del paso), plantilla desconocida, `template_name` vacío.
- **R5** (A3, supuesto S-U1) Mientras la constante `WARN_UTILITY_IN_WINDOW` sea `false`, el sistema
  no debe devolver `'utility'` (solo `'marketing'`). Su valor inicial es `true`.
  *Verificación:* `template-window.test.ts` llamando a la función con la opción
  `{ warnUtility: false }` (la constante es el valor por defecto de esa opción).
- **R6** (A4) La función debe ser pura: sin `fetch`, sin Supabase, sin reloj, sin `window`; recibe
  disparador, árbol de pasos y plantillas y devuelve un `Map<cid, 'utility' | 'marketing'>`.
  *Verificación:* el archivo no importa nada salvo tipos (`@/types`) — comprobado en el test con un
  `import` en entorno node sin mocks; revisión del reviewer.

### UI del builder de automatizaciones

- **R7** (A1) Cuando el paso `send_template` expandido tenga aviso, el sistema debe mostrar bajo el
  selector de plantilla un `Alert` no destructivo con el título `templateWindow.title` y: para
  `utility`, el texto `templateWindow.utility` (un texto normal cuesta lo mismo o menos que esta
  plantilla de utilidad); para `marketing`, `templateWindow.marketing` (se cobra a tarifa de
  marketing, la más cara; un texto cuesta menos). En cuentas `direct` (o sin dato), además
  `templateWindow.quotaNote` (las plantillas no entran en los {freeTier} mensajes de servicio gratis
  del mes); en cuentas `managed`, sin esa frase. Textos exactos en `design.md` §Claves i18n.
  *Verificación:* `src/components/automations/template-window-notice.test.tsx`: `utility`/`direct`,
  `marketing`/`direct`, `utility`/`managed`, `metaBilling` indefinido (se trata como `direct`).
- **R8** (A1) Cuando un paso `send_template` con aviso esté plegado, el sistema debe mostrar en su
  cabecera un indicador ámbar con texto accesible (`aria-label`/`title`) que diga que la plantilla
  se envía con la ventana abierta.
  *Verificación:* test de render del indicador en `template-window-notice.test.tsx`.
- **R9** (A1) El aviso no debe impedir guardar, activar ni editar la automatización ni cambiar el
  cuerpo que se envía a la API.
  *Verificación:* test de `toApiSteps` (`automation-builder.tsx`) con y sin aviso: mismo resultado;
  el diff no toca `src/lib/automations/validate.ts` ni `src/app/api/automations/` (CP8).
- **R10** (A1) Cuando cambien el disparador, los pasos o la plantilla elegida, el sistema debe
  recalcular los avisos sin recargar la página.
  *Verificación:* test en `template-window-notice.test.tsx` del componente proveedor: cambiar el
  disparador de `keyword_match` a `tag_added` quita el aviso; cambiar la plantilla de una de
  autenticación a una de utilidad lo pone.
- **R11** (CP6) Cuando se añada un texto de UI, el sistema debe tenerlo en `messages/es.json` y
  `messages/en.json` con la misma clave y los mismos placeholders ICU.
  *Verificación:* `template-window-notice.test.tsx` recorre las claves
  `Automations.builder.templateWindow.*` en los dos catálogos; `src/i18n/messages.test.ts` verde.

### Lo que no cambia

- **R12** (A4, A5) Esta feature no debe añadir migraciones, rutas ni consultas nuevas, ni tocar el
  motor de automatizaciones, el de flujos, el constructor de flujos ni el webhook.
  *Verificación:* `git diff --stat` limitado a `src/lib/automations/template-window*`,
  `src/components/automations/*`, `messages/*.json` y `CHANGELOG.md` (CP8, CP11).

## Guion manual (lo ejecuta el humano)

1. Confirmar en la documentación de precios de Meta del 2026-10-01 cómo se cobra una plantilla de
   utilidad entregada **dentro** de la ventana de atención (S-U1). Si es gratis, poner
   `WARN_UTILITY_IN_WINDOW = false` antes de desplegar y ajustar el texto `utility` (o retirarlo).
2. Con un número real, mandar una plantilla de utilidad dentro de la ventana y mirar en
   `message_charges` la `pricing_category`, `pricing_type` y `pricing_billable` que devuelve Meta.
3. En `/automations/new`, disparador «palabra clave», paso «Enviar plantilla» con una plantilla de
   utilidad sincronizada → aviso visible; añadir un `wait` de 1 día antes → desaparece.

## Fuera de alcance

- Nodo de plantilla en flujos.
- Avisos en difusiones (s10.5 ya estima su costo) o en el compositor.
- Calcular el costo en dinero del paso.
