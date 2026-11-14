# Estado actual

## 2026-11-12 — Aura v5: saludo, empatía con medida, sin calendario, un solo hueco, fichas breves; n13.11 fechas

Brian trajo seis cambios de comportamiento de Aura (Rehactive, producción) con tres capturas: (1) saludar y presentarse
siempre como Aura, asistente virtual; (2) empatía solo ante dolor/lesión, no ante «necesito terapia» («Lamento mucho que
esté pasando por eso» sobraba); (3) nunca el emoji de calendario 📅 (los pacientes leen «24»/«FEB» como fecha); (4) sigue
diciendo «Mañana jueves 13 de noviembre» siendo jueves 12 (13 = viernes); (5) ofrecer UN solo hueco, el más cercano, y
más solo si lo pide (objetivo: llenar los cupos del día); (6) información del centro condensada, párrafos de 2-3 líneas
con línea en blanco, negrita de WhatsApp (*texto*) en montos y datos clave.

Hecho: **`progress/aura_prompt_completo_v5.md`** (24 342 chars; fuente de verdad del prompt desde ahora: secciones
nuevas SALUDO Y PRESENTACIÓN, EMPATÍA CON MEDIDA, FORMATO DE LOS MENSAJES; FECHA Y HORA reescrita; CITAS con un solo
hueco; ejemplos en formato ficha) y **`progress/aura_conector_health_v5.txt`** (1 999 chars; un starts_at, plantilla de
confirmación sin 📅 y con negritas). Script de aplicación en el scratchpad de la sesión (`aura_apply_v5.js`, node por
PostgREST dentro de `crm-app`, con `--check` de solo lectura; lo corre Brian con `!` por `ssh cabbity`, el clasificador
bloquea al agente). Pendiente: Brian lo ejecuta y prueba en playground.

Código: **n13.11 `ai-weekday-guard`** (sin sdd, `in_progress`, rama `feat/ai-weekday-guard`, worktree
`.claude/worktrees/ai-weekday-guard`, desde `main @ 57a98e6`): líneas de fecha local con today/tomorrow ya calculados y
ANTES de la UTC; etiqueta relativa «(tomorrow)» en los campos `_local`; nuevo `weekday-fix.ts` que corrige de forma
determinista el día de la semana del texto final cuando contradice al calendario («jueves 13 de noviembre» →
«viernes»), aplicado en loop.ts con warn `[ai weekday-fix]`. Implementada en 2 rondas (533a7d2, 9af3d5c; el reviewer pidió no tocar listas «lunes a viernes», no aplicar el relativo sin zona, no corregir conflictos relativo↔fecha, año plausible), APPROVED, merge 0224f5f, compuerta completa verde (6184 tests, build), push → `done`. Deuda: generate.ts sin herramientas no pasa por la red; «Live data» sin «(tomorrow)». Producción: modelo de Rehactive era gemini-3.5-flash-lite (Brian lo subió a gemini-3.5-flash el 12-nov); ai_policy de Health estaba NULL en las 16 operaciones (guardia n13.7 inactiva): script `health_policy_apply.js` en el scratchpad, lo corre Brian. **n15.2 `ai-image-input`** (sdd): Brian aclaró que el objetivo son fotos de cédula y carnet de ARS. Spec aprobado («dale»), implementada en 2 rondas (9b42939, 90953bf, cfc0707; el reviewer cazó un reintento sin imágenes que podía duplicar una cita cuando el proveedor no manda `usage`), APPROVED, merge 5e55426, compuerta completa verde (6297 tests, build), push → `done`. Sin migración; 3 variables de entorno nuevas con defaults (`AI_IMAGE_MAX_PER_TURN`, `AI_IMAGE_MAX_BYTES`, `AI_IMAGE_DOWNLOAD_TIMEOUT_MS`, en docs/docker.md; `.env.local.example` bloqueado por permisos, añadir a mano). Prompt v5 ampliado con «FOTOS DEL PACIENTE»: reaplicar en producción tras el despliegue (script `aura_apply_v5.js` del scratchpad). Deuda: álbum de N fotos = N respuestas (decisión de Brian pendiente: agrupar ráfagas); borrador de bandeja sin párrafo de imágenes; sticker = cualquier image/webp.
Dudas abiertas para Brian: si la captura 3 es posterior al despliegue de n13.9 (CI 43068701985, 11-nov 17:29 UTC) y si
`ai_policy` de las operaciones Health se recargó en producción tras la migración 095 (bootstrap); sin ella la guardia de
texto de n13.7 está inactiva.

## 2026-11-11 (noche) — n13.10 interruptor de respuesta automática; cuenta del operador

Brian no podía apagar «Responder automáticamente» en Rehactive: el Switch tenía `disabled={disabled || !isActive}` y el
asistente principal se apagó a las 17:24, así que quedaba bloqueado pero pintado encendido. **n13.10
`ai-autoreply-toggle-independent`** (sin sdd): regla extraída a `ai-config-state.ts` (`autoReplyControls`), el switch
solo se bloquea por rol o guardado; textos es/en aclaran que solo aplica con el asistente activo. Implementada (69ced6e),
APPROVED, merge 57a98e6, compuerta completa verde, push, CI verde → `done`. Sin migración. Deuda anotada por el
implementer: Switches de esa pantalla sin `id`/`aria-labelledby`; comentario basura en `ai-config.tsx` ~L380.

Aparte: brianpolancodisenos@gmail.com (platform admin) era expulsado del dashboard por la puerta de onboarding porque su
empresa «Brian Polanco» (10826eaf) tenía suscripción `incomplete` (Pro/PayPal nunca pagado) y perfil vacío. Fix
propuesto: plan `ilimitado` manual como las demás cuentas internas; el clasificador bloqueó el UPDATE, SQL dejado en
el scratchpad de la sesión y camino UI (`/platform` → asignar plan) indicado a Brian. Su rol en esa cuenta es `user`.

## 2026-11-11 (tarde) — n13.9: Aura dice mal el día de la semana

