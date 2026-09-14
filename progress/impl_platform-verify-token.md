# f2.4 — platform-verify-token

Rama `saas/fase-2-seguridad`, worktree
`.claude/worktrees/agent-a4220e4b5ba8896fd`. Spec: `docs/saas/fase-2-seguridad.md` §4.

Este informe cubre **las dos entregas**: el commit original (que nunca tuvo informe)
y la corrección de los cuatro cambios requeridos en
`progress/review_platform-verify-token.md`.

## Commits

| Commit | Qué |
|---|---|
| `31f10ea` | `feat: camino corto de verificación del webhook con token de plataforma` — la implementación original. |
| `74834d7` | `fix: recorta el token de plataforma del webhook y avisa en el 403` — los cuatro cambios requeridos. |

Base de la corrección: `0997adf` (f2.3). Nada pusheado.

## Entrega original (`31f10ea`)

El `GET` de verificación recorría **todas** las filas de `whatsapp_config`
descifrando cada `verify_token` hasta dar con el que coincidía: trabajo
criptográfico proporcional al número de inquilinos en cada suscripción de Meta.

Con `META_WEBHOOK_VERIFY_TOKEN` definida, el `GET` compara contra ella en tiempo
constante y **no consulta la tabla**; sin ella (autoalojado) el bucle queda
idéntico. Archivos: `src/app/api/whatsapp/webhook/route.ts` (+33),
`src/app/api/whatsapp/webhook/route.test.ts` (+112/−20), `docs/security.md`,
`CHANGELOG.md`.

Núcleo, en `route.ts` (helper nuevo + camino corto en el `GET`):

```ts
function verifyTokensMatch(supplied: string, expected: string): boolean {
  const a = Buffer.from(supplied)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}
```

(el chequeo de longitud va delante porque `timingSafeEqual` lanza con longitudes
distintas; la longitud en sí no es sensible).

## Corrección (`74834d7`) — diff real

### 1. `route.ts` — `.trim()` + `console.warn` en el 403

```diff
@@ -131,7 +131,13 @@ export async function GET(request: Request) {
-    const platformToken = process.env.META_WEBHOOK_VERIFY_TOKEN
+    // Trimmed because the value arrives from a secret file, a K8s
+    // ConfigMap or a hand-edited `.env` line as often as from a shell
+    // export, and a trailing newline or space would otherwise be
+    // truthy: the short path would activate and never match, so every
+    // subscribe would 403. Whitespace-only counts as unset, same as the
+    // empty string.
+    const platformToken = process.env.META_WEBHOOK_VERIFY_TOKEN?.trim()
     if (platformToken) {
       if (verifyTokensMatch(verifyToken, platformToken)) {
@@ -139,6 +145,13 @@ export async function GET(request: Request) {
         })
       }
+      // Names neither the supplied nor the expected token on purpose —
+      // both are credentials, and the operator only needs to know that
+      // the platform path rejected a subscribe (usually a stale value
+      // in the Meta app's webhook settings).
+      console.warn(
+        '[webhook] verify token mismatch against META_WEBHOOK_VERIFY_TOKEN'
+      )
       return NextResponse.json(
         { error: 'Verification token mismatch' },
         { status: 403 }
```

El mensaje es una constante literal: no interpola nada, así que no puede filtrar
ni el token suplido ni el esperado por mucho que cambie el entorno.

### 2. `route.test.ts` — la variable ambiental deja de decidir el resultado

En el `beforeEach`, justo después de `vi.unstubAllEnvs()`:

```ts
  // `unstubAllEnvs` only undoes previous `stubEnv` calls; it does not
  // clear a variable exported in the developer's shell. …
  vi.stubEnv('META_WEBHOOK_VERIFY_TOKEN', '')
```

Y tres tests nuevos al final del `describe` del camino corto (espacio en blanco
alrededor, solo-espacios, y el `console.warn` sin eco).

