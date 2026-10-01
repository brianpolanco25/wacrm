# Review — s9.10 local-font

**Veredicto:** APPROVED

Rango revisado: `68594c2..45ab08d` en `platform/local-font` (1 commit, 12 archivos, coincide con el informe).

## Compuerta
- `grep -rn "next/font/google" src` antes del build: 0 coincidencias.
- lint: verde (exit 0; 35 warnings previos, ninguno en archivos tocados).
- typecheck: verde.
- `TZ=UTC npm test -- --reporter=dot`: verde, 249 archivos / 3510 tests.
- build: verde (exit 0) con las variables dummy de `docs/harness.md` + `NEXT_TELEMETRY_DISABLED=1`, sobre `.next`
  limpio (`rm -rf` denegado por permisos; el `.next` anterior se movió al scratchpad del revisor). Único aviso:
  «inferred your workspace root» (preexistente, por el lockfile del worktree).
- replay-migrations: n/a (sin SQL).

## Verificación del build sin red
- `.next/static/media/`: los seis woff2 (`inter_500_normal-s.p.*`, `inter_700_normal-s.p.*`,
  `inter_latin_400_normal-s.p.*`, `inter_latin_600_normal-s.p.*`, `inter_latin_ext_400_normal.*`,
  `inter_latin_ext_600_normal.*`), mismos tamaños que los fuente.
- CSS generado: `--font-inter:"inter", "inter Fallback"`, `--font-inter-latin-ext:"interLatinExt"` (sin fallback,
  así el ASCII cae a `inter` y no a Arial), 4 `@font-face` de `inter` 400/500/600/700, `inter Fallback` sobre
  `local(Arial)` con overrides, 2 `@font-face` de `interLatinExt` con `unicode-range:U+100-24F,…`,
  `.font-sans{font-family:var(--font-inter-latin-ext), var(--font-inter)}`.
- `git grep` de `NEXT_FONT_GOOGLE`, `Google Fonts`, `fonts.googleapis`, `fonts.gstatic`: solo en `CHANGELOG.md:17`,
  `docs/docker.md:40`, `src/app/layout.tsx:20` y el título de un test, todos para decir que ya no se usa.

## Archivos de fuente (script Node sin dependencias: cabecera WOFF2 + brotli de `zlib` + tablas `OS/2`, `name`, `head`, `hhea`)
| archivo | bytes | magic | usWeightClass | familia (name 1/16) | versión |
|---|---|---|---|---|---|
| inter-latin-400-normal | 17156 | wOF2 | 400 | Inter | 3.012 |
| inter-500-normal | 106484 | wOF2 | 500 | Inter | 3.013 |
| inter-latin-600-normal | 18096 | wOF2 | 600 | Inter | 3.012 |
| inter-700-normal | 107144 | wOF2 | 700 | Inter | 3.013 |
| inter-latin-ext-400-normal | 22192 | wOF2 | 400 | Inter | 3.012 |
| inter-latin-ext-600-normal | 24168 | wOF2 | 600 | Inter | 3.012 |

Todas estáticas (sin `fvar`), copyright «The Inter Project Authors». Pesos declarados en `layout.tsx` = `usWeightClass`.
Total 295 240 bytes (~288 KB, coincide con el informe). `LICENSE-Inter.txt`: OFL 1.1 canónica completa (preámbulo,
definiciones, 5 condiciones, terminación, exención), cabecera «Copyright 2016-2020 The Inter Project Authors».

Mezcla fontsource 3.012 (400/600) + rsms 3.013 (500/700): declarada en el informe. Métricas verticales idénticas en
los seis (UPM 2816, ascender 2728, descender -680, lineGap 0, xHeight 1536): no hay salto de línea ni de altura
entre pesos. Riesgo visual aceptable.

## Next 16 (`node_modules/next/dist/docs/01-app/03-api-reference/02-components/font.md`)
- `src` como `Array<{path, weight?, style?}>`, `variable`, `display`, `preload`, `adjustFontFallback` (`'Arial'` |
  `false`) y `declarations` (descriptores de `@font-face`) son opciones documentadas de `next/font/local`.
  `unicode-range` es un descriptor válido y el build lo emite dentro de cada `@font-face` de la llamada.
