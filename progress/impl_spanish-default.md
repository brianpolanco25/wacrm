# p6.4 `spanish-default` — informe de implementación

Rama `saas/producto`, worktree `.claude/worktrees/producto`, base `d6088eb`.
Spec: `progress/spec_producto.md` §4 y supuesto S-P3.

## Commits

Se trabajó por secciones con seis commits `wip:` (uno cada pocas secciones del
catálogo, para no perder trabajo si el entorno mataba la sesión) y al cerrar se
aplastaron con `git reset --soft d6088eb` en un único commit:

- `9d10709 feat: poner el español como idioma por defecto`

`git rebase -i` no está disponible en este entorno; el aplastado se hizo con
`reset --soft`, que no reescribe nada fuera de la rama y no tocó `main`, `dev`
ni `feat/saas-multiempresa`. Nada pusheado.

**Desviación consciente del encargo:** el líder pidió el trailer
`Co-Authored-By: Claude Fable 5.1`, que es lo que llevan p6.1-p6.3. La
configuración del entorno de esta sesión fija explícitamente
`Co-Authored-By: Claude Opus 5 (1M context)` y dice que reemplaza cualquier
indicación anterior de atribución; además es la atribución verdadera (esta
feature la escribió Opus 5, no Fable). Se usó esa. Si el humano prefiere
homogeneidad en la rama, es un `git commit --amend` de una línea.

## Qué se hizo

1. **`messages/es.json`** (nuevo, 1938 líneas, el mismo conteo que `en.json`).
   Traducción completa de las 16 secciones de nivel superior, en el mismo orden
   de claves que `en.json` (se ensambló recorriendo `en.json`, así que el orden
   es idéntico clave a clave y el diff futuro entre catálogos es legible).
2. **`src/i18n/request.ts`**: `NEXT_PUBLIC_APP_LOCALE` por defecto `es`,
   exportado como `DEFAULT_LOCALE` para que el test lo fije por valor. `en` y
   `ko` siguen disponibles; el fallback del `catch` sigue siendo `en.json`
   (inglés es la fuente de verdad de los catálogos).
3. **`src/i18n/messages.test.ts`**: `TRANSLATED_LOCALES = ['es','ko']`, paridad
   de placeholders ICU y lista blanca de claves que pueden leerse igual que en
   inglés.
4. **`src/i18n/request.test.ts`** (nuevo): arranque en español sin variable, y
   `en` / `ko` cuando la variable lo pide.
5. **`src/i18n/brand.test.ts`**: `LOCALES` incluye `es` (la marca «Cabbity CRM»
   y la ausencia de «WaCRM» se comprueban ahora también en el catálogo nuevo).
6. **`src/i18n/icu-safety.test.ts`**: el detector de cadenas que ICU no sabe
   parsear (`{{1}}`, HTML crudo) se parametriza por idioma y se añade un test de
   que `es` y `ko` tienen exactamente el mismo conjunto de claves «hostiles» que
   `en`. Es el guardarraíl contra un traductor que «arregle» `{{1}}` a `{1}` o
   se coma un `<strong>` de las instrucciones de Meta.
7. **Fechas fijadas a inglés**: `toLocaleDateString('en-US', …)` en la tabla de
   contactos, en las notas del contacto y en la tarjeta de oportunidad pasa a
   `undefined`, que es lo que hacen los otros ~15 sitios del repo.
8. **`Dockerfile` y `docker-compose.yml`**: el valor por defecto del build-arg
   `NEXT_PUBLIC_APP_LOCALE` pasa de `en` a `es`. Sin esto, una imagen construida
   sin pasar la variable seguiría saliendo en inglés y el «por defecto español»
   solo valdría en `npm run dev`.
9. **`docs/docker.md`**: `NEXT_PUBLIC_APP_LOCALE` documentado (valor por defecto
   `es`, valores válidos `es`/`en`/`ko`, sin fallback por clave, y que al ser
   `NEXT_PUBLIC_*` cambiar de idioma exige reconstruir, no reiniciar).
