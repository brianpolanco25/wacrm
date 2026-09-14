# Review — f4.4 impersonation-audit (cuarta ronda)

**Veredicto:** APPROVED

Rama `saas/fase-4-plataforma`, worktree `.claude/worktrees/fase-4`, HEAD `7533aae`
(limpio), base `saas/integracion` @ `9680b68`. Cuatro commits (`3c99804`,
`e45cbf9`, `fb95a3e`, `7533aae`); la cuarta corrección toca 10 archivos
(`git diff fb95a3e..7533aae --stat`: 1145 inserciones, 201 borrados), todos bajo
`src/`. Coincide con lo que dice `progress/impl_impersonation-audit.md` en su
sección de cuarta ronda.

**Los tres cambios requeridos de mi tercera ronda están cerrados y los he
comprobado leyendo el código y los tests, no el informe.** La vía de eventos ya
no confía en la RLS (dos cinturones: `filter:` en la suscripción y comprobación
de la fila en el manejador), el cartel de la cabecera no puede sobrevivir a un
cambio de cuenta, y la red de regresión cubre `postgres_changes`, mira el
argumento de `.eq`/`.in` y deriva sus tablas de las migraciones. No queda fuga,
ni escritura durante el soporte, ni sesión reutilizable, ni vista mentirosa.

## Compuerta

Ejecutada por mí en el worktree, cada comando por separado, con variables dummy.

- `npm run lint` — **verde** (0 errores, 34 avisos, los mismos de la ronda anterior).
- `npm run typecheck` — **verde**.
- `TZ=UTC npm test -- --reporter=dot` — **verde**: 110 archivos, 1366 tests
  (la ronda anterior: 109 / 1329; el archivo nuevo es `account-scope.test.ts`).
- `npm run build` — **verde** (`ƒ Proxy (Middleware)`).
- `scripts/replay-migrations.sh "$(pwd)"` — **verde, salida 0** (repetido con el
  código de salida capturado). Aplicadas 040–044, 047, 051, 055 y 057;
  `verify-schema.sql: OK`. Esta ronda no toca SQL: el diff `fb95a3e..7533aae` no
  contiene ni un archivo de `supabase/`.

## (1) Realtime — cerrado

- **`src/lib/realtime/account-scope.ts:36` `eventBelongsToAccount`**: pura, falla
  cerrado con `accountId` nulo, con fila sin `account_id` (DELETE sin REPLICA
  IDENTITY FULL) y con fila de otra empresa.
- **`src/hooks/use-realtime.ts:88-118`**: `accountId` es obligatorio en las
  opciones, **no se suscribe a nada mientras sea `null`** (`:81`), `conversations`
  lleva `filter: account_id=eq.${accountId}` y su manejador
  (`conversationPayloadHandler`, `:33`) descarta el evento cuya `payload.new` no
  nombre la cuenta efectiva. El efecto depende de `accountId` (`:130`).
- **`src/app/(dashboard)/inbox/page.tsx:143,152,187`**: `hydrateConversation`
  sale temprano sin cuenta y lleva `.eq("account_id", accountId)`; el `useCallback`
  depende de `accountId`, y `:350` pasa ese mismo `accountId` al hook. Verificado
  que es el único llamante de `useRealtime`.
- **Vía de `messages`** (la única suscripción que sigue sin `filter:`, a
  propósito, porque la tabla no tiene `account_id`): seguida a mano en
  `handleMessageEvent` (`:218-276`). Un INSERT de otra empresa no puede entrar
  en `setMessages` (exige `conversation_id === activeConversation.id`, y la
  conversación activa sale de la lista filtrada) ni parchear la lista
  (`knownConvIdsRef` solo tiene ids de la cuenta) — cae en
  `hydrateConversation`, que ahora filtra y no encuentra nada. El evento muere ahí.
