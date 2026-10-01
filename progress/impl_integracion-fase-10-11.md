# Integración fase 10 → fase 11: conflicto en la ficha de cuenta

Worktree `.claude/worktrees/precios-meta-directo`, rama `feat/precios-meta-directo` @ 24fdb08,
`git merge feat/facturacion-gestionada` (0085083) en curso. **Sin commit**: todo queda en el índice
para que el líder cierre el merge. No se ejecutó `commit`, `merge --abort` ni `checkout`.

## Qué se hizo

1. `src/components/platform/platform-account-detail.tsx` (UU → resuelto)
   - Hunk 1: fuera la interfaz `WhatsAppNumber` duplicada de p11.1; queda el import de
     `./platform-numbers`.
   - Hunk 2: se queda `<AccountNumbersCard>` (s10.6) y recibe además
     `checkingNumber={checkingNumber}` y `onRecheckPayment={recheckPayment}`. El estado
     `checkingNumber` y el callback `recheckPayment` de p11.1 (POST
     `/api/platform/accounts/:id/payment-status`, toast `paymentRecheckFailed`, `load()`) siguen
     en la ficha, sin cambios.
2. `src/components/platform/platform-numbers.tsx`
   - `WhatsAppNumber` gana `metaPaymentStatus?`, `metaPaymentCheckedAt?`, `metaPaymentError?`
     (opcionales, como el resto de campos nuevos).
   - Nuevas props opcionales `checkingNumber?: string | null` y
     `onRecheckPayment?: (configId) => void`.
   - Por número con `wabaId`: la línea de p11.1 portada tal cual (span `data-payment-status`,
     etiqueta, badge ok/missing/unknown/pending, «Comprobado el {date}», error de Meta solo si
     `unknown`, botón «Comprobar de nuevo» → `onRecheckPayment(number.id)`), debajo del error de
     registro. Botón deshabilitado si hay una comprobación en curso **o si no se pasó callback**
     (decisión: sin callback no hay qué hacer). Se añadió `type="button"`.
   - Copia local del helper `moment()` (no se puede importar de la ficha: dependencia circular).
   - Las claves usadas son `Platform.payment*` (están en `Platform`, no en `Platform.account`);
     `t = useTranslations('Platform')` ya existía en la tarjeta. Sin claves i18n nuevas.
3. **Conflicto semántico fuera del archivo encargado** (git lo fusionó "limpio" pero no
   compilaba): `src/components/settings/whatsapp-config.tsx` declaraba dos `metaBilling`
   (p11.1: `useBillingStatus()?.metaBilling` para ocultar el badge de pago; s10.6:
   `useState<ManagedSetupBilling|null>` + `fetchMetaBilling` para la checklist gestionada y el
   acordeón). Arreglo mínimo: el de p11.1 se renombra a `statusMetaBilling` y solo lo usa
   `PaymentStatusBadge`; el de s10.6 conserva el nombre y sus dos usos. Cada lado mantiene su
   fuente y su comportamiento. El líder puede preferir unificar en una sola fuente: queda anotado.

## Tests

`src/components/platform/platform-numbers.test.tsx`, nuevo describe
«AccountNumbersCard — payment method per number (p11.1)» (movido desde la ficha):
- `a missing number of a managed account: red badge, date and the re-check button` (además
  comprueba que los ids y la etiqueta de portafolio de s10.6 conviven, y botón habilitado)
- `unknown shows Meta's error`
- `ok hides the error; never checked reads as pending`
- `a number without WABA has no payment line`
- `every re-check button is disabled while one number is being checked` (nuevo)
- `English catalogue`

`src/components/platform/platform-account-detail.test.tsx` (queda como prueba de cableado):
- `the numbers card shows the payment line with an enabled re-check button` (la línea está
  dentro de `data-testid="account-numbers"`, botón sin `disabled`, y waba + portafolio de s10.6)
- `a number without WABA has no payment line`
- `English catalogue`

Los tests de s10.6 (`AccountNumbersCard`, `copyId`, `the operator file uses the numbers
section`, claves `Platform.numbers`) pasan sin tocar. Sin entorno DOM en vitest, el clic en
«Comprobar de nuevo» no se prueba (tampoco lo probaba p11.1); queda cubierto por props + markup.

## Verificación

- Marcadores de conflicto: ninguno en `src`, `messages`, `docs`; `git diff --name-only
  --diff-filter=U` vacío.
- Prettier aplicado a los cinco archivos.
- `npx vitest run src/components/platform src/lib/platform`: 19 archivos, 290 tests, todos
  pasan. (Con `src/components/settings` incluido: 24 archivos, 344 tests, todos pasan.)
- `npm run lint`: 0 errores, 34 warnings (preexistentes, p. ej. `src/middleware.ts`).
- `npm run typecheck`: limpio (antes del arreglo 3 fallaba con TS2451/TS2322 en
  `whatsapp-config.tsx`).
- No se ejecutó la suite completa, ni build, ni Docker, ni red.

## Archivos en el índice (git add)

- src/components/platform/platform-account-detail.tsx
- src/components/platform/platform-numbers.tsx
- src/components/platform/platform-account-detail.test.tsx
- src/components/platform/platform-numbers.test.tsx
- src/components/settings/whatsapp-config.tsx

Variables de entorno nuevas: ninguna. CHANGELOG: no se tocó (no hay cambio visible nuevo).
