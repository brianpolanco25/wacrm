# Review — f0.4 platform-ai-key (cuarta ronda)

**Veredicto:** APPROVED

Rango revisado: `afbaecb`, `8854c65`, la parte de `324f087` que es
`supabase/migrations/047_ai_platform_key.sql` + su aserción, `8909d90`, `a0157a7` y la tercera
corrección `1c7ddab`. Worktree
`/Users/brian/Documents/Dev/projects/wacrm/.claude/worktrees/agent-a85d874ab350adc04`, HEAD
`1c7ddab`, árbol limpio. Base `feat/saas-multiempresa` (61c1fbb).

El único cambio requerido de la ronda 3 está cerrado, verificado por mí en los tres sitios y con
el test nuevo probado como detector. No aparece nada nuevo que sea pérdida de datos, fuga, gasto
sin registrar ni 500. Lo menor queda como observación.

## Compuerta

Ejecutada por mí en el worktree, no leída del informe:

- `npm run lint` → **verde** (0 errores, 37 warnings preexistentes).
- `npm run typecheck` → **verde**, limpio.
- `TZ=UTC npm test` → **verde**: `Test Files 86 passed (86)`, `Tests 905 passed (905)`
  (ronda 3: 85 / 902; +1 archivo, +3 `it`).
- `npm run build` con las cuatro variables dummy de `docs/harness.md` → **verde**.
- `scripts/replay-migrations.sh <worktree>` → **exit 0**, `ok 047_ai_platform_key.sql`,
  `verify-schema.sql: OK`. (La ronda 3 no toca SQL; se corre igual porque la feature sí lo hizo.)

### Control propio: el test nuevo es un detector

Devolví `usage/route.ts` a la forma anterior (mapa literal de dos casillas + `byMode[r.mode].calls
+= 1`) y corrí solo `src/app/api/ai/usage/route.test.ts` → **2 rojos de 3**
(«summarises auto_reply, draft and playground…» y «tallies a mode it has never heard of…», ambos
`expected 500 to be 200`). Archivo restaurado con `git checkout --`; árbol limpio otra vez.
Es decir: el bloqueante de la ronda 3 era real y el test lo habría cazado.

## Cierre del cambio requerido de la ronda 3

Los tres sitios que pedí, leídos en el código final:

1. `src/app/api/ai/usage/route.ts:16-25` — `UsageRow.mode` pasa a `string`, con el comentario de
   por qué (la unión cerrada era justo lo que le tapaba el problema a `tsc` bajo el
   `as UsageRow[]` de `:82`). **Cerrado.**
2. `src/app/api/ai/usage/route.ts:14,91-96,115-120` — `byMode` es
   `Record<string, {calls,tokens}>` sembrado con `KNOWN_MODES`
   (`['auto_reply','draft','playground']`) y el acumulado es
   `const tally = (byMode[r.mode] ??= { calls: 0, tokens: 0 })`. La siembra conserva los mosaicos
   fijos a cero; el `??=` impide que un cuarto valor del `CHECK` vuelva a dar 500. Las llaves que
   pueden nacer ahí salen de `mode`, columna con `CHECK`, no de entrada del cliente: no hay
   superficie de inyección de claves. **Cerrado, y a prueba de valores futuros como pedí.**
3. `src/components/agents/ai-usage.tsx:36-39,51-57,111-116,161-175` — `by_mode` se tipa abierto,
   los mosaicos salen de `MODE_TILES` (Auto-reply / Drafts / Playground) y lo que quede fuera se
   agrupa en «Other» **por diferencia contra el total** (`otherTokens`, `:113-116`), visible solo
   si es > 0. Comprobado el álgebra: los mosaicos por modo son subconjunto del total, luego
   `otherTokens >= 0` siempre y `Total tokens == Auto-reply + Drafts + Playground + Other`
   **incluso con modos que este build no conoce**. Era el hallazgo 2 de la ronda 3. **Cerrado.**

Y el agujero de fondo: `src/app/api/ai/usage/route.test.ts` **existe**, tres `it`, leído entero:

