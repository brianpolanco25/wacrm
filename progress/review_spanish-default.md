# Review — p6.4 spanish-default

**Veredicto:** APPROVED

Rama `saas/producto`, base `d6088eb`, commit único `9d10709`. Worktree limpio, sin push.
Spec: `progress/spec_producto.md` §4 y supuesto S-P3.

## Compuerta

Ejecutada por mí en el worktree, comando a comando:

- `npm run lint` → **verde** (0 errores, 35 avisos, todos preexistentes; el de
  `src/i18n/request.ts:17` `catch (error)` sin usar ya venía de antes del cambio).
- `npm run typecheck` → **verde**, sin salida.
- `TZ=UTC npx vitest run --reporter=dot` → **verde**: 149 archivos, 2006 tests, 0 fallos.
  Los dos fallos conocidos de `date-utils.test.ts` no aparecen (TZ=UTC).
- `npm run build` con las variables dummy de CI → **verde**.
- `scripts/replay-migrations.sh` → **n/a**: el diff no toca `supabase/`.

Comprobación sobre el artefacto real, no sobre el informe:
`.next/server/app/login.html` sale con `lang="es"`, contiene «Iniciar sesión» y
0 apariciones de «Sign in».

## Trazabilidad criterio ↔ test

Criterios del spec §4 (leí cada test, no solo su nombre):

- C1 «`messages.test.ts` verde con `es`: mismo conjunto de claves y mismos placeholders
  ICU que `en`»: **[x]**
  - Claves: `src/i18n/messages.test.ts:169` › "es.json covers every en.json key" y
    `:175` › "es.json has no orphaned keys". Recorren las hojas reales de ambos JSON
    (`loadKeys`, `:68`), comparan conjuntos en los dos sentidos. No son test de existencia.
  - Placeholders por nombre de argumento: `:193` › "es.json interpolates exactly the
    arguments en.json does". Compara `argumentNames(...)`, o sea el nombre del argumento,
    clave a clave, en ambos sentidos (missing + extra).
  - Ramas de plural: `:218` › "es.json never leaves a plural without `other`" (para `es` y
    `ko`) y `:235` › "es.json keeps en.json's argument types and plural branches", que para
    `es` exige además el mismo *tipo* (`simple`/`plural`/`date`…) y el mismo juego de
    selectores (`=1,other`). El parser (`icuArguments`, `:96`) es recursivo de verdad:
    distingue `{count}` del cuerpo de rama `{conversation}` y trata `{{1}}` como no-ICU
    (`:121`), que era la trampa que una regex no cubre. Verifiqué que las 22 cadenas con
    plural del catálogo pasan por ahí.
  - Cobertura de `ko`: `TRANSLATED_LOCALES = ['es','ko']` (`:13`); ambos idiomas entran en
    los cuatro `it.each`. La asimetría (paridad estricta de tipos solo en `es`) está
    justificada: `ko.json` colapsa los plurales a `{count}` a propósito y ya venía así.
- C2 «Sin la variable la app arranca en español; con `en` o `ko`, en esos idiomas»: **[x]**
  `src/i18n/request.test.ts:29` › "serves Spanish when NEXT_PUBLIC_APP_LOCALE is unset"
  (afirma `DEFAULT_LOCALE === 'es'`, `config.locale === 'es'` **y** que el mensaje servido
  es `Sidebar.inbox === 'Bandeja'`: comprueba el catálogo, no solo la etiqueta) y `:39`
  › "still serves en/ko when the variable asks for it" (`'Inbox'` / `'인박스'`). El mock de
  `next-intl/server` es la identidad, que es lo que hace la build de react-server, y está
  argumentado en el propio archivo: no oculta comportamiento.
  Contrastado además contra el HTML prerenderizado del build (arriba).
