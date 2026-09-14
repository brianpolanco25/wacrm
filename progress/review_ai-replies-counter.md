# Review — f1.5 ai-replies-counter

**Veredicto:** APPROVED

Rama `saas/fase-1-bandeja`, worktree `.claude/worktrees/fase-1`, base `316441c`, commit
`96e02fa` (único). Árbol limpio. Diff real: 3 archivos, +258/-0
(`src/lib/ai/auto-reply.ts` +57, `src/lib/ai/auto-reply.test.ts` +194, `CHANGELOG.md` +7).
Coincide con lo que declara `progress/impl_ai-replies-counter.md`.

## Compuerta

Ejecutada por mí en el worktree, con las variables dummy de `ci.yml`:

- `npm run lint` → **verde** (0 errores, 37 warnings preexistentes).
- `npm run typecheck` → **verde**.
- `TZ=UTC npm test` → **verde**: 93 archivos, 1 033 tests.
- `npm run build` → **verde** (exit 0).
- `scripts/replay-migrations.sh` → **n/a**: el diff no toca `supabase/`
  (`git diff 316441c..HEAD --stat` no lista ningún `.sql`).

## Trazabilidad criterio ↔ test

Todos en `src/lib/ai/auto-reply.test.ts` salvo donde se indique.

- **C1 «cada respuesta de IA enviada con éxito llama `increment_usage(account_id,'ai_replies',1)`»**:
  [x] `:700` › "counts one ai_reply for the account after a delivered reply" — comprueba la
  llamada **con los argumentos exactos** `{ p_account_id:'acct-1', p_metric:'ai_replies', p_delta:1 }`
  y que el total queda en 1. Refuerzo en `:240` › "claims a slot and sends on the happy path",
  que ahora exige las dos RPC en orden.
- **C1 «DESPUÉS del envío»**: [x] `:713` › "counts AFTER the send, never before it". Tiene
  dientes de verdad: sustituye la implementación de `engineSendText` para fotografiar
  `rpcCalls` **dentro** del envío y asserta `not.toContain('increment_usage')` ahí, más el
  orden final `['claim_ai_reply_slot','increment_usage']`. No es un test de existencia.
- **C1 «envío fallido no cuenta»**: [x] `:731` › "does not count a reply the send rejected"
  (`engineSendText` rechaza → `usageCalls()` vacío y `usage.size === 0`; la despachada
  resuelve `undefined`). Complementos: `:743` (perdió la carrera del cupo por conversación →
  no envía, no cuenta) y `:750` (una automatización ya respondió a ese entrante → no cuenta).
  Contrastado con el código: `engineSendText` (`src/lib/flows/meta-send.ts:65-139`) o
  devuelve `whatsapp_message_id` o lanza; no tiene rama de "no envié y resuelvo", así que
  contar después es correcto.
- **C2 «el mensaje de transición de f1.2 no cuenta»**: [x] `:756` › "does not count the
  handoff transition message (f1.2)" — con `handoffMessage` y `handoff:true` se envía 1
  mensaje y `usageCalls()` queda vacío. Más el preexistente `:498` › "does not claim a reply
  slot nor count as an AI reply", que ahora también asserta `not.toContain('increment_usage')`.
  En el código el `return` de la rama de cesión (`auto-reply.ts:254`) precede al contador
  (`:288`), así que el aviso nunca llega.
- **C3 «no se aplica ningún límite»**: [x] `:824` › "applies no limit: it reads no plan,
  subscription or counter first" — con el contador en 999 999 la respuesta sale igual y
  `tablesRead` (poblado de verdad en el mock de `from`, `:62`) no contiene `plans`,
  `subscriptions` ni `usage_counters`. Verificado además a mano: no hay import de
  `entitlements` ni lectura de cupo en el diff.
- **A prueba de fallos**: [x] `:799` › "logs and swallows a counter error — the reply was
  already delivered" (error estilo supabase-js → la despachada resuelve, `engineSendText`
  se llamó 1 vez y el log contiene `increment_usage(ai_replies)`) y `:813` › "survives the
  counter throwing outright" (`rpc` lanza). El `try/catch` de `countAiReply`
  (`auto-reply.ts:359-380`) cubre las dos formas.
- **Aislamiento (CP3)**: [x] `:771` › "counts against the account of the dispatch, never
  another tenant" — dos despachadas, dos claves de contador, ninguna cruzada. Contra base
  real: `progress/checks_ai-replies-counter.sql` parte C (A=3, B=1, una fila por cuenta,
  ninguna otra métrica tocada).
- **Nombre de la métrica y firma de la RPC (la lee f3.4)**: [x] el literal `'ai_replies'`
  aparece en `auto-reply.ts:373` y el test lo compara por igualdad, no por `contains`.
  La firma se comprueba contra Postgres en `checks_ai-replies-counter.sql` parte A
  (`p_account_id uuid, p_metric text, p_delta bigint` + `prosecdef`), con **control negativo**
  en la parte D (`p_account` en vez de `p_account_id` no resuelve) y privilegios en la parte B
  (`service_role` sí, `authenticated`/`anon` no). Coincide literalmente con
  `supabase/migrations/041_billing_model.sql:169-192`. Resultado declarado en el informe:
  `checks_ai-replies-counter: OK`.
