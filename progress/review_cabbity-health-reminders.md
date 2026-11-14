# Review — n15.3 cabbity-health-reminders

**Veredicto:** APPROVED

## Compuerta
- Corridos en el worktree: `npm run lint` (0 errores, 34 warnings preexistentes), `npm run typecheck` (ok), `TZ=UTC npm test` (410 archivos, 6322 tests pasan, 7 skipped), `npm run build` con las variables dummy de ci.yml (ok).

## Trazabilidad
- GET /numbers aislamiento por `account_id`, sin tokens, scope: [x] `src/app/api/v1/numbers/route.test.ts` (dos cuentas, `access_token` ausente del cuerpo). La ruta filtra `.eq('account_id', ctx.accountId)` y hace SELECT explícito.
- `template.params` objeto validado, 400 por forma/botón/índice, array intacto: [x] `template-params.test.ts`, `send-message.test.ts`, `v1/messages/route.test.ts`. `validateTemplateParams` deja pasar arrays y `undefined`; `/api/whatsapp/send` comparte núcleo.
- `message.interactive_reply`: [x] `webhook/route.test.ts` y `events.test.ts`. Solo con `interactiveReplyId` (button/button_reply/list_reply). Va después de la inserción idempotente, que corta los reenvíos de Meta antes. Pasa por `dispatchWebhookEvent`, mismo firmado que los demás eventos.
- OpenAPI: [x] conteos 37→38 / 25→26 justificados por la nueva ruta.

## Checkpoints
CP1 [x] · CP2 n/a · CP3 [x] · CP4 [x] (M1/M2 Meta real: guion manual en el informe) · CP5 [x] · CP6 n/a · CP7 n/a · CP8 [x] · CP9 [x] · CP10 [x] · CP11 [x].

## Hallazgos wacrm
Ninguno bloqueante. Deuda: el evento se emite también si un flow consumió el toque (coherente con `message.received`).

## Compatibilidad con Cabbity Health (rama dev, solo lectura)
Coinciden: cabecera `X-Wacrm-Signature: t=,v1=` HMAC(t.cuerpo); sobre `id/event/data`; eventos `message.interactive_reply` y `message.status_updated`; campos `reply_id`, `context_whatsapp_message_id`, `whatsapp_message_id`, `conversation_id`; `/numbers` (`phone_number_id`, `display_phone_number`, `verified_name`, `is_default`, 404 tolerado); sobre de error `error.code`; `Idempotency-Key`; respuesta de envío `message_id/whatsapp_message_id/conversation_id`.

Incompatibilidad real:
1. **`buttonParams` serializado como array JSON.** `SendWhatsappReminderJob::buttonTokens` (`Jobs/SendWhatsappReminderJob.php:252`) devuelve `['0'=>…, '1'=>…]`. PHP convierte las claves a int y, con 0 y 1 (índices por defecto), `json_encode` produce una lista `["chr1:…:confirm","chr1:…:cancel"]`. wacrm responde 400 `bad_request` («buttonParams must be an object keyed by button index») y el envío falla siempre con los índices por defecto. Arreglo recomendado en **Health**: en `WacrmClient::sendTemplate` enviar `(object) $buttonParams`. Aceptar arrays en wacrm contradice el contrato documentado; mejor Health.

Notas: Health descarta a propósito `reply_title` y `phone`; ambos lados usan camelCase `buttonParams`.
