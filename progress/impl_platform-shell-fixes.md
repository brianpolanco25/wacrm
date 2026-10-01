# impl s9.11 `platform-shell-fixes`

## Plan
1. `platform-overview.tsx`: envolver la tabla de datos del gráfico semanal en `<div className="sr-only">`, quitar `sr-only` del `<table>`; buscar el patrón en `platform/` y `billing/`.
2. Test en `platform-overview.test.tsx`: ningún `<table>` con `sr-only`; el wrapper sí.
3. `mode-toggle.tsx`: `mounted` con `useSyncExternalStore`; antes de montar, botón determinista (Sun, `aria-label` genérico «Cambiar modo»); tras montar, el real. Vista pura exportada para testear el estado montado sin DOM (vitest corre en `node`).
4. `mode-toggle.test.tsx`: primer render idéntico en dark y light; montado en dark → Moon + «light».
5. Clave i18n nueva `ModeToggle.toggle` en es/en. CHANGELOG. Compuerta.

## Estado: done (pendiente de reviewer)

- Rama `platform/shell-fixes` (worktree `.claude/worktrees/shell-fixes`), base `feat/superadmin` @ f1b8cee.
- Commit: `dc74009` fix: scroll de /platform y hydration mismatch del ModeToggle (s9.11).

## Cambios
- `src/components/platform/platform-overview.tsx`: la tabla de datos del gráfico semanal va dentro de `<div className="sr-only">`; el `<table>` ya no lleva la clase. Grep de `<table className="sr-only"` / `Table className="sr-only"` en `src/components/platform/` y `src/components/billing/`: era la única aparición.
- `src/components/layout/mode-toggle.tsx`: `useMounted()` = `useSyncExternalStore(noop, () => true, () => false)`. Se separa en `ModeToggle` (hooks) y `ModeToggleButton` (vista pura, exportada). Sin montar: Sol + `aria-label`/`title` genéricos `ModeToggle.toggle`; montado: icono y etiqueta reales. Mismas clases (40x40) en ambos estados. Sin `suppressHydrationWarning`.
- `messages/es.json` / `messages/en.json`: `ModeToggle.toggle` = «Cambiar modo» / «Toggle mode».
- `CHANGELOG.md` (Unreleased): sección «Platform console: shell fixes», una línea por arreglo.

## Criterio ↔ test
| Criterio | Test |
|---|---|
| El `<table>` no lleva `sr-only`, el wrapper sí | `src/components/platform/platform-overview.test.tsx` › «never puts sr-only on a <table> itself, only on its wrapper (s9.11)»; y «draws twelve weekly bars…» (ahora espera `<div class="sr-only"><table>`) |
| Primer render igual al del servidor, sin depender del modo | `src/components/layout/mode-toggle.test.tsx` › «renders the same HTML in dark and in light mode before mounting» (renderToString, compara HTML completo, etiqueta «Cambiar modo», Sol) |
| Etiqueta genérica traducida | «uses a generic, translated label in en too» |
| Tras montar en dark: Moon y «light» | «shows the moon and offers light in dark mode» |
| Tras montar en light: Sol y «dark» | «shows the sun and offers dark in light mode» |
| Mismo tamaño de botón antes/después | «keeps the same 40x40 button before and after mounting» |

## Decisiones
- vitest corre en `environment: "node"` sin jsdom (y no se añaden dependencias), así que el estado «montado» no se puede alcanzar renderizando `ModeToggle`: `renderToString` siempre usa el snapshot de servidor. Por eso se exporta la vista pura `ModeToggleButton` y el estado montado se testea con `mounted` explícito. El cambio real de `false`→`true` lo hace React tras hidratar (comportamiento documentado de `useSyncExternalStore`).
- `header.tsx` del CRM no cambia: usa `<ModeToggle />` con la misma firma. No tiene test propio; su comportamiento visible tras montar es idéntico al de antes (en el CRM la cabecera solo se pinta en cliente, ya montada salvo el primer frame).

## Compuerta
- `npm run lint`: 0 errores (34 warnings previos, ninguno en archivos tocados).
- `npm run typecheck`: OK.
- `TZ=UTC npm test`: 251 archivos, 3499 tests, verdes.
- `npm run build` con variables dummy: OK.
- Sin SQL: no aplica `replay-migrations.sh`.

## Verificación manual pendiente
1. `npm run dev`, abrir `/platform` en modo oscuro: la consola del navegador no muestra el aviso de hydration mismatch del botón de modo; el botón aparece (Sol) y pasa a Luna al hidratar.
2. En `/platform`, `document.documentElement.scrollHeight === innerHeight`: la página no hace scroll y el sidebar no se corta.

## Variables de entorno nuevas
Ninguna.

## Deuda fuera de alcance
- Al primer frame el botón muestra el Sol aunque el modo sea oscuro (parpadeo de icono de un frame, inevitable sin conocer el modo en servidor; resolverlo de raíz exigiría cookie de modo leída en servidor).

## Segunda ronda

Verificación en el navegador del coordinador: seguía habiendo 35 px de scroll. El wrapper `sr-only` (`position:absolute`) no tenía ancestro posicionado dentro del `<main>` (`overflow-y-auto`), así que su bloque contenedor era el documento: quedaba en top 699 px y alargaba `html` a 700 px con un viewport de 665.

- Commit `0fea446` fix: ancestro posicionado para la tabla sr-only de /platform (s9.11).
- `src/components/platform/platform-overview.tsx`: `relative` en el `<CardContent>` de la tarjeta `weekly`. Es el padre directo del wrapper, porque `WeeklyBars` devuelve un fragmento.
- `src/components/platform/platform-shell.tsx`: `relative` en el `<main className="relative flex-1 overflow-y-auto p-4 sm:p-6">` de `PlatformFrame`, como cinturón para cualquier `sr-only` futuro.
- `DashboardShell` del CRM (`src/app/(dashboard)/dashboard-shell.tsx:68`) tiene el mismo `<main className="flex-1 overflow-y-auto p-4 sm:p-6">` **sin** `relative`. No lo toqué porque está fuera de alcance y hoy no se observa el bug ahí. Un `sr-only` dentro de una página del CRM sin ancestro posicionado podría producir el mismo scroll fantasma. Lo dejo como deuda para decidir.

| Criterio | Test |
|---|---|
| El contenedor del gráfico lleva `relative` y contiene el wrapper `sr-only` | `platform-overview.test.tsx` › «never puts sr-only on a <table> itself, only on its wrapper (s9.11)» (aserción añadida sobre `data-slot="card-content"`) |
| El `<main>` de `PlatformFrame` está posicionado | `platform-shell.test.tsx` › «positions the scrolling <main>, so sr-only boxes stay inside it (s9.11)» |

Compuerta: lint con 0 errores (34 warnings previos), typecheck OK, `TZ=UTC npm test` con 251 archivos y 3500 tests en verde, build OK.

Verificación manual pendiente: en `/platform`, `document.documentElement.scrollHeight === innerHeight` con viewport de 665 px de alto.
