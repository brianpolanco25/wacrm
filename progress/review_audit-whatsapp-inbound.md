# Review — p16.1 audit-whatsapp-inbound (ronda 3)

**Veredicto:** APPROVED

Ronda 3 = `de8809a..dc26617` (`dedupe.ts`, `dedupe.test.ts`). Lo de abajo de la línea divisoria es la ronda 2, vigente salvo lo que esta sección corrige.

## Compuerta (ronda 3)
- lint: verde (0 errores). typecheck: verde. build (dummies + `ENCRYPTION_KEY`): verde. replay-migrations: n/a.
- `npm test` dentro de la cadena lint→typecheck→test: 4 rojos en `src/app/api/ai/playground/route.test.ts` (timeouts de 5 s, load average 15–21), igual que en las rondas 1 y 2. Comprobado que es carga y no la rama: dos pasadas completas seguidas de `npx vitest run` en el worktree → 417 archivos / 6410 tests verdes; el archivo solo, 27/27; `main` completo, verde. El diff no toca `src/app/api/ai/` ni nada que importe. `src/middleware.test.ts` no falló.

## Cambios requeridos de la ronda 2
1. 0 troncal en nacional guardado: [x] `src/lib/contacts/dedupe.ts:87-92` quita el 0 inicial del número corto antes de exigir ≥ 7 dígitos, 1–3 dígitos faltantes y `endsWith`. Test `dedupe.test.ts` › "a national number saved with its trunk 0 matches the international one": `07911 123456` ↔ `447911123456`, `06 12 34 56 78` ↔ `33612345678` casan; `0555-1234` ↛ `18095551234`. Falla sin el cambio (con el código de `de8809a` daban null; lo comprobé en la ronda 2 ejecutando la función).
2. Residual AR `011 15…` anotado: [x] `progress/impl_audit-whatsapp-inbound.md:88`.

Prefiltro SQL: el `LIKE '%<últimos 7 del entrante>'` sobre `phone_normalized` encuentra al candidato con 0 delante, porque el 0 está al principio y los últimos 7 dígitos coinciden (`07911123456` y `447911123456` terminan en `1123456`). El stub del test aplica ese mismo LIKE.

Tabla final: las tres filas en negrita de la ronda 2 (UK, FR, VE) pasan a «casa (sufijo tras quitar 0)». Ningún caso pierde el mensaje, funde dos personas reales en RD ni duplica algo que antes casaba, salvo el residual AR anotado.

Riesgo residual a conocer (misma familia que `2025551234` ↔ `442025551234`, ya aceptado; en `main` también casaba por last-8): un nacional de 11 dígitos guardado con 0 puede casar con un NANP `1` + los mismos 10 dígitos (`02079460000` UK ↔ `12079460000` Maine) si es la única candidata. No afecta a contactos de RD.

## Checkpoints (ronda 3)
CP1 [x] (rojo de carga ajeno, verificado) · CP2 n/a · CP3 [x] · CP4 [x] · CP5 [x] · CP6 n/a · CP7 n/a · CP8 [x] · CP9 [x] · CP10 [x] · CP11 [x].

---

# Review — p16.1 audit-whatsapp-inbound (ronda 2)

**Veredicto:** CHANGES_REQUESTED

Rango: `main...fix/audit-whatsapp-inbound` (`5fb7f49`, `6cbc150`, `de8809a`). Ronda 2 = `6cbc150..de8809a`
(12 archivos; nuevo `src/lib/whatsapp/meta-fetch.ts`).

## Compuerta
- lint: verde (0 errores, 34 warnings preexistentes). typecheck: verde. build (dummies + `ENCRYPTION_KEY`): verde.
- `TZ=UTC npm test`: 6405 verdes, 4 rojos en `src/app/api/ai/playground/route.test.ts` (timeouts de 5 s). Mismo
  resultado en las dos rondas, siempre en la pasada completa con load average 17–25 por otras sesiones. Solo:
  27/27 verdes en 0,9 s. El diff no toca `src/app/api/ai/` ni nada que ese route importe. Flaky por carga,
  ajeno; si el líder quiere certeza, que lo compare con una pasada completa de `main` en máquina tranquila.
  `src/middleware.test.ts` no falló esta vez.
- replay-migrations: n/a.

## Cambios requeridos de la ronda 1
1. Sufijo solo si faltan 1–3 dígitos: [x] `dedupe.ts:87-94`; tests «a suffix only stands for a missing country code»
   (`555-1234` ↛ `18095551234`; `8095551234` ↛ `18295551234`; entrada `5551234` con 809 y 829 → null) y
   «two equally good suffix candidates match neither» (empate → null, `dedupe.ts:99-103`).
2. Recipients: [x] `route.ts:880-885` `.in('status', [...LADDER,'failed'].filter(isValidStatusTransition))`; para
   `read` da `pending/sent/delivered`, nunca `read/replied/failed`. Test actualizado lo afirma.
3. Entry sin `changes` / change null: [x] `route.ts:444`, `:589-594`; tests «una entry sin `changes`…» y
   «un change null no hace lanzar al propio catch».