Captura de producción (Rehactive): Aura ofreció «Jueves 13 de noviembre» cuando el 13-nov-2026 es viernes. Causa:
el resultado de `find_availability` llega como JSON crudo sin weekday (`src/lib/ai/tools/result.ts`) y la línea
«Current date and time» del prompt de herramientas tampoco lo lleva; el modelo calcula el día de cabeza. El bloque
Live data de n13.7 sí lo anota, pero no cubre el camino de tool call. Feature **n13.9 `ai-tool-dates-weekday`**
(sin sdd, `in_progress`, rama `feat/ai-tool-dates-weekday`, worktree `.claude/worktrees/ai-tool-dates-weekday`,
desde `main @ 4257fcc`): weekday en las líneas de fecha del prompt, campo hermano `<clave>_local` («Friday
2026-11-13 14:00 (-04:00)») en cada fecha ISO de los resultados de herramienta sin tocar el valor original, regla
«nunca calcules el weekday», helper compartido con live-render. Brian: «dale subelo». Implementada (ac6bc6e), reviewer APPROVED, merge c3a2d88, compuerta completa en main verde, push y CI 43057042332 verde (sube también n13.7 y n15.1; las tres a `done`). **Incidente**: el push desplegó n13.7+n15.1 sin 095/096 aplicadas en el Supabase remoto → `loadAiConfig` y GET /api/ai/config fallaban por columna inexistente (`voice_fallback_message`): Ajustes → IA vacío, playground «Stored API key could not be decrypted», Aura caída ~1 h. Brian pegó token sbp_; 095 y 096 aplicadas y verificadas (historial 093–096, `ai_live_reads`, `ai_policy`, `transcript*`, 2 ai_configs intactas). Lección en memoria: aplicar migraciones remotas ANTES del push, o no pushear. El guardado de Ajustes → IA en ese estado (16:30) dejó `ai_configs` de Rehactive con `system_prompt` NULL e `is_active`/`auto_reply_enabled` en false; restaurado por SQL desde `progress/aura_prompt_completo_v4.md` (21 356 chars, cabecera «QUIÉN ES AURA»), interruptores en true. Conector Health intacto (1994 chars, `ai_timezone` Santo Domingo). `ai_live_reads` sigue `[]`: las lecturas en vivo de n13.7 no están configuradas aún para Rehactive. `voice_fallback_message` quedó con el default en inglés. Después: plantilla de confirmación de cita nueva (título «SU CITA QUEDÓ PROGRAMADA:» en mayúsculas, línea en blanco tras la primera, mapa https://maps.app.goo.gl/rUywiAEpMRAoENBF7 bajo el lugar) en `progress/aura_conector_health_v4.txt` (1992 chars; recortes: «deja una propuesta», «la confirma el recordatorio») y referencias alineadas en el prompt v4; ambos aplicados en producción por SQL. Pendiente: Brian revoca el token y comprueba en playground «viernes 13».
Ojo: `main` está 11 commits por delante de `origin/main` (n13.7 + n15.1 fusionadas, sin push): el push de n13.9
las sube también; mirar CI de main después.

Aparte, consulta de Brian resuelta sin código: en la automatización «Bienvenida · menú al primer mensaje» de
Rehactive, para que Aura responda cuando el primer mensaje contiene «darme consulta», basta un paso Condición
(Contenido del mensaje → «darme consulta») con la rama Sí vacía y la bienvenida en la rama No: si la automatización
no envía, la reserva de `inbound_auto_replies` queda libre y la IA responde.


## 2026-11-11 — n13.7 y n15.1 aprobadas; implementación en paralelo

Brian aprobó por la mañana los dos specs `spec_ready` de anoche: **n13.7 `ai-grounded-availability`** tal cual
(D1–D8, migración 095) y **n15.1 `ai-voice-notes`** con D3 cambiada: ante fallo de transcripción, un reintento
(solo errores transitorios) y texto fijo pidiendo que escriba, sin traspaso ni apagar la IA. Worktrees creados
desde `main @ 2799b6b`: `.claude/worktrees/ai-grounded-availability` (`feat/ai-grounded-availability`, implementer
lanzado, `in_progress`) y `.claude/worktrees/ai-voice-notes` (`feat/ai-voice-notes`; spec_author revisando D3,
luego implementer). Las dos tocan `auto-reply.ts`, `defaults.ts`, playground, `messages/*`, CHANGELOG y
`verify-schema.sql`: quien fusione segundo rebasa. Tras APPROVED: merge a main, compuerta completa, push, done
(ver memoria autonomia-merge-push). Pendiente humano: aplicar 095/096 en Supabase remoto; verificar adjuntos en
bandeja (m14.x) y dar un ejemplo de las «mentiras» de Aura.


## 2026-11-10 — Aura (ex Elsa): cédula con guiones, sin pedir consentimiento, menos mentiras

Encargo de Brian: la IA de Rehactive pasa a llamarse **Aura**; debe aceptar la cédula con guiones y mandarla a Health solo con dígitos; dejar de preguntar si autoriza el registro de datos; y dejar de «decir mentiras». Hecho: (1) textos nuevos `progress/aura_prompt_completo_v4.md` (fuente de verdad del prompt; añade VERDAD Y LÍMITES y DOCUMENTO DE IDENTIDAD) y `progress/aura_conector_health_v3.txt` (1994 chars); script de aplicación en el scratchpad de la sesión (`aura_apply.js`, PostgREST desde el contenedor `crm-app`; el clasificador bloquea al agente, lo corre Brian con `!`). (2) Feature **n13.8 `health-document-normalize`** (sin sdd, `in_progress`, rama `feat/health-document-normalize`): normalización declarativa `normalize` en el ejecutor + descripciones del catálogo Health sin «consentimiento expreso». Tras el merge hay que resincronizar `integration_operations` en producción (bootstrap o patch). (3) n13.7 `ai-grounded-availability` → **`spec_ready`** (`specs/ai-grounded-availability/`, D1–D8), esperando aprobación de Brian: dos capas (lecturas en vivo inyectadas en el prompt vía columna nueva `ai_live_reads`, migración 095 + guardia del texto final) y política `ai_policy` por operación (cancelar solo tras listar citas y buscar disponibilidad); se implementa después de n13.8.

**Cierre (misma tarde):** n13.8 APPROVED (review en `progress/review_health-document-normalize.md`) y fusionada (bb18135). Al correr la compuerta en main aparecieron 2 tests rojos de m14.1 (`/api/media/sign`: esperaban 403 y m14.3 responde 400 a rutas no canónicas): **CI de main llevaba en rojo desde el 6-nov (a4726df)** y producción seguía en 7bc2fd2 (n13.6), sin nada de m14.x. Abierta y cerrada **m14.4 `media-sign-tests-canonical`** (solo tests, aa6a8d0; revisada por el líder por diff, sin reviewer, al no tocar comportamiento). Compuerta completa en verde en main y push → CI → despliegue. CI verde (run 42946478902) y desplegado. Brian corrió `health_ops_sync.js` (scratchpad) en el contenedor: `integration_operations` de Health ya lleva las descripciones nuevas (sin «consentimiento expreso») y `normalize: compact` en document_number (3 operaciones). Ojo al comparar jsonb desde JS: Postgres reordena claves; comparar canónico. Abierta **n15.1 `ai-voice-notes`** (sdd) → **`spec_ready`** (`specs/ai-voice-notes/`, migración 096, sin dependencias nuevas): la IA debe responder a notas de voz (hoy ni dispara ni entra en contexto).

**Parado por Brian el 2026-11-10 («cuando tengas el spec lo paras ahí y seguimos tomorrow»).** Para el 11-nov: (1) Brian aprueba o pide cambios en los dos specs `spec_ready`: n13.7 (dos capas + `ai_policy`, migración 095) y n15.1 (transcripción en el camino de la IA; el líder recomienda cambiar la decisión 2: reintento + texto fijo en vez de traspaso pegajoso). Orden sugerido: n13.7 y luego n15.1. (2) Brian verifica en producción: playground con cédula con guiones y paciente nuevo sin pregunta de consentimiento; adjuntos visibles en la bandeja de Rehactive (m14.1/m14.2 recién desplegados); si siguen sin verse, pedir conversación concreta y leer logs del espejo de media en `crm-app`. (3) Un ejemplo concreto de las «mentiras» de Aura para validar la sección VERDAD Y LÍMITES. Adjuntos no visibles: m14.1/m14.2 recién desplegados por primera vez; Brian verifica. Ojo local: `npm run lint` en el checkout principal barre los `.next` de los worktrees de `.claude/worktrees/` y falla por eso; usar `npx eslint . --ignore-pattern '.claude/**'` o borrar los worktrees terminados.

## 2026-11-10 — Elsa cancela en vez de reprogramar

Brian mostró en playground que Elsa cancelaba con motivo de horario. Causa: el prompt v2 preguntaba motivo y ofrecía huecos en el mismo mensaje. Además el prompt guardado en `ai_configs` de Rehactive estaba corrupto (frases truncadas al pegarlo) y aún tenía la sección Gicre. Reconstruido entero en `progress/elsa_prompt_citas_v2.md` → `progress/elsa_prompt_completo_v3.md` y aplicado en producción junto con `progress/elsa_conector_health_v2.txt` (1990 chars; la columna trunca a 2000). Nota de n13.7 ampliada con la guardia de código para `cancel_appointment`. Pendiente: Brian repite la prueba. Nayelhy L. dada de alta a mano en Rehactive como `agent` (perfil insertado, invitación `cc2fe434…` aceptada). **Deuda/bug**: su usuario auth existía desde el 3-nov, confirmado y con login el 5-nov, pero SIN perfil: `handle_new_user` falló en silencio (rama personal con `EXCEPTION WHEN OTHERS → RAISE WARNING`). Investigar causa en logs de Postgres y plantear feature: alta sin perfil debe fallar ruidosamente o repararse al iniciar sesión.

## Fase 14 — adjuntos que no se ven (abierta el 2026-11-05)

Origen: captura de Brian en una conversación de Photo Nice Studio: dos imágenes entrantes con icono roto y dos
salientes como «[image]». Diagnóstico del líder: (a) en **sesión de soporte** `src/lib/media/signed-url.ts` firma con
el JWT del operador y la política 044 (`profiles.user_id = auth.uid()`) resuelve SU cuenta, no la impersonada → la
firma falla, cae a la URL pública y el bucket es privado en producción (comprobado: 400) → `ImageOff`; sin rastro en
logs del servidor. (b) Los ecos de coexistencia (`smb_message_echoes`) se guardan como marcador `[tipo]` con
`media_url` null por diseño de #1651. Brian: «arreglalo». Dos features sin spec_author, en paralelo desde
`main @ 7bc2fd2`:

- `m14.1 support-media-signing` (`approved`, 3 rondas: traversal por normalización de storage-js → cerrado con dos capas
  en `pathBelongsTo`; `expiresAt` solo con reloj local vía `expiresIn`). Merge b6719e0. Deuda: restringir
  `/api/media/sign` a sesiones de soporte; unificar su validación con `assertStoragePathOwnedBy`.
- `m14.2 coexistence-echo-media` (`approved`, 2 rondas: revoke limpia el adjunto, edit sobre adjunto escribe el caption a
  secas, test de reintento). `main` ff 0dd04d8. Deuda H4–H6, H8 en `progress/impl_coexistence-echo-media.md`.
- `m14.3 storage-path-canonical` (`approved`, 1 ronda). **Vulnerabilidad crítica** hallada por el reviewer de m14.1 y
  auditada en `progress/sec_storage-path-normalization.md` (C1 `resolveOutboundMedia`, H1 `ensureImageHeaderHandle`):
  un `media_url` con `..` codificado pasaba el check de cuenta y el rol de servicio descargaba y enviaba a Meta
  adjuntos de otra empresa. Fix centralizado en `storage-url.ts` (path canónico + ida y vuelta `new URL` +
  `assertStoragePathOwnedBy` con UUID estricto). Merge a4726df (conflictos de apéndice en CHANGELOG y
  tenant-isolation.test.ts, ambos bloques conservados). **Antes de desplegar**: las dos consultas SQL de solo lectura
  de `progress/impl_storage-path-canonical.md` («Verificaciones manuales pendientes») deben dar 0 filas.

n13.6 `integrations-support-manage`: reviewer APPROVED, fusionada en main (7bc2fd2) y pusheada; pasada a `done` el
2026-11-05.

## Fase 12 — invitación directa (abierta el 2026-11-03)

Origen: un cliente invitó a un usuario desde Miembros y ese usuario acabó como empresa nueva. Decisión del humano:
el invitado que entra por el enlace cae directamente en la empresa que lo invitó, sin pantalla de aceptar.
Feature `i12.1 invite-direct-join` (`pending`, sdd) en rama `feat/invitacion-directa` (worktree
`.claude/worktrees/invitacion-directa`, desde `main @ 5f64211`). Spec aprobado por el humano el 2026-11-03 («dale»); `approved` (reviewer APPROVED, 3 commits be9cae6..63a3ff9, 4860 tests). `done`: fusionada en main (ff 63a3ff9) el 2026-11-03 y pusheada. Migración 090 aplicada en Supabase remoto por Brian el 2026-11-03. Pendiente humano: guiones S-M1..S-M3 en producción. Deuda anotada: rescate del usuario ya afectado (mover su cuenta a la
empresa invitadora) e invitaciones ligadas a email para quien se registra sin enlace.

## Fase 13 — conector Cabbity Health para la IA (2026-11-05)

Pedido del humano: con la clave `chk_live_…` del centro Rehactive (cinco scopes, 120/min; verificada con GET /me) y
el OpenAPI de la API de terceros de Cabbity Health (`docs/integrations/cabbity-health-openapi.json`, 19 operaciones),
«crear el conector para que el agente de IA pueda utilizarlo y sepa cómo hacerlo». Specs aprobados por el humano
(«dale») el 2026-11-05 con todas las decisiones recomendadas. Dos features en paralelo desde `main @ fd4ce95`:

- `n13.5 cabbity-health-connector` — catálogo versionado (`src/lib/integrations/catalogs/cabbity-health.ts`, 16 de
  19 operaciones; `list_patients`/`get_patient` cargadas apagadas; `list_appointments` exige `patient_id` y sin
  `status`, Health exige `status[]`), script `scripts/integrations-bootstrap-catalog.ts <slug>`, cabecera
  `Idempotency-Key` autogenerada (`in:'header'`, `auto:'uuid'`, `callerParams()`), cuerpos anidados con punto,
  `remoteError` en `ok:false`. Sin migración. Reviewer APPROVED ronda 1; guion §M1 de lectura y test vivo 7/7
  corridos por el líder contra el servicio real. `main` ff 69d67dd.
- `n13.3 integration-ai-tools` — tool calling en anthropic/openai/gemini (`src/lib/ai/tools/*`,
  `generate*WithTools`), bucle 5+1 vueltas / 8 ejecuciones / 40 s, resultados a 8 KiB, borrador solo GET,
  «Usar en IA» + instrucciones + zona horaria por integración (migración 094), línea «Usó:» en playground y
  borrador. Reviewer APPROVED en ronda 2 (ronda 1: test de R36, uso en `ai_usage_log` al fallar una vuelta,
  límite de anidamiento, unificación con `callerParams`). `main` ff a5c7617.

Compuerta completa en `main` tras la fusión: lint 0 errores (ojo: lintear el checkout raíz con worktrees que
tienen `.next/` da miles de errores falsos; borrar los worktrees fusionados antes), typecheck, 5571 tests, build,
replay 001–094. Pendiente del humano: aplicar 094 en Supabase remoto, cargar el catálogo
(`node --env-file=.env.local scripts/integrations-bootstrap-catalog.ts cabbity-health`), activarlo en `/platform`,
pegar la clave en Ajustes → Integraciones, encender «Usar en IA» con zona `America/Santo_Domingo`, y rotar la clave
(se pegó en el chat). Decisiones abiertas del reviewer de n13.3: doble despacho (dos entrantes seguidos pueden
ejecutar la misma escritura), playground ejecuta escrituras reales como `agent`, reactivar conserva `ai_enabled`.
n13.2 sigue `spec_ready` en su rama sin aprobar; debe adoptar `callerParams()` y convivir con `remoteError`.

## Fase 13 — integraciones con apps Cabbity (abierta el 2026-11-03)

Pedido del humano: el superadmin crea integraciones (p. ej. Cabbity Health: crear citas, consultar doctores) que los
clientes activan y usan desde el CRM. Feature `n13.1 integrations-catalog` (`pending`, sdd) en rama
`feat/integraciones` (worktree `.claude/worktrees/integraciones`, desde `main @ 5f64211`). Cabbity Health
(Laravel 12, `/api/v1`, Sanctum) aún no expone citas ni doctores (sus features 1.3/1.4 están en spec_ready), así que el
diseño es declarativo (D1). Spec aprobado por el humano el 2026-11-03 («dale»); `approved` (reviewer APPROVED en ronda 2, 12 commits 2dab443..c91a215, 5092 tests; la ronda 2 corrigió el guardia SSRF compartido en src/lib/webhooks/ssrf.ts). `done`: fusionada en main (merge 2f46f45, conflictos en CHANGELOG y verify-schema resueltos conservando ambos bloques) el 2026-11-03 y pusheada; compuerta completa en main (5173 tests, build, replay 001–091). Migración 091 aplicada en Supabase remoto por Brian el 2026-11-03. Pendiente humano: guion httpbin en producción. n13.2–n13.4 (nodo de flow, herramientas IA, paso de automatización) en `pending` con sdd. Restricción añadida por el humano a la fase 12: el
número de invitados depende del plan del cliente (ya se pasó al spec de i12.1).

Actualizado: 2026-10-01 (tarde). **Fases 9, 10 y 11 COMPLETAS** (30/30 features de las tres fases en `done`), sin
merge a `main`. **Rama final del conjunto: `feat/precios-meta-directo` @ 0ed0338** (worktree
`.claude/worktrees/precios-meta-directo`) = fase 9 (`feat/superadmin` @ 4ad530f) + fase 10 completa
(`feat/facturacion-gestionada` @ 0085083, fusionada @ 74a5daa) + fase 11 completa. Compuerta final sobre esa rama:
lint 0 errores (34 avisos preexistentes), typecheck limpio, 305 archivos / 4 559 tests, build OK.

**Base local verificada (2026-10-01, noche):** Docker encendido por orden del humano («levanta la bd local»); stack
de Supabase local arrancado con `docker start` de los contenedores existentes (sin Studio, analytics, vector ni
edge-runtime; el CLI de Supabase no está instalado, solo en caché de npx). Copia previa en el scratchpad de la sesión.
Migraciones 075–084 (sin 081, hueco intencional: p11.4 no la necesitó) aplicadas con psql y registradas en
`supabase_migrations.schema_migrations`; `verify-schema.sql` OK; segunda pasada de cada una en transacción con
ROLLBACK → las nueve idempotentes; los cinco `checks_*.sql` pendientes (s10.4, p11.3, p11.6, p11.7, s10.7) en verde con
ROLLBACK. El fixture de `checks_meta-reconciliation.sql` se corrigió (usuarios en auth.users, índice de una cuenta por
dueño soltado dentro de la transacción, CASCADE comprobado por catálogo porque `subscriptions` impide borrar cuentas).
La base local queda en la 084 con los datos del seed del 30-09 intactos.

## Cierre del 2026-10-01 (tarde)

| Feature | Rondas | Integrada en | Nota |
|---|---|---|---|
| s10.4 statements | 3 | fg @ 0085083 | lock_timeout en 078, applyLock condicionado al ancla, banner por motivo, ancla conservada al reasignar |
| p11.3 service-cap-per-number | 3 | pmd @ 24fdb08 | 403 explícito en soporte, caché del hook sin carrera |
| p11.5 utility-in-window-warning | 1 | pmd @ 470ff3e | |
| p11.6 free-entry-point-badge | 1 | pmd @ 5c4d2a0 | H1 pendiente del humano (apagar insignia a las 24 h sin respuesta) |
| fase 10 → fase 11 | — | pmd @ 74a5daa | conflicto semántico en la ficha del superadmin resuelto (`AccountNumbersCard` + estado de pago de p11.1), informe `impl_integracion-fase-10-11.md` |
| p11.4 ai-single-reply | 2 | pmd @ b37e4ad | reprompt condicionado al puntero (`lost_race_before_reprompt`) |
| p11.7 billing-emails | 1 | pmd @ 8d7ef9f | proveedor no-op por defecto; `EMAIL_API_URL/KEY/FROM` |
| s10.5 managed-usage-panel | 2 | pmd @ 4cc91ee | estimado con estado de carga, `pricingMissing`, RangeError capturado |
| s10.7 meta-reconciliation | 2 | pmd @ 0ed0338 | mig. 084; ventana reemplazada por cuenta+WABA; formato de `pricing_analytics` SIN verificar |

**Incidente de red (2026-10-01):** en la primera pasada de tests de s10.7, un test de `tenant-isolation.test.ts` sin
mock de `fetch` ejecutó el cron real y salió UNA petición a graph.facebook.com con token dummy (rechazada). Corregido
antes del commit; el reviewer lo verificó con un guardia de red. Regla nueva: todo test que invoque
`GET /api/billing/cron` mockea `fetch`; el `afterEach` global de la suite de aislamiento hace `unstubAllGlobals`.

## Pendiente del humano (orden sugerido)

1. Probar el conjunto: `cd .claude/worktrees/precios-meta-directo && npm run dev` (la rama vive en ese worktree; el
   checkout raíz sigue en `feat/superadmin`). Necesita una base con 001–084 aplicadas.
2. ~~Réplica y checks~~ HECHO el 2026-10-01 contra la base local (ver arriba). Falta en el worktree el enlace
   `ln -s ../../../.env.local .env.local` (archivo vedado a los agentes) antes de `npm run dev`.
3. Merge a `main` (sugerido: `feat/precios-meta-directo` directo, ya contiene las tres fases) y push; luego
   `db push` 066–084 con copia previa y el usuario operador creado ANTES de la 074 (docs/security.md).
4. `.env.local.example`: `META_PAYMENT_CHECK_DISABLED`, `BILLING_CRON_SECRET`, `EMAIL_API_URL`, `EMAIL_API_KEY`,
   `EMAIL_FROM`, más las viejas (`WEBHOOK_CRON_SECRET`, `AI_PLATFORM_GEMINI_API_KEY`, `META_CONFIG_ID`…).
5. Crons en Dokploy: webhooks (cada minuto), renovación de token, `GET /api/billing/cron` al menos cada hora
   (estados de cuenta + correos + conciliación), ver `docs/docker.md`.
6. Verificaciones manuales contra Meta (sin red para los agentes): supuestos S-M1…S-M8 de p11.1, formato y `paging`
   de `pricing_analytics` (guion en `impl_meta-reconciliation.md`), proveedor de correo HTTP (S-B1); cargar tarifas en
   `/platform/rates`; Redirect URLs de `docs/docker.md`.
7. Decisiones de producto abiertas: (a) cuenta gestionada manual `cancelled`/`expired` recibe estado de cuenta con
   cuota completa al corte (review_statements §6); (b) H1 de p11.6; (c) duplicado posible de correo si el proveedor
   envía y falla el cierre de la fila (review_billing-emails §2); (d) deudas viejas: tag-manager por `user_id`,
   automatizaciones huérfanas.

## Historial hasta la fase 8

Actualizado: 2026-09-23. 34 de 34 features aprobadas (programa SaaS 22 + fase 6 de producto 5 + fase 7 «API
pública para clientes» 7). **La fase 7 está en `main` y en producción**: `main` = 9c8d5d9 (fase 7 @ 0be9815 +
`feat/planes-api`: Pro a 100/1000 USD, `api`/`webhooks` solo en Pro y Negocio, migración 065), pusheada ff el
2026-09-23 por orden del humano; el push a `main` dispara la imagen y el deploy de Dokploy. Supabase remoto
(`wacrm`, ref gjrbkxnbgsuzaqfjopof) migrado hasta la 065 con copia previa en
`~/Documents/Dev/backups/wacrm-20260923-0755/`. Inventario de la fase: migraciones 061–065, 26 rutas `/api/v1`
(37 operaciones, 12 scopes), `GET /api/v1/openapi.json`, `/developers` (12 páginas, es/en), MCP con 17 tools
nuevas; informe de cierre `progress/impl_integracion-api-4.md`. Este archivo se regenera desde `feature_list.json`
(fuente de verdad); las notas de trabajo de los agentes van a `progress/impl_*.md`, no aquí.

## Cierre de la fase 7 (2026-09-23, rama `chore/cierre-fase-7`, worktree `.claude/worktrees/cabos`)

Rama desde `main` @ 9c8d5d9 para (1) commitear el estado del harness de la fase 7 que vivía sin commit en el
checkout raíz (este archivo, `feature_list.json`, `progress/{spec,impl,review,checks}_*` de a7.x), (2) añadir
`WEBHOOK_CRON_SECRET` a `.env.local.example` y (3) cerrar las deudas baratas de `impl_integracion-api-4.md`
§«Deudas abiertas» como feature a7.8 (spec `progress/spec_cierre-fase-7.md`, informe `progress/impl_cierre-fase-7.md`): **hecha el 2026-09-23**, 7 commits (04c39ca…abe3042), compuerta verde (2 655 tests, build OK). Cierra: tope de cuerpo en `/api/account/api-keys`, guarda de miembro en `PATCH /api/conversations/{id}`, tests 413/415 del PATCH de webhooks, test del sync de plantillas, `stripComments`, versión y catálogo del MCP. Fuera, por diseño o producto: `EXPORT_STALE_MS`, export en streaming, `resolveServerUrl`, deudas de a7.3 (WABA por plantilla, botones OTP/FLOW), barridos sin filtro de cuenta. Sigue **pendiente del humano** (además del merge/PR de esta rama):

- Programar `GET /api/webhooks/cron` cada minuto en Dokploy con la cabecera `x-cron-secret` =
  `WEBHOOK_CRON_SECRET` (receta en `docs/docker.md` §«Outbound webhooks need their own scheduler»). Sin él las
  entregas de webhook no se reintentan y los exports a medias no se rematan.
- Decisión de producto: `src/components/settings/tag-manager.tsx` lista etiquetas por `user_id`; desde la 064
  el nombre es único por cuenta, así que la etiqueta de un compañero es invisible pero colisiona al crearla.
  Recomendación del líder: listar por cuenta (quitar el `.eq('user_id')`), es un cambio de una línea más el
  copy de la tarjeta de colisión; la API `/api/v1/tags` ya es por cuenta.
- `.opencode/` y `opencode.jsonc` (config de OpenCode del humano) siguen sin commit en la raíz; `docs/harness.md`
  ya los cita. Si se commitean, `.opencode/node_modules/` va al `.gitignore`.

## Fase 8 — ajustes tras la fase 7 (2026-09-23)

- **p8.1 developers-link** — hecha (`feat/enlazar-developers` @ f76d4eb, worktree
  `.claude/worktrees/developers-link`, base `main` @ 9c8d5d9). El humano no conocía `/developers`: se enlaza
  desde el menú lateral, el menú de usuario y el pie del login, con claves es/en/ko. Sin tocar el contenido de
  la doc. Compuerta verde (2 638 tests). Informe `progress/impl_developers-link.md`. Pendiente del humano:
  revisar el contenido de `/developers` con el líder; merge/PR de la rama.

- **p8.2 attention-solo** — hecha (`feat/atencion-cuenta-solo`, worktree `.claude/worktrees/atencion`, base `main`
  @ 641c60c). El humano veía «Nadie la atiende» en todas las conversaciones: cuenta de una persona, bot apagado y
  nadie asigna (regla de f1.3, no un fallo). Decisión: `deriveAttentionState` recibe `teamSize`; con un solo
  miembro o tamaño desconocido no se pinta la alarma ni el chip «Sin atender»; equipos igual que hoy. Compuerta
  verde (2 675 tests). Informe `progress/impl_attention-solo.md`. Pendiente del humano: probar en `/inbox`,
  merge/PR.

- **p8.3 gemini-provider** — hecha (`feat/proveedor-gemini`, worktree `.claude/worktrees/gemini`, base `main`
  @ 7460351). Google Gemini como tercer proveedor: adaptador REST `generateContent` v1beta con `x-goog-api-key`
  (sin SDK), default `gemini-3.5-flash-lite`, `AI_PLATFORM_GEMINI_API_KEY`, UI, docs, legal. **Migración 066**
  (CHECK de `provider` en `ai_configs` y `ai_usage_log`), autorizada por el humano; replay y verify-schema OK.
  Embeddings siguen en OpenAI. Compuerta verde (2 692 tests). Informe `progress/impl_gemini-provider.md`.
  Pendiente del humano: merge/PR, `supabase db push` de la 066 al remoto (copia previa), prueba con clave real,
  `AI_PLATFORM_GEMINI_API_KEY` en `.env.local.example`.

## Ramas

| Fase | Rama | Worktree | Base |
|---|---|---|---|
| 0 | `saas/fase-0-cimientos` | `.claude/worktrees/agent-a85d874ab350adc04` | feat/saas-multiempresa |
| 1 | `saas/fase-1-bandeja` | `.claude/worktrees/fase-1` | saas/fase-0-cimientos |
| 2 | `saas/fase-2-seguridad` | `.claude/worktrees/agent-a4220e4b5ba8896fd` | feat/saas-multiempresa |
| 3 | `saas/fase-3-facturacion` | `.claude/worktrees/fase-3` | saas/fase-0-cimientos |
| 4 | `saas/fase-4-plataforma` | `.claude/worktrees/fase-4` | saas/integracion |
| 4 (f4.2) | `saas/fase-4-multinumero` | `.claude/worktrees/fase-4-multinumero` | saas/integracion @ e6ceba2 |
| 7 | `feat/api-publica` (+ `api/recursos`, `api/webhooks`) | `.claude/worktrees/api-publica`, `api-recursos`, `api-webhooks` | main @ 3b82698 |

## Features

| Fase | Feature | Estado | Nota |
|---|---|---|---|
| 0 | f0.1 assignment-integrity | done |  |
| 0 | f0.2 billing-model | done | APPROVED tras 324f087 (RESTRICT, 047_ai_platform_key.sql, checks SQL). Fase 1 y 3 deben fusionar saas/fase-0-cimientos para heredar la 04… |
| 0 | f0.3 entitlements | done |  |
| 0 | f0.4 platform-ai-key | done | Corrección 8909d90 (key_source en ai_usage_log vía 047, guardado sin bloqueo, camino BYO→plataforma). Segunda ronda CHANGES_REQUESTED: en… |
| 1 | f1.1 pick-available-agent | done | APPROVED tras fac4d40 (RPC restringida a service_role, SQL de comprobación) y la decisión CP6 = en + ko. |
| 1 | f1.2 handoff-message | done | APPROVED tras a492504. Default sembrado en inglés (decisión del líder); incluye el arreglo de la guarda fixed/destino heredada de f1.1. |
| 1 | f1.3 attention-state-list | done | Corrección 4c63367 (fallo de red = desconocido, guarda en el filtro, closed excluido, TTL en caché). APPROVED. |
| 1 | f1.4 per-message-guard | done | CHANGES_REQUESTED: el motor ignora la reserva al reanudar un wait (doble envío); afirmaciones falsas sobre la garantía; IA responde en hi… |
| 1 | f1.5 ai-replies-counter | done | APPROVED. Fase 1 completa en saas/fase-1-bandeja @ 96e02fa (incluye fase 0). |
| 2 | f2.1 private-media | done | Migración 044 solo se aplica en producción tras verificar envíos por media id. |
| 2 | f2.2 tenant-isolation-suite | done | Segunda ronda CHANGES_REQUESTED (menor): el waiver de automations/select por id bendice la lectura del motor que 8413526 arregló; falta c… |
| 2 | f2.3 versioned-encryption | done | CHANGES_REQUESTED: el anillo de claves en CBC (no autenticado) puede sobrescribir tokens con basura; formato nuevo irreversible sin aviso… |
| 2 | f2.4 platform-verify-token | done | CHANGES_REQUESTED (menor): tests dependen del entorno, falta .trim() y warn en el 403, variable ausente en docker.md, sin informe. APPROV… |
| 3 | f3.1 paypal-client-catalog | done | APPROVED tras la corrección d44d68e. El cambio de tsconfig (allowImportingTsExtensions) fue aprobado. |
| 3 | f3.2 checkout-flow | done | CHANGES_REQUESTED: la FK RESTRICT de checkout_intents rompe redeem_invitation() (borra la cuenta personal vacía del invitado); guardián a… |
| 3 | f3.3 paypal-webhook | done | CHANGES_REQUESTED: re-contratar tras cancelar nunca activa (guarda por provider_subscription_id); reenvío de PayPal choca con UNIQUE y la… |
| 3 | f3.4 enforce-limits | done | CHANGES_REQUESTED: broadcast_recipients solo en la ruta del panel (v1/broadcasts y resume sin tope ni conteo); comentario del lote falso … |
| 3 | f3.5 subscription-settings-ui | done | CHANGES_REQUESTED: re-contratar tras cancelar deja la fila active+cancel_at_period_end y el webhook no adopta la suscripción nueva (paga … |
| 4 | f4.1 embedded-signup | done | Reviewer APPROVED (b77e7f0, 8adcd7a, ddd6c38) pero el líder verificó la doc viva de Meta (progress/meta_embedded-signup-verificacion.md):… |
| 4 | f4.2 multi-number | done | APPROVED (ff3dca4, 9b054ef, 09f71ba); fusionada ff en saas/integracion. Migración 053: retira UNIQUE(account_id), índice (account_id, pho… |
| 4 | f4.3 platform-admins-panel | done | APPROVED (47a091c, 1b989f4, 1ff573c; migración 058; manual_hold_* en subscriptions). Tras f4.4 y tras fusionar fase 3 en saas/integracion… |
| 4 | f4.4 impersonation-audit | done | CHANGES_REQUESTED: el panel habla con Supabase desde el navegador con el JWT del operador, así que en soporte ve SUS datos etiquetados co… |
| 6 | p6.1 rebrand-cabbity | done | Nombre visible: Cabbity CRM. No se toca package.json name (CP5) salvo que el humano lo pida. |
| 6 | p6.2 trial-banner | done |  |
| 6 | p6.3 plan-prices-35 | done | Migración 059; plan inicio a 35 USD/mes; anual con el mismo descuento relativo que hoy. |
| 6 | p6.4 spanish-default | done | Crea messages/es.json completo, NEXT_PUBLIC_APP_LOCALE por defecto es; CP6 pasa a exigir es+en+ko con las mismas claves. Va la última par… |
| 6 | p6.5 whatsapp-bsuid | done | Aprobado por el humano el 2026-09-14; va detrás de p6.4 en saas/producto. Migración 060. Spec en progress/spec_producto.md#5 (verificado … |

## Integración

`saas/integracion`: fases 0+1 (96e02fa) + fase 2 (9680b68) + fase 3 (63280f2 + fix e6ceba2,
informe `progress/impl_integracion-fase-3.md`): una sola contabilización de `ai_replies`
(`recordUsage` de f3.4; `countAiReply` de f1.5 retirado), fixtures de `plans`/`subscriptions`
en la suite de aislamiento y waiver estrecho para `plans` (tabla global sin `account_id`).
1554 tests; replay 040–052 + 056 verde. Pendiente: traer e6ceba2 a `saas/fase-4-plataforma`
cuando f4.4 termine; fusionar `saas/fase-4-multinumero` y `saas/fase-4-plataforma` en
`saas/integracion` al cerrar cada una.

## Decisiones tomadas por el líder (no están en la spec)

- CP6 = `messages/en.json` + `messages/ko.json`; no existe `es.json` y no se crea.
- 041 editada en sitio (CASCADE → RESTRICT); 043 editada en sitio (default del aviso en inglés).
- Numeración: 040–041, 047 fase 0; 042–043, 051 fase 1; 044 fase 2; 045–046, 048–050, 052, 056
  fase 3; 053 f4.2; 054 f4.1; 055, 057 f4.4.
- Fase 4: orden f4.4 → f4.2 → f4.1 → f4.3; plan en `progress/plan_embedded-signup.md`.
- Impersonación: lectura real por RLS (predicado de sesión de soporte, solo SELECT), guarda de
  mutaciones en el cliente de navegador, revocación por fila abierta, accountId efectivo en el
  navegador = cuenta impersonada.
- Re-contratar tras cancelar: el webhook adopta la suscripción nueva sobre filas con
  `cancel_at_period_end`.

## Fase 6 (ajustes de producto, 2026-09-14)

Rama `saas/producto` (worktree `.claude/worktrees/producto`), fusionada ff en
`feat/saas-multiempresa` @ 50c9758. Spec en `progress/spec_producto.md`. Nombre visible Cabbity
CRM (no el técnico); banner de trial en cabecera; plan Inicio 35/350 (059); `es.json` completo y
`NEXT_PUBLIC_APP_LOCALE` por defecto `es` (CP6 = es+en+ko); BSUID/usernames de WhatsApp (060:
`contacts.wa_user_id`, `wa_username`, `phone` nullable; webhook por BSUID; envío con `recipient`).
Deuda: botón `REQUEST_CONTACT_INFO` en plantillas; planes de PayPal ya creados no se reprecian,
se versionan con el bootstrap de f3.1.

## Pendiente para el humano

- `.env.local.example` (bloqueado a los agentes): `ENCRYPTION_KEY_PREVIOUS`,
  `META_WEBHOOK_VERIFY_TOKEN`, `PAYPAL_WEBHOOK_ID`, `META_CONFIG_ID`, `META_GRAPH_VERSION`,
  `NEXT_PUBLIC_APP_LOCALE` (defecto `es`).
- Commitear en `feat/saas-multiempresa` el estado del harness que sigue sin commit: `CHECKPOINTS.md`
  (CP6 = es+en+ko), `.claude/agents/*.md`, `docs/harness.md`, `feature_list.json`, `progress/`.
- Migraciones remotas: APLICADAS el 2026-09-15 al proyecto Supabase `wacrm` (ref gjrbkxnbgsuzaqfjopof)
  con `supabase db push` tras reparar el historial (001–039 marcadas como aplicadas); copia previa en
  `~/Documents/Dev/backups/wacrm-20260915-1146/`. El remoto está en la 060.
- Sandbox de PayPal: pasos 6–8 de `progress/impl_subscription-settings-ui.md` y el guion de
  `progress/impl_paypal-webhook.md`; bootstrap del catálogo (`progress/impl_paypal-client-catalog.md`).
- Alta del primer administrador de plataforma: SQL manual en `progress/impl_impersonation-audit.md`.
- Trámite con Meta para f4.1 (verificación de negocio, app en producción, permisos, configuración
  de Embedded Signup).
- Ramas: `feat/saas-multiempresa` = `dev` = `main` = 4756a47, pusheadas el 2026-09-15 por orden del
  humano (ff, sin PR). El push a `main` dispara el build de imagen y el webhook de Dokploy.
- Deuda de producto: automatizaciones de un miembro expulsado quedan sin dueño; cupo de IA agotado
  no cede ni avisa; adjuntos no visibles durante el soporte (storage.objects fuera de 057);
  plantillas por WABA y conversaciones por número (fuera de f4.2).

## Incidencias

- 2026-09-10 noche: límite de sesión; cuatro agentes murieron y se relanzaron.
- 2026-09-11: `progress/current.md` fue sobrescrito por notas de un agente de integración;
  se conservó en `progress/scratch_integracion-fase-2.md` y este archivo se regeneró.
- 2026-09-11 noche: dos agentes se colgaron (watchdog de 600 s): el implementer de la 4ª ronda de
  f4.4 (dejó trabajo sin commitear, retomado por otro) y el reviewer de f4.2 (esperaba una
  compuerta en segundo plano; relanzado con la compuerta en primer plano).
- 2026-09-11/12 noche: racha de cuelgues del watchdog (5 agentes, incluido uno que solo leía
  docs y el skill code-review): parece del entorno, no del trabajo. f4.4 dejó WIP commiteado
  (8590794, 1366 tests verdes) y se relanzó solo para cerrar; f4.2 se relanza sin code-review.

## f4.2 — multi-number: implementación terminada, pendiente de revisión

Commits en `saas/fase-4-multinumero`: `ff3dca4` (migración 053 + resolvedor), `9b054ef`
(envío, difusiones, recepción), `09f71ba` (rutas de configuración y UI). Compuerta y replay
verdes; `progress/checks_multi-number.sql` con 7 bloques OK contra el Postgres del harness.
Informe en `progress/impl_multi-number.md`.

Plan ejecutado (de `progress/plan_embedded-signup.md` §6, §7, §9, §12):

1. Migración `053_whatsapp_config_multi_number.sql` + aserciones en `verify-schema.sql`.
2. `src/lib/whatsapp/resolve-config.ts` (resolvedor único, orden fijo) + test.
3. Recepción: sellado de `conversations.whatsapp_config_id` en el webhook.
4. Envío: `send-message.ts`, `/api/whatsapp/send`, `/api/v1/messages` (`from`),
   `resolve-conversation.ts`, `flows/meta-send.ts` ×3, `automations/meta-send.ts`,
   `react`, `media`, plantillas (predeterminado, deuda anotada).
5. Difusiones: `broadcasts.whatsapp_config_id` al crear; `broadcast-core` y
   `broadcast-resume` resuelven por la difusión.
6. Rutas de configuración: `GET/POST/DELETE /api/whatsapp/config`,
   `PATCH/DELETE /api/whatsapp/config/[id]`, `verify-registration?config_id=`.
7. UI: lista de números + formulario, `settings-overview`, `inbox/page`.
8. Tope `numbers` solo para pares nuevos (conserva la semántica de f3.4) + 2 tests.
9. Tests §9 filas 4, 4b, 4c, 4d, 5b + suite de aislamiento; `checks_multi-number.sql`.
10. Compuerta + replay; `CHANGELOG.md`, `docs/public-api.md`; informe.

Terminado. Commit `fb95a3e` en `saas/fase-4-plataforma` (37 archivos). Compuerta verde:
lint 0 errores / 34 avisos (los 37 preexistentes menos tres que las guardas nuevas
satisfacen), typecheck limpio, `TZ=UTC npm test` 109 archivos y 1 329 tests, build OK con
`ƒ Proxy (Middleware)`. `scripts/replay-migrations.sh` salida 0 con `verify-schema.sql: OK`
(057 solo cambia comentarios) y `progress/checks_impersonation-audit.sql` re-ejecutado
contra el contenedor: `NOTICE: checks_impersonation-audit: OK`. Sin claves i18n nuevas
(CP6: `en.json` y `ko.json` intactos y en paridad). Informe: sección «Tercera ronda» de
`progress/impl_impersonation-audit.md`. Pendiente de re-revisión.

## Fase 7 — deuda acumulada para la integración (2026-09-15)

De `progress/review_webhooks-durable.md` (a7.4 APPROVED) e `impl_webhooks-durable.md`:
- Al fusionar `api/webhooks` con `api/recursos`: mover `WEBHOOK_ACTION_RATE_LIMIT` a `RATE_LIMITS`
  (`src/lib/rate-limit.ts`) y tipar el `fail('conflict', …)` de la ruta de reintento con el
  `ApiErrorCode.conflict` que añade a7.1.
- `contact.tag_removed` se emite aunque el `DELETE` no quite nada (`tag-events.ts`, `engine.ts`):
  cerrarlo en a7.2 (tags-v1), que toca esa capa.
- `PATCH /api/conversations/{id}` no valida que `assigned_agent_id` sea miembro de la cuenta
  (preexistente: la bandeja hacía el mismo UPDATE desde el navegador). Fuera de la fase 7.
- Tests de 413/415 por ruta en `webhooks` pendientes de añadir tras la integración (a7.1, 2.ª ronda).
- `.env.local.example`: falta `WEBHOOK_CRON_SECRET=` (lo añade el humano).
- De `review_tags-v1.md` (a7.2 APPROVED): (a) `tags` no tiene índice único por `(account_id, lower(name))`
  → carrera de doble inserción en el find-or-create; cerrar con migración `064_tags_unique_name.sql`
  + tratar 23505 como find-or-create, en la integración final de la fase; (b) `POST /contacts/{id}/tags`
  aplica el lote a medias si un id es ajeno: resolver los ids en una consulta antes de escribir;
  (c) `findTagByName` sin `.limit()`; (d) `engine.ts` descarta el `error` del DELETE de tag (preexistente).
- Integración 2 (`impl_integracion-api-2.md`, feat/api-publica @ 4327aa4): cerradas las deudas (a)(b)(c) de tags
  con la migración 064 (índice único `tags(account_id, lower(name))`, fusión de duplicados previos incl.
  referencias en jsonb de automatizaciones/flujos). **Decisión de producto pendiente del humano**: el gestor
  de etiquetas del panel (`tag-manager.tsx`) lista por `user_id`, no por cuenta; una etiqueta de un compañero
  es invisible y desde la 064 colisiona por nombre. Cambiar ese alcance no es de la fase 7.
- Para la integración final (a7.6 + a7.7): a7.6 deja `servers[0].url = '/api/v1'` con claves de `paths`
  SIN prefijo; el fixture de a7.7 asume `servers[0].url = origen` y claves CON prefijo, y su renderizador
  concatena en crudo (`model.ts` ~L333) y deriva anclas de la ruta (`operationAnchor`). Al cambiar
  `source.ts` al generador real hay que: pasar el origen (`serverUrl`) al construir la referencia para
  que el curl de ejemplo sea absoluto, y aceptar que las anclas cambien (o normalizarlas). Detalle en
  `review_developer-docs.md` §Segunda ronda.

## Fase 12 — i12.2 member-direct-create (abierta el 2026-11-04)

Pedido del humano: un invitado al equipo no consigue terminar de crearse; el superadmin debe poder, desde la ficha de
la empresa (bloque «Equipo»), crear un miembro ya validado con nombre, email, contraseña y rol para que entre
directamente. Feature `i12.2 member-direct-create` (`pending`, sdd) en rama `feat/miembro-directo` (worktree
`.claude/worktrees/miembro-directo`, desde `main @ 0e9c956`). Lanzado `spec_author` (Opus) el 2026-11-04.
Spec aprobado por el humano el 2026-11-04 («dale», seis decisiones recomendadas). `approved` (reviewer APPROVED, 2 commits
4577e66..6de5654, 5250 tests). `done`: fusionada en main (ff 6de5654) el 2026-11-04 y pusheada; compuerta completa en main
(lint src 0 err, typecheck, 5250 tests, build, replay 001–093 + verify-schema). Migraciones 088, 089 y 093 aplicadas en Supabase remoto por el líder el 2026-11-04 vía API de gestión (`/database/query`, token con
alcance limitado que Brian pasó en chat; 088/089 no estaban aplicadas aunque el código en producción las espera) y registradas en
`supabase_migrations.schema_migrations` (historial ahora 001–093 sin 092). Pendiente humano: guiones S1/S2 de `progress/impl_member-direct-create.md`. Deuda: usuario en Auth sin perfil → 409, sin reparar.

## 2026-11-09 — Elsa afirma disponibilidad inventada (pendiente para el 10-nov)
- Dada de alta **n13.7 `ai-grounded-availability`** (`pending`, sdd): garantía de código para que la IA
  siempre tenga la disponibilidad real de Cabbity Health antes de hablar de días u horas. Diseño
  recomendado en la `note` de la feature. Siguiente paso: lanzar `spec_author` → `spec_ready` → aprobación de Brian.
- Textos de prompt ya redactados (Brian los pega en el CRM): `progress/elsa_conector_health_v2.txt`
  (1999 chars, Ajustes → Integraciones → Cabbity Health → Instrucciones para la IA) y
  `progress/elsa_prompt_citas_v2.md` (sección para el prompt de Elsa; quitar horarios fijos y «No conoces la fecha de hoy»).
