# Review — s10.6 managed-number-setup

**Veredicto:** APPROVED

## Compuerta
No ejecutada por el reviewer (instrucción explícita del líder para esta pasada). Según el
informe del implementer (`progress/impl_managed-number-setup.md`): lint 0 errores/34 warnings
preexistentes, typecheck verde, `TZ=UTC npm test` 267 archivos/3808 tests en verde, build verde.
Sin migración: no aplica `replay-migrations.sh`. Pendiente de que el líder la corra y la anote.

## Trazabilidad criterio ↔ test

- C1 «Checklist opción A, solo visible con `metaBilling === 'managed'`»:
  [x] `src/components/settings/managed-setup-checklist.test.tsx` › `renders nothing when
  meta_billing is direct/null` y `renders the five steps of option A, in order, for a managed
  account` — leído: el render devuelve `''` para `direct`/`null`, y las 5 claves
  (`waba, number, token, displayName, paste`) salen en orden para `managed`.
- C2 «Casillas de estado local, sin persistir»:
  [x] `managed-setup-checklist.test.tsx` › `starts with every box unticked; a ticked one is
  marked done` (verifica `data-done="false"` × 5 en el primer render y `data-done="true"` con
  `initialDone`) + `toggleStep` › `ticks and unticks without touching the input set` (pureza,
  no muta el set de entrada). No hay `localStorage`/`sessionStorage` en el componente (grep
  limpio) ni llamada de red al marcar: el estado vive solo en `useState`.
- C3 «Sin URLs de Meta que no estén ya en el repo»:
  [x] `managed-setup-checklist.test.tsx` › `carries no link (no Meta URL exists in the repo for
  these screens)` (sin `<a`, sin `href=`, sin `https?://` salvo el `xmlns` del icono) y
  `platform-numbers.test.tsx` › `carries no link to Meta`. Confirmado también por grep directo:
  sin `business.facebook.com` ni `billing_hub` en los archivos tocados ni en `messages/*.json`.
- C4 «`token-renewal.ts` salta configs sin `token_expires_at` sin warning ni llamada, sin afectar
  a las que sí caducan»:
  [x] `src/lib/whatsapp/token-renewal.test.ts` › `skips a manual config without expiry silently:
  no call, no write, no warning` (resultado `{scanned:0,...}`, `refresh` no llamado, sin updates,
  sin `console.warn`/`console.error`) y `drops a row without expiry even if one ever slips past
  the query filter` (builder que ignora los filtros SQL y devuelve igual la fila `permanent`; el
  código la descarta en JS antes de contar). El resto de la suite preexistente (`only looks at
  embedded_signup rows…`, `replaces the token…`, `does not send an already expired token…`)
  sigue en verde y cubre que las filas que sí caducan se siguen procesando igual.
- C5 «Ficha: `waba_id`/`phone_number_id` + modo de conexión, visibles con copiar»:
  [x] `src/components/platform/platform-numbers.test.tsx` › `shows the WABA id and the
  phone_number_id of every number, each with a copy button` y `shows the connection mode:
  Embedded Signup or manual` — leídos: comprueban los valores de ambos ids, los `aria-label` de
  copiar y `data-mode`.
- C6 «Etiqueta «En el portafolio de Cabbity [CRM]» solo para `managed`»:
  [x] `platform-numbers.test.tsx` › `tags every number «En el portafolio de Cabbity CRM» on a
  managed account only` — comprueba 2 apariciones en `managed` y 0 en `direct`/`undefined`.
  (Texto final «Cabbity CRM», no «Cabbity», por `brand.test.ts`; documentado como decisión en el
  informe, punto 5 — razonable.)
- C7 «Sin rutas nuevas; si las hay, `requirePlatformAdmin()` + fuga A↔B»:
  [x] N/A — `git diff --stat` no toca `src/app/**`; no hay rutas nuevas.
