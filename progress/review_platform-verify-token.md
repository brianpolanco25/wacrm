# Review — f2.4 platform-verify-token

**Veredicto:** APPROVED

Re-revisión tras la corrección. Worktree `.claude/worktrees/review-fase-2`, HEAD
desprendido en `74834d7` (padre `0997adf`). Commits de la feature: `31f10ea`
(original, ya revisado) y `74834d7` (corrección). Diff de `74834d7`: `CHANGELOG.md`,
`docs/docker.md` (+12), `docs/security.md` (+6/−1), `src/app/api/whatsapp/webhook/route.ts`
(+15/−1), `src/app/api/whatsapp/webhook/route.test.ts` (+42). Coincide con lo que
declara `progress/impl_platform-verify-token.md`, informe que ahora sí existe.

## Compuerta

Ejecutada por mí en el worktree, en un solo encadenado, salida 0:

- `npm run lint`: verde — 0 errores, 37 warnings (mismo recuento que en la revisión
  anterior; el único de `webhook/route.ts` es `'downloadMedia' is defined but never
  used`, línea 5, que no toca ninguno de los dos commits de f2.4 — llega de f2.2).
- `npm run typecheck`: verde.
- `TZ=UTC npm test`: verde — 85 archivos, 954 tests. Coincide con el informe.
- `npm run build` con las variables dummy de `ci.yml`: verde.
- `scripts/replay-migrations.sh`: n/a — ninguno de los dos commits toca `supabase/`.

Reproducción del hallazgo 1 anterior, el comando exacto que pidió el líder:

```
META_WEBHOOK_VERIFY_TOKEN=platform-secret TZ=UTC npx vitest run \
  src/app/api/whatsapp/webhook/route.test.ts
→ Test Files 1 passed (1) · Tests 23 passed (23)
```

Antes de `74834d7` ese mismo comando daba `2 failed | 18 passed`. **Cerrado.**

## Cambios requeridos anteriores — cierre uno a uno

1. **Tests independientes del entorno**: [x] `route.test.ts:290`,
   `vi.stubEnv('META_WEBHOOK_VERIFY_TOKEN', '')` en el `beforeEach` justo detrás de
   `vi.unstubAllEnvs()`. Leído: la variable ambiental deja de decidir el resultado y
   la cadena vacía ya la trata el código como no definida. Verificado corriendo la
   suite con la variable exportada (arriba).
2. **`.trim()` + `console.warn` sin eco**: [x] `route.ts:140`
   (`process.env.META_WEBHOOK_VERIFY_TOKEN?.trim()`) y `route.ts:152-154`. El mensaje
   es una constante literal sin interpolación: no puede filtrar ningún token por mucho
   que cambie el entorno. Nivel `warn` (configuración del operador), coherente con el
   `console.error` reservado al fallo de consulta del camino largo.
3. **Documentación de la variable**: [x] con la salvedad que fijó el líder.
   `docs/docker.md:42` la mete en la enumeración de variables de **runtime** y
   `docs/docker.md:53-61` le da viñeta propia (para qué sirve, cuándo dejarla sin
   definir, que se recorta). `docs/security.md:148-155` actualiza la promesa «an empty
   value counts as unset» para incluir el recorte y el `warn`. `.env.local.example`
   queda **pendiente para el humano** por decisión explícita del líder (el archivo está
   bloqueado para los agentes); no lo cuento en contra, pero conviene cerrarlo junto al
   `ENCRYPTION_KEY_PREVIOUS` de f2.3.
4. **Informe de implementación**: [x] `progress/impl_platform-verify-token.md` existe,
   cubre las dos entregas, y su tabla de archivos y recuentos cuadra con el diff real
   que he sacado con `git show --stat`.

## Trazabilidad criterio ↔ test

Spec `docs/saas/fase-2-seguridad.md` §4. Todos en
`src/app/api/whatsapp/webhook/route.test.ts`, `describe('webhook GET verification:
platform token short path')`. Los cinco primeros ya los leí en la revisión anterior y
siguen igual; releídos los tres nuevos.

- C1 «Con el token de plataforma definido, la verificación no consulta la tabla de
  configuraciones»: [x] `route.test.ts:579` › "with META_WEBHOOK_VERIFY_TOKEN set, a
  matching token echoes the challenge without touching whatsapp_config" — `GET` real,
  200 + challenge en texto plano, `h.state.fromCalls` sin `'whatsapp_config'`. La
  aserción negativa no es vacua: los tests de las líneas 600 y 609 demuestran que ese
  contador sí se llena por el camino del bucle.