- C3 «Ninguna clave de `es.json` idéntica a `en.json` salvo nombres propios, siglas y
  valores que no se traducen, con lista en el informe»: **[x]**
  `src/i18n/messages.test.ts:255` › "leaves nothing in English outside the documented list"
  y `:269` › "keeps the allow-list honest" (el segundo impide que la lista blanca se pudra
  con claves muertas). La lista es `IDENTICAL_TO_SOURCE_OK` (`:25`), explícita, 24 entradas
  con motivo. Ver el juicio una a una más abajo.
- C4 «`docs/docker.md` documenta el nuevo valor por defecto»: **[x]** `docs/docker.md:40-45`
  — valor por defecto `es`, catálogos `en`/`ko`, ausencia de fallback por clave y el hecho
  de que al ser `NEXT_PUBLIC_*` cambiarlo exige reconstruir. Es documentación: no exige test.

Tests extra que el spec no pedía y que sí aportan:
`src/i18n/icu-safety.test.ts:107` › "es/ko.json has the same unparseable keys as en.json"
(25 cadenas candidatas con `{{1}}` o HTML crudo: el test no es vacío, y es el guardarraíl
contra un traductor que «arregle» `{{1}}` → `{1}` o se coma un `<strong>`);
`src/i18n/brand.test.ts:14` amplía `LOCALES` a `['en','es','ko']`.

No hay criterio que exija base real (no hay SQL) ni servicio externo, así que no procede
`progress/checks_spanish-default.sql` ni guion manual.

## Lista de claves idénticas a `en`, juzgada una a una

Calculé las idénticas sobre los catálogos: **24**, exactamente las 24 de
`IDENTICAL_TO_SOURCE_OK`; ni una de más ni una de menos. Todas legítimas:

- Marcas: `Sidebar.title` («Cabbity CRM»), `Settings.sections.whatsapp` («WhatsApp»).
- Siglas: `Automations.builder.config.urlLabel`, `Settings.templates.btnUrl` («URL»).
- Palabras que en español se escriben igual: `Sidebar.beta`, `Flows.list.beta` («Beta»),
  `Sidebar.defaultAvatar`, `Header.defaultAvatar` («Avatar»),
  `Dashboard.pipelineDonut.total` («Total»), `Inbox.bubble.audio`, `Flows.summary.audio`
  («Audio»), `Inbox.replyQuote.audio` («[Audio]»), `Broadcasts.detail.table.error`
  («Error»), `Broadcasts.wizard.personalize.variables` y `…scheduleSend.variables`
  («Variables»), `Automations.builder.branches.no` («No»), `Platform.columns.plan` («Plan»).
- Placeholders de formulario y literales: `Contacts.form.phonePlaceholder`
  («+1234567890»), `Settings.templates.phonePlaceholder` («+15551234567»),
  `Contacts.form.companyPlaceholder` («Acme Corp»),
  `Automations.builder.config.placeholderTime` («HH:mm-HH:mm»), `…placeholderHeaders` y
  `…placeholderBody` (JSON literal que el usuario copia tal cual),
  `Billing.subscription.noNextCharge` («—»).

Ninguna es una frase en inglés. La política de dejar en inglés los rótulos literales de la
consola de Meta («My Apps», «Create App», «Set Up», «Edit», el campo `messages`) me parece
correcta y no genera claves idénticas porque el resto de la frase sí se traduce.

## Calidad de la traducción (muestreo dirigido, secciones leídas enteras)

Leí completas `Billing`, `Inbox`, `Settings.aiConfig`, `Settings.aiKnowledge`,
`Settings.whatsapp`, `LoginPage`, más `Header`, `AccountAccess` y `Impersonation` (la
franja de soporte) y las claves del banner de prueba (`Billing.trialEndsIn`,
`trialEndsToday`, `trialChoosePlan`).

El nivel es alto y consistente: trato de «tú» uniforme, impersonal donde el original lo era,
comillas angulares, glosario respetado sin fugas (bandeja, difusión, operador, prueba,
embudo, oportunidad, etapa, traspaso, base de conocimiento). Barridos que hice:

- Anglicismos y calcos: escaneé las 1662 hojas buscando términos sin traducir; los únicos
  positivos son literales legítimos (columnas de CSV `phone`/`name`/`tags`, rutas de la
  consola de Meta `API Setup`, `Business Settings > System Users`).