- C8 «Fuga A↔B / CP3 en la consulta de `loadNumbers`»:
  [x] `src/lib/platform/accounts.test.ts` › `s10.6: each number carries its WABA id,
  phone_number_id and connection mode, for this account only` — comprueba el listado de columnas
  del `.select()` (incluye `waba_id`, `provisioned_via`; excluye `access_token` y `*`), el filtro
  `.eq('account_id', A)` y que la cuenta B no aparece (`not.toContain('waba-b')`). Coherente con
  el diff de `accounts.ts`: la consulta ya filtraba por cuenta; solo se añadió una columna.
- C9 «Nada de `BillingStatusAlert`, `/billing` ni `statements` tocado»:
  [x] `git diff --stat bfe366f..6bb0565` no incluye ningún archivo de billing/statements.
- C10 «Paridad es/en»:
  [x] `managed-setup-checklist.test.tsx` › `Settings.managedSetup keys (CP6: es and en)` (mismas
  claves, mismos placeholders ICU en `steps.paste.body`) y `platform-numbers.test.tsx` ›
  `Platform.numbers keys (CP6: es and en)`. Verificado además por lectura directa del diff de
  ambos catálogos: mismas 10+6 claves nuevas, mismo shape.
- C11 «CHANGELOG actualizado»:
  [x] `CHANGELOG.md` — sección «Managed numbers in the Cabbity CRM Meta portfolio» en Unreleased.

## Checkpoints

- CP1: [ ] (no ejecutada por el reviewer esta pasada, según instrucción; el informe la declara
  verde — el líder debe confirmarlo y anotarlo).
- CP2: n/a — sin migración.
- CP3: [x] `loadNumbers` sigue filtrada por `account_id`, con test de fuga nuevo que cubre la
  columna añadida.
- CP4: [x] cada criterio del spec tiene test leído (ver trazabilidad arriba).
- CP5: [x] `package.json` sin cambios (confirmado por `git diff --stat`).
- CP6: [x] es/en con las mismas claves y placeholders.
- CP7: [x] uso de `Accordion`/`AccordionItem` de `@base-ui/react` con `value`/`defaultValue`
  verificado contra `node_modules/@base-ui/react/accordion/root/AccordionRoot.d.ts` (prop
  `defaultValue?: AccordionValue<Value>`), no de memoria.
- CP8: [x] alcance — 14 archivos tocados, todos justificados por la sección s10.6 del spec
  (checklist, token-renewal, ficha de números, i18n, CHANGELOG, docs/security.md). Sin tocar
  billing/statements (s10.4 corre en paralelo) ni rutas.
- CP9: [x] CHANGELOG (Unreleased) y `docs/security.md` actualizados; sin variables de entorno
  nuevas (no toca `docs/docker.md`, correcto); informe coincide con el diff.
- CP10: [x] 3 commits en `fg/number-setup`, en español, con prefijo (`feat:`/`docs:`) y
  `Co-Authored-By`; sin push.
- CP11: n/a — esta feature no toca el camino de mensajes entrantes.

## Hallazgos (archivo:línea)

Ninguno bloqueante. Dos observaciones menores, ya anotadas como deuda fuera de alcance por el
propio implementer y correctas en mi lectura:

1. `src/lib/whatsapp/token-renewal.ts` — un token manual de 60 días (no de usuario de sistema)
   pegado por error en el formulario manual tampoco se renueva ni avisa, porque el barrido solo
   mira filas `provisioned_via = 'embedded_signup'`. Preexistente a s10.6, no un regresión de
   esta feature; correctamente dejado fuera de alcance en el informe.
2. `src/components/settings/whatsapp-config.tsx` — `metaBilling` se lee con un segundo efecto y
   una query aparte a `subscriptions` en vez de reutilizar `useBillingStatus`/`/api/billing/status`
   (que aún no expone el campo). Documentado como decisión 1 y como deuda; razonable dado que
   tocar esa ruta choca con s10.4, que corre en paralelo.

## Cambios requeridos

Ninguno.

APPROVED