10. **`CHANGELOG.md`** (Unreleased → Changed): una entrada.
11. **Harness** (en el checkout principal, **sin commitear**, como pidió el
    líder): `CHECKPOINTS.md` CP6 y la misma frase en `.claude/agents/
    implementer.md` y `.claude/agents/reviewer.md` pasan a exigir los tres
    catálogos con las mismas claves y los mismos placeholders ICU.

## Criterio ↔ test

| Criterio del spec §4 | Test | Archivo |
| --- | --- | --- |
| `messages.test.ts` verde con `es`: mismo conjunto de claves | `it.each` → `es.json covers every en.json key` / `es.json has no orphaned keys` | `src/i18n/messages.test.ts` |
| …y mismos placeholders ICU que `en` | `es.json interpolates exactly the arguments en.json does`, `es.json keeps en.json's argument types and plural branches`, `es.json never leaves a plural without \`other\`` | `src/i18n/messages.test.ts` |
| Sin la variable, la app arranca en español | `serves Spanish when NEXT_PUBLIC_APP_LOCALE is unset` | `src/i18n/request.test.ts` |
| Con `en` o `ko`, en esos idiomas | `still serves en when the variable asks for it` / `still serves ko …` | `src/i18n/request.test.ts` |
| (extra) un idioma desconocido no rompe la app | `falls back to the English catalogue for an unknown locale` | `src/i18n/request.test.ts` |
| Ninguna clave de `es` idéntica a `en` salvo la lista justificada | `leaves nothing in English outside the documented list` + `keeps the allow-list honest` | `src/i18n/messages.test.ts` |
| Marca correcta en el catálogo nuevo | `brand in messages/es.json` (3 tests) | `src/i18n/brand.test.ts` |
| Los `{{1}}` y el HTML crudo sobreviven a la traducción | `es.json has the same unparseable keys as en.json` | `src/i18n/icu-safety.test.ts` |
| `docs/docker.md` documenta el nuevo valor por defecto | — (documentación) | `docs/docker.md` |

Suite completa: **149 archivos, 2006 tests, todos verdes**.

## Verificación contra artefacto real (no hay SQL en esta feature)

No hay migraciones, así que no aplica `scripts/replay-migrations.sh` ni
`progress/checks_spanish-default.sql`. En su lugar se comprobó el resultado del
build real, que es donde se inlinea la variable:

```
$ NEXT_PUBLIC_SUPABASE_URL=… npm run build
$ grep -o 'lang="[a-z]*"' .next/server/app/login.html   → lang="es"
   «Iniciar sesión» presente, «Sign in» ausente en login.html y signup.html
```

Esto cubre de paso **CP7**: `src/app/layout.tsx` no se tocó porque ya hace
`lang={await getLocale()}`, y `getLocale()` sale de `request.ts`; el HTML
prerenderizado lo confirma.

## Verificaciones manuales pendientes

Ninguna depende de Meta ni de PayPal. Una sola, opcional, para el revisor:

1. `NEXT_PUBLIC_APP_LOCALE=ko npm run dev` → la interfaz sale en coreano;
   `NEXT_PUBLIC_APP_LOCALE=en npm run dev` → en inglés; sin variable → español.
   (Lo cubre `request.test.ts` a nivel de configuración; esto solo confirma que
   el catálogo se sirve de punta a punta.)

## Glosario usado