- `className` en `<html>`: `${inter.variable} ${interLatinExt.variable}` (`layout.tsx:152`), `<body>` sigue con
  `font-sans` (`layout.tsx:169`); `@theme inline` de `globals.css:10,12` compone `--font-sans`/`--font-heading`.
  Nadie más consume `var(--font-sans)` directamente en `src`.
- 800 (`font-extrabold`, 5 usos): sin cara 800, el navegador elige la 700; declarado en el informe y en el comentario
  de `layout.tsx:27`.

## Trazabilidad criterio ↔ test (`src/app/layout.test.ts`)
- C1 «`next/font/local` con los woff2 de Inter, `display: swap`»: [x] › "loads the UI weights 400/500/600/700 from
  the repository" — comprueba pesos, `style`, `display`, `preload`, `adjustFontFallback` sobre las opciones
  capturadas por el mock.
- C2 «latin y latin-ext»: [x] › "serves Latin Extended at 400/600 only for its unicode-range, without preload" —
  además afirma que el rango no contiene `U+00xx` (no ensombrece al ASCII).
- C3 «woff2 en `src/app/fonts/` + licencia OFL junto a ellos»: [x] › "points every src at a real woff2 file next to
  the OFL licence" — lee cada `path` de las opciones y comprueba magic `wOF2`.
- C4 «mismo `--font-sans`»: [x] › "wires both families into --font-sans and --font-heading" (lee `globals.css`).
  El nombre de la variable de Next cambia a `--font-inter` para evitar la referencia circular; justificado en el
  informe y el resultado para Tailwind es el mismo.
- C5 «`layout.test.ts` mockea `next/font/local`»: [x] `vi.mock('next/font/local', …)` con `vi.hoisted`.
- C6 «sin red / sin Google»: [x] › "leaves no Google Fonts loader anywhere in src" — recorre `src` (`.ts/.tsx/.mjs/.css`)
  con la cadena construida por partes; no es vacuo (la búsqueda es literal sobre todos los archivos, incluido el propio
  test, que no la contiene) + build verificado por el revisor.
- C7 «documentar en `docs/docker.md`»: [x] `docs/docker.md:34-41`, sin mención al mock ni a descargas.
- C8 «sin dependencias nuevas»: [x] `package.json`/`package-lock.json` fuera del diff.

## Checkpoints
- CP1 Compuerta: [x] ejecutada por el revisor, verde.
- CP2 Migraciones: [x] n/a.
- CP3 Aislamiento: [x] n/a (sin consultas).
- CP4 Tests: [x] ver trazabilidad; verificación visual manual con guion en el informe.
- CP5 Sin dependencias: [x].
- CP6 i18n: [x] n/a (sin textos de UI nuevos).
- CP7 Next 16: [x] comprobado contra la referencia de `font.md`.
- CP8 Alcance: [x] 12 archivos, todos justificados por s9.10. El cambio de comillas en `layout.tsx` y el orden de
  clases del `<body>` son de prettier (equivalentes).
- CP9 Documentación: [x] `CHANGELOG.md:14-17` (Unreleased, «Self-hosted font»), `docs/docker.md`, informe coincide.
- CP10 Git: [x] commit en español con prefijo y `Co-Authored-By`; sin push (ninguna rama remota contiene 45ab08d);
  worktree limpio.
- CP11 Entrante: [x] n/a.

## Hallazgos (archivo:línea) — no bloqueantes
1. `src/app/layout.tsx:33-51` — `preload: true` precarga los cuatro archivos de `inter` (~249 KB) en cada ruta; las
   estáticas 500/700 son la Inter completa (2 496 glifos, ~105 KB cada una). Con Google se precargaba solo el
   subconjunto latin. Es regresión de peso de primera carga, no de corrección; se arregla sustituyendo 500/700 por
   subconjuntos latin de fontsource si el humano los aporta. Anotar como deuda.
2. `src/app/layout.tsx:59-78` — caracteres latin-ext en `font-medium`/`font-bold` salen a 400/600 (la familia ext
   solo tiene esos pesos). Declarado en el informe; glifos raros en este producto (es/en). Aceptado.
3. `font-extrabold` (logo, titulares de auth) pasa de 800 real a 700. Declarado; revisión visual pendiente del humano
   según el guion del informe.

## Cambios requeridos
Ninguno.