- «summarises auto_reply, draft and playground rows without dropping any tokens» (`:64-86`):
  las tres filas, asevera las tres casillas exactas, `total_tokens === 180`, `calls === 3` y
  `sumTokens(by_mode) === totals.total_tokens` — la suma del desglose contra el titular, que es
  justo lo que la tarjeta enseña lado a lado. Es el caso de los tres modos que pedí.
- «tallies a mode it has never heard of instead of failing the request» (`:88-99`): fila
  `future_mode` → 200, casilla propia y la suma sigue cuadrando.
- «keeps the summary scoped to the caller account» (`:101-122`): captura los `.eq()` y asevera
  `['account_id','acct-1']` sobre la ruta que antes no tenía ninguna prueba.

El mock de `toErrorResponse` (`:19-22`) devuelve 500 como el real (`src/lib/auth/account.ts:69-75`),
así que un fallo se ve en el test con el mismo código que vería el navegador. Correcto.

## Trazabilidad criterio ↔ test

Criterios del apartado 4 de `docs/saas/fase-0-cimientos.md` (supuesto S1). Lo cerrado en rondas
anteriores y no tocado por `1c7ddab` lo doy por bueno con la verificación de las rondas 2 y 3
(cada `it` fue leído entonces); reverifico lo que cambió.

- **C1 «clave de plataforma por variable de entorno, usada cuando la cuenta no trae la suya»**:
  [x] `src/lib/ai/platform-key.test.ts` › «reads one variable per provider», «falls back to the
  platform key when the account has none»; `src/lib/ai/config.test.ts` › «uses the platform key
  when the account has no stored key».
- **C2 «`ai_configs.api_key` pasa a ser opcional»**: [x] 047 + aserción en `verify-schema.sql`;
  parte A de `progress/checks_platform-ai-key.sql`, ejecutada contra base real (ronda 3).
- **C3 «resolución cuenta → plataforma, por proveedor, en los dos sentidos»**: [x]
  `platform-key.test.ts`, `config.test.ts`, `config/route.test.ts` (las cuatro precedencias del
  guardado), `test/route.test.ts` (siete `it`).
- **C4 «la clave de plataforma nunca vuelve a la interfaz»**: [x] el `GET` solo emite booleanos;
  `config/route.test.ts` › «…never returns the stored key»; `usage.test.ts` asevera que la fila de
  log no contiene `sk-platform`.
- **C5 «el uso con clave de plataforma queda contabilizable por cuenta»**: [x] **ahora también
  legible en producto.** Escritura en los tres grifos (`usage.test.ts` › «tells a call paid by the
  platform apart from one paid by the account, both scoped to their account»;
  `playground/route.test.ts` › «logs a platform-funded turn to ai_usage_log, scoped to the
  account»; `draft/route.ts` y `auto-reply.ts` pasan `config.keySource`, tipo obligatorio) y
  contra base real (partes B1–B5 y C1–C3 del SQL). Lectura: `usage/route.test.ts`, los dos primeros
  `it`. Los valores escritos y el dominio del `CHECK` coinciden, verificado uno a uno:
  `auto-reply.ts:111,130` `'auto_reply'`, `draft/route.ts:103,121` `'draft'`,
  `playground/route.ts:109` `'playground'`, `047:66` `CHECK (mode IN ('auto_reply','draft',
  'playground'))`, `KNOWN_MODES` en `usage/route.ts:14` los mismos tres.
  (El `mode: 'auto_reply'` de `playground/route.ts:89` es el de `buildSystemPrompt`, otra cosa:
  el banco de pruebas simula la respuesta automática. No es el del log.)
- **C6 «ninguna consulta con rol de servicio pierde el `account_id`»**: [x] `usage/route.ts:69`
  `.eq('account_id', accountId)` sobre el cliente de `requireRole('admin')` (no es rol de
  servicio), y ahora **con test de alcance**. El `insert` de `usage.ts:44` lleva `account_id`; el
  `logAiUsage` del playground lo pasa desde `requireRole` y su test asevera `account_id: 'acct-1'`
  en la fila. Lecturas/escrituras de `ai_configs` filtradas (`config/route.ts:53,138,167,282,327`,
  `test/route.ts:69`, `config.ts:42,114`) + «scopes every ai_configs query to the caller account».