- Prosa inglesa colada: heurística de palabras función inglesas sobre todo el catálogo →
  0 positivos reales.
- Puntuación: 0 interrogaciones o exclamaciones sin `¿`/`¡` de apertura.
- ICU roto que el test no atrape: revisé a mano las 22 cadenas con `plural`. Todas con
  concordancia correcta de género y número en ambas ramas, incluido el caso difícil
  `Settings.aiConfig.overlapTitle` («{count} {count, plural, =1 {automatización puede
  responder} other {automatizaciones pueden responder}} a los mismos mensajes»), que mete
  el verbo dentro de la rama para que concuerde — correcto, y con los mismos selectores
  que `en`. `Billing.trialEndsIn` («… {days, plural, =1 {día} other {días}}») igual.

## Checkpoints

- CP1 Compuerta: **[x]** ejecutada por mí, verde.
- CP2 Migraciones: **[x]** n/a — no hay SQL.
- CP3 Aislamiento: **[x]** n/a — el diff no contiene ninguna consulta ni
  `supabaseAdmin()`; es catálogo, configuración de i18n y tests.
- CP4 Tests: **[x]** los cuatro criterios tienen test leído (arriba).
- CP5 Sin dependencias nuevas: **[x]** `git diff d6088eb..HEAD -- package.json` vacío. El
  parser ICU del test es propio, ~50 líneas, sin importar el `@formatjs` transitivo.
- CP6 i18n: **[x]** `en`/`es`/`ko` con el mismo conjunto de claves (test) y los mismos
  nombres de argumento ICU (test). `messages/en.json` y `messages/ko.json` **intactos**:
  `git diff d6088eb..HEAD -- messages/en.json messages/ko.json` es vacío. El texto de CP6 en
  el checkout principal (`CHECKPOINTS.md:18-20`) y la misma frase en
  `.claude/agents/implementer.md:46-47` y `.claude/agents/reviewer.md:42-43` ya exigen los
  tres catálogos con `es` por defecto; están modificados y **sin commitear**, que es lo
  acordado (lo commitea el humano).
- CP7 Next 16: **[x]** `src/app/layout.tsx` no se tocó y ya resuelve el idioma con
  `getLocale()` de `next-intl/server` (`:85`) y lo pasa a `<html lang={locale}>` (`:90`) y
  a `NextIntlClientProvider` (`:111`). Verificado contra el artefacto: el HTML
  prerenderizado sale `lang="es"`. No hay API de framework nueva que contrastar.
- CP8 Alcance: **[x]** con una salvedad, ver hallazgo 5. `Dockerfile`/`docker-compose.yml`
  no están en la letra del spec pero sí en su intención (sin ellos ninguna imagen saldría en
  español) y el informe lo declara; lo doy por dentro de alcance.
- CP9 Documentación: **[x]** `CHANGELOG.md` (Unreleased → Changed) con una entrada que
  coincide con el diff; `docs/docker.md:40-45` documenta la variable; el informe
  `progress/impl_spanish-default.md` existe y **coincide con el diff** (contrasté commit,
  archivos y afirmaciones: los tres `toLocaleDateString('en-US'…)` → `undefined` están, y
  no queda ningún locale fijo en `src`).
- CP10 Git: **[x]** un commit en `saas/producto`, en español, con prefijo `feat:` y
  `Co-Authored-By`. `git branch --contains` devuelve solo `saas/producto`. Nada pusheado.
- CP11 Entrante nunca bloqueado: **[x]** n/a — no toca webhook ni facturación.

## Hallazgos (archivo:línea)

Ninguno bloqueante. Por orden de importancia:

1. `messages/es.json:1450` — `Settings.templates.toastSyncCount`:
   «Se sincronizaron {total} {total, plural, =1 {plantilla} other {plantillas}} de Meta».
   El verbo está fuera de la rama, así que con `total = 1` sale «Se sincronizaron 1
   plantilla». Se arregla metiendo el verbo dentro (`=1 {se sincronizó 1 plantilla}`), como
   ya se hizo bien en `Settings.aiConfig.overlapTitle`.