- C1 (refuerzo, aislamiento): [x] `route.test.ts:588` › "…a tenant token that only
  exists in whatsapp_config is refused" — en modo plataforma el token por inquilino
  deja de ser credencial: 403 y la tabla ni se consulta.
- C2 «Sin él, el comportamiento actual se mantiene intacto»: [x] `route.test.ts:600`
  (dos filas, coincide la segunda → 200 + challenge, consulta la tabla),
  `route.test.ts:609` (token desconocido → 403 tras consultar) y `route.test.ts:617`
  (cadena vacía = no definida → cae al bucle). Ya sin la fragilidad de entorno.
- Corrección 2a, el espacio no forma parte del token: [x] `route.test.ts:625` › "…is
  trimmed, not part of the token" — stub ` platform-secret\n`, token suplido
  `platform-secret` → 200 sin tocar la tabla. Sin el `.trim()` esto es 403.
- Corrección 2b, solo-espacios = no definida: [x] `route.test.ts:637` — stub `'   '`,
  token de inquilino → 200 **y** `fromCalls` contiene `whatsapp_config`, o sea que
  demuestra que cayó al bucle, no solo que respondió 200.
- Corrección 2c, el 403 no filtra credenciales: [x] `route.test.ts:643` › "the 403 of
  the platform path warns without echoing either token" — espía `console.warn`, exige
  exactamente una llamada y que el texto no contenga ni `attacker-guess` ni
  `platform-secret`. Prueba lo que dice.
- Comparación en tiempo constante: sin test posible en vitest; verificada por lectura,
  `route.ts:106-110` (`timingSafeEqual` con chequeo previo de longitud, que va delante
  porque la función lanza con longitudes distintas).
- Base real / servicio externo: no aplica al camino corto (no consulta la base y el
  `GET` es el que Meta hace contra nosotros, no al revés). Sin `checks_<name>.sql`,
  correcto. El guion manual contra Meta está en el informe, §«Verificación manual
  pendiente», con cinco pasos incluido el del espacio final y el de comprobar que la
  ingesta del `POST` sigue viva.

## Checkpoints

- CP1 Compuerta: [x] ejecutada por mí, verde, salida 0.
- CP2 Migraciones: [x] n/a — sin SQL en ninguno de los dos commits.
- CP3 Aislamiento: [x] para el diff. El camino corto no consulta nada. La consulta
  preexistente `supabaseAdmin().from('whatsapp_config').select('id, verify_token')`
  (`route.ts:162`) sigue sin filtro de cuenta, pero es global por diseño —busca a qué
  fila corresponde el token— y es anterior a f2.4. Territorio de f2.2, no lo atribuyo aquí.
- CP4 Tests: [x] sin reserva. Cada criterio tiene test leído por mí, y los tres nuevos
  son rojos contra el código anterior según el informe (revertiendo solo `route.ts`:
  `3 failed | 20 passed`); consistente con lo que leo en las aserciones.
- CP5 Sin dependencias nuevas: [x] `package.json` y `package-lock.json` no aparecen en
  `git log 61c1fbb..74834d7 --` de esos archivos. `node:crypto` es del runtime.
- CP6 i18n: [x] n/a — el rango no toca `messages/` y no hay texto de UI.
- CP7 Next 16: [x] leer una variable no `NEXT_PUBLIC_*` en un route handler se resuelve
  en runtime, confirmado en
  `node_modules/next/dist/docs/01-app/02-guides/environment-variables.md` §"Runtime
  Environment Variables" (solo `NEXT_PUBLIC_*` se inlinea en `next build`). El handler
  ya es dinámico por usar `request.url`. `console.warn` en un route handler no tiene
  restricción de framework.
- CP8 Alcance: [x] `31f10ea` toca 4 archivos y `74834d7` cinco, todos justificados por
  §4. El resto de lo que aparece en `31f10ea^..74834d7` es de f2.1/f2.2/f2.3.
- CP9 Documentación: [x] `CHANGELOG.md` (extiende la línea de `Unreleased` en vez de
  abrir una de `Fixed`, correcto porque la entrada original no está publicada),
  `docs/docker.md` con la variable de runtime, informe presente y fiel al diff.
  `.env.local.example` dispensado por el líder.