- **C7 «documentar las variables»**: [x] `docs/docker.md` §«Platform AI keys».
- **C8 «`ai_replies` empieza a contar en la fase 1»**: fuera de alcance por spec (f1.5).

## Checkpoints

- **CP1 Compuerta**: [x] verde, ejecutada por mí, con replay y mutación de control.
- **CP2 Migraciones**: [x] 047 idempotente (comprobado en rondas anteriores reaplicándola),
  aserciones en `verify-schema.sql` verificadas como detectores, sin `CASCADE`. `1c7ddab` no toca
  SQL; el replay se corrió igual y sale 0.
- **CP3 Aislamiento**: [x] ver C6; la ruta que no tenía test ahora lo tiene.
- **CP4 Tests**: [x] cerrado. El hueco de la ronda 3 (`/api/ai/usage` sin archivo de test) está
  tapado y el test es detector comprobado.
- **CP5 Sin dependencias nuevas**: [x] `package.json` y `package-lock.json` no aparecen en el
  rango `61c1fbb..HEAD` (diff vacío).
- **CP6 i18n**: [x] `Settings.aiConfig`: cero claves solo en `en`, cero solo en `ko` (verificado
  programáticamente sobre el árbol actual). `messages/` solo tiene `en.json` y `ko.json`.
  `1c7ddab` no añade claves: los rótulos «Playground» y «Other» van en duro porque
  `ai-usage.tsx` no pasa **ninguna** de sus ~20 cadenas por `next-intl` (no hay `useTranslations`
  ni namespace propio en los catálogos). Traducir dos de veinte habría dejado la tarjeta a medias;
  queda como deuda 7 del informe. Acepto el criterio: CP6 pide que el texto nuevo esté en los dos
  catálogos, y aquí no hay catálogo al que añadirlo sin internacionalizar el archivo entero.
- **CP7 Next 16**: [x] `1c7ddab` no introduce ningún API de framework: `GET(request: Request)` +
  `NextResponse.json` ya estaban, y la tarjeta sigue siendo `'use client'` con los hooks de React
  19 que ya usaba.
- **CP8 Alcance**: [x] cerrado. Los cuatro archivos de `1c7ddab` son exactamente los tres que pedí
  más `CHANGELOG.md`; +192 −32 sin ruido de prettier (los dos archivos preexistentes no cumplen
  `.prettierrc` y se editaron en su estilo, como en la ronda 2 — verificado en el diff: ninguna
  línea ajena tocada).
- **CP9 Documentación**: [x] `CHANGELOG.md` (Unreleased) con la entrada del arreglo,
  `docs/docker.md` con las dos variables, e `impl_platform-ai-key.md` coincide con el diff
  verificado (commits, archivos, nombres de `it` y cifras de la compuerta cuadran con lo que corrí).
- **CP10 Git**: [x] seis commits en `saas/fase-0-cimientos`, en español, con prefijo y
  `Co-Authored-By`; nada pusheado; árbol limpio. Queda el conflicto de atribución que el informe
  anota (`Claude Fable 5.1` vs `Claude Opus 5 (1M context)`): el trailer existe en todos, que es lo
  que CP10 exige; homogeneizarlo lo decide el humano.
- **CP11 Lo entrante nunca se bloquea**: [x] `logAiUsage` sigue sin lanzar (`usage.ts:57`), se
  llama con `void` en `auto-reply.ts`, `draft/route.ts` y `playground/route.ts` (este último
  además en `try/catch` por el `supabaseAdmin()`). Test: «still answers when the usage log cannot
  be written».

## Revisión de código (`code-review`, nivel `high`, sobre `1c7ddab^..1c7ddab`)

Corrida por mí y contrastada: dos hallazgos, los dos **bajos** y de texto (los recojo abajo como
observaciones 1 y 2). Coincide con mi lectura en lo sustantivo —el 500 era real, el `??=` más la
siembra de `KNOWN_MODES` lo cierra y conserva los dos invariantes (`sum(by_mode.tokens) ===
totals.total_tokens` y `sum(by_mode.calls) === totals.calls`)— y descarta explícitamente:
`by_mode` no tiene más consumidores que la tarjeta; `LogAiUsageArgs.mode` sigue siendo unión
cerrada del lado del escritor (correcto: escritores restringidos, lector tolerante); `otherTokens`
no puede salir negativo y su guarda es una comparación, no un `0 &&`; y el `??=` sobre objeto plano
sería sensible a claves de prototipo (`'__proto__'`) pero el `CHECK` de 047 cierra el dominio, así
que no hay escenario alcanzable. Nada que cambie el veredicto.

