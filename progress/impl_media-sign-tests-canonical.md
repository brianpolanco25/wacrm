# impl m14.4 media-sign-tests-canonical

## Plan
1. Localizar los dos tests rojos y los vectores que m14.3 rechaza con 400.
2. Separar vectores canónicos (exigen 403) de no canónicos (aceptan 400|403), con aserción de "nada firmado" en todos.
3. Compuerta completa en el worktree; commit en la rama.

## Rama y commits
- Rama `fix/media-sign-tests-canonical` (desde `main @ a4726df`).
- `aa6a8d0` fix: tests de /api/media/sign aceptan el 400 de ruta no canónica (m14.4)

## Cambios (solo `*.test.ts`)
- `src/app/api/media/sign/route.test.ts`: el `it` «403s an object of another account — including the operator's own company in a support session» queda solo con rutas canónicas (`account-OWN`, `account-other`, `account-TARGETx`, legado `<uid>/`) y sigue exigiendo `403`. Nuevo `it` «rejects non-canonical paths (traversal, encoded, backslash) before ownership, signing nothing» con `%2F..%2F` + `TRAVERSALS`: `expect([400, 403]).toContain(status)`. En ambos: el cuerpo no contiene `token=` y `h.signs` vacío (no se llamó a `createSignedUrl`).
- `src/lib/security/tenant-isolation.test.ts`, «no path form under A's folder reaches B's objects through the service role»: los vectores (todos no canónicos) aceptan `400|403`; se conservan `not.toContain('account-B')` en el cuerpo y `storageCalls` vacío (ninguna llamada a Storage con rol de servicio), más el control positivo 200 de A. La ruta canónica de B (403) ya la cubre «outside a support session, an actor from A cannot sign B's objects» y el `it` canónico de route.test.ts.

## Criterio ↔ test
| Criterio | Test |
|---|---|
| A1 canónica de otra cuenta = 403, nada firmado | route.test.ts › «403s an object of another account — including the operator's own company in a support session» |
| A1 no canónicos = 400 (o 403), nada firmado | route.test.ts › «rejects non-canonical paths (traversal, encoded, backslash) before ownership, signing nothing»; tenant-isolation.test.ts › «no path form under A's folder reaches B's objects through the service role» |
| A1 sin tocar src/ fuera de *.test.ts | `git show --stat aa6a8d0`: solo los dos `*.test.ts` |
| A2 compuerta | lint (0 errores; 34 warnings preexistentes, ninguno en los archivos tocados), typecheck, `TZ=UTC npm test` 366 archivos / 5709 tests verdes, build OK |

## Verificaciones contra base real / manuales
Ninguna: sin SQL, sin servicios externos.

## Decisiones
- `[400, 403]` en vez de `400` estricto para los no canónicos, como pedía el líder: el test no depende de qué capa rechaza, sí de que se rechaza y no se firma.
- CHANGELOG sin entrada: cambio solo de tests, no visible para el usuario (el formato del archivo es de cambios visibles).

## Variables de entorno nuevas
Ninguna.

## Deuda fuera de alcance
Ninguna detectada.
