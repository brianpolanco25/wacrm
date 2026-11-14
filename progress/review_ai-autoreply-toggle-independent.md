# Review — n13.10 ai-autoreply-toggle-independent

**Veredicto:** APPROVED

Rama `feat/ai-autoreply-toggle-independent`, base `main @ c3a2d88`, commit único `69ced6e`. 6 archivos: `CHANGELOG.md`, `messages/{es,en}.json`, `src/components/settings/ai-config{.tsx,-state.ts,-state.test.ts}`. Coincide con el informe.

## Compuerta (dirigida, ejecutada por el revisor en el worktree)
- typecheck: verde (`tsc --noEmit` sale 0).
- `npx eslint src/components/settings/`: 0 errores, 5 warnings `exhaustive-deps` preexistentes; el único de `ai-config.tsx` está en L213 (`useCallback` sin `t`), línea no tocada por el diff.
- `TZ=UTC npx vitest run src/components/settings`: 11 archivos, 138 tests verdes.
- JSON `messages/es.json` y `messages/en.json`: `JSON.parse` OK.
- lint completo / build: no corridos (instrucción del líder). replay-migrations: n/a (sin SQL).

## Trazabilidad criterio ↔ test
- C1 «Switch de respuesta automática no depende de `isActive`; editable con is_active=false»: [x] `src/components/settings/ai-config-state.test.ts` › "deja editable el interruptor con el asistente apagado y auto_reply_enabled=true". La garantía es además estructural: `AutoReplyControlsContext` no tiene campo `isActive`, y `ai-config.tsx:701` usa `autoReplyState.switchDisabled` (= `!canEdit || saving`, idéntico a `disabled` de L387).
- C2 «Solo lo bloquean rol o guardado»: [x] mismo archivo › "bloquea el interruptor solo por rol o guardado en curso" (canEdit=false → true; saving=true → true; autoReplyEnabled=false → false).
- C3 «El máximo por conversación sigue la misma regla / sin cambio de comportamiento»: [x] mismo archivo › "el máximo por conversación sigue a la respuesta automática, no al asistente". En main era `disabled || !autoReplyEnabled` (`ai-config.tsx` L717 en c3a2d88); ahora `locked || !autoReplyEnabled` con `locked ≡ disabled`. Equivalente exacto.
- C4 «Guardado con is_active=false y auto_reply_enabled=false funciona; API intacta»: [x] `git diff c3a2d88..HEAD -- src/app/api` vacío. `src/app/api/ai/config/route.ts:134-135` lee ambos booleanos por separado (`=== true`) y los persiste tal cual en L380-381; no hay validación que exija `is_active` para `auto_reply_enabled` ni viceversa. Nota: el endpoint es `POST`, no `PUT` como dice la nota de la feature; el componente llama `POST` (L281/L325). Sin impacto.
- C5 «Al pulsarlo pasa a desmarcado»: cubierto por guion manual del informe (Switch controlado `checked`/`onCheckedChange`). Aceptable.

### Decisión de no usar Testing Library
Correcta. `package.json` no tiene `@testing-library/*`, `jsdom` ni `happy-dom`; `vitest.config` fija `environment: "node"`; añadir dependencias está prohibido sin aprobación. `AiConfig` carga por `fetch` en `useEffect`, así que `renderToStaticMarkup` solo pintaría el loader. Extraer la regla a función pura sigue el patrón existente (`integration-card-state.ts`). El riesgo residual (que el JSX no use la función) se mitiga leyendo `ai-config.tsx:701` y `:723`, que sí la usan.

## Checkpoints
- CP1 Compuerta: [x] dirigida verde (completa no corrida por instrucción).
- CP2 Migraciones: n/a.
- CP3 Aislamiento: n/a (sin consultas nuevas; la API no se tocó).
- CP4 Tests: [x].
- CP5 Sin dependencias nuevas: [x] `package.json` sin cambios.
- CP6 i18n: [x] misma clave `Settings.aiConfig.autoReplyDesc` en es/en; frase añadida coherente con el tono («Solo tiene efecto con el asistente activo.» / «Only takes effect while the assistant is active.»).
- CP7 Next 16: n/a (sin APIs de framework nuevas).
- CP8 Alcance: [x] solo componente, helper, test, mensajes y CHANGELOG.
- CP9 Documentación: [x] `CHANGELOG.md` Unreleased con entrada «Fix: the AI auto-reply switch can be turned off while the assistant is off», sin migración, sin env nuevas.
- CP10 Git: [x] commit en español con prefijo `fix:` y `Co-Authored-By`.
- CP11 Lo entrante nunca se bloquea: [x] no afecta.

## Hallazgos (archivo:línea)
Ninguno bloqueante. Skill `code-review` no ejecutado: diff de lógica de 6 líneas revisado a mano íntegro.

1. (menor, fuera de alcance) `src/components/settings/ai-config.tsx:683,699` — los `Switch` no tienen `id`/`aria-labelledby` ligado a su texto; ya anotado por el implementer como deuda.

## Cambios requeridos
Ninguno.