- **No se confunde con la reserva de f1.4 ni con `claim_ai_reply_slot`**: [x] son tres
  mecanismos distintos y los tests los separan. `inbound_auto_replies` (upsert, f1.4) sigue
  siendo la reserva por mensaje entrante y su fallo se prueba en `:750`;
  `claim_ai_reply_slot` sigue siendo el cupo por conversación y su fallo en `:743`; el
  contador es una tercera RPC que solo corre tras el envío. El test de orden `:713` fija
  la secuencia exacta y `usageCalls()` filtra por nombre de RPC, así que un cruce entre
  ellas rompería en rojo.
- **Independiente de `keySource` (f0.4)**: [x] `:790` › "counts per account regardless of
  whose API key paid (keySource)".

El informe declara tres sabotajes (quitar la llamada → 6 rojos; moverla antes del envío →
2 rojos; contar el aviso de cesión → 2 rojos). No los repetí uno a uno, pero leí los tests
implicados y las aserciones sostienen esos números: ninguna es un `expect(fn).toBeDefined()`.

## Checkpoints

- **CP1 Compuerta**: [x] verde, ejecutada por mí.
- **CP2 Migraciones**: [x] n/a — el diff no toca `supabase/`.
- **CP3 Aislamiento**: [x] la única consulta nueva con rol de servicio es la RPC
  `increment_usage`, que recibe `accountId` explícito (bajo rol de servicio no hay RLS que
  corrija); test de fuga entre dos cuentas en `:771` y comprobación en base real en la parte
  C del SQL. No se tocó ninguna otra consulta de `supabaseAdmin()`.
- **CP4 Tests**: [x] cada criterio tiene test leído; lo que exige base real está en
  `progress/checks_ai-replies-counter.sql`.
- **CP5 Sin dependencias nuevas**: [x] `package.json` y `package-lock.json` no cambian.
- **CP6 i18n**: [x] n/a — no hay texto de UI nuevo; `messages/` no cambia.
- **CP7 Next 16**: [x] n/a — no se usa ninguna API de framework (el `after()` del webhook es
  preexistente y no se toca).
- **CP8 Alcance**: [x] 3 archivos, +258 líneas para una feature de una llamada. Lo único
  fuera del núcleo es `__resetRateLimitForTests()` en el `beforeEach` del propio archivo de
  tests: es código de test, está justificado (el limitador de 30/min vive en un mapa de
  módulo y los tests nuevos chocaban con él), la función ya existía en
  `src/lib/rate-limit.ts:180` desde antes (`1f295a8`) y el informe lo anota como deuda
  detectada, no como arreglo silencioso.
- **CP9 Documentación**: [x] `CHANGELOG.md` bajo `[Unreleased]`; ninguna variable de entorno
  nueva, así que `docs/docker.md` no cambia; el informe existe y coincide con el diff
  (revisé commit, archivos y cifras de la compuerta).
- **CP10 Git**: [x] un commit en `saas/fase-1-bandeja`, mensaje en español con prefijo
  `feat:` y `Co-Authored-By`; nada pusheado; `main` (`46a0999`) y `feat/saas-multiempresa`
  (`593b92f`) intactos (no existe rama `dev`).
- **CP11 Lo entrante nunca se bloquea**: [x] el contador corre después del envío, no lee
  cupo y traga error y excepción; no puede impedir que el webhook guarde un entrante.

## Hallazgos (archivo:línea)

Ninguno bloqueante. Pase de `code-review` a nivel `high` sobre `316441c..96e02fa`: un solo
hallazgo de severidad baja, que contrasto y comparto:

1. `src/lib/ai/auto-reply.ts:336` — el comentario afirma «`engineSendText` throws when Meta
   rejects the send, so a failed reply never reaches here», que confunde «lanzó» con «no se
   entregó». En `src/lib/flows/meta-send.ts:128-139` Meta ya aceptó el mensaje cuando corre
   el insert en `messages`; si ese insert falla, la función lanza tras la entrega y la
   respuesta queda sin contar. El error va en la dirección segura (se sub-cuenta, nunca se
   sobre-factura) y el informe ya anota la familia del caso en «Deuda detectada fuera de
   alcance», pero el invariante escrito en el comentario no se sostiene literalmente. Es una
   corrección de comentario, no de código: no justifica otra ronda, pero conviene arreglarlo
   cuando f3.4 construya la cuota encima de este contador.

Nota, sin acción aquí: `src/lib/ai/auto-reply.test.ts:831-833` prueba «no se aplica límite»
mirando `tablesRead`, que solo se puebla desde el mock de `src/lib/ai/admin-client`;
`src/lib/billing/entitlements.ts` usa `@/lib/automations/admin-client`. Si f3.4 conectara
la comprobación de cuota por esa vía, este guardián no la vería. No afecta a la corrección
de f1.5; queda anotado para la revisión de f3.4.

## Cambios requeridos

Ninguno.