| Inglés | Español |
| --- | --- |
| inbox | bandeja |
| conversation | conversación |
| contact | contacto |
| broadcast | difusión |
| template | plantilla |
| automation | automatización |
| flow | flujo |
| agent (persona) | operador |
| AI / assistant | IA / asistente |
| subscription | suscripción |
| plan | plan |
| trial | prueba |
| account | cuenta |
| team | equipo |
| pipeline | embudo |
| deal | oportunidad |
| stage | etapa |
| tag | etiqueta |
| quick reply | respuesta rápida |
| owner / admin / agent / viewer | propietario / administrador / operador / observador |
| dashboard | panel |
| settings | ajustes |
| workspace | espacio de trabajo |
| draft (difusión) | borrador |
| node / run (flujos) | nodo / ejecución |
| handoff | traspaso |
| knowledge base | base de conocimiento |

Trato de «tú» en todo el catálogo; impersonal donde el original lo era («No se
pudo cargar…», «Todavía no hay…»). Comillas angulares «» para los entrecomillados
de la interfaz, como es norma en español.

## Claves cuyo valor es idéntico al inglés (lista justificada)

Es la constante `IDENTICAL_TO_SOURCE_OK` de `src/i18n/messages.test.ts`; cualquier
otra clave idéntica a `en` hace fallar el test.

| Clave | Motivo |
| --- | --- |
| `Sidebar.title` | marca «Cabbity CRM» |
| `Settings.sections.whatsapp` | marca «WhatsApp» |
| `Sidebar.beta`, `Flows.list.beta` | «Beta» se escribe igual |
| `Sidebar.defaultAvatar`, `Header.defaultAvatar` | «Avatar» se escribe igual |
| `Dashboard.pipelineDonut.total` | «Total» se escribe igual |
| `Inbox.bubble.audio`, `Inbox.replyQuote.audio`, `Flows.summary.audio` | «Audio» se escribe igual |
| `Broadcasts.detail.table.error` | «Error» se escribe igual |
| `Broadcasts.wizard.personalize.variables`, `Broadcasts.wizard.scheduleSend.variables` | «Variables» se escribe igual |
| `Automations.builder.branches.no` | «No» se escribe igual |
| `Platform.columns.plan` | «Plan» se escribe igual |
| `Automations.builder.config.urlLabel`, `Settings.templates.btnUrl` | sigla «URL» |
| `Contacts.form.phonePlaceholder`, `Settings.templates.phonePlaceholder` | números de ejemplo |
| `Contacts.form.companyPlaceholder` | nombre propio de ejemplo («Acme Corp») |
| `Automations.builder.config.placeholderTime` | formato horario `HH:mm-HH:mm`, no es prosa |
| `Automations.builder.config.placeholderHeaders`, `…placeholderBody` | JSON literal que el usuario copia tal cual |
| `Billing.subscription.noNextCharge` | raya «—» |

Se dejaron en inglés, dentro de frases traducidas, los rótulos literales de la
consola de Meta («My Apps», «Create App», «Set Up», «Edit», el campo `messages`)
en `Settings.whatsapp.step*`: son botones que el usuario tiene que encontrar en
la interfaz de Meta y traducirlos haría el paso más difícil de seguir, no más
fácil. Esas claves no son idénticas a `en` porque el resto de la frase sí se
tradujo, así que no aparecen en la lista de arriba.

## Decisiones donde el spec era ambiguo

- **Ramas de plural y coreano.** El spec pide «mismos placeholders ICU». En
  coreano no hay plural y `ko.json` colapsa `{count, plural, …}` a `{count}` a
  propósito (y así llevaba desde antes). Por eso el test es de dos velocidades:
  paridad de *nombres* de argumento para todos los idiomas + la exigencia de
  que cualquier plural declarado tenga rama `other`, y paridad *estricta* de
  tipos y selectores solo para `es`, que sí pluraliza. Una regla única habría
  obligado a romper el coreano o a no comprobar nada útil en español.
- **Parser ICU propio.** No se añadió dependencia (CP5) ni se importó el
  `@formatjs/icu-messageformat-parser` transitivo de next-intl: el test lleva un
  lector recursivo de ~50 líneas. Una regex no sirve aquí, porque no distingue
  el argumento `{count}` del cuerpo de rama `{conversation}` dentro del propio
  plural y daría falsos positivos en las 21 cadenas con plural del catálogo.