- CP10 Git: [x] los dos commits en `saas/fase-2-seguridad`, en español con prefijo
  (`feat:` / `fix:`) y `Co-Authored-By`; nada pusheado.
- CP11 Lo entrante nunca se bloquea: [x] el diff no toca el `POST`, ni
  `verifyMetaWebhookSignature`, ni `processWebhook`, ni `after()`. Un fallo del camino
  corto solo puede impedir dar de alta la suscripción, nunca guardar un entrante ya
  suscrito.

## Hallazgos (archivo:línea)

Ninguno bloqueante. Dos observaciones, no cambios requeridos:

1. `src/app/api/whatsapp/webhook/route.ts:152` — el `GET` es público y sin límite de
   tasa, así que cualquiera puede provocar un `console.warn` por petición y ensuciar el
   log de un despliegue de plataforma. El mensaje no filtra nada y el volumen es el de
   un endpoint que Meta llama a mano al configurar el webhook, así que no lo bloqueo;
   si el ruido molesta, el sitio de arreglarlo es un límite de tasa en el `GET`, no
   quitar el aviso.
2. `src/app/api/whatsapp/webhook/route.ts:226` — el 403 del camino largo (modo
   autoalojado) sigue sin registrar nada, ahora que el del camino corto sí. Es una
   asimetría cosmética; el operador autoalojado tiene una sola fila y el 403 es más
   fácil de diagnosticar. Fuera de alcance de §4.

3. `docs/security.md:35` — la frase «Rows in either shape are rewritten under the
   active key the next time they are used (the `isLegacyFormat` write-back in the send
   path and the webhook)», y su eco en `CHANGELOG.md:27`, se vuelven falsas justo en el
   modo que añade esta feature: el reescrito de `verify_token` a GCM vive en el camino
   largo (`route.ts:194`) y el camino corto retorna antes. Verificado: el único otro
   write-back es el de `access_token` en `src/lib/whatsapp/send-message.ts:281`, que no
   toca `verify_token`. Impacto práctico bajo —en modo plataforma el `verify_token` deja
   de descifrarse, o sea que la fila heredada queda inerte— y el runbook de
   `scripts/reencrypt-secrets.ts` sigue siendo el camino canónico. Una cláusula aclaratoria
   lo cierra; no lo bloqueo.
4. `CHANGELOG.md:34` — la entrada vende la variable solo como optimización. En un
   despliegue mixto (algunos inquilinos con su propia app de Meta) ponerla deja sin
   suscripción a esos inquilinos la próxima vez que su app repita el challenge.
   `docs/security.md:146` sí lo dice («per-tenant verify tokens stop being credentials»)
   y `docs/docker.md:53-61` también, así que la información existe; falta solo en el
   CHANGELOG, que es lo que lee quien despliega.

## Deuda confirmada (del informe, no atribuible a esta feature)

- `route.ts` y `route.test.ts` incumplen `.prettierrc` (`"semi": true`) **ya en la base
  `61c1fbb`**: lo he comprobado corriendo `prettier --check` sobre la versión de la base.
  Prettier no está en la compuerta de CI. Reformatear merece un `chore:` propio.
- El token viaja en el query string del `GET` de Meta y lo capturan los logs de acceso
  del proxy. Inherente al protocolo, no algo que la app pueda evitar.

Contrastado con el skill `code-review` a nivel `high` sobre `31f10ea^..74834d7`
acotado a los archivos de la feature: coincide en que **no hay error de corrección** en
la lógica de producción (colocación del camino corto tras la guarda de
`mode/challenge/verifyToken`, `?.trim()`, chequeo de longitud previo a
`timingSafeEqual`, mensaje literal sin interpolación, bucle autoalojado intacto) y
valida el mock reescrito de `whatsapp_config` (`Object.assign(all, { eq: byPhone })`):
la promesa se reconstruye por cada `from()`, así que la cadena del `POST` y el
`select()` a secas del `GET` no interfieren, y `fromCalls` se resetea por test, de modo
que las aserciones negativas no son vacuas. Sus cinco hallazgos son todos de severidad
baja; he verificado los dos que sí tocan esta feature y los recojo arriba como
observaciones 3 y 4. Los otros tres (`.env.local.example`, ya dispensado por el líder;
la séptima copia del patrón `timingSafeEqual`, que pide un helper compartido junto a
`timingSafeHexEqual` de `src/lib/api-keys/keys.ts:88`; y el `.trim()` que le falta a
`META_APP_SECRET`) no los bloqueo aquí.
