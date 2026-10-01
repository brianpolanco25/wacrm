# p11.4 `ai-single-reply` — tareas

Rama `pmd/ai-single-reply` desde `feat/precios-meta-directo` @ be8ca0f; worktree
`.claude/worktrees/pmd-ai-single-reply`. Sin red, sin migración, sin claves i18n. Informe en
`/Users/brian/Documents/Dev/projects/wacrm/progress/impl_ai-single-reply.md`, con la tabla de
auditoría de `design.md` copiada y cada fila enlazada a su test.

- [ ] **T1 Límite de texto.** `src/lib/whatsapp/text-limit.ts` (`WHATSAPP_TEXT_MAX_LENGTH`,
  `fitWhatsAppText`). — **R3** · Prueba: `src/lib/whatsapp/text-limit.test.ts` (4096 exactos, 4097,
  corte en espacio, sin espacios, emoji en la frontera, espacios finales).
- [ ] **T2 IA: un envío por turno.** `src/lib/ai/auto-reply.ts`: `fitWhatsAppText` antes de los dos
  `engineSendText`, `warn` sin texto, cabecera. — **R1, R2, R3, R4, R5** · Prueba:
  `src/lib/ai/auto-reply.test.ts`, bloque «un solo envío por turno (p11.4)»: normal, traspaso,
  traspaso con texto parcial, texto vacío, aviso vacío, varios párrafos, 6.000 caracteres, mismo
  `inboundMessageId` dos veces, `engineSendText` lanzando (dos mensajes de error).
- [ ] **T3 Flujos: tipos.** `FlowRunRow.last_advanced_at` y `outcome: "lost_race"` en
  `src/lib/flows/types.ts`. — **R6, R7** · Prueba: `npm run typecheck`.
- [ ] **T4 Flujos: reclamar antes de enviar.** `src/lib/flows/engine.ts`: `advanceCurrentNodeKey` con
  `expectedLastAdvancedAt`, reclamo en `handleReplyForActiveRun` (con `vars`/`reprompt_count` de
  `collect_input` en el mismo UPDATE), reprompt condicionado. — **R6, R7, R10** · Prueba:
  `src/lib/flows/engine.test.ts` (carrera de dos toques, botón al mismo nodo, dos textos a
  `collect_input`, dos reprompts, cadena con dos `send_message` = 2 envíos, mismo
  `meta_message_id` = 0).
- [ ] **T5 Flujos: errores tras enviar.** `try` en `send_buttons`/`send_list` (avance y reprompt) y
  `engaged` en `dispatchInboundToFlows`. — **R8, R9** · Prueba: `engine.test.ts` (botones y lista
  lanzando en avance y en reprompt → `consumed: true`, una llamada) y
  `src/lib/flows/dispatch.test.ts` (excepción tras empezar → `consumed: true`; antes → `false`).
- [ ] **T6 Automatizaciones y cron.** Tests de R11 en `src/lib/automations/engine.test.ts` (los cuatro
  pasos de envío lanzando → una llamada, sin pasos siguientes, log `failed`) y
  `src/app/api/automations/cron/route.test.ts` **(nuevo)** (dos `GET` sobre la misma fila → una
  reanudación; 401; 503). Confirmar y citar los tests de `reply-marker.test.ts` de R13. Código solo
  si un test destapa un reintento. — **R11, R12, R13** · Prueba: los tests citados.
- [ ] **T7 Variantes de teléfono.** Tests en `src/lib/flows/meta-send.test.ts` y
  `src/lib/automations/meta-send.test.ts`: 500 en la primera variante → una llamada; «recipient not
  allowed» → dos llamadas y un mensaje guardado. — **R14** · Prueba: los tests nuevos.
- [ ] **T8 Alcance.** En el informe, `git diff --stat` sin `supabase/` ni
  `src/app/api/whatsapp/webhook/route.ts`, y el guion manual de `requirements.md` con S-L1…S-L3
  pendientes. — **R15, R16 (CP8, CP11)** · Prueba: revisión del reviewer.
- [ ] **T9 Compuerta en verde + CHANGELOG.** Entrada en `CHANGELOG.md` (Unreleased);
  `npm run lint && npm run typecheck && TZ=UTC npm test && npm run build` (variables dummy de
  `ci.yml`); commits en español con prefijo y `Co-Authored-By`, sin push. — **CP1, CP9, CP10** ·
  Prueba: salida de la compuerta en `progress/impl_ai-single-reply.md`.
