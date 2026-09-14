# Implementación — f2.3 versioned-encryption (corrección tras CHANGES_REQUESTED)

Rama `saas/fase-2-seguridad`, worktree
`.claude/worktrees/agent-a4220e4b5ba8896fd`. Base de la corrección: `8413526`
(f2.2). Commit original de la feature: `dd39c90`. Spec:
`docs/saas/fase-2-seguridad.md` §3. Revisión atendida:
`progress/review_versioned-encryption.md` (seis cambios requeridos).

Commit de esta sesión: **`0997adf`** —
`fix: no aceptar un descifrado CBC ambiguo ni cortar la paginación en página corta`.

Archivos tocados: `src/lib/whatsapp/encryption.ts`,
`src/lib/whatsapp/encryption.test.ts`, `src/lib/whatsapp/reencrypt.ts`,
`src/lib/whatsapp/reencrypt.test.ts`, `scripts/reencrypt-secrets.ts`,
`docs/security.md`, `docs/docker.md`, `CHANGELOG.md`. Sin SQL, sin UI, sin
dependencias, sin cambios en `tsconfig.json`.

## Qué se hizo, punto por punto

### 1. Hallazgo 1 (crítico) — el anillo podía sobrescribir el token con basura

`decrypt()` descifra ahora **a bytes** y valida el texto claro antes de
devolverlo:

- `toUtf8()` usa `new TextDecoder('utf-8', { fatal: true })`. El código anterior
  hacía `decipher.update(..., 'utf8')`, que sustituye lo inválido por U+FFFD y
  devuelve mojibake indistinguible de un secreto real.
- `tryEachKey()` deja de devolver el primer acierto: prueba **todas** las claves
  del anillo y exige exactamente un ganador. Dos aciertos ⇒ `Error`
  (`decrypts under more than one configured key (k…, k…)`), porque un
  criptograma escrito por una clave del anillo siempre acierta con **esa**
  clave, de modo que un segundo acierto demuestra colisión.
- Los errores estructurales (longitud de IV o de tag) siguen relanzándose sin
  recorrer el anillo.
- El camino versionado (GCM con prefijo) valida UTF-8 como error duro: ahí la
  clave está nombrada y el GCM ya autentica.

Con esto el escenario del hallazgo queda cerrado por construcción, no por
probabilidad: si el blob CBC se escribió con la clave retirada y esta está en el
anillo, la clave retirada acierta siempre; si además acierta la vigente, hay dos
aciertos y `decrypt()` falla en vez de elegir.

**Reescritos oportunistas** (revisados, sin tocar código):

- `src/lib/whatsapp/send-message.ts:278` — el `update` de `access_token` está
  aguas abajo de `decrypt(config.access_token)` (línea 274). Si el descifrado no
  es inequívoco, `decrypt` lanza y la función sale antes de escribir.
- `src/lib/whatsapp/reencrypt.ts:80` — `reencryptValue` llama a `decrypt` antes
  de `encrypt`; la excepción se cuenta como `failed`, se registra y la fila
  queda intacta. Cubierto por test nuevo (ver tabla).
- `src/app/api/whatsapp/webhook/route.ts:181` — escribe
  `encrypt(verifyToken)`, el valor que **llegó en la petición** y que coincidió
  con el descifrado; nunca escribe el resultado del descifrado. Era seguro ya y
  lo sigue siendo.
- `src/app/api/whatsapp/config/route.ts:118` — un `decrypt` que lanza produce
  `token_corrupted` con `needs_reset`, que es la salida deseada: se pide
  reintroducir el token en vez de destruirlo.

**Límite residual, documentado** (`docs/security.md`, sección «How ciphertexts
are versioned»): una fila CBC cuya clave **no** está en el anillo ya es
ilegible, y no queda nada con qué contrastar un candidato. Una de cada varios
cientos de miles (relleno *y* UTF-8 por azar; mucho más raro cuanto más largo el
token) todavía se devuelve como basura. Mantener la clave retirada en
`ENCRYPTION_KEY_PREVIOUS` hasta que el script dé una pasada limpia es lo que
mantiene ese caso fuera de alcance.

### 2. Hallazgo 3 — paginación del script

- `reencryptTable` pagina hasta recibir una página **vacía** y avanza el offset
  por `data.length`, no por `batchSize`. Lo segundo importa tanto como lo
  primero: con `batchSize` mayor que `db-max-rows`, avanzar por `batchSize`
  tras una página recortada **se salta** las filas que el servidor retuvo.
- `MAX_PAGE_ROWS = 1000` exportado; `reencryptTable` rechaza cualquier
  `batchSize` que no sea entero en 1…1000, y `--batch-size` lo rechaza en la CLI
  con mensaje explícito (`PostgREST's db-max-rows truncates larger pages`).
