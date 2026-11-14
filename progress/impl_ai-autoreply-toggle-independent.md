# impl n13.10 ai-autoreply-toggle-independent

## Plan
1. Quitar la dependencia de `isActive` del Switch «Responder automáticamente» en `src/components/settings/ai-config.tsx`.
2. Revisar el campo «máximo por conversación».
3. Aclarar `autoReplyDesc` (es/en).
4. Test vitest.
5. CHANGELOG.

## Rama y commits
- Rama `feat/ai-autoreply-toggle-independent` (worktree `.claude/worktrees/ai-autoreply-toggle-independent`), base `main @ c3a2d88`.
- `69ced6e fix: el interruptor de respuesta automática de la IA se puede apagar con el asistente inactivo (n13.10)`

## Cambios
- `src/components/settings/ai-config-state.ts` (nuevo): `autoReplyControls({canEdit, saving, autoReplyEnabled}) → {switchDisabled, maxPerConversationDisabled}`. `isActive` no entra en la regla.
- `src/components/settings/ai-config.tsx`: el Switch usa `autoReplyState.switchDisabled` (= `!canEdit || saving`, equivale a `disabled`); el input «máximo» usa `maxPerConversationDisabled` (= `disabled || !autoReplyEnabled`, igual que antes: ya no dependía de `isActive`, sin cambio de comportamiento).
- `messages/es.json` / `messages/en.json` `Settings.aiConfig.autoReplyDesc`: se añade «Solo tiene efecto con el asistente activo.» / «Only takes effect while the assistant is active.»
- `CHANGELOG.md` Unreleased: sección «Fix: the AI auto-reply switch can be turned off while the assistant is off».
- API (`src/app/api/ai/config/route.ts`) intacta.

## Criterio ↔ test
| Criterio | Test |
|---|---|
| Con is_active=false y auto_reply_enabled=true el switch no está disabled | `src/components/settings/ai-config-state.test.ts` › «deja editable el interruptor con el asistente apagado y auto_reply_enabled=true» |
| Solo lo bloquean rol o guardado | mismo archivo › «bloquea el interruptor solo por rol o guardado en curso» |
| El máximo sigue la misma regla (depende de auto-reply, no del asistente) | mismo archivo › «el máximo por conversación sigue a la respuesta automática, no al asistente» |

## Decisión: función pura en vez de Testing Library
El repo no tiene `@testing-library/*` ni `jsdom`/`happy-dom` (vitest `environment: "node"`); los tests de componentes usan `renderToStaticMarkup`. `AiConfig` carga por `fetch` en `useEffect`, así que en SSR estático solo pinta el loader, y no hay forma de pulsar el switch sin DOM. Añadir dependencias está prohibido, así que se extrajo la regla a `autoReplyControls` (patrón de `integration-card-state.ts`) y se testeó ella. «Al pulsarlo pasa a desmarcado» no se cubre con test: el Switch es controlado (`checked={autoReplyEnabled}` / `onCheckedChange={setAutoReplyEnabled}`), así que con `disabled=false` alterna; queda para verificación manual.

## Compuerta dirigida (verde)
- `npm run typecheck`: OK.
- `npx eslint src/components/settings/`: 0 errores (5 warnings preexistentes `exhaustive-deps`, ninguno nuevo). `messages/` no tiene config de eslint (JSON ignorado); JSON validado con `JSON.parse`.
- `npx vitest run src/components/settings`: 11 archivos, 138 tests OK.
- Prettier sobre todo lo tocado.

## Verificación manual pendiente
1. Ajustes → Asistente IA con rol owner/admin; apagar «Asistente activo» y guardar con «Responder automáticamente» encendido.
2. Recargar: el switch de respuesta automática debe estar habilitado y encendido; pulsarlo lo apaga; guardar; recargar y comprobar que sigue apagado con el asistente inactivo.
3. Encender «Asistente activo» y guardar: no debe responder solo a entrantes.
4. Con rol agent/viewer, ambos switches siguen bloqueados.

## Otros
- Skill `impeccable` no está disponible en esta sesión (no aparece en la lista de skills); cambio de UI mínimo sin alterar layout ni estilos.
- Sin variables de entorno nuevas. Sin migraciones.
- Deuda fuera de alcance: los `Switch` de esta pantalla no tienen `id`/`aria-labelledby` que los ate a su texto (lectores de pantalla los anuncian sin nombre). Comentarios basura en `ai-config.tsx` ~L380 («Re-using label or a global one, wait...») en el estado de carga.
