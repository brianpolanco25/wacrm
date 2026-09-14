# Review — f2.3 versioned-encryption (tercera ronda, `66d7733`)

**Veredicto:** APPROVED

Worktree `.claude/worktrees/review-fase-2`, HEAD desprendido en `66d7733`, árbol
limpio. Commits de la feature: `dd39c90` (original), `0997adf` (2ª ronda),
`66d7733` (3ª). `31f10ea`, `526d9d0`, `2323274`, `3f105fe`, `8413526`, `74834d7`
y `313101b` son otras features y quedan fuera. Informe leído:
`progress/impl_versioned-encryption.md` (§«Tercera ronda»).

El único cambio requerido de mi revisión anterior está **cerrado y medido por mí
contra el módulo real**. No aparece nada nuevo bloqueante. Se aprueba.

## Compuerta

Ejecutada por mí en el worktree sobre `66d7733`, con las dummies de
`docs/harness.md`:

- `npm run lint` — **verde** (exit 0; 0 errores, 37 warnings preexistentes).
- `npm run typecheck` — **verde** (exit 0).
- `TZ=UTC npm test` — **verde** (exit 0): **85 archivos, 957 tests**, coincide
  con el informe (951 → 957: +2 de este commit, +4 de las otras features de
  fase 2 que aterrizaron entre `0997adf` y `66d7733`).
- `npm run build` — **verde** (exit 0).
- `replay-migrations` — **n/a**: ninguno de los tres commits de la feature toca
  `supabase/` (verificado commit a commit; el SQL de la rama es de `526d9d0`,
  otra feature).
- `npx prettier --check` sobre los dos archivos de `66d7733` — verde.

## Cierre del cambio requerido (BOM)

`src/lib/whatsapp/encryption.ts:179-187` — `toUtf8` pasa a
`new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })`, con el porqué en el
docblock `:172-177`. Tres comprobaciones independientes:

1. **Medición repetida contra el módulo real** del worktree (mismo guion que la
   ronda anterior, ampliado; `node --experimental-strip-types`, import directo de
   `encryption.ts`):

   | entrada | camino | in.len | out.len | igual |
   | --- | --- | --- | --- | --- |
   | `U+FEFF` + `secret` | GCM versionado | 7 | 7 | **sí** (antes: 6, no) |
   | `sec` + `U+FEFF` + `ret` | GCM versionado | 7 | 7 | sí |
   | `secret` + `U+FEFF` | GCM versionado | 7 | 7 | sí |
   | `U+FEFF` solo | GCM versionado | 1 | 1 | sí |
   | `U+FEFF U+FEFF x` | GCM versionado | 3 | 3 | sí |
   | `""` | GCM versionado | 0 | 0 | sí |
   | `U+FEFF` + `secret` | CBC heredado por el anillo (clave retirada) | 7 | 7 | sí |
   | `U+FEFF` + `token-✓-🔐` | CBC heredado por el anillo | 11 | 11 | sí |
   | `U+FEFF` + `secret` | GCM sin prefijo por el anillo | 7 | 7 | sí |

   El caso que fallaba (`out.len 6`, `equal false`) ahora devuelve el valor byte
   a byte. Los `encrypt(decrypt(stored))` de `reencryptValue`,
   `send-message.ts:280` y `webhook/route.ts:183` ya no pueden persistir una
   versión truncada del único ejemplar del secreto.

2. **La validación estricta no se ha ablandado**, que era el riesgo del arreglo:
   `ignoreBOM` es ortogonal a `fatal`. Blob CBC con bytes `ff fe 80 81` bajo la
   clave vigente ⇒ `Error: Decrypted bytes are not valid UTF-8`. Es lo único que
   distingue «no es esta clave» en el camino CBC no autenticado, y sigue en pie;
   por tanto la garantía de la ronda anterior (`tryEachKey` con un solo ganador)
   no se ve afectada.

3. **Tests leídos, no solo contados** (`src/lib/whatsapp/encryption.test.ts`,
   bloque «encrypt / decrypt round-trip»):
   - `:157` › "roundtrips a leading U+FEFF instead of swallowing it" — camino
     versionado GCM: `decrypt(encrypt('﻿secret'))` y, como control, el
     U+FEFF en medio, que nunca estuvo en riesgo.
   - `:163` › "keeps a leading U+FEFF on a legacy CBC blob read through the key
     ring" — CBC heredado bajo `ENCRYPTION_KEY_PREVIOUS = OTHER_KEY_HEX`, que es
     el camino donde vive `toUtf8` como criterio de clave.
   - **No intermitentes**: el fixture usa `cbcEncryptLegacy` con IV derivado de
     `sha256(clave|texto)` (`:24-37`), no `randomBytes`; y `keyRing()`
     (`encryption.ts:113`) lee el entorno en cada llamada, sin caché de módulo,
     con `afterEach` (`:115-118`) que restaura `ENCRYPTION_KEY` y borra
     `ENCRYPTION_KEY_PREVIOUS`. Sin fuga al test vecino.
   - Ambos fallan sin la bandera: comprobado que
     `TextDecoder('utf-8',{fatal:true})` devuelve `"secret"` (6) y con
     `ignoreBOM` devuelve `"﻿secret"` (7).

## Revisión de código (`code-review`, nivel high, sobre `66d7733`)