## Hallazgos (archivo:línea)

Ninguno bloqueante. Observaciones, por orden de a quién molestan:

1. `src/components/agents/ai-usage.tsx:156` — el estado vacío sigue diciendo «This fills in as the
   assistant drafts and auto-replies»: no menciona el banco de pruebas, que ahora también lo
   llena, y el mismo commit sí actualizó la descripción de la cabecera (`:127-128`). Una frase,
   cosmético. (Coincide con el `code-review` a nivel `high`.)
2. `CHANGELOG.md:73` y `progress/impl_platform-ai-key.md` (guion manual, paso 5) — **la pantalla
   está mal situada**: la entrada dice «Settings → AI» y el guion manda «recargar Settings → AI y
   mirar la tarjeta Token usage», pero `AiUsageCard` se renderiza en
   `src/app/(dashboard)/agents/page.tsx:80-84`, en la pestaña **Usage** de **AI Agents**
   (Settings → AI es el panel de configuración de la clave, `components/settings/ai-config.tsx`).
   Quien siga el changelog o el guion para comprobar el arreglo abre la pantalla equivocada y no
   encuentra la tarjeta. Es documentación, no producto; lo dejo como observación porque la feature
   lleva cuatro rondas, pero **conviene corregir el guion antes de la verificación manual**.
   (Hallazgo del `code-review` a nivel `high`, verificado por mí en el archivo.)
3. `src/lib/ai/secret-field.ts:50` — **repetido de la ronda 3.** La máscara no vuelve al perder el
   foco: tras tabular por el formulario el campo queda vacío con el placeholder `sk-…`,
   visualmente idéntico a «no hay clave guardada», mientras el texto de ayuda dice lo contrario.
   El dato está a salvo (lo cerró la ronda 2); engaña la pantalla. Cierre: `secretFieldBlurred`
   que reponga `secretFieldLoaded(hasStoredKey)` si `!typed && !clearRequested`, sus casos en
   `secret-field.test.ts` y un `onBlur` en los dos campos. Anotado como deuda 8 del informe.
4. `src/components/settings/ai-config.tsx:279-281` — **preexistente, ajeno a la feature.**
   Comentarios de borrador en el bloque de carga y `t('loadFailed')` usado como texto de
   «cargando». Deuda 9 del informe.
5. `src/components/agents/ai-usage.tsx` — la tarjeta entera sigue sin `next-intl` (~20 cadenas).
   `chore:` propio, incluida la pluralización de `call`/`calls`. Deuda 7.
6. `.env.local.example` sigue sin `AI_PLATFORM_OPENAI_API_KEY` ni `AI_PLATFORM_ANTHROPIC_API_KEY`.
   Archivo bloqueado para los agentes: **pendiente del humano**. Cuarta vez que se anota; no se
   puede cerrar desde aquí, pero un despliegue nuevo no descubrirá las variables por la plantilla.

Deuda ya aceptada por el líder y bien anotada en el informe (no la reabro): gasto de plataforma sin
techo hasta la fase 3, `console.error(err)` crudo del proveedor, formato preexistente, ausencia de
prueba de componente real (no hay jsdom en el repo) y que `POST /api/ai/test` no se contabilice.

**Sigue abierta una decisión humana antes de fusionar** (no bloquea esta revisión, la repito porque
se pierde en el merge): 047 va numerada por delante de 042-046, que llegan en fases posteriores, y
además se ha editado en sitio tres veces. En CI da igual (reset en orden léxico), pero
`supabase db push` no inserta migraciones anteriores a la última aplicada en remoto, y cualquier
base donde 047 ya se hubiera aplicado no recibiría el `CHECK` ampliado — y perdería en silencio los
registros del playground. La vía de aplicación en producción la decide el humano.

## Cambios requeridos

Ninguno.