- Runbook de `docs/security.md` actualizado con el porqué del tope.

### 3. Hallazgo 2 — el formato es de ida y no de vuelta

Nueva sección «The new format is one-way» en `docs/security.md`: las filas se
convierten con el tráfico normal (un envío, una re-verificación del webhook) sin
que nadie rote nada; un build anterior no lee el formato de cuatro partes; el
rollback deja esas cuentas en `token_corrupted` y hay que reintroducir el
secreto; no hay script de bajada; si el rollback es parte del plan, respaldar
`whatsapp_config`, `ai_configs` y `webhook_endpoints` antes de desplegar. Aviso
equivalente en `CHANGELOG.md` (Unreleased) y en la cabecera de
`encryption.ts`.

### 4. Hallazgo 5 — `allowImportingTsExtensions` en la raíz

Decisión del líder: se **acepta** el flag en el `tsconfig.json` raíz (la fase 3
ya lo introdujo y su reviewer lo aprobó; acotarlo aquí crearía divergencia entre
ramas). No se crea `scripts/tsconfig.json` y `tsconfig.json` no se toca en este
commit. La justificación queda escrita en `docs/security.md` («Why
`allowImportingTsExtensions` is on in the root `tsconfig.json`»): el repo
compila como un proyecto con `noEmit: true`, así que el riesgo habitual —emitir
un import a una ruta `.ts` que ningún runtime resuelve— no puede darse; el flag
existe para los scripts que ejecuta Node 24 directamente; el código de `src/`
sigue importando por `@/…` sin extensión y eso lo hace cumplir la revisión, no
el compilador. También en el cuerpo del commit.

### 5. Hallazgo 4 — variable de entorno

`ENCRYPTION_KEY_PREVIOUS` añadida a `docs/docker.md` (lista de variables de
runtime, con formato, ciclo de vida y aviso de no dejarla puesta
indefinidamente).

**Pendiente para el humano:** `.env.local.example` está bloqueado por permisos
(`.claude/settings.json`) y no se ha tocado. Falta añadir ahí, junto a
`ENCRYPTION_KEY`:

```dotenv
# Retired encryption keys, comma-separated, 64 hex chars each. Leave
# empty unless you are rotating ENCRYPTION_KEY (see docs/security.md).
ENCRYPTION_KEY_PREVIOUS=
```

### 6. Hallazgo 6 — tests intermitentes y este informe

Las fijaciones CBC del test ya no usan `crypto.randomBytes`: `cbcEncryptLegacy`
deriva el IV de `sha256(clave|texto)`. Con IV aleatorio, «la clave equivocada
rechaza este blob» solo era cierto el ~99,6 % de las veces, que es justo como se
consigue una suite que falla una vez cada varios cientos de ejecuciones en CI.
Este informe cubre el CP9 que faltaba.

## Trazabilidad criterio ↔ test

Criterios del spec (§3). Los cuatro estaban cubiertos por `dd39c90`; se listan
los tests vigentes tras la corrección.

| Criterio | Test |
| --- | --- |
| C1 Con dos claves configuradas se descifra lo escrito con cualquiera | `src/lib/whatsapp/encryption.test.ts` › "decrypts versioned ciphertexts written under the current OR the previous key"; "accepts several previous keys, comma-separated, and ignores blanks" |
| C2 Lo nuevo se cifra siempre con la vigente | `encryption.test.ts` › "encrypt() always uses the current key, never a previous one"; "produces a key id plus three colon-separated GCM parts" |
| C3 Lo antiguo sin prefijo se sigue descifrando | `encryption.test.ts` › "decrypts an unversioned GCM blob produced before key ids existed"; "decrypts a CBC blob produced by the original codepath"; "tries every key in the ring for unprefixed GCM and CBC blobs" |
| C4 Procedimiento de recifrado ejecutable y documentado | `src/lib/whatsapp/reencrypt.test.ts` (11 tests) + runbook de `docs/security.md`; CLI ejecutada a mano (abajo) |

Cambios requeridos por la revisión:

| Cambio requerido | Test / evidencia |
| --- | --- |
| 1. CBC no acepta en silencio un candidato de clave equivocada | `encryption.test.ts` › "returns the retired key’s plaintext, not the garbage the current key happens to unpad" — **determinista**: fijación real bajo la clave retirada cuyo relleno PKCS#7 *también* valida con la vigente (el test lo afirma explícitamente con `rawCbcDecrypt`), y `decrypt` devuelve el token verdadero |
| 1b. Dos aciertos ⇒ fallo, no «el primero» | `encryption.test.ts` › "refuses to pick a plaintext when two keys in the ring both succeed" — **determinista**: blob construido que descifra a texto UTF-8 bien rellenado con **las dos** claves; con una sola clave se documenta el límite conocido, con las dos `decrypt` lanza `/more than one configured key/` nombrando ambas huellas |
| 1c. UTF-8 estricto | `encryption.test.ts` › "treats non-UTF-8 plaintext as “not this key”, never as a result" |
| 1d. Ningún reescrito escribe si el descifrado no fue inequívoco | `reencrypt.test.ts` › "leaves a row alone when its value decrypts under two keys at once" (`failed 1`, `updates` vacío, log con el motivo); `send-message.ts` y el webhook revisados arriba |
| 2. Paginar hasta página vacía | `reencrypt.test.ts` › "keeps paging through pages the server truncated, and skips nothing" — `fakeDb` con `maxRows: 2` y `batchSize: 5`: 5 filas, 5 recifradas, ninguna saltada |
| 2b. Rechazar `--batch-size` > 1000 | `reencrypt.test.ts` › "rejects a batch size PostgREST would truncate"; CLI comprobada a mano |
| 3. Documentar la irreversibilidad | `docs/security.md` «The new format is one-way» + nota en `CHANGELOG.md` |
| 4. `ENCRYPTION_KEY_PREVIOUS` documentada | `docs/docker.md`; `.env.local.example` pendiente (bloqueado) |
| 5. Justificar el flag del tsconfig | `docs/security.md` + cuerpo del commit |
| 6. Informe | este archivo |

Los tres tests nuevos de `encryption.test.ts` y los dos de paginación se
comprobaron **rojos** contra el código de `HEAD` antes del arreglo (sustituyendo
solo el módulo correspondiente por su versión previa) y verdes después.

## Verificaciones contra base real

No procede: la feature no toca `supabase/` ni depende de RLS, concurrencia o
RPC. No hay `progress/checks_versioned-encryption.sql`. `replay-migrations.sh`
no aplica (sin SQL).

Comprobaciones fuera de la suite, ejecutadas en este entorno (Node 24.21.0):

```
node scripts/reencrypt-secrets.ts --help                  → exit 0, usage con «N = 1…1000»
… --batch-size 2000                                       → exit 1, «--batch-size cannot exceed 1000»
… --batch-size 1000 (sin NEXT_PUBLIC_SUPABASE_URL)         → exit 1, «NEXT_PUBLIC_SUPABASE_URL is not set»
```

## Verificación manual pendiente

Una rotación de verdad necesita un proyecto Supabase con filas cifradas; no se
puede hacer en CI y no debe hacerse contra producción sin ventana. Guion, sobre
un proyecto de staging con al menos una fila en `whatsapp_config`:

```bash
# 0. Estado de partida: una fila legible.
export NEXT_PUBLIC_SUPABASE_URL='https://<staging>.supabase.co'
export SUPABASE_SERVICE_ROLE_KEY='<service-role>'
export ENCRYPTION_KEY='<la clave actual>'
node scripts/reencrypt-secrets.ts --dry-run     # 0 a reescribir si ya está al día

# 1. Rotar: la vieja pasa a PREVIOUS, la nueva a ENCRYPTION_KEY. Reiniciar la app.
export ENCRYPTION_KEY_PREVIOUS="$ENCRYPTION_KEY"
export ENCRYPTION_KEY="$(openssl rand -hex 32)"

# 2. La app sigue leyendo: GET /api/whatsapp/config responde connected:true
#    (no token_corrupted) y un envío desde la bandeja llega al teléfono.

# 3. Informe y recifrado.
node scripts/reencrypt-secrets.ts --dry-run     # N filas «would rewrite»
node scripts/reencrypt-secrets.ts               # N reescritas, failed 0, exit 0
node scripts/reencrypt-secrets.ts               # segunda pasada: 0 reescritas, todo «up to date»

# 4. Retirar la clave vieja y reiniciar; repetir el paso 2.
unset ENCRYPTION_KEY_PREVIOUS
```

Criterio de aceptación manual: en el paso 3 la segunda pasada no reescribe nada
y `failed` es 0 en las tres tablas; en el paso 4 la app sigue conectada con la
clave vieja fuera del anillo. Para probar el tope de página hace falta una tabla
con más de 1000 filas: con `--batch-size 1000` sobre 1500 filas el script debe
reportar `scanned 1500`, no 1000.

## Decisiones donde el spec o la revisión dejaban margen

- **Fallo cerrado ante ambigüedad.** El spec no dice qué hacer si dos claves
  descifran el mismo criptograma. Se elige `Error` (que la UI traduce a
  `token_corrupted`, recuperable reintroduciendo el secreto) antes que devolver
  un candidato: el coste de equivocarse es destruir el único ejemplar del token.
  El precio es que, durante una rotación, una fila CBC podría volverse ilegible
  por colisión; la probabilidad es del orden de 1e-11 para un token real y el
  fallo es recuperable, mientras que la sobrescritura no lo es.
