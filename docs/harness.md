# Harness de agentes

Cómo se reparte el trabajo entre el líder y los subagentes en este repo. Los agentes viven en
`.claude/agents/`; el estado del programa, en `feature_list.json` y `progress/`.

## Roles y modelos

| Agente | Modelo | Hace | No hace |
|---|---|---|---|
| `leader` | Fable | Descompone, lanza, integra ramas, habla con el humano | Escribir código |
| `spec_author` | Opus | `specs/<name>/{requirements,design,tasks}.md` para features sin spec | Código, tests |
| `implementer` | Opus | Una feature: código + tests + compuerta + `progress/impl_<name>.md` | Marcar `done`, push |
| `reviewer` | Opus | Ejecuta la compuerta, lee los tests, veredicto en `progress/review_<name>.md` | Editar código |
| `Explore` (integrado) | Haiku/Sonnet | Búsquedas amplias por el código | — |
| `Plan` (integrado) | Opus | Diseño previo cuando la spec deja el cómo abierto | — |

El modelo del líder (`model: fable` en `.claude/settings.json`) **no** se hereda: cada agente
fija el suyo en su frontmatter. Un agente genérico se lanza siempre con `model` explícito.

## Flujo por feature

```
pending → [spec_author] → spec_ready → ⏸ humano aprueba → in_progress → [implementer] → review → [reviewer] → done
```

Las fases del programa SaaS (`docs/saas/fase-N-*.md`) ya son specs aprobados: sus features
nacen `spec_ready` y van a `in_progress` cuando el líder las lanza, sin `spec_author`.

Cada feature es **una sección** de una fase (granularidad de `feature_list.json`), no la fase
entera: agentes cortos, revisables y baratos.

## Dónde vive cada cosa

- `feature_list.json` — fases (rama, worktree, base) y features (id, status, spec, commits).
- `progress/current.md` — feature en curso y estado de ramas. `progress/impl_<name>.md`,
  `progress/review_<name>.md`, `progress/checks_<name>.sql` — informes y SQL de comprobación.
- `CHECKPOINTS.md` — lo que el reviewer comprueba siempre.
- `scripts/replay-migrations.sh <ruta>` — réplica local de `migrations.yml`: Postgres de
  Supabase en Docker (`supabase/postgres:17.4.1.075`), aplica `supabase/migrations/*.sql` en
  orden y corre `verify-schema.sql`. `KEEP=1` deja el contenedor vivo para SQL a mano. No hace
  falta el CLI de Supabase.

## Ramas

Una rama y un worktree por fase, bajo `.claude/worktrees/` (gitignoreado). Una fase que
depende de otra parte de la rama de la anterior:

```bash
git worktree add .claude/worktrees/fase-N -b saas/fase-N-nombre <rama-base>
```

Los agentes commitean en la rama de su fase y nunca pushean. El merge a
`feat/saas-multiempresa`, el push y el PR los hace el humano.

## Compuerta

La misma de CI, en el mismo orden:

```bash
npm run lint && npm run typecheck && TZ=UTC npm test && npm run build
```

`build` necesita las variables dummy de `ci.yml`:

```bash
NEXT_PUBLIC_SUPABASE_URL=https://ci.example.supabase.co \
NEXT_PUBLIC_SUPABASE_ANON_KEY=ci-dummy-anon-key \
ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000 \
META_APP_SECRET=ci-dummy-meta-secret npm run build
```

`TZ=UTC` porque dos tests de `src/lib/dashboard/date-utils.test.ts` dependen de la zona horaria
(deuda preexistente; CI corre en UTC).

## Reglas que no se negocian

- Informes en disco, una línea en chat. El líder no acepta diffs por chat.
- Sin dependencias nuevas sin visto bueno del humano.
- Nunca supabase contra un proyecto remoto. `.env.local` está fuera de límites.
- Toda consulta con rol de servicio filtra por `account_id` y tiene test de fuga.
- Lo entrante (webhook de WhatsApp) nunca se bloquea por facturación.
