@AGENTS.md

<!-- El import de arriba carga AGENTS.md, que lo GENERA una herramienta
     (bloque BEGIN/END:nextjs-agent-rules). No escribas ahí: se sobrescribe.
     El contenido propio del proyecto va aquí abajo. -->

## Qué es esto

CRM con Next.js App Router y Supabase. Versión 0.8.0.

**Stack**: **Node 24 LTS** ("Krypton"), Next 16.2.12, React 19.2.4, TypeScript 6,
Tailwind 4, Supabase (Postgres + migraciones), vitest 4, ESLint 9. Gestor:
**npm** (npm@10.9.9, declarado en `packageManager` — no uses pnpm ni yarn).

La versión de Node está fijada en cuatro sitios y se mueven juntos: `.nvmrc`,
`engines` de `package.json`, las tres etapas del `Dockerfile` y `node-version`
en `ci.yml`. `mcp-server/package.json` queda aparte en `>=20.0.0` a propósito:
es un paquete con `bin`, lo instala gente de fuera, y subirle el mínimo les
cerraría la puerta a quienes están en Node 20 o 22.

**Estructura**: `src/app` (App Router), `src/lib` (lógica y utilidades),
`src/components`, `src/hooks`, `src/i18n` + `messages/` (traducciones),
`supabase/migrations`, `mcp-server/` (servidor MCP propio).

## Comandos que SÍ funcionan

```bash
npm run dev          # servidor de desarrollo
npm run lint         # eslint
npm run typecheck    # tsc --noEmit
npm test             # vitest run
npm run test:watch   # vitest en watch
npm run build        # next build
npm run format       # prettier --write .
```

**La compuerta real es CI** (`.github/workflows/ci.yml`), que corre en este
orden: `npm ci` → `lint` → `typecheck` → `test` → `build`. Si los cuatro pasan
en local, el PR pasa. Está atajado en `/check`.

**Tests**: vitest, colocados junto al código (`src/**/*.test.ts`, 79 archivos).
No hay e2e ni Playwright: no lo propongas como si existiera.

## Trampas conocidas

- **Next 16 y React 19 son posteriores al corte de entrenamiento del modelo.**
  Las APIs, convenciones y estructura de archivos cambiaron. La documentación
  real está en `node_modules/next/dist/docs/`: léela antes de escribir código
  de framework, en vez de confiar en la memoria. Es lo que advierte AGENTS.md,
  y es la causa más probable de código que "parece bien" y no compila.
- **Migraciones: siempre `--local`.** CI las valida contra una base limpia
  (`supabase db reset --local --no-seed` + `supabase/ci/verify-schema.sql`).
  Cualquier comando de supabase contra un proyecto remoto se pregunta primero.
- **Secretos**: `.env.local` es real y está fuera de límites (bloqueado en
  `.claude/settings.json`). La plantilla pública es `.env.local.example`.

## Convenciones

- **Rama por defecto**: `main`. No commitear directo: rama + PR.
- **Commits**: hay `CHANGELOG.md`; revisa `CONTRIBUTING.md` antes de fijar el
  formato del mensaje.
- **Formato**: lo impone prettier (`.prettierrc`) — no discutas estilo a mano.

## Alcance

- **Pregunta antes de**: instalar dependencias, tocar migraciones, hacer push,
  abrir PRs, construir o publicar imágenes.

## Harness de agentes

El trabajo por fases lo reparten los agentes de `.claude/agents/` (`leader` en Fable;
`implementer`, `reviewer` y `spec_author` en Opus). Estado en `feature_list.json` y
`progress/`; checklist del revisor en `CHECKPOINTS.md`; flujo, ramas y compuerta en
`docs/harness.md`. Las migraciones se validan en local con
`scripts/replay-migrations.sh <ruta>` (Docker, sin CLI de Supabase).

## graphify — cómo se navega este repo

Hay un grafo de conocimiento del código en `graphify-out/` (2.308 nodos, 6.513
aristas, 434 archivos). Es la primera parada para orientarse, antes de `grep` o
de abrir archivos a ciegas.