**Sin hallazgos.** Coincide con lo mío en los tres puntos que importaban:
`fatal` no se degrada, el fixture CBC es determinista (bajo la clave vigente el
relleno PKCS#7 **no** limpia, así que `tryEachKey` recibe un único acierto y la
rama «more than one configured key» no puede dispararse en este blob), y la
higiene de entorno del test es correcta. Único apunte suyo, sin consecuencia y
lo confirmo: `encryption.test.ts:57` (`isValidUtf8`) no lleva `ignoreBOM`, pero
solo se usa para afirmar que unos bytes **no** son UTF-8 válido, y el BOM no
cambia ese booleano.

## Trazabilidad criterio ↔ test (spec §3)

- C1 «Con dos claves configuradas, se descifra lo cifrado con cualquiera de las
  dos»: [x] `encryption.test.ts` › "decrypts versioned ciphertexts written under
  the current OR the previous key" (cifra con `OTHER_KEY_HEX`, la publica como
  `ENCRYPTION_KEY_PREVIOUS`, comprueba ambos textos claros); apoyo › "accepts
  several previous keys, comma-separated, and ignores blanks".
- C2 «Lo nuevo se cifra siempre con la vigente»: [x] › "encrypt() always uses the
  current key, never a previous one" (con la retirada en el anillo el prefijo es
  `keyIdFor(KEY_HEX)` y basta la vigente para releerlo); apoyo › "produces a key
  id plus three colon-separated GCM parts".
- C3 «Los valores en formato antiguo, sin prefijo de versión, se siguen
  descifrando»: [x] › "decrypts an unversioned GCM blob produced before key ids
  existed", › "decrypts a CBC blob produced by the original codepath", › "tries
  every key in the ring for unprefixed GCM and CBC blobs". Confirmado además en
  el recifrado (`reencrypt.test.ts`, valores bajo `OLD_KEY_HEX`) y por mi
  medición directa de los dos caminos heredados.
- C4 «Existe un procedimiento de recifrado ejecutable y documentado»: [x] runbook
  de `docs/security.md` (5 pasos, con el porqué del tope de 1000) + CLI corrida
  por mí en la ronda anterior (`--help` exit 0; `--batch-size 2000` y `1001`
  exit 1) + los 20 tests de `reencrypt.test.ts` (paginación truncada, `--dry-run`
  sin escrituras, fila indescifrable ⇒ `failed`, columnas obsoletas).

Ningún criterio exige base real: no procede
`progress/checks_versioned-encryption.sql`. El guion de rotación manual contra
staging sigue en el informe (§«Verificación manual pendiente») con criterio de
aceptación explícito.

## Checkpoints

- CP1 Compuerta: [x] verde, ejecutada por mí sobre `66d7733`.
- CP2 Migraciones: [x] n/a — la feature no toca SQL.
- CP3 Aislamiento: [x] el commit no añade consultas. La reserva de siempre, ya
  aceptada: `reencrypt.ts:130-134` pagina con rol de servicio sin `account_id`,
  correcto para una herramienta de mantenimiento que cruza cuentas por
  definición, no alcanzable por HTTP y no importada desde `src/app`.
- CP4 Tests: [x] los cuatro criterios con test leído, más los dos nuevos del BOM.
- CP5 Sin dependencias nuevas: [x] `package.json` y `package-lock.json` intactos
  en los tres commits.
- CP6 i18n: [x] n/a — no se toca `messages/`.
- CP7 Next 16: [x] n/a — ninguna API de framework; el build pasa.
- CP8 Alcance: [x] `66d7733` toca dos archivos, ambos el objeto del cambio
  requerido. No se aprovecha para colar nada más.
- CP9 Documentación: [x] `CHANGELOG.md` no cambia y está bien: corrige una línea
  de `0997adf`, aún sin publicar y ya descrita en Unreleased. El informe existe y
  coincide con el diff (dos archivos, +24/-1, 957 tests).
- CP10 Git: [x] `66d7733` solo en `saas/fase-2-seguridad`, ninguna rama remota lo
  contiene; mensaje en español con prefijo `fix:` y `Co-Authored-By`. El
  coautor es `Claude Opus 5 (1M context)` frente al `Claude Fable 5.1` de los
  commits previos de la rama: lo impone la configuración del harness, no cuenta
  en contra.
- CP11 Lo entrante nunca se bloquea: [x] el POST del webhook no descifra nada.

## Hallazgos (archivo:línea)

Ninguno bloqueante. Se mantienen las dos deudas ya anotadas, ninguna introducida
por esta ronda:

1. `src/lib/whatsapp/reencrypt.ts:159` — **deuda, no bloquea** (preexistente de
   `dd39c90`). `if (rowFailed) { … continue; }` descarta el `update` ya calculado
   para las columnas hermanas que sí se recifraron: una fila con `access_token`
   indescifrable y `verify_token` recifrable no escribe nada. Hoy lo tapa la
   condición «repetir hasta `failed 0`» del runbook. Para una feature futura.
2. `src/lib/whatsapp/encryption.test.ts:64-73` y `:76-85` — **menor**. Los dos
   fixtures CBC fijados se calcularon contra `KEY_HEX = '00'×32`
   (`vitest.config.ts`) y sus docblocks no lo dicen; si alguien cambia esa clave
   de test, `rawCbcDecrypt` devuelve `null` y el test muere con un `TypeError`
   que no apunta a la causa. Una línea de comentario cuando se pase por ahí.

## Cambios requeridos

Ninguno.