### 3. Documentación

- `docs/docker.md`: `META_WEBHOOK_VERIFY_TOKEN` añadida a la enumeración de
  variables de **runtime** y con viñeta propia (para qué sirve, cuándo dejarla
  sin definir, que se recorta).
- `docs/security.md`: la promesa «an empty value counts as unset» ahora dice
  también que el valor se recorta y que un desajuste registra un `console.warn`
  sin los tokens.
- `CHANGELOG.md`: se extiende la línea existente de la sección `Unreleased`
  (la entrada original aún no está publicada, así que no procede una de `Fixed`).

## Trazabilidad criterio ↔ test

Todos en `src/app/api/whatsapp/webhook/route.test.ts`, `describe('webhook GET
verification: platform token short path')`.

| Criterio | Test (`it`) |
|---|---|
| C1 — con el token de plataforma, la verificación no consulta la tabla | `with META_WEBHOOK_VERIFY_TOKEN set, a matching token echoes the challenge without touching whatsapp_config` |
| C1 (aislamiento) — un token de inquilino deja de ser credencial en modo plataforma | `with META_WEBHOOK_VERIFY_TOKEN set, a tenant token that only exists in whatsapp_config is refused` |
| C2 — sin la variable, el comportamiento actual intacto (acierto) | `without META_WEBHOOK_VERIFY_TOKEN, the per-tenant loop is intact: a config token matches` |
| C2 — sin la variable, token desconocido → 403 tras consultar | `without META_WEBHOOK_VERIFY_TOKEN, an unknown token is a 403 after consulting the table` |
| C2 — cadena vacía = no definida | `an empty META_WEBHOOK_VERIFY_TOKEN counts as unset` |
| Corrección 2 — espacio/salto de línea alrededor no forma parte del token | `surrounding whitespace in META_WEBHOOK_VERIFY_TOKEN is trimmed, not part of the token` |
| Corrección 2 — solo-espacios = no definida | `a whitespace-only META_WEBHOOK_VERIFY_TOKEN counts as unset` |
| Corrección 2 — el 403 avisa sin filtrar credenciales | `the 403 of the platform path warns without echoing either token` |
| Comparación en tiempo constante | sin test posible en vitest; por lectura, `route.ts:106-110` |

**Los tres tests nuevos son rojos contra el código anterior.** Comprobado
revirtiendo solo `route.ts` (`git checkout --`) y corriendo el archivo:
`3 failed | 20 passed`. Con el arreglo: `23 passed`.

**Independencia del entorno** (hallazgo 1 del revisor), el comando que pidió:

```
META_WEBHOOK_VERIFY_TOKEN=platform-secret TZ=UTC npx vitest run \
  src/app/api/whatsapp/webhook/route.test.ts
→ Test Files 1 passed (1) · Tests 23 passed (23)
```

Antes de la corrección ese mismo comando daba `2 failed | 18 passed`.

## Compuerta (en el worktree, sobre `74834d7`)

- `npm run lint`: verde — 0 errores, 37 warnings preexistentes, ninguno en lo tocado.
- `npm run typecheck`: verde.
- `TZ=UTC npm test`: verde — 85 archivos, 954 tests.
- `npm run build` (con las variables dummy de `ci.yml`): salida 0.
- `scripts/replay-migrations.sh`: **no procede**, el cambio no toca `supabase/`.
  Por lo mismo no hay `progress/checks_platform-verify-token.sql`.

## Verificaciones contra base real

Ninguna aplica: el camino corto no consulta la base. Los tests del modo
autoalojado ejercitan el bucle contra el mock de `whatsapp_config` del propio
archivo, que ya existía.

## Verificación manual pendiente (servicio externo: Meta)

Lo único que no se puede automatizar es que Meta acepte la suscripción. Guion,
en un despliegue con la variable puesta:

1. `META_WEBHOOK_VERIFY_TOKEN=<cadena aleatoria>` en el entorno del contenedor;
   reiniciar (es runtime, no build).
2. En la app de Meta → WhatsApp → Configuration → Edit webhook: URL
   `https://<host>/api/whatsapp/webhook`, «Verify token» = la misma cadena.
   Guardar → Meta debe aceptar a la primera.
3. Repetir con un token distinto en la casilla de Meta: debe fallar, y en los
   logs del contenedor aparece
   `[webhook] verify token mismatch against META_WEBHOOK_VERIFY_TOKEN`
   **sin** ninguno de los dos valores.
4. Con la variable puesta y un espacio final (`"<cadena> "`), repetir el paso 2:
   debe seguir aceptando — es el caso que arregla `74834d7` y que antes
   403-eaba en silencio.
5. Confirmar que el `POST` de entrantes sigue llegando (mandar un mensaje al
   número): el camino corto no toca la ingesta.

## Decisiones donde el spec era ambiguo

- **Sin respaldo al bucle en modo plataforma.** Con la variable puesta, un token
  de inquilino no vale aunque exista en la tabla. Es deliberado: si el bucle
  siguiera como respaldo, cualquier `verify_token` de cualquier fila validaría la
  URL compartida y el camino corto no cerraría nada. Documentado en
  `docs/security.md`.
- **Solo-espacios = no definida.** El spec no lo contempla; `docs/security.md` ya
  prometía que el vacío cuenta como no definido y `.trim()` extiende la promesa
  a lo que es indistinguible de vacío para un humano.
- **Nivel de log `warn`, no `error`.** Un desajuste es configuración del
  operador, no un fallo del sistema; el `console.error` del camino largo se
  reserva para el fallo de consulta.
- **CHANGELOG**: se amplía la línea existente en vez de abrir una de `Fixed`,
  porque la entrada original sigue sin publicar.

## Variables de entorno

`META_WEBHOOK_VERIFY_TOKEN` — nueva, **opcional**, runtime. Cadena aleatoria,
la misma que se teclea en la configuración del webhook de la app de Meta. Sin
definir = modo autoalojado. Documentada en `docs/security.md` y `docs/docker.md`.

**Pendiente para el humano:** `.env.local.example` está bloqueado por permisos
(`.claude/settings.json`) y no lo he tocado. Le falta `META_WEBHOOK_VERIFY_TOKEN`
en el bloque `OPTIONAL`, comentada, con una línea explicando que es solo para
despliegues de plataforma. Es el mismo pendiente que dejó f2.3 con
`ENCRYPTION_KEY_PREVIOUS`: convendría cerrarlos juntos.

## Deuda detectada fuera de alcance (no la he arreglado)

1. **`route.ts` y `route.test.ts` no cumplen `.prettierrc`.** Ambos archivos
   fallan `npx prettier --check` **ya en `HEAD~1`**, antes de mi cambio: el repo
   configura `"semi": true` y estos dos archivos están escritos sin punto y
   coma. Correr `prettier --write` sobre ellos genera ~600 líneas de diff
   ajenas al arreglo, así que he seguido el estilo del código circundante y no
   he reformateado. Reformatearlos merece un commit `chore:` propio (y quizá
   una revisión de cuántos archivos más están en la misma situación —
   `npm run format` no está en la compuerta de CI).
2. **`supabaseAdmin().from('whatsapp_config').select('id, verify_token')`**
   (`route.ts:149`, camino largo) sigue sin filtro de cuenta. Es global por
   diseño —busca a qué fila corresponde el token— y es anterior a f2.4;
   territorio de f2.2. Lo apunta también el revisor en CP3.
3. **El token viaja en el query string** del `GET` de Meta, así que los logs de
   acceso del proxy o de la plataforma lo capturan. Es inherente al protocolo
   de Meta, no algo que la app pueda evitar; conviene que el runbook de
   despliegue lo tenga presente al configurar la retención de logs.