```bash
graphify query "cómo se autentica una request"   # subgrafo acotado (BFS)
graphify query "..." --dfs                        # seguir una cadena concreta
graphify path "webhook" "supabaseAdmin"           # ruta más corta entre dos cosas
graphify explain "checkRateLimit"                 # un nodo y sus vecinos
graphify affected "createClient"                  # qué se rompe si tocas esto
```

**Corre gratis y así se queda.** La extracción es AST determinista: sin API key,
sin llamadas a ningún modelo (`Token cost: 0` en `GRAPH_REPORT.md`). Lo único
que gastaría LLM es nombrar comunidades (`graphify label`, o `cluster-only` sin
`--no-label`) — por eso el reporte las lista como `Community N` y así se queda.
Reconstruir siempre con `--code-only` y `--no-label`.

**Qué cubre y qué no.** Solo código: 434 archivos de `src/`, `mcp-server/`,
`supabase/` y los manifiestos de raíz (`.ts`, `.tsx`, `.mjs`, `.sql`, y los
`package.json`/`tsconfig.json` de donde salen las aristas de dependencia). Fuera
quedan `node_modules`, `.next`, `build`, `coverage`, `public/`, `messages/` y los
`.md`. El alcance lo fija `.graphifyignore`, no una bandera de línea de comandos,
y esa distinción importa: `graphify update` —el comando que corre el hook en cada
commit— no acepta `--code-only`, así que sin ese archivo reintroduciría la
documentación en cada rebuild. Si hay que excluir algo más, va ahí.

**Las migraciones sí están, pero dependen de un parser aparte.** `supabase/`
aporta 152 nodos: tablas, vistas, funciones y las relaciones de clave foránea
entre ellas (`graphify explain "broadcast_recipients"` devuelve sus FKs). Eso
requiere `tree-sitter-sql` instalado en el venv de graphify; **sin él el
extractor de SQL falla en silencio** —devuelve cero nodos por archivo, sin
warning— y te queda un grafo que parece completo pero no tiene el esquema. Si
`graphify explain "contacts"` no encuentra el nodo, es esto:

```bash
uv pip install --python "$(cat graphify-out/.graphify_python)" tree-sitter-sql
```

Con una limitación que conviene tener presente: **el esquema es una isla**. Sus
152 nodos tienen 153 aristas entre ellos y **cero** hacia el código TS — el
extractor no ata un `.from('messages')` de TypeScript con la tabla `messages`.
O sea: sirve para recorrer el esquema (FKs, qué tabla depende de cuál), no para
ir de una ruta de API a su tabla. Para eso, grep.

**Actualizar el grafo al cerrar un feature.** Es automático: `graphify hook
install` dejó hooks de git `post-commit` y `post-checkout` que reextraen solo lo
que cambió, en segundo plano (log en `~/.cache/graphify-rebuild.log`). `/check`
además corre `graphify update .` cuando pasa la compuerta, para que el grafo
refleje el trabajo antes del commit. A mano: `graphify update .`.

**Comunidades.** El reporte agrupa los nodos en ~137 comunidades: son clusters
detectados con Louvain sobre la topología del grafo —qué importa a qué, qué
llama a qué— no carpetas. Suelen coincidir con una vertical del producto
(`src/lib/api` + `src/app/api` + `src/lib/api-keys` caen juntos). Sirven para
ver el acoplamiento real: si tu cambio toca dos comunidades, estás cruzando un
límite. Salen numeradas y no nombradas porque ponerles nombre es lo único que
gastaría LLM; los números **cambian entre reconstrucciones**, así que no los
cites en un PR ni los guardes en la doc.

`graphify-out/` está gitignoreado — es derivado. En un clon nuevo:

```bash
uv tool install --with tree-sitter-sql graphifyy   # sin esto no entra el esquema
graphify extract . --code-only && graphify cluster-only . --no-label
graphify hook install
```

Ojo con dos cosas al reconstruir: `extract` es incremental y se guía por
`graphify-out/manifest.json`, así que tras cambiar el alcance o instalar un
parser nuevo hay que borrar `graphify-out/` entero para que re-extraiga; y
`--no-cluster` deja `graph.json` en 0 nodos, no lo uses suelto.
