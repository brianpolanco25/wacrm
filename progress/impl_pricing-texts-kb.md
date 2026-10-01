# p11.2 `pricing-texts-kb` — informe del implementer

## Plan

1. No existe página de precios ni FAQ públicas: crear `(public)/precios` (patrón de las páginas
   legales: sin sesión, `?lang=es|en`), con textos en `messages/{es,en}.json` (`Pricing`) y catálogo
   público estático en `src/lib/billing/public-plans.ts` anclado por test a las migraciones
   041/059/065 (la RLS de `plans` es solo para autenticados).
2. Página: planes Inicio/Pro/Negocio con lo incluido, bloque «qué cobra Cabbity / qué cobra Meta»,
   cuota gratis por número (Negocio: 3 números = 3.000), método de pago en Meta, FAQ.
3. `PlanPicker` (/billing y onboarding): mensajes como «incluidos», línea de números + cuota gratis
   de Meta, nota de Meta con enlace a /precios.
4. `/billing` (`usageDesc`, `usageOf`) y aviso de cuota de `enforce.ts`: explicar qué pasa al
   agotar lo incluido, sin tocar el comportamiento.
5. Enlace a /precios desde el login (como p8.1 con /developers).
6. Sección nueva en `progress/ai_cabbity-conocimiento.md` en formato pregunta/respuesta.
7. Tests: render de /precios es/en, catálogo anclado a migraciones, frases prohibidas en
   `messages/*.json`, login enlaza /precios, paridad i18n.
8. CHANGELOG, compuerta, commit.

## Resultado

- Rama `pmd/pricing-texts` (worktree `.claude/worktrees/pmd-pricing-texts`), base `be8ca0f`.
- Commit: `63a145f` feat: página de precios y textos de «incluidos» con lo que cobra Meta (p11.2).
- Compuerta: lint 0 errores (34 warnings preexistentes, ninguno en archivos tocados), typecheck
  verde, `TZ=UTC npm test` 270 archivos / 3 834 tests verdes, `npm run build` verde (`ƒ /precios`).
  Sin SQL: no aplica replay.
- Base de conocimiento: `progress/ai_cabbity-conocimiento.md` editado en el checkout principal
  (no versionado en la rama; está fuera del worktree, como el resto de `progress/`).

## Qué había y qué se hizo

- **No existía página de precios ni FAQ pública.** Se creó `src/app/(public)/precios/page.tsx`
  → `src/components/pricing/pricing-page.tsx` (patrón de `LegalPage`: sin sesión, `?lang=es|en`
  con `resolveDocsLocale`, cabecera con selector de idioma, pie con Términos/Privacidad). Textos en
  `messages/{es,en}.json` bajo `Pricing`, leídos con `createTranslator` (así los cubren los tests de
  paridad, ICU, marca y frases prohibidas). El middleware no la protege (no está en
  `protectedPaths`). Enlazada desde el login junto a `/developers` (`LoginPage.pricingLink`).
- **FAQ**: sección «Preguntas frecuentes» dentro de `/precios` (7 entradas, `PRICING_FAQ`).
- **PlanPicker** (`/billing` y paso de plan del onboarding, que lo reutiliza): mensajes salientes,
  respuestas de IA y destinatarios de difusión como «incluidos al mes»; línea nueva de números de
  WhatsApp y, debajo, la cuota gratis de Meta para esos números (Negocio: «3.000 … 1.000 por cada
  uno de los 3 números»); nota «el plan lo cobra Cabbity CRM, los mensajes los cobra Meta aparte»
  con enlace a `/precios`.
- **/billing → Suscripción**: `usageDesc` explica que al usar lo incluido la acción se pausa hasta el
  ciclo siguiente, que un plan mayor incluye más (con efecto en la siguiente renovación, que es lo que
  ya dice `changePlanNote`) y que lo entrante sigue llegando; `usageOf` = «{used} de {limit}
  incluidos».
- **Enforce**: el texto del `quota_exceeded` de `billingErrorPayload` (`src/lib/billing/enforce.ts`)
  pasa de «allowance … Upgrade the plan to raise this limit» a «You have used the N 'metric' included
  in your plan this month (M so far). This kind of send pauses until the next cycle; to get more,
  upgrade to a plan that includes more.» Mismo código, mismo 402, mismo `upgradeUrl`.

## Criterio ↔ test

| Criterio | Test |
|---|---|
| 1. Qué cobra Meta / Cabbity en precios y FAQ (es) | `src/components/pricing/pricing-page.test.tsx` › «says what Cabbity charges and what Meta charges, with the payment method and FAQ (es)» |
| 1. Lo mismo en en | idem › «renders the same page in English with ?lang=en» |
| 1. Solo planes públicos, nunca `gestionado`/`ilimitado` | idem › «lists the three public plans with their price, never a hidden one»; `src/lib/billing/public-plans.test.ts` › «never publishes a hidden plan» |
| 2. Mensajes como «incluidos» en la página | `pricing-page.test.tsx` › «words the plan messages as included (es)» |
| 2. Frases prohibidas en `messages/*.json` | `src/i18n/included-wording.test.ts` › «messages/es.json has none of the forbidden phrasings», «messages/en.json …» |
| 2. Aviso de enforce explica qué pasa, sin cambiar comportamiento | `src/lib/billing/enforce.test.ts` › «p11.2: words the quota as what the plan includes and says the send pauses» (+ el test previo del payload sigue verde) |
| 3. 3 números = 3.000 gratis en Negocio | `pricing-page.test.tsx` › «explains that 3 numbers are 3.000 free service messages on Negocio (es)»; `public-plans.test.ts` › «is 1,000 per number: Negocio with 3 numbers gets 3,000» |
| Catálogo de `/precios` = migraciones | `public-plans.test.ts` › «matches the limits of the 041 seed», «matches the prices left by the last catalogue migration (059, 065)» |
| Enlace desde el login | `src/app/(auth)/login/page.test.tsx` › «LoginPage → /precios» (2 `it`) |
| Paridad i18n | `src/i18n/messages.test.ts` (sin cambios de lógica; `Pricing.who.metaTitle`/`cabbityTitle` añadidos a `IDENTICAL_TO_SOURCE_OK` como nombre de marca), `icu-safety.test.ts`, `brand.test.ts` verdes |
| Metadatos por idioma | `pricing-page.test.tsx` › «titles the page in the visitor language» |

