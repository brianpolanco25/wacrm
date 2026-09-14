# Review — f1.3 attention-state-list (2ª ronda)

**Veredicto:** APPROVED

Revisado `4c63367` (corrección) sobre `de7fb0a` (1ª ronda), base `saas/fase-0-cimientos`
(`a492504`), worktree `.claude/worktrees/fase-1`, limpio. La corrección son 6 archivos,
+274/−71: `attention.ts`, `use-ai-account-status.ts`, `conversation-list.tsx`, los dos
tests y `CHANGELOG.md`. Nada fuera de §3. La feature entera: 12 archivos, +953/−62.

## Compuerta

Ejecutada por mí en el worktree, en el orden de CI:

- `npm run lint` → **verde** (0 errores, 37 warnings, las mismas preexistentes de la 1ª ronda).
- `npm run typecheck` → **verde**.
- `TZ=UTC npm test` → **verde**: 87 archivos, **949** tests (938 en la 1ª ronda → +11, como
  dice el informe).
- `npm run build` (con las cuatro variables dummy de `ci.yml`) → **verde**.
- `replay-migrations`: **n/a**, el diff no toca `supabase/`.

## Los seis cambios requeridos

1. **Fallo de red ⇒ «IA apagada»** — **cerrado**. `use-ai-account-status.ts:73` y `:83`
   devuelven `null`; la firma es `Promise<AiAccountStatus | null>` y el hook traduce
   `s === null ? null : s.autoReplyOn` (`:115`). Tests leídos:
   `use-ai-account-status.test.ts` › "resolves a non-OK response to unknown, never to
   \"AI off\"" y "resolves a network error to unknown, never to \"AI off\"" — asertan
   `toBeNull()` **y** `not.toEqual({ autoReplyOn: false })`, que es exactamente la
   confusión que se pedía cerrar. Los dos consumidores tratan `null` como nada:
   `ai-thread-banner.tsx:95` (`if (!autoReplyOn) return null`) y la lista vía la
   derivación.
2. **El filtro sin la guarda de la insignia** — **cerrado, y mejor de lo pedido**. La
   guarda subió a la función pura (`attention.ts:66`, `if (accountAiOn === null) return
   null`), y ahora el filtro (`conversation-list.tsx:233`) y la insignia (`:494`) hacen
   **la misma llamada** con el mismo `aiStatus`; `accountAiOn = aiStatus === true` ya no
   existe. No pueden volver a divergir. Tests: `attention.test.ts` › "decides nothing for
   an unassigned thread", "never reports \"unattended\" on a failed or pending read"
   (recorre las dos filas, `idle` y `handed-off`), "still names the assignee — a human is
   knowable without the flag" y "returns nothing while the account's AI status is unknown".
3. **Chats cerrados** — **cerrado** según la decisión del líder. `attention.ts:68` deja
   fuera `status === 'closed'` de `unattended`; `AttentionInput` incorpora `status`
   (`:30`). Tests: "gets no alarm when nobody is on a closed thread" (con la IA on y off),
   "still shows who owns a closed thread", "keeps the alarm on the open and pending ones"
   (itera `open`/`pending`) y "never returns a closed chat — the queue is not the archive"
   (itera `true | false | null`). El helper `conv()` pone `status: 'open'` por defecto, así
   que los casos previos siguen midiendo lo que medían.
4. **Caché sin invalidar** — **cerrado** por la vía que el líder fijó: `STATUS_TTL_MS = 30_000`
   (`use-ai-account-status.ts:40`), comparación en `:63` y borrado de la entrada vencida en
   `:66`; no se toca `ai-config.tsx`. Test leído: "expires a cached status so Settings
   changes reach the list" — congela `Date.now`, comprueba que a `TTL−1` responde la caché
   (`fetch` 1 vez) y que a `TTL` exacto re-lee y **gana el valor nuevo** (`fetch` 2 veces).
   El `CHANGELOG.md` ya no promete un absoluto: la frase «"AI replying" never appears» se
   sustituyó por el comportamiento real («within about half a minute, no reload needed»)
   más la exclusión de los cerrados.
5. **`??` con nombre vacío** — **cerrado**: `conversation-list.tsx:509` usa `||`.
   (El informe lo cita como `:510`; es `:509`. Trivial.)
