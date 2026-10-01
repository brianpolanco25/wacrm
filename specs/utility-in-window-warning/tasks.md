# p11.5 `utility-in-window-warning` — tareas

Rama `pmd/template-window` desde `feat/precios-meta-directo` @ be8ca0f; worktree
`.claude/worktrees/pmd-template-window`. Sin red, sin migración, sin rutas. Informe en
`/Users/brian/Documents/Dev/projects/wacrm/progress/impl_utility-in-window-warning.md`.

- [ ] **T1 Función pura.** `src/lib/automations/template-window.ts` (`WARN_UTILITY_IN_WINDOW`,
  `SAFE_WINDOW_MS`, `FREE_SERVICE_MESSAGES_PER_NUMBER`, `OPEN_WINDOW_TRIGGERS`, `waitDurationMs`,
  `templateWindowWarnings`), solo con `import type`. — **R1, R2, R3, R4, R5, R6** · Prueba:
  `src/lib/automations/template-window.test.ts` (ocho disparadores; esperas 22 h / 23 h / 1 día /
  12+12 h / 90 min; ramas y paso tras condición con el máximo; tres categorías, mismo nombre en dos
  idiomas, plantilla desconocida o vacía; `warnUtility: false`; `waitDurationMs` igual que `waitMs`
  del motor para minutos, horas, días, 0 y negativo).
- [ ] **T2 Componentes del aviso.** `src/components/automations/template-window-notice.tsx`
  (`TemplateWindowNotice`, `TemplateWindowBadge`, proveedor y hook del contexto). Claves
  `Automations.builder.templateWindow.*` en `messages/en.json` y `messages/es.json`. — **R7, R8,
  R11** · Prueba: `src/components/automations/template-window-notice.test.tsx` (`utility`/`direct`,
  `marketing`/`direct`, `utility`/`managed`, `metaBilling` indefinido, badge con `aria-label`,
  paridad de claves y placeholders es/en).
- [ ] **T3 Integración en el builder.** `src/components/automations/automation-builder.tsx`:
  proveedor bajo `ResourcesProvider` con `useMemo`, aviso en `StepEditor` (`send_template`) y badge en
  la cabecera plegada de `StepRenderer`; `metaBilling` de `useBillingStatus()`. — **R7, R8, R9, R10**
  · Prueba: `template-window-notice.test.tsx` (cambio de disparador y de plantilla recalcula) y test
  de `toApiSteps` con y sin aviso (mismo cuerpo).
- [ ] **T4 Alcance.** En el informe: `git diff --stat` limitado a los archivos de R12, nota de que el
  constructor de flujos no cambia porque no hay nodo de plantilla (`FlowNodeConfig` en
  `src/lib/flows/types.ts`), el guion manual con S-U1…S-U4 pendientes (S-U1 decide
  `WARN_UTILITY_IN_WINDOW` antes de desplegar) y la deuda de `executeStepsFrom` anotada en
  `design.md`. — **R12 (CP8, CP11)** · Prueba: revisión del reviewer.
- [ ] **T5 Compuerta en verde + CHANGELOG.** Entrada en `CHANGELOG.md` (Unreleased);
  `npm run lint && npm run typecheck && TZ=UTC npm test && npm run build` (variables dummy de
  `ci.yml`); commits en español con prefijo y `Co-Authored-By`, sin push. — **CP1, CP5, CP6, CP9,
  CP10** · Prueba: salida de la compuerta en `progress/impl_utility-in-window-warning.md`.