**Frases prohibidas acordadas** (regex, sin distinguir mayúsculas):
- es: `límite máximo`, `máximo de mensajes`, `límite de mensajes`, `tope de mensajes`,
  `mensajes como máximo`, `hasta \S+ mensajes`.
- en: `maximum (number of )?messages`, `message (limit|cap)`, `messages limit`,
  `up to \S+ messages`, `raise this limit`.
No se prohíbe «límite» suelto: «Sin límite», límites de tamaño de imagen, etc. son legítimos.

## Verificaciones contra base real

No aplica: sin migración ni consultas nuevas.

## Verificación manual (guion)

1. `npm run dev`, abrir `/precios` sin sesión: tres tarjetas (35/100/199 USD), Negocio con «3 números
   de WhatsApp», «Meta: 3.000 mensajes de servicio gratis al mes (1.000 por número)» y la nota por
   número; `?lang=en` cambia todo a inglés.
2. `/login`: pie con «API para desarrolladores · Precios».
3. `/billing` con una cuenta admin: tarjetas con «incluidos», línea de números y cuota de Meta, nota
   con enlace a `/precios`. Ajustes → Suscripción: texto de uso nuevo y «X de Y incluidos».

## Decisiones donde la nota era ambigua

- **Catálogo estático** (`src/lib/billing/public-plans.ts`) en vez de leer `plans`: la RLS de la 041
  es `TO authenticated` y abrirla a `anon` sería una migración fuera de alcance; usar
  `supabaseAdmin()` en una página sin sesión no es aceptable. El test lo ancla a 041/059/065: una
  migración de catálogo que no actualice la constante rompe la compuerta.
- **Marca**: `brand.test.ts` exige «Cabbity CRM» en toda cadena que nombre Cabbity; los textos dicen
  «Cabbity CRM» en lugar de «Cabbity».
- **Ventana de 72 h**: el repo solo dice «los de la ventana de 72 h» no los cobra Meta. Se describe
  como «la ventana gratuita de 72 horas que se abre cuando un cliente te escribe desde un anuncio o un
  botón de WhatsApp de tu página de Facebook» (los puntos de entrada gratuitos de Meta), sin cifras.
  Revísalo el humano si prefiere una redacción más genérica.
- **Cifras**: solo 1.000 por número y mes desde el 2026-10-01; RD en «Resto de Latinoamérica» 0,0113
  servicio (pasados los gratis) / utilidad y 0,0740 marketing; «a partir del 1.001, tarifa de
  utilidad» (spec de la fase 10). El resto: «según la tarifa vigente de Meta para tu país».
- **Ampliar plan**: los textos dicen que el cambio de plan se aplica en la siguiente renovación,
  coherente con `changePlanNote`/`taxNote`; no se promete que ampliar desbloquee al instante.
- «Cabbity CRM no cobra extra» al agotar lo incluido: cierto para cuentas `direct` (enforce bloquea,
  no hay excedente). El plan `gestionado` sí cobra excedente, pero no se publica.
- El aviso de método de pago de p11.1 se reutiliza en contenido («Billing Hub de Meta», banner en el
  panel), sin enlazar a sus claves.

## Base de conocimiento del asistente

- Sección nueva «Cabbity CRM: qué cobra Cabbity y qué cobra Meta» (8 preguntas/respuestas: quién
  cobra qué, si el plan incluye Meta, cuota gratis, Negocio 3.000, tarifas con ejemplo de RD, método
  de pago, qué pasa al agotar lo incluido, dónde ver precios). Las fichas Inicio/Pro/Negocio de la
  sección «Cabbity CRM» pasan a «incluidos» (y «destinatarios de difusión incluidos al mes» en vez de
  «difusiones de hasta N destinatarios», que era inexacto: es un cupo mensual). Negocio añade los 3.000.
- **Cómo se carga**: no hay cargador en código. Es material para pegar a mano en Asistentes IA →
  base de conocimiento, que guarda en `knowledge_documents` vía `/api/ai/knowledge` por cuenta. Hay
  que pegar la sección nueva y las fichas corregidas en la cuenta de Cabbity y reindexar.

## Variables de entorno nuevas

Ninguna.

## Deuda detectada (fuera de alcance, no tocada)

- `progress/ai_cabbity-conocimiento.md` sigue diciendo «Prueba gratis de Cabbity CRM: 14 días … sin
  tarjeta» y la FAQ «¿Necesito tarjeta para probar Cabbity?» la incluye: desde la 073 (s9.6) no hay
  prueba gratis del CRM. El asistente lo contestará mal.
- El error `quota_exceeded` (y los de `PlanLimitError`/`FeatureNotAvailableError`) es inglés fijo del
  servidor y se muestra tal cual en toasts a usuarios en español; no hay mapeo por `code` a i18n.
- `PlanPicker` muestra los números sin agrupar (`3000`) en las líneas de límites (`String(value)`);
  solo la cuota de Meta se agrupa con `formatCount`.
- `Billing.limitOperators` y similares en el editor del superadmin (`Platform…limits: «Límites»`) se
  dejan: es la consola del operador, no texto para el cliente.
