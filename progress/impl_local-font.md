# impl s9.10 `local-font` — Inter local en vez de Google Fonts

## Plan
1. Inspeccionar los woff2 aportados (cabecera wOF2, tablas name/OS/2/cmap con Node sin dependencias).
2. Ver qué pesos usa la UI y cómo se consume `--font-sans`.
3. Leer la referencia de `next/font/local` de Next 16 (docs + loader compilado).
4. Copiar los woff2 elegidos + `LICENSE-Inter.txt` a `src/app/fonts/`.
5. `layout.tsx` con `localFont`; `globals.css`; `layout.test.ts` con mock de `next/font/local` y grep de src.
6. `docs/docker.md`, `CHANGELOG.md`.
7. `grep -rn "next/font/google" src` = 0 → build → comprobar `.next/static/media`.

## Estado: done (pendiente reviewer)

- Worktree `/Users/brian/Documents/Dev/projects/wacrm/.claude/worktrees/local-font`, rama `platform/local-font`, base `feat/superadmin` @ 68594c2.
- Commit: `45ab08d feat: servir Inter desde el repositorio con next/font/local (s9.10)` (binarios + layout en el mismo commit).

## Inspección de las fuentes (script Node: brotli de `zlib` + tablas name, OS/2, cmap)

| archivo | bytes | familia (name 1/16) | usWeightClass | versión | glifos cmap | cobertura |
|---|---|---|---|---|---|---|
| inter-latin-400-normal | 17 156 | Inter | 400 | 3.012 | 224 | Basic Latin + Latin-1 (ñ ¿ ¡ á €), sin č ő |
| inter-latin-600-normal | 18 096 | Inter (SemiBold) | 600 | 3.012 | 224 | igual |
| inter-latin-ext-400-normal | 22 192 | Inter | 400 | 3.012 | 541 | solo Latin Ext (U+0100-024F…), sin ASCII |
| inter-latin-ext-600-normal | 24 168 | Inter (SemiBold) | 600 | 3.012 | 541 | igual |
| inter-400-static | 100 368 | Inter | 400 | 3.013 | 2 496 | completa — NO incluida |
| inter-500-static → `inter-500-normal.woff2` | 106 484 | Inter (Medium) | 500 | 3.013 | 2 496 | completa |
| inter-700-static → `inter-700-normal.woff2` | 107 144 | Inter (Bold) | 700 | 3.013 | 2 496 | completa |

