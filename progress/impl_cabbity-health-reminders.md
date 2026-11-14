# impl_cabbity-health-reminders (n15.3)

Rama `feat/cabbity-health-reminders` (worktree `.claude/worktrees/cabbity-health-reminders`). Spec: Health `specs/whatsapp-agenda/` design §15, tasks Tanda W.

## Plan

W1 evento `message.interactive_reply` · W2 `template.params` objeto validado · W3 `GET /api/v1/numbers` · W4 docs + CHANGELOG + compuerta.

## Compuerta

En el worktree:

```
npm run lint            # 0 errores, 34 warnings (preexistentes)
npm run typecheck       # ok
TZ=UTC npm test         # 410 archivos pasan, 1 skipped; 6322 tests pasan, 7 skipped
NEXT_PUBLIC_SUPABASE_URL=https://ci.example.supabase.co NEXT_PUBLIC_SUPABASE_ANON_KEY=ci-dummy-anon-key \
  ENCRYPTION_KEY=000…0 META_APP_SECRET=ci-dummy-meta-secret npm run build   # ok, /api/v1/numbers aparece
```

El build necesita las variables dummy de `ci.yml` (el worktree no tiene `.env.local`; no se leyó ningún `.env`).

## Criterio ↔ test

| Criterio | Test |
|---|---|
| W1 vocabulario, suscripción solo a este evento, campos de `data` | `src/lib/webhooks/events.test.ts` «message.interactive_reply (cabbity-health W1)» |
| W1 emisión desde el webhook de Meta (`button` y `interactive`), `reply_id` sin alterar, junto a `message.received`; texto no lo emite | `src/app/api/whatsapp/webhook/route.test.ts` «message.interactive_reply (cabbity-health W1)» |
| W1 OpenAPI/guía | `webhook-events.ts`, `reference.ts` es/en, fixture; cubiertos por `real-document.test.ts`, `validate-examples.test.ts` |
| W2 forma inválida 400; alias snake_case; 400 a botón no QUICK_REPLY/URL/COPY_CODE o índice inexistente; `payload` en componente `quick_reply` | `src/lib/whatsapp/template-params.test.ts`; `send-message.test.ts` «template.params objeto (W2)»; `v1/messages/route.test.ts` «template.params objeto (W2)» |
| W3 forma, scope `messages:send`, sin tokens, aislamiento por cuenta | `src/app/api/v1/numbers/route.test.ts` |
| Cobertura OpenAPI (rutas ↔ documento) | `coverage.test.ts`, `openapi.json/route.test.ts`, `real-document.test.ts`, `model.test.ts` (conteos 37→38 ops, 25→26 rutas) |

## Contrato final

### Evento `message.interactive_reply`

Sobre estándar (`id`, `event`, `occurred_at`, `account_id`, `data`). `data`:

```json
{
  "conversation_id": "uuid",
  "contact_id": "uuid",
  "whatsapp_message_id": "wamid de la pulsación",
  "context_whatsapp_message_id": "wamid de la plantilla/mensaje al que responde, o null",
  "reply_id": "payload del botón (type=button) o button_reply.id / list_reply.id, sin alterar",
  "reply_title": "etiqueta visible (button.text / title) o null",
  "phone": "contacto.phone o null (solo BSUID)"
}
```

Se emite **además** de `message.received`, tras él, solo si hay `interactiveReplyId` (button, button_reply, list_reply). No se emite para texto. No se emite en reenvíos de la misma entrega (la inserción idempotente corta antes).

### `template.params` objeto (`POST /api/v1/messages`)

`params`: array de strings (body posicional) **o** objeto `{ body?: string[], headerText?|header_text?: string, headerMediaUrl?|header_media_url?, headerMediaId?|header_media_id?, buttonParams?|button_params?: { "<índice>": string } }`. Índice = posición del botón en `buttons` de la plantilla. Para QUICK_REPLY el valor es el `payload`. 400 `bad_request` si: no es array/objeto, `body` no es array de strings, `headerText` no string, `buttonParams` no objeto / clave no entera / valor vacío, índice sin botón, o botón PHONE_NUMBER. Forma → antes de crear contacto/conversación; tipo de botón → tras resolver la fila de la plantilla (si la cuenta no tiene fila local no se valida el tipo). Aplica también a `/api/whatsapp/send` (mismo núcleo).

### `GET /api/v1/numbers`

Scope `messages:send`. Respuesta `{ "data": [ { "phone_number_id": "…", "display_phone_number": "…"|null, "verified_name": "…"|null, "is_default": true|false } ] }`, predeterminado primero y luego más antiguos. SELECT explícito (nunca tokens), filtrado por `account_id` de la clave. Sin paginación ni `meta` (es una lista corta). Sin números → `data: []`.

## Desvíos / decisiones

- `docs/integrations/cabbity-health.md` ya existía (conector wacrm→Health); la guía de recordatorios es su §8 en lugar de un archivo nuevo.
- «Guía de desarrolladores»: actualizado el catálogo `reference.ts` (es/en); no se tocaron `guides.ts` (no hay guía de webhooks que enumere eventos).
- `GET /numbers` responde `{data: [...]}` sin `meta.next_cursor`, como pide design §15.
- Los conteos de operaciones de los tests de OpenAPI/fixture subieron a 38 (era 37) por la nueva ruta.
- Sin migración, sin scopes, sin dependencias, sin variables de entorno nuevas.

## Verificación manual pendiente (Meta real)

M1/M2 de Health requieren una cuenta wacrm con Meta real: enviar la plantilla con `buttonParams`, tocar el botón y comprobar la entrega firmada de `message.interactive_reply`.

## Deuda

- 34 warnings de lint preexistentes.
