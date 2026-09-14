# f1.5 — `ai-replies-counter`

Rama `saas/fase-1-bandeja`, worktree `.claude/worktrees/fase-1`, sobre `316441c`.
Spec: `docs/saas/fase-0-cimientos.md` §4 (supuesto S1: «la métrica `ai_replies`
empieza a contar en la fase 1 aunque no se aplique el límite hasta la fase 3»)
más el modelo de la migración 041 (`usage_counters` + `increment_usage`).

## Qué cambia

Una sola cosa: cuando el agente de IA entrega una respuesta automática, la
cuenta suma 1 en `usage_counters` para la métrica `ai_replies` del mes natural.
Sin SQL nuevo (la RPC ya existe desde la 041), sin textos de UI, sin variables
de entorno, sin límites.

- `src/lib/ai/auto-reply.ts` — `countAiReply(db, accountId)`, una función privada
  de 20 líneas que llama `increment_usage(p_account_id, 'ai_replies', 1)` con el
  cliente de rol de servicio que la propia despachada ya tenía abierto. Se invoca
  en una única línea, **después** del `await engineSendText(...)` del camino de
  respuesta.
- `src/lib/ai/auto-reply.test.ts` — rama `increment_usage` en el mock de `rpc`
  (modela el upsert por cuenta+métrica y devuelve el total nuevo, con error y
  excepción configurables) y once tests nuevos.
- `CHANGELOG.md` — una línea en `Added`.

## Por qué así

**Después del envío, no antes.** `engineSendText` lanza cuando Meta rechaza el
envío, así que un envío fallido sale por el `catch` exterior y nunca llega al
contador. Contar antes habría facturado respuestas que el cliente no recibió.
El orden es criterio de aceptación, y tiene test propio (no basta con que la
llamada exista).

**El aviso de cesión no cuenta.** La rama de handoff hace `return` bastante
antes de este punto; no hubo que añadir ninguna condición. El comentario que ya
decía «does NOT count towards `ai_replies`» (f1.2) pasa de promesa a hecho.

**Es a prueba de fallos.** Cuando se ejecuta, el mensaje ya está en manos del
cliente: una respuesta sin contar es un fallo de contabilidad, nunca de entrega.
`countAiReply` traga tanto el `{ error }` que resuelve supabase-js como una
excepción, y registra ambos con el mismo prefijo `[ai auto-reply]`. No repite el
patrón fire-and-forget de `logAiUsage` porque aquí no hay latencia que proteger
(el envío ya ocurrió) y esperar la llamada hace el comportamiento determinista y
comprobable.

**Por cuenta, no por dueño de la clave.** `AiConfig.keySource` (f0.4) responde a
otra pregunta —quién pagó los tokens— y ya la responde `ai_usage_log`. Consumo
de plan y atribución de coste son dos registros distintos y ninguno sustituye al
otro; el contador suma igual con la clave de la cuenta o con la de la plataforma,
y hay test de eso.

**Sin cupo.** No se lee `plans`, ni `subscriptions`, ni `usage_counters` antes de
responder. f3.4, en la rama de fase 3, añadirá la comprobación leyendo este mismo
contador. Hay un test que fija esa frontera: con el contador en 999 999 la
respuesta sale igual.

**Aislamiento.** `increment_usage` es una RPC con argumentos explícitos, no una
consulta a tabla: lo que la acota a un inquilino es el `accountId` de la
despachada que se le pasa. Bajo rol de servicio no hay RLS que corrija un error
ahí, de modo que hay test de fuga entre dos cuentas (dos despachadas → dos
claves de contador, ninguna cruzada) y la parte C de las comprobaciones contra
base real repite lo mismo en Postgres.

## Criterios ↔ tests

Todos en `src/lib/ai/auto-reply.test.ts`.

| Criterio (feature_list f1.5) | Test (`it`) |
|---|---|
| 1. Cada respuesta enviada con éxito llama `increment_usage(account_id,'ai_replies',1)` | `counts one ai_reply for the account after a delivered reply` |
| 1. …DESPUÉS del envío | `counts AFTER the send, never before it` (captura los nombres de RPC vistos *dentro* de `engineSendText`) |
| 1. …y solo con éxito | `does not count a reply the send rejected`; `does not count when the dispatch never sends (slot race lost)`; `does not count when an automation already answered this inbound` |
| 2. El mensaje de transición no cuenta | `does not count the handoff transition message (f1.2)` y el ya existente `does not claim a reply slot nor count as an AI reply` |
| 3. No se aplica límite | `applies no limit: it reads no plan, subscription or counter first` |
| Aislamiento (CP3) | `counts against the account of the dispatch, never another tenant` |
| Independiente de `keySource` (f0.4) | `counts per account regardless of whose API key paid (keySource)` |
| A prueba de fallos | `logs and swallows a counter error — the reply was already delivered`; `survives the counter throwing outright` |
| Camino feliz completo (actualizado) | `claims a slot and sends on the happy path` — ahora exige las dos RPC en orden |

**Probados como detectores** (se rompe el código, se cuentan los rojos, se
restaura):

| Sabotaje | Rojos |
|---|---|
| Quitar `await countAiReply(db, accountId)` | 6 |
| Mover el contador **antes** de `engineSendText` | 2 (`counts AFTER the send…`, `does not count a reply the send rejected`) |
| Contar también el aviso de cesión | 2 (`does not count the handoff transition message (f1.2)`, `does not claim a reply slot nor count as an AI reply`) |