6. **Deuda por anotar** — **cerrado**: cupo de IA agotado en `impl_...md` punto 6, con
   `auto-reply.ts:83` y `:241`/`:226-232`; tick de 15 s en el punto 7, con
   `conversation-list.tsx:90`.

Los cuatro cambios de comportamiento vienen con detector comprobado por inversión (el
informe da los conteos de fallos; los tests que cito son los que producen esos fallos).

## Trazabilidad criterio ↔ test

- **C1 «Los tres estados se distinguen a simple vista»**: [x] `attention-badge.test.tsx` ›
  "renders a different mark for each of the three states", "does not lean on colour alone
  — each state carries its own icon", "keeps the AI and unattended states visually apart",
  "shows the label of each state", "carries the assignee's presence dot", "defaults an
  assignee with no presence row to offline". Sin cambios en la 2ª ronda; verificados en la
  1ª. `attention-badge.tsx:42-56`: icono propio + color propio por estado.
- **C2 «Al asignar desde el hilo, la fila cambia al instante para el resto del equipo»**:
  [x] con el mismo matiz aceptado en la 1ª ronda: `attention.test.ts` › "flips a row to
  'assigned' when the payload brings an assignee" / "flips a row back to 'unattended' when
  the assignee is dropped" sobre la función pura, el camino real leído en el código
  (`inbox/page.tsx` mezcla el payload; la insignia se deriva en render, sin memo) y el
  guion manual del informe (paso 3-5). No hay e2e en el repo.
- **C3 «El filtro "Sin atender" devuelve los chats sin operador y sin IA, incluidos los
  cedidos»**: [x] "returns the chats with no operator AND no AI, handed-off included"
  (la fila `handed-off` es la única que pasa) y "returns every unassigned chat once the
  account's AI is off". Los dos casos que la 1ª ronda dejaba mal —cerrados dentro,
  desconocido = apagada— tienen ahora su test (punto 2 y 3 de arriba).
- **C4 «Con la IA desactivada, "IA atendiendo" no aparece nunca»**: [x] "never returns 'ai'
  when the account has auto-reply off" (con y sin bandera de pausa) y "still shows the
  assignee when the account has auto-reply off". El «nunca» en una sesión abierta lo acota
  ahora el TTL, con su test; la ventana residual queda como deuda 2 del informe (hallazgo 2).
- **C5 «Textos»** → CP6 (en + ko): [x] comparé los dos catálogos clave a clave por
  programa: **cero** claves solo-en y cero solo-ko. Las cuatro nuevas están en
  `Inbox.conversationList` con traducción real al coreano (`Unattended`/`미대응`,
  `AI replying`/`AI 응답 중`, `Assigned`/`담당 배정됨`, `Nobody on it`/`담당자 없음`).
- **«No añade consultas por conversación»**: [x] "hits the endpoint once per account,
  however many rows ask" y "keys the cache by account so a workspace switch re-reads"; el
  TTL no lo rompe (el valor se lee una vez por montaje, no por fila) y el propio test del
  TTL cuenta las llamadas a `fetch`.
- **Base real / servicio externo**: no procede. Ni SQL, ni rol de servicio, ni consulta de
  servidor nueva. No hace falta `progress/checks_attention-state-list.sql`; el informe lo
  justifica.

## Checkpoints

- **CP1 Compuerta**: [x] los cuatro verdes, ejecutados por mí.
- **CP2 Migraciones**: [x] n/a.
- **CP3 Aislamiento**: [x] no hay `supabaseAdmin()` en el diff. La consulta de `profiles`
  va con el cliente de navegador bajo RLS (`profiles_select`, `017_account_sharing.sql:612`).
- **CP4 Tests**: [x] ver trazabilidad. 949 tests, +36 de la feature.
- **CP5 Sin dependencias**: [x] `package.json` / `package-lock.json` no aparecen en el diff
  de la feature.
- **CP6 i18n**: [x] en + ko, misma clave, sin `es.json`. Verificado por diff de conjuntos
  de claves completos.
- **CP7 Next 16**: [x] la corrección no añade ninguna API de framework; `"use client"` sigue
  donde toca (hook sí, `attention-badge.tsx` no, que no tiene estado y lo importa un
  componente de cliente). Contrastado en la 1ª ronda con
  `node_modules/next/dist/docs/01-app/01-getting-started/05-server-and-client-components.md`.