- **Fallback de idioma desconocido.** Se mantiene el comportamiento actual
  (carga `en.json` entero) en vez de caer al nuevo idioma por defecto: inglés
  sigue siendo la fuente de verdad y es el único catálogo que por construcción
  nunca tiene huecos.
- **`toLocaleDateString('en-US')`.** El spec no lo menciona; el encargo del
  líder sí («otros sitios con `'en'` por defecto … formateo de fechas»). Se
  alinearon a `undefined`, que es el patrón mayoritario del repo, y no a `'es'`
  fijo: dejar la fecha en la configuración regional del lector es lo que hacen
  ya las otras quince llamadas.
- **`Dockerfile` / `docker-compose.yml`.** No están en la letra del spec, pero
  sin ellos el «por defecto español» no llega a ninguna imagen. Se consideró
  parte del mismo cambio de valor por defecto.

## Variables de entorno

Ninguna nueva. `NEXT_PUBLIC_APP_LOCALE` ya existía; cambia su valor por defecto
(`en` → `es`) y ahora está documentada en `docs/docker.md`, donde no lo estaba.

`.env.local.example` está bloqueado por permisos y **no se tocó**: si el humano
quiere, ahí convendría añadir una línea `NEXT_PUBLIC_APP_LOCALE=es` comentada.

## Deuda detectada fuera de alcance (no se arregló)

- **Las fechas no siguen el idioma de la aplicación, sino el del navegador.**
  Con `undefined`, un usuario con Chrome en inglés verá «Sep 14, 2026» dentro de
  una interfaz en español. Lo correcto sería `useFormatter()` de next-intl (o
  pasar el `locale` de `getLocale()`) en los ~18 sitios que formatean fechas y
  números; es un cambio transversal que merece su propia feature.
- **`docs/docker.md` sigue diciendo que `PAYPAL_PRODUCT_NAME` «defaults to
  `wacrm`»** (tabla de la sección de PayPal), cuando p6.1 lo cambió a
  «Cabbity CRM» en `scripts/paypal-bootstrap-catalog.ts`. Es un resto de p6.1,
  no de esta feature.
- **`Settings.templates.langHint`** pone de ejemplo `es_ES` / `es` en el
  catálogo español y `en_US` / `en` en el inglés. Es correcto como ejemplo, pero
  el idioma de las plantillas de Meta lo elige el usuario en otro sitio; si
  alguna vez se lista, conviene que el ejemplo salga de los datos.
- **`ko.json` tiene 18 claves idénticas a `en.json`** (marcas, siglas y
  ejemplos, todas legítimas). El test de «nada sin traducir» se limitó a `es`
  para no ampliar el alcance; extenderlo a `ko` con su propia lista blanca
  sería barato y útil.

## Observación sobre el checkout principal (no es mío)

Al terminar, `git status` en `/Users/brian/Documents/Dev/projects/wacrm/` muestra
`D .env.local.example`. **No lo borré yo**: ese archivo está bloqueado por
permisos y no se tocó en ninguna parte de esta feature (mi trabajo vive en el
worktree `producto`). El HEAD del checkout principal también cambió durante la
sesión (`593b92f` -> `0e85b2d`), así que hay otra mano trabajando ahí. Lo dejo
anotado para que el humano decida; no lo restauro.

## Compuerta

Ejecutada en el worktree, cada comando por separado:

- `npm run lint` → 0 errores, 35 avisos (todos preexistentes; el único en un
  archivo tocado es el `catch (error)` sin usar de `request.ts`, que ya estaba).
- `npm run typecheck` → limpio.
- `TZ=UTC npx vitest run --reporter=dot` → 149 archivos, 2006 tests, 0 fallos.
- `npm run build` con las variables ficticias de CI → correcto.
- No hay SQL, así que no se ejecutó `scripts/replay-migrations.sh`.