2. `messages/es.json:191-192` — `Inbox.sessionTimer.xhRemaining` / `xmRemaining`:
   «Quedan {hours} h» / «Quedan {minutes} min» concuerdan mal en singular («Quedan 1 h»).
   El inglés no pluraliza aquí, y el test estricto de `es` exige los mismos selectores que
   `en`, así que arreglarlo requiere tocar también `en.json`: es deuda, no error de esta
   feature.
3. `messages/es.json:213` — `Inbox.composer.addCaption`: «Añade un pie de foto…». El
   composer adjunta también vídeo y documento; «Añade un pie…» o «Añade una descripción…»
   cubre los tres casos sin mentir.
4. `messages/es.json:1533-1535` y `:1495` — `Settings.whatsapp.step3_2`/`step3_3`/`step3_4`
   traducen los rótulos de campo de la consola de Meta («id del número de teléfono», «token
   de acceso permanente») mientras `step1_2`, `step2_2` y `step4_2` dejan los botones en
   inglés («My Apps», «Set Up», «Edit»). La política del informe es buena; la aplicación es
   desigual. Además «Id» en minúscula (`:1495`, `phoneNumberId`) canta frente a «ID».
5. `src/app/(dashboard)/contacts/page.tsx`, `src/components/contacts/contact-detail-view.tsx`,
   `src/components/pipelines/deal-card.tsx` — el cambio real es **una línea por archivo**
   (`toLocaleDateString('en-US', …)` → `undefined`), pero el commit reformatea los tres
   archivos enteros con prettier: 950 líneas de diff, ~346 incluso ignorando espacios
   (reordenación de clases de Tailwind y comillas). El repo no está formateado (288 archivos
   fallan `prettier --check`), así que esto no es «devolver el archivo a su estado»: es ruido
   que entierra el cambio de una línea y ensucia el `git blame`. No lo bloqueo porque el
   formato lo impone prettier por convención del repo, pero si el humano quiere un histórico
   legible, esto pedía commit aparte.
6. `src/i18n/request.ts:12` — con un `NEXT_PUBLIC_APP_LOCALE` desconocido se cargan los
   mensajes de `en` pero `locale` conserva el valor inválido, que acaba en
   `<html lang="xx">`. Es preexistente (no lo introduce esta feature) y el test `:51` solo
   afirma los mensajes, no el `locale`. Deuda menor de accesibilidad.
7. Deuda ya anotada por el implementer y que confirmo: con `undefined` las fechas siguen el
   idioma del navegador, no el de la aplicación, así que una interfaz en español puede
   imprimir «Sep 14, 2026». Es el patrón mayoritario del repo (no queda ni un locale fijo en
   `src` tras el cambio) y arreglarlo de verdad es `useFormatter()` en ~18 sitios: correcto
   dejarlo fuera.

## Notas para el humano (no son cambios requeridos)

- El trailer del commit es `Co-Authored-By: Claude Opus 5 (1M context)`, no el `Claude Fable
  5.1` que llevan p6.1-p6.3. El implementer lo justifica y es la atribución verdadera; si se
  quiere homogeneidad en la rama, es un `git commit --amend`.
- `git status` del checkout principal muestra `D .env.local.example`. No sale de este commit
  (el diff de `9d10709` no lo toca y el archivo vive fuera del worktree). Conviene
  restaurarlo antes de mezclar.
- `.env.local.example` no lleva `NEXT_PUBLIC_APP_LOCALE`; una línea comentada `=es` ahí
  ayudaría a quien despliegue a mano.

## Cambios requeridos

Ninguno. Los hallazgos 1-4 son retoques de una línea en `messages/es.json` que el humano
puede aplicar al mezclar o dejar para la siguiente pasada de copy; no invalidan ningún
criterio del spec ni ponen en rojo la compuerta.