- **CP8 Alcance**: [x] los 6 archivos de la corrección son los que los cambios requeridos
  obligaban; no se tocó `ai-config.tsx` ni `auto-reply.ts`, que §3 no justifica, y lo roto
  fuera está anotado como deuda.
- **CP9 Documentación**: [x] `CHANGELOG.md` en `[Unreleased]` corregido y ya coincide con
  el código (ver hallazgo 2 para el matiz que queda); sin variables de entorno nuevas; el
  informe coincide con el diff archivo por archivo.
- **CP10 Git**: [x] dos commits en `saas/fase-1-bandeja`, en español con prefijo (`feat:`,
  `fix:`) y `Co-Authored-By`. Nada pusheado; `main` (`46a0999`), `dev` y
  `feat/saas-multiempresa` (`593b92f`) intactos.
- **CP11 Entrante nunca bloqueado**: [x] n/a, cambio 100 % de cliente.

## Hallazgos (archivo:línea) — ninguno bloqueante

Contrastados con `code-review` a nivel `high` sobre `de7fb0a~1..4c63367`; sus siete
hallazgos caen todos en deuda ya anotada o en decisiones del líder. Los que aportan algo:

1. `src/lib/inbox/attention.ts:67` — el corte de `closed` está **después** de la rama `'ai'`,
   así que un cerrado con la IA de la cuenta encendida sigue leyéndose «AI replying»: un
   archivo de 800 cerrados se pinta entero de acento. No es la alarma ámbar, que es lo que
   la decisión del líder excluía, así que no lo bloqueo — pero es el mismo ruido en otro
   color y **no está en la lista de deuda del informe**. Anotadlo en la próxima feature de
   la bandeja que toque este archivo.
2. `src/hooks/use-ai-account-status.ts:111` — el TTL solo se consume en un **montaje** del
   hook: no hay intervalo ni revalidación por foco. La frase del `CHANGELOG.md` («within
   about half a minute, no reload needed») es cierta para el camino que nombra (Ajustes →
   volver a la bandeja, que remonta la lista) y falsa para una pestaña dejada quieta en
   `/inbox`, y en el peor caso del camino bueno —volver antes de que expire la entrada— el
   valor rancio aguanta hasta el siguiente montaje pasado el TTL. Es la deuda 2 del informe,
   declarada con honestidad; la doy por buena porque el líder fijó el TTL como la solución
   y porque lo que había antes era una promesa absoluta y falsa.
3. `src/components/inbox/conversation-list.tsx:233` — con `aiStatus === null` permanente
   (401 que no se reintenta en toda la vida del montaje), el filtro «Unattended» pinta el
   vacío genérico `noConversations`, indistinguible de «no hay nada pendiente». Es la
   consecuencia directa de la decisión del líder (nadie pinta la alarma sin saber) y la
   prefiero a la alarma falsa; un «no se puede saber ahora mismo» sería mejor, pero es UI
   nueva fuera de §3. Queda dicho.
4. `src/hooks/use-ai-account-status.ts:111` — el efecto no limpia `autoReplyOn` cuando
   `accountId` cambia o se queda vacío, así que un cambio de espacio de trabajo sin remontar
   enseña el estado de la cuenta anterior hasta que resuelve el nuevo `fetch`. Verificado
   que es **preexistente**, copiado tal cual del banner (`git show
   de7fb0a~1:src/components/inbox/ai-thread-banner.tsx`, líneas 83 y 91-95): no lo introduce
   esta feature, pero ahora manda en toda la lista. Deuda.
5. `src/components/inbox/attention-badge.tsx:42` — `title` descarta `label` en el estado
   `assigned`, que es justo el único texto variable y truncable (un nombre largo en 320 px
   se corta y el tooltip solo dice el estado de presencia). Cosmético.
6. `src/hooks/use-ai-account-status.ts:66` — al vencer el TTL se borra la entrada **antes**
   de pedir; si esa petición falla, se pierde un valor rancio pero conocido y la lista se
   queda sin insignias. Prefiero «desconocido» a «mentira», así que está bien como está.

Nada de lo anterior justifica otra ronda: todo es deuda declarada, decisión ya tomada por
el líder, o cosmético. El reparto (`attention.ts` puro con la guarda en un solo sitio,
el hook compartido, la insignia tonta) es sólido y los tests son detectores de verdad.