4. CHANGELOG: [x] reescrito, menciona MX/AR, sufijo 1–3, `555-1234` y los tres sitios con timeout.

Decisiones del líder:
- MX/AR: [x] `mobilePrefixTwin` (`dedupe.ts:25-31`). Ataque: `52`+10 ↔ `521`+10 y `54`+10 ↔ `549`+10. Con 12
  dígitos que empiecen `521…`/`549…` la regex retrocede a `1?`/`9?` vacío y toma el 1/9 como primer dígito
  nacional; no hay áreas mexicanas que empiecen en 1 ni argentinas en 9, así que no inventa gemelos. En AR los
  bloques fijo/móvil no comparten número. No funde dos personas reales. Prefiltro: el gemelo comparte los
  últimos 10 dígitos → entra en `LIKE '%<últimos 7>'`. Tests «Mexico 52/521 and Argentina 54/549…» y
  «a 52 number does not match another country sharing only the tail».
- Timeout en `template-sync.ts:207` y `embedded-signup.ts:145` vía `meta-fetch.ts`: [x]; tests en
  `template-sync.test.ts` y `embedded-signup.test.ts` comprueban `signal`.
- Token indescifrable no llama a Graph: [x] `route.ts:1593-1604`; test «con token indescifrable no se llama a
  Graph para la media» (`getMediaUrl` no llamado, `media_url` null, mensaje guardado).
- Comentario de `inbound-thread.ts:110-115`: [x].

## Tabla de casos con la regla final (comprobada ejecutando `findExistingContact` real con stub de LIKE; archivo temporal borrado)
| Guardado | Entrante | Ahora | `main` (`phonesMatch`) |
|---|---|---|---|
| `+1 (809) 555-1234` | `18095551234` | casa (exacta) | no casaba en SQL → mensaje perdido |
| `809-555-1234` / `8095551234` | `18095551234` | casa (sufijo, falta 1) | idem perdido / casaba |
| `809-555-1234` | `18295551234` | no casa → contacto nuevo | casaba → fusión |
| `18095551234` | `18295551234`, `18495551234` | no casa | fusión |
| `555-1234` | `18095551234` | no casa → contacto nuevo | no casaba |
| `370063949836` ↔ `37063949836` | ambos sentidos | casa (troncal 0) | casaba |
| `+52 55 1234 5678` / `5215512345678` | `5215512345678` / `525512345678` | casa | casaba |
| corto (< 7 dígitos) | — | solo exacta | solo exacta |
| BSUID, `phone` NULL | — | fuera del LIKE (NULL); lo resuelve `findContactByWaUserId` antes | igual |
| `2025551234` | `442025551234` | casa (riesgo residual conocido) | casaba |
| **`07911123456`** | **`447911123456`** | **no casa → duplicado** | **casaba** |
| **`0612345678`** | **`33612345678`** | **no casa → duplicado** | **casaba** |
| **`04121234567`** | **`584121234567`** | **no casa → duplicado** | **casaba** |

Ningún caso pierde el mensaje ni funde dos personas. Queda un duplicado de algo que antes casaba y debería.

## Checkpoints
- CP1 [x] (rojo ajeno documentado) · CP2 n/a · CP3 [x] · CP4 [x] salvo hallazgo 1 · CP5 [x] · CP6 n/a · CP7 n/a ·
  CP8 [x] (`template-sync.ts`/`embedded-signup.ts` justificados por decisión del líder) · CP9 [x] · CP10 [x] · CP11 [x].

## Hallazgos (archivo:línea)
1. `src/lib/contacts/dedupe.ts:87-94` — número nacional guardado **con prefijo troncal 0** y sin código de país
   (forma habitual fuera de RD y típica de importaciones CSV en solo dígitos: UK `07911123456`, FR `0612345678`,
   VE `04121234567`) ya no casa con el entrante `447911123456` / `33612345678` / `584121234567`. En `main` casaba
   (cuando estaba guardado sin formato: el LIKE sobre `phone` entraba). Ahora se crea un segundo contacto y el
   hilo se parte. Es «número guardado sin código de país» con el 0 nacional delante, el mismo supuesto que el
   líder ya acepta. No afecta a RD (sin troncal 0).
2. Residual, no bloquea: AR guardado `011 15 2345 6789` (troncal 0 + `15` de móvil) no casa con `5491123456789`;
   requeriría quitar el `15`, fuera del arreglo mínimo. Anotar en el informe.

## Cambios requeridos
1. En `suffixLen` (`dedupe.ts:85-94`), si el número corto empieza por `0`, compararlo sin ese 0
   (`const s = short.startsWith('0') ? short.slice(1) : short;` y usar `s` en la longitud ≥ 7, en `missing` 1–3 y
   en `endsWith`). Test: `07911123456` ↔ `447911123456` y `0612345678` ↔ `33612345678` casan;
   `08095551234` (inexistente en RD) no rompe 809/829: `0555-1234` ↛ `18095551234`.
2. Anotar el residual AR `011 15…` en `progress/impl_audit-whatsapp-inbound.md`.