Todos woff2 válidos (firma `wOF2`, el flujo brotli descomprime), sin `fvar` (estáticas, no variables),
copyright embebido «Copyright 2020 The Inter Project Authors (https://github.com/rsms/inter)», licencia OFL.
Mezcla declarada: fontsource (Inter 3.012) para 400/600 y rsms (Inter 3.013) para 500/700; misma familia y
métrica, diferencia de un parche.

## Pesos usados en la UI
`font-medium` 194, `font-semibold` 128, `font-bold` 28, `font-extrabold` 5 (logo y titulares de auth),
`font-normal` 2. Incluidos: 400, 500, 600, 700. **800 no tiene archivo**: el navegador usa la cara 700 (sin
síntesis, ya es negrita). Antes, con la Inter variable de Google, 800 era real: el logo y el titular del hero
se ven un punto menos gruesos.

Tamaño total añadido: 295 240 bytes de woff2 (~288 KB) + 4,4 KB de licencia. Preload: los cuatro de `inter`
(~249 KB); latin-ext (~46 KB) solo se descarga si la página contiene un carácter de su rango.

## Diseño (y por qué dos llamadas)
`next/font/local` (leído en `node_modules/next/dist/docs/01-app/03-api-reference/02-components/font.md` y en
`next/dist/compiled/@next/font/dist/local/loader.js`) acepta `src: [{ path, weight, style }]` pero `preload` y
`declarations` son **por llamada**, no por archivo. No hay `unicode-range` por archivo, y dos caras del mismo
peso sin `unicode-range` se pisan (la latin-ext no tiene ASCII). Por eso:

- `inter` (`--font-inter`): latin 400, estática 500, latin 600, estática 700; `display: 'swap'`,
  `preload: true`, `adjustFontFallback: 'Arial'` (genera `inter Fallback` con ascent/descent/size-adjust).
- `interLatinExt` (`--font-inter-latin-ext`): latin-ext 400/600, `preload: false`, `adjustFontFallback: false`,
  `declarations: [{ prop: 'unicode-range', value: 'U+0100-024F, U+0259, U+1E00-1EFF, U+2020, U+20A0-20AB,
  U+20AD-20CF, U+2113, U+2C60-2C7F, U+A720-A7FF' }]` (rango latin-ext canónico de Google/fontsource v4;
  contiene todo el cmap del archivo, comprobado).
- `globals.css` `@theme inline`: `--font-sans` y `--font-heading` = `var(--font-inter-latin-ext), var(--font-inter)`.
  La ext va primero para que un č/ő no caiga en el `inter Fallback` (Arial local cubre todo). Lo que queda fuera
  de su rango pasa a `inter`.

## Criterio ↔ test (`src/app/layout.test.ts`)
| criterio | `it` |
|---|---|
| `next/font/local` con los woff2 de Inter, `display: swap`, fallback Arial | `self-hosted Inter (s9.10) > loads the UI weights 400/500/600/700 from the repository` |
| latin-ext por `unicode-range`, sin preload, sin ASCII en el rango | `… > serves Latin Extended at 400/600 only for its unicode-range, without preload` |
| archivos reales + licencia OFL junto a ellos | `… > points every src at a real woff2 file next to the OFL licence` |
| la fuente sigue llegando a `font-sans`/`font-heading` | `… > wires both families into --font-sans and --font-heading` |
| ningún import de `next/font/google` en `src` | `… > leaves no Google Fonts loader anywhere in src` (la cadena se construye por partes para que `grep -rn "next/font/google" src` dé 0; probado con un archivo sonda: el test falla con él y pasa sin él) |
| marca intacta | los tres `root metadata > …` previos, sin cambios |

## Verificación del build sin red
- `grep -rn "next/font/google" src | wc -l` → 0, antes de compilar.
- `.next` no existía en el worktree (el `rm -rf .next` fue denegado por permisos, pero no hacía falta): build limpio.
- `npm run build` con las variables dummy + `NEXT_TELEMETRY_DISABLED=1` → exit 0.
- `.next/static/media/`: los seis woff2 copiados (`inter_latin_400_normal-s.p.*`, `inter_500_normal-s.p.*`,
  `inter_latin_600_normal-s.p.*`, `inter_700_normal-s.p.*`, `inter_latin_ext_400_normal.*`,
  `inter_latin_ext_600_normal.*`; `.p` = preload, `-s` = size-adjust), mismos bytes que los fuente.
- CSS generado: 4 `@font-face` de `inter` + `inter Fallback` (local Arial, ascent 90 %, descent 22,43 %,
  size-adjust 107,64 %) + 2 de `interLatinExt` con `unicode-range`; `.font-sans{font-family:var(--font-inter-latin-ext), var(--font-inter)}`.
- `index.html` prerenderizado: preload solo de los cuatro de `inter`.
- `grep -rl "fonts.googleapis|fonts.gstatic" .next`: solo aparece dentro de `next/dist/compiled/@vercel/og`
  (código de Next para `ImageResponse`, que baja fuentes en runtime si se dibuja texto). `src/app/icon.tsx`
  solo dibuja un SVG, sin texto: no dispara esa ruta.
- No se comprobó tráfico saliente a nivel de sistema (sin herramienta disponible sin instalar nada); la garantía
  es que ya no hay cargador de Google y el build pasa.

## Compuerta
`npm run lint` exit 0 (35 warnings previos, ninguno en archivos tocados) · `npm run typecheck` exit 0 ·
`TZ=UTC npm test` 249 archivos / 3 510 tests en verde · `npm run build` exit 0. Sin SQL.

## Decisiones donde el spec o el encargo era ambiguo
- Spec pedía «variable, latin y latin-ext»: no hay Inter variable en local; se usan estáticas (arriba).
- Encargo pedía `variable: '--font-sans'` y preload solo de 400/600: Next no permite ni `unicode-range` ni
  `preload` por archivo, así que son dos familias con variables propias (`--font-inter`, `--font-inter-latin-ext`)
  y `--font-sans` se compone en `globals.css`. No reusé `--font-sans` como nombre de la variable de Next
  porque `--font-sans: var(--font-inter-latin-ext), var(--font-sans)` sería una referencia circular.
- Caracteres latin-ext con `font-medium`/`font-bold` salen a 400/600 (la familia ext solo tiene esos pesos y el
  navegador elige cara por peso antes de mirar cobertura). Añadir las estáticas 500/700 a la ext duplicaría
  ~210 KB en `.next` (Next nombra distinto el mismo archivo según preload/size-adjust). Aceptado: glifos raros.
- Copyright de la licencia: «Copyright 2016-2020 The Inter Project Authors (https://github.com/rsms/inter)»
  (el encargo decía 2016; los archivos embeben 2020 — el rango cubre ambos, como el LICENSE de Inter 3.x).
  No había copia de la OFL en `node_modules`; texto canónico OFL 1.1 escrito tal cual.
- `CHANGELOG.md` está entero en inglés: la línea va en inglés («The Inter font is served from the repository;
  the build no longer contacts Google Fonts…») en una sección `### Self-hosted font`.
- `docs/docker.md` no mencionaba Google Fonts ni `NEXT_FONT_GOOGLE_MOCKED_RESPONSES`; nada que quitar. Añadida
  la subsección «Fonts: no network needed at build time».

## Variables de entorno nuevas
Ninguna.

## Verificación manual pendiente
Abrir la app (`npm run dev` o la imagen) y mirar en DevTools → Network que las fuentes vienen de
`/_next/static/media/*.woff2`, que no hay peticiones a `fonts.gstatic.com`, y que un contacto llamado
«Dvořák Łukasz» dispara la descarga de `inter_latin_ext_*` y se ve en Inter. Revisar a ojo el logo/hero
(`font-extrabold`, ahora 700).

## Deuda fuera de alcance
- `docs/docker.md` ya no pasaba `prettier --check` antes de este cambio; no lo reformateé entero (s9.9 toca
  docs en paralelo y generaría conflictos).
- Aviso de build previo: «Next.js inferred your workspace root» por varios `package-lock.json` (worktree dentro
  del checkout); se silencia con `turbopack.root`.
- Si algún día se quiere 800 real (logo), hace falta un archivo Inter 800 o la variable.