- **`src/hooks/use-total-unread.ts:66,89-101`**: `filter:` + `applyUnreadEvent`,
  que descarta lo ajeno y devuelve `null` cuando no hay que repintar; el DELETE
  (sin `account_id` en el registro viejo) se descarta por no estar en el mapa,
  que solo contiene filas de esta cuenta.
- **`src/hooks/use-unread-notifications.ts:60,79-91`** y
  **`src/app/(dashboard)/notifications/page.tsx:57,60-77,104`**: `filter:` +
  comprobación de fila, con el DELETE comprobado por `payload.old` porque
  `notifications` sí es REPLICA IDENTITY FULL. **Comprobado por mí en el
  esquema**: `supabase/migrations/027_notifications.sql:31`
  `ALTER TABLE notifications REPLICA IDENTITY FULL;`. Cierra la contradicción con
  `docs/security.md` (insignia que subía con notificaciones del operador).
- **Test leído** (`src/lib/realtime/account-scope.test.ts`, 297 líneas): el caso
  exigido existe y prueba lo que dice. «does not move for a conversation of the
  operator's own company» siembra INSERT y UPDATE de `OPERATOR_ACCOUNT` mientras
  `SHOWING = effectiveAccountId(OPERATOR, CUSTOMER)` y exige lista vacía; «does
  not count the operator's own unread conversation» exige `null` y que el mapa no
  se toque; «does not rise for the operator's own notification» exige 0. **No es
  tautológico**: cada uno tiene su contrapartida positiva («still moves for the
  customer's…», «counts the customer's, so the badge is not simply frozen»,
  «rises for the customer's») y su vuelta al estado normal tras la sesión.

## (2) El resumen `account` — cerrado

- **`src/hooks/use-auth.tsx:536-555`**: la lectura salió de `fetchProfile` a
  `fetchAccountSummary` (`:256`) dentro de un efecto que depende de
  `[userId, effectiveAccount, accountRefreshTick]` — **el mismo disparador que la
  bandera**, que es lo que faltaba.
- **`accountSummaryFor` (`:297`) + `:572` + `:597-598`**: el contexto entrega
  `account` y `defaultCurrency` solo si el resumen es de la cuenta que las listas
  están consultando; si no, `null` y `DEFAULT_CURRENCY`. Es la barandilla de la
  ventana en la que la lectura aún no ha llegado.
- **Tests leídos** (`src/hooks/use-auth.test.tsx`, bloque nuevo, 6 + 2 casos):
  «goes blank the moment the session expires under it» (bandera presente → nombre
  del cliente; bandera fuera → `none`) y «goes blank the moment a session opens
  from another tab» (la otra dirección). Las dos direcciones que pedí, con el
  estado positivo comprobado antes en cada caso, así que no pasan por vacuidad.
  Más «stays blank while the flag names no account» y «prints nothing before the
  fetch lands».
- `accountRefreshTick` (`:316`, incrementado en `refreshProfile` `:518`) evita la
  regresión de que un rename en Ajustes dejara de verse sin recargar.

## (3) La red de regresión — cerrada

`src/lib/security/support-session-view.test.ts`, leída entera:

- **`ACCOUNT_SCOPED` sale de `supabase/migrations`** (`accountScopedTables()`):
  dos formas (`ALTER TABLE … ADD COLUMN [IF NOT EXISTS] account_id` y
  `CREATE TABLE … (… account_id …)`), con emparejado de paréntesis y el
  `account_id` anclado a principio de línea para que `contact_id` o un
  `REFERENCES` no cuelen; `accounts` sembrada a mano y justificada. Con test de
  que las **siete** tablas que faltaban en la lista escrita a mano ahora están, y
  test de que las hijas (`messages`, `pipeline_stages`, …) siguen fuera.
- **`FILTERS_BY_ACCOUNT = /\.(eq|in)\(\s*["'`]account_id["'`]/`**: mira el
  argumento, no la cadena. Con test «would catch a list that merely selects the
  account_id column» — el agujero que yo señalé.
- **`isKeyedRead`** ya no toma `user_id` por clave, y las dos lecturas
  legítimas por `user_id` están fijadas por archivo en `OWN_USER_ROW_READS` con
  un test que exige que la lista sea **exactamente** esa.
- **Bloque nuevo de `postgres_changes`**: extrae el objeto de opciones de cada
  `.on('postgres_changes', …)` escaneando llaves (hay un comentario entre medias
  en `use-realtime.ts`) y exige `filter: account_id=eq.…` en toda tabla con
  `account_id`. Con **guardia de no-vacuidad** (lista literal de las cinco
  suscripciones acotadas), con «would catch the unfiltered subscription this
  round removed» y con el inventario explícito de las dos que no pueden estarlo
  (`messages`, `message_reactions`) y por qué — más la aserción de que
  `message_reactions` va por `conversation_id`.
- **Contrastado a mano**: `grep -rn "\.channel("` sobre `src` da 7 sitios (6 de
  código + un comentario); los 7 son los que el test nombra. El `describe` ya no
  promete de más: «every browser SELECT…» y «every browser subscription…».
- **El inventario del informe dice la verdad**: 10 archivos, ninguna migración,
  ninguna dependencia, la tabla criterio↔test corresponde con los `it` que
  existen y hacen lo que dice.

## Trazabilidad criterio ↔ test

Criterios del spec (`docs/saas/fase-4-plataforma.md` §2) — los tres originales
siguen cubiertos y verificados en rondas anteriores (SQL en
`progress/checks_impersonation-audit.sql`, ejecutado por mí):

- **«un `owner` normal no ve más que la suya»**: [x] `src/lib/auth/platform.test.ts`
  › «rejects a company owner…»; `tenant-isolation.test.ts` › «403s the owner of
  account A…».
- **«toda impersonación queda registrada con actor, cuenta, momento y motivo»**:
  [x] `.../impersonate/route.test.ts` › «records actor, account, moment and
  reason, and only then hands out the cookie» + cierre y barrido.
- **«rutas inaccesibles para quien no esté en `platform_admins`»**: [x] «403s a
  company owner…, on every verb», «leaks nothing about the target account…»,
  «fails closed when the lookup errors».

Invariantes de esta ronda:

- **«El operador ve los datos de la cuenta impersonada, y solo esos» — vía de
  `select()`**: [x] `support-session-view.test.ts` › «shows only the customer,
  not both companies merged» (+ guardia de no-vacuidad), verificado por mí contra
  Postgres en la ronda 3.
- **«…y también en la vía de eventos»**: [x] `src/lib/realtime/account-scope.test.ts`
  › «does not move for a conversation of the operator's own company», «does not
  count the operator's own unread conversation», «does not rise for the
  operator's own notification» (leídos arriba).
- **«Ninguna lectura del navegador confía en la RLS como filtro»**: [x] ahora sí,
  las dos vías: «holds for every `.from(table).select(…)` in the client bundle» y
  «holds for every `postgres_changes` channel in the client bundle», con sus
  tests de que la red detecta el caso que la motivó.
- **«El cartel nunca queda sobre las filas de otra cuenta»**: [x]
  `use-auth.test.tsx` › «goes blank the moment the session expires under it» /
  «…a session opens from another tab».
- **«`useAuth().accountId` vuelve a la cuenta propia»**: [x] 5 casos de
  `useEffectiveAccountId`, leídos en la ronda 3.
- **«Escrituras rechazadas, incluidas las de `storage`»**: [x]
  `src/lib/supabase/client.test.ts`, leído en la ronda 3, y frontera de base
  comprobada en SQL.
- **Lo que exige base real** tiene su SQL en
  `progress/checks_impersonation-audit.sql` (ejecutado por mí en rondas
  anteriores); lo que no se puede sembrar sin dos sesiones vivas (el canal de
  replicación) tiene guion manual: pasos 15 y 16 del informe, ambos verificables
  y con resultado esperado concreto.

## Checkpoints

- **CP1 Compuerta**: [x] verde, ejecutada por mí, comando a comando.
- **CP2 Migraciones**: [x] esta ronda no toca SQL; replay salida 0,
  `verify-schema.sql: OK`. Sin `CASCADE` sobre datos de clientes.
- **CP3 Aislamiento**: [x] ninguna consulta nueva con rol de servicio; las del
  conjunto siguen acotadas por `account_id` con test de fuga.
- **CP4 Tests**: [x] cada criterio tiene su `it`, leído por mí, con contrapartida
  que impide el aprobado por vacuidad.
- **CP5 Sin dependencias nuevas**: [x] `package.json` y `package-lock.json`
  intactos en todo el rango `9680b68..HEAD`.
- **CP6 i18n**: [x] esta ronda no añade texto; en el conjunto, `en.json` y
  `ko.json` suman las mismas 6 líneas con las mismas claves.
- **CP7 Next 16**: [x] nada de framework nuevo; `useSyncExternalStore` con los
  tres argumentos y efectos de cliente corrientes.
- **CP8 Alcance**: [x] los 10 archivos son exactamente los tres cambios pedidos.
- **CP9 Documentación**: [x] `CHANGELOG.md`, `docs/security.md` y la cabecera de
  057 ya dicen la verdad, y la frase sobre la vista deja de tener la excepción de
  la vía de eventos. Queda el detalle de «settings» (observación 1).
- **CP10 Git**: [x] cuatro commits en `saas/fase-4-plataforma`, en español, con
  prefijo y `Co-Authored-By`; worktree limpio; nada pusheado.
- **CP11 Lo entrante nunca se bloquea**: [x] el webhook sigue exento y con test;
  nada de esta ronda toca el camino de entrada (todo es navegador).

## Hallazgos (archivo:línea)

Ninguno bloqueante.

## Observaciones (no bloquean)

1. `CHANGELOG.md:152` sigue nombrando «settings» entre las listas que muestran
   las filas del cliente, y en Ajustes el gestor de tags y el de plantillas salen
   vacíos. `docs/security.md` lo cuenta bien. (Hallazgo 4 de la ronda 3.)
2. `automations/[id]/logs/page.tsx:45`, `broadcasts/[id]/page.tsx:172` e
   `inbox/page.tsx:141`: lecturas claveadas por parámetro de URL, sin acotar por
   cuenta. Sin fuga entre clientes. (Hallazgo 5 de la ronda 3.)
3. `src/hooks/use-auth.tsx:545` — el efecto que **re-lee** el resumen no tiene
   test; lo probado es la barandilla pura `accountSummaryFor` más
   `useEffectiveAccountId`. La barandilla es la mitad que importa (con ella, un
   fallo del efecto da cabecera en blanco, nunca el nombre equivocado), pero una
   regresión que sacara `effectiveAccount` de las dependencias pasaría la
   compuerta.
4. `support-session-view.test.ts` — `browserSelects()` y `browserSubscriptions()`
   solo miran archivos que importan `@/lib/supabase/client`; un componente que
   recibiera el cliente por prop escaparía de la red. Limitación heredada, no
   introducida aquí.
5. `conversations` no es REPLICA IDENTITY FULL, así que con el `filter:` nuevo un
   DELETE de conversación ya no llega al canal. No cambia nada hoy
   (`handleConversationEvent` nunca trató el DELETE), pero si alguna vez se
   borran conversaciones desde la interfaz habrá que subir la replica identity o
   refrescar a mano.
6. El trailer de `fb95a3e` y `7533aae` dice `Co-Authored-By: Claude Fable 5.1`;
   los dos primeros commits dicen otra cosa. Incoherente, no bloquea.
7. Deudas 7, 8, 10, 11 y 12 del informe siguen escritas y ninguna abre nada.