- **UTF-8 estricto también en GCM.** No hace falta criptográficamente (el tag ya
  autentica), pero mantiene una sola definición de «texto claro válido» y no
  puede rechazar nada que `encrypt()` haya escrito: la entrada se codifica como
  UTF-8 al cifrar.
- **Tope de lote rechazado, no recortado.** Recortar en silencio a 1000 dejaría
  al operador creyendo que pidió páginas de 2000; el runbook condiciona retirar
  la clave vieja a esa salida.
- **`tryEachKey` recorre el anillo entero** aunque ya haya acertado. Son unas
  pocas operaciones AES por lectura, en un anillo de dos o tres claves, y es lo
  que permite detectar la colisión.

## Variables de entorno

Ninguna nueva en esta corrección. `ENCRYPTION_KEY_PREVIOUS` (ya introducida por
`dd39c90`) queda documentada en `docs/security.md` y `docs/docker.md`; falta
`.env.local.example`, bloqueado por permisos (ver punto 5).

## Deuda detectada fuera de alcance (no arreglada)

- `src/lib/whatsapp/send-message.ts:274` — si `decrypt` lanza, sale un `Error`
  pelado, no un `SendMessageError`, así que la API responde 500 en vez de un
  código de dominio como `token_corrupted`. Es anterior a esta feature (el
  descifrado ya podía fallar por clave equivocada) y tocarlo implica revisar el
  mapeo de errores de la ruta pública.
- `src/lib/whatsapp/send-message.test.ts` y
  `src/app/api/whatsapp/webhook/route.test.ts` simulan el módulo de cifrado
  entero (`isLegacyFormat: () => false`), así que sus reescritos oportunistas no
  se ejercitan de verdad en la suite. La garantía se prueba donde el código es
  real (`reencrypt.test.ts`); un test de integración del camino de envío con el
  cifrado sin simular sería mejor y es transversal a varios archivos.
- El script recifra con el rol de servicio y **sin** `account_id` (CP3): es
  correcto para una herramienta de mantenimiento que por definición cruza
  cuentas y no es alcanzable por HTTP, pero conviene que siga sin importarse
  desde `src/app`.
- 37 warnings de ESLint preexistentes en el repo; ninguno en los archivos
  tocados.

## Compuerta

Ejecutada en el worktree, con el árbol tal cual se commiteó:

- `npm run lint` — verde (0 errores, 37 warnings preexistentes).
- `npm run typecheck` — verde.
- `TZ=UTC npm test` — verde: **85 archivos, 951 tests** (945 en `8413526`; los
  6 nuevos son 3 en `encryption.test.ts` y 3 en `reencrypt.test.ts`).
- `npm run build` con las variables dummy de `docs/harness.md` — verde.
- `npx prettier --check` sobre los ocho archivos tocados — verde.
- `scripts/replay-migrations.sh` — n/a, sin SQL.

## Tercera ronda — `66d7733` (BOM inicial)

Único cambio requerido de `progress/review_versioned-encryption.md`: `toUtf8`
pasa a `new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })`
(`src/lib/whatsapp/encryption.ts:181`), que valida sin comerse un U+FEFF de
cabecera, más dos tests en el bloque «encrypt / decrypt round-trip» de
`src/lib/whatsapp/encryption.test.ts` — › "roundtrips a leading U+FEFF instead
of swallowing it" (camino versionado GCM, y U+FEFF en medio como control) y ›
"keeps a leading U+FEFF on a legacy CBC blob read through the key ring" (CBC
heredado bajo `ENCRYPTION_KEY_PREVIOUS`). Comprobado que ambos **fallan** al
quitar la bandera y pasan con ella; nada más tocado (dos archivos, +24/-1).
Compuerta verde en el worktree sobre `66d7733`: lint 0 errores / 37 warnings
preexistentes, typecheck, `TZ=UTC npm test` 85 archivos y **957 tests** (951 →
957: +2 míos y +4 de las features de fase 2 que aterrizaron entre medias),
`npm run build` con las dummies de `docs/harness.md`, prettier sin cambios;
`replay-migrations` n/a, sin SQL. Sin CHANGELOG nuevo: corrige una línea de
`0997adf`, aún sin publicar, ya descrita en Unreleased. Atribución del commit:
el harness impone `Co-Authored-By: Claude Opus 5 (1M context)`, no el
`Claude Fable 5.1` de los tres commits anteriores de la rama; la configuración
manda sobre la instrucción de la tarea, se anota por si el revisor lo cuenta
en CP10.
