# Estado actual

Actualizado: 2026-09-10 (sesión de arranque del programa SaaS).

## Situación

Las tres primeras olas se lanzaron con agentes genéricos que heredaron el modelo del líder.
El humano paró todo y se adaptó el harness (`.claude/agents/`, `feature_list.json`,
`CHECKPOINTS.md`, `docs/harness.md`). A partir de aquí: implementer/reviewer/spec_author en
Opus, una feature por agente, informes en `progress/`.

## Ramas y worktrees

| Fase | Rama | Worktree | Estado |
|---|---|---|---|
| 0 | `saas/fase-0-cimientos` | `.claude/worktrees/agent-a85d874ab350adc04` | 4 features implementadas, compuerta verde, **sin revisar** |
| 1 | `saas/fase-1-bandeja` | `.claude/worktrees/fase-1` | f1.1 y f1.2 commiteadas sin revisar; f1.3–f1.5 pendientes |
| 2 | `saas/fase-2-seguridad` | `.claude/worktrees/agent-a4220e4b5ba8896fd` | f2.1, f2.3, f2.4 commiteadas sin revisar; f2.2 empezada sin commitear |
| 3 | `saas/fase-3-facturacion` | `.claude/worktrees/fase-3` | f3.1 empezada sin commitear (incluye un cambio a `tsconfig.json` por revisar) |
| 4 | — | — | no arrancada; depende de 0, 2 y 3 |

## Próximo paso

Que el humano apruebe el harness adaptado. Después: reviewers sobre lo ya implementado
(f0.x, f1.1, f1.2, f2.1, f2.3, f2.4) e implementers para retomar f2.2 y f3.1.

## Feature en curso

Ninguna. Todos los agentes detenidos.