## Verificación contra base real

`progress/checks_ai-replies-counter.sql`, ejecutado contra el Postgres del
harness (`KEEP=1 scripts/replay-migrations.sh`, réplica completa 001→051 +
`verify-schema.sql` OK) → `checks_ai-replies-counter: OK`.

Comprueba lo que un test con mocks no puede ver:

- **A.** `public.increment_usage(p_account_id uuid, p_metric text, p_delta bigint)`
  existe con **esos nombres de argumento** y es `SECURITY DEFINER`. supabase-js
  llama con argumentos nombrados: una errata en un nombre solo se vería en
  producción.
- **B.** `service_role` puede ejecutarla; `authenticated` y `anon`, no.
- **C.** Tres respuestas en la cuenta A y una en la B → A vale 3, B vale 1, una
  sola fila por cuenta en el periodo en curso y ninguna otra métrica tocada.
- **D.** Control negativo: la misma llamada con `p_account` en vez de
  `p_account_id` no resuelve (es lo que hace de A una comprobación con dientes).

## Verificaciones manuales pendientes

Ninguna dependiente de un servicio externo *para el contador*: el envío a Meta
ya está cubierto por el contrato de `engineSendText` (lanza si falla) y por el
test de envío rechazado. Si se quiere confirmar de extremo a extremo en una
instalación real, el guion es:

1. Ajustes → IA: agente activo, auto-respuesta activada, `handoffMessage` con
   texto. Anotar el valor actual:
   `SELECT value FROM usage_counters WHERE account_id = '<cuenta>' AND metric = 'ai_replies' AND period_start = date_trunc('month', now())::date;`
2. Escribir al número desde WhatsApp algo que el agente pueda contestar → llega
   respuesta → el valor sube exactamente 1.
3. Escribir algo que fuerce la cesión (por ejemplo pedir hablar con una persona)
   → llega el aviso de transición → el valor **no** cambia.
4. Repetir el paso 2 con la clave del proveedor de la plataforma
   (`AI_PLATFORM_OPENAI_API_KEY`) y la casilla de la cuenta vacía → sube igual.

## Decisiones donde el spec era ambiguo

- **Dónde vive la llamada.** El spec no dice si el incremento debe ser una
  utilidad compartida. Se dejó como función privada de `auto-reply.ts` para no
  salirse del alcance de f1.5. f3.4 tocará el mismo terreno; si necesita
  `messages_out` o `broadcast_recipients`, ahí es donde tiene sentido extraer un
  `recordUsage(db, accountId, metric, delta)` a `src/lib/billing/` — no antes,
  con un solo llamador.
- **Esperar la llamada vs. fire-and-forget.** Se espera. `logAiUsage` es
  fire-and-forget porque corre antes del envío y su latencia la pagaría el
  cliente; esta corre después, la despachada ya vive dentro del `after()` del
  webhook y esperar no retrasa nada visible.
- **El delta es 1, fijo.** «Una respuesta = una unidad». Que un mensaje largo se
  parta en varios envíos no está en el camino de la auto-respuesta (un solo
  `engineSendText`), así que no hay caso que decidir todavía.

## Variables de entorno nuevas

Ninguna. `docs/docker.md` no cambia. `.env.local.example` está bloqueado por
permisos y no se tocó (tampoco haría falta).

## Deuda detectada fuera de alcance

- **`auto-reply.test.ts` compartía el limitador de tasa entre tests.** El tope de
  30 auto-respuestas por minuto y cuenta vive en un mapa de módulo, y todos los
  tests del archivo despachan como `acct-1`: al añadir casos, los últimos
  empezaban a chocar con el límite y la despachada dejaba de enviar sin decir por
  qué. Arreglado en el sitio (`__resetRateLimitForTests()` en el `beforeEach`,
  con comentario) porque sin eso los tests nuevos no podían existir. Otros
  archivos que usen `checkRateLimit` pueden tener la misma bomba de relojería;
  no se auditaron.
- **`CHANGELOG.md` no pasa `prettier --check`** ya antes de este cambio (se
  comprobó con el archivo sin modificar). No se reformateó: el diff resultante
  taparía el cambio real. La compuerta no lo mira.
- **Nadie lee todavía `usage_counters` en la interfaz.** La política RLS deja
  verlos a admin+, pero no hay pantalla; es trabajo de fase 3.
- **El contador no distingue reintentos de Meta.** Si un envío se entrega pero la
  respuesta HTTP se pierde, `engineSendText` lanza y la respuesta no se cuenta:
  fail-safe hacia abajo, coherente con el resto del módulo (se sub-cuenta antes
  que sobre-facturar).

## Compuerta

`npm run lint` (0 errores, 37 warnings preexistentes) · `npm run typecheck` ·
`TZ=UTC npm test` → **93 archivos, 1 033 tests, todos verdes** (44 en
`auto-reply.test.ts`) · `npm run build` con las variables dummy de CI → exit 0.
`scripts/replay-migrations.sh` exit 0 (no se tocó SQL; se corrió igual para
poder ejecutar las comprobaciones contra base real).

## Commits

- `96e02fa` `feat: contar las respuestas de IA entregadas` — `src/lib/ai/auto-reply.ts`,
  `src/lib/ai/auto-reply.test.ts`, `CHANGELOG.md`.
