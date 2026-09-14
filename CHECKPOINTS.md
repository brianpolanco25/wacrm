# Checkpoints

Lista que el `reviewer` recorre en cada feature y el `implementer` usa como autochequeo.
Es la parte del criterio de aceptación que no cambia de una feature a otra.

- **CP1 Compuerta.** `npm run lint && npm run typecheck && TZ=UTC npm test && npm run build`
  en verde, ejecutada por el reviewer, no leída del informe.
- **CP2 Migraciones.** Si hay SQL: archivo nuevo con el número que fija el spec, idempotente
  (`IF NOT EXISTS`, `CREATE OR REPLACE`, `ON CONFLICT`), aserción por objeto nuevo en
  `supabase/ci/verify-schema.sql`, y `scripts/replay-migrations.sh` sale 0. Ningún
  `ON DELETE CASCADE` que pueda borrar datos de clientes.
- **CP3 Aislamiento.** Toda consulta con `supabaseAdmin()` (rol de servicio) filtra por
  `account_id` y tiene test de fuga entre dos cuentas. La RLS no protege ahí.
- **CP4 Tests.** Cada criterio de aceptación del spec tiene un test vitest junto al código que
  prueba ese criterio (no solo que el archivo existe). Lo que exige base real tiene su SQL en
  `progress/checks_<name>.sql`; lo que depende de Meta o PayPal tiene guion manual.
- **CP5 Sin dependencias nuevas.** `package.json` no cambia salvo que el humano lo aprobó.
- **CP6 i18n.** Cada texto de UI nuevo está en `messages/es.json`, `messages/en.json` y
  `messages/ko.json` (los tres catálogos completos del repo) con la misma clave y los mismos
  placeholders ICU. `es` es el idioma por defecto; `en` es la fuente de verdad.
- **CP7 Next 16.** Cualquier API de framework usada se comprobó en `node_modules/next/dist/docs/`.
- **CP8 Alcance.** El diff no toca archivos que la sección del spec no justifique. Lo que se vio
  roto fuera está anotado como deuda en el informe, no arreglado.
- **CP9 Documentación.** `CHANGELOG.md` (Unreleased) actualizado; variables de entorno nuevas en
  `docs/docker.md`; el informe `progress/impl_<name>.md` existe y coincide con el diff.
- **CP10 Git.** Commits en la rama de la fase, en español con prefijo y `Co-Authored-By`; nada
  pusheado; `main`, `dev` y `feat/saas-multiempresa` intactos.
- **CP11 Lo entrante nunca se bloquea.** Ningún cambio de facturación, cuota o suspensión puede
  impedir que el webhook de WhatsApp guarde un mensaje entrante.
