# Conector de Cabbity Health

Cabbity Health es la agenda de un centro de salud (profesionales, sedes, disponibilidad, pacientes
y citas). Su API de terceros está en `docs/integrations/cabbity-health-openapi.json`
(`https://api.health.cabbity.com/api/integrations/v1`, `Authorization: Bearer <clave del centro>`).
Este conector la declara como una integración más del catálogo de n13.1: no hay código propio
para Health, solo una definición versionada en
`src/lib/integrations/catalogs/cabbity-health.ts` que un script carga en la base.

La API **nunca devuelve datos clínicos** (alergias, alertas, consultas, signos) ni motivos de cita
o de cancelación.

## 1. Cargar el catálogo

Con la base migrada (091) y la service role de esa base en el entorno:

```bash
node --env-file=.env.local scripts/integrations-bootstrap-catalog.ts cabbity-health
```

- Primera vez: crea la integración `cabbity-health` **inactiva** y sus 16 operaciones.
- Después: actualiza solo los campos que cambiaron en la definición (textos, parámetros, salidas,
  orden). Nunca toca `slug` ni `is_active` (ni de la integración ni de las operaciones: eso lo
  decide el operador). Una segunda ejecución sin cambios no escribe nada (`unchanged`).
- Una operación que esté en la base y no en la definición se deja como está y se avisa
  (`WARNING: operation … is in the database but not in the definition`).
- Sin argumento o con un slug desconocido sale con código 1 y lista los slugs válidos; sin
  `NEXT_PUBLIC_SUPABASE_URL` o `SUPABASE_SERVICE_ROLE_KEY` sale con código 1 nombrando la
  variable (nunca su valor).

Primero en local. Contra el Supabase remoto se usa la service role del proyecto remoto y, como
cualquier operación remota, **se pregunta antes**.

## 2. Activarla

**Operador de plataforma** (`/platform`):

1. Integraciones → Cabbity Health: revisar las operaciones y **activar** la integración.
2. `list_patients` y `get_patient` nacen apagadas (ver §3). Encenderlas solo si un cliente lo
   justifica y entiende que exponen datos personales completos.
3. El plan del cliente tiene que incluir la feature **Integraciones con otras apps**
   (`integrations`).

**Cliente** (Ajustes → Integraciones → Cabbity Health):

1. Pedir al administrador de Cabbity Health una clave de integración del centro (empieza por
   `chk_live_`) con los permisos `availability:read`, `patients:read`, `patients:write`,
   `appointments:read` y `appointments:write`.
2. Pegarla y pulsar «Probar conexión» (`GET /me`). `ok` = lista; «falló la autenticación» = clave
   mal copiada, vencida o revocada.

La clave se guarda cifrada en `account_integrations` y solo la descifra el ejecutor. No va al
repositorio, ni a un log, ni a `integration_calls`.

## 3. Operaciones

| Clave                    | Método y ruta                        | Nace        | Para qué                                            |
| ------------------------ | ------------------------------------ | ----------- | --------------------------------------------------- |
| `get_center`             | GET `/me`                            | activa      | Centro, zona horaria y permisos de la clave         |
| `list_locations`         | GET `/locations`                     | activa      | Sedes (`location_id`)                               |
| `list_practitioners`     | GET `/practitioners`                 | activa      | Profesionales (`membership_id`)                     |
| `get_practitioner`       | GET `/practitioners/{id}`            | activa      | Un profesional                                      |
| `list_specialties`       | GET `/specialties`                   | activa      | Especialidades (`key`)                              |
| `find_availability`      | GET `/availability`                  | activa      | Huecos libres (rango ≤ 13 días)                     |
| `lookup_patient`         | POST `/patients/lookup`              | activa      | ¿Ya es paciente? (por documento o teléfono)         |
| `list_patients`          | GET `/patients`                      | **apagada** | Listado de pacientes con datos completos            |
| `create_patient`         | POST `/patients`                     | activa      | Registrar paciente (con consentimiento)             |
| `get_patient`            | GET `/patients/{id}`                 | **apagada** | Ficha administrativa completa                       |
| `list_appointments`      | GET `/appointments`                  | activa      | Citas **de un paciente** (`patient_id` obligatorio) |
| `create_appointment`     | POST `/appointments`                 | activa      | Crear cita                                          |
| `get_appointment`        | GET `/appointments/{id}`             | activa      | Una cita                                            |
| `reschedule_appointment` | POST `/appointments/{id}/reschedule` | activa      | Reprogramar                                         |
| `confirm_appointment`    | POST `/appointments/{id}/confirm`    | activa      | Confirmar asistencia                                |
| `cancel_appointment`     | POST `/appointments/{id}/cancel`     | activa      | Cancelar                                            |

**Por qué hay dos apagadas.** `list_patients` busca por nombre y `get_patient` devuelve cualquier
id, las dos con documento, teléfono, email y dirección. Una IA que contesta a cualquier contacto de
WhatsApp podría enumerar pacientes del centro. `lookup_patient` cubre el caso real y solo devuelve
los últimos dígitos del documento (`document_hint`).

**Por qué `list_appointments` exige `patient_id`.** El OpenAPI también acepta un rango `from`/`to`
sin paciente, que devuelve la agenda entera del centro con nombres. El caso de uso del CRM es «mis
citas»; la agenda completa queda fuera.

**Fuera del catálogo.** `PATCH /patients/{id}` (un contacto podría cambiar el teléfono o documento
de otro paciente), `DELETE /patients/{id}` (desactivar pacientes no es tarea de un bot ni de un
flow) y `DELETE /appointments/{id}` (alias de `cancel`; duplicarlo confunde a la IA).

**Detalles del modelo.**

- `Idempotency-Key`: las escrituras (`create_patient`, `create_appointment`, `reschedule`,
  `confirm`, `cancel`) la llevan como parámetro `in: 'header'`, `auto: 'uuid'`. El CRM genera un
  UUID nuevo **en cada llamada**; ni los flows ni la IA la ven ni la mandan (si alguien la manda, la
  llamada se rechaza con `invalid_params`). `lookup_patient` es un POST de lectura y no la lleva.
- `consent{accepted, accepted_at, reference}` de `create_patient` se declara con nombres con punto
  (`consent.accepted`, …) y viaja como objeto anidado. Quien llama puede mandarlo con punto o como
  objeto.
- `list_appointments` **no filtra por estado**. Health exige el filtro como lista estilo PHP
  (`status[]=confirmed`); `status=confirmed` responde `422 validation_failed` (`field` = `status`,
  comprobado contra el servicio real el 2026-11-05). El modelo de parámetros no tiene arrays, así que
  el parámetro se quitó: la IA filtra el resultado, que trae `status` en cada cita.
- `lookup_patient` y `create_patient`: un número de documento con formato inválido responde
  `422 validation_failed` con `field` = `document_number`. Las descripciones le piden a la IA que
  vuelva a pedir el dato al cliente.
- Horas: `starts_at` siempre en ISO 8601 con el offset de la zona del centro
  (p. ej. `2026-11-12T10:30:00-04:00`; la zona sale de `get_center`). Fechas de rango: `YYYY-MM-DD`.
- Paginación: `meta.next_cursor` se pasa como `cursor` hasta que sea `null` (no hay paginación
  automática).

## 4. Límites

- **120 peticiones por minuto por clave** en Health (`429 rate_limited`). El CRM limita antes: **60
  llamadas por minuto por cuenta** (resultado local `rate_limited`, sin petición).
- **3 citas futuras por paciente** creadas por integraciones (`409 too_many_upcoming_appointments`).
- Disponibilidad: rango de como mucho **13 días** (`to` − `from`). Citas: rango de como mucho
  **31 días**.
- Sin datos clínicos ni motivos.
- Respuestas de hasta 256 KiB y 10 s (n13.1).

## 5. Errores que conviene tratar

Health responde `{"error": {"code", "message", "field", "details", "request_id"}}`. El ejecutor
devuelve `{ ok: false, outcome: 'http_error', status, remoteError: { code, message, field,
requestId } }` (se leen como mucho 8 KiB; `details` se descarta; el mensaje se corta a 300
caracteres). `integration_calls` solo guarda `outcome` y `status_code`, no el código ni el mensaje.

| `code`                           | HTTP | Qué hacer                                                                                                        |
| -------------------------------- | ---- | ---------------------------------------------------------------------------------------------------------------- |
| `slot_unavailable`               | 409  | El hueco se ocupó: volver a `find_availability` y ofrecer otro                                                   |
| `too_many_upcoming_appointments` | 409  | El paciente ya tiene 3 citas futuras: ofrecer reprogramar o cancelar una                                         |
| `patient_exists`                 | 409  | Ya existía: buscarlo con `lookup_patient`                                                                        |
| `appointment_not_changeable`     | 409  | La cita ya pasó, se atendió o se canceló                                                                         |
| `consent_required`               | 422  | Falta el consentimiento expreso del cliente                                                                      |
| `validation_failed`              | 422  | Un dato no vale (`field` dice cuál: rango de más de 13 días, o `document_number` mal formado → volver a pedirlo) |
| `idempotency_mismatch`           | 409  | Misma clave con otro cuerpo; no debería ocurrir (el CRM genera una clave por llamada)                            |
| `api_key_expired`                | 401  | La clave venció: el cliente pide otra y la pega en Ajustes                                                       |
| `api_key_revoked`                | 401  | La clave fue revocada: ídem                                                                                      |
| `rate_limited`                   | 429  | Más de 120/min en Health: esperar y reintentar                                                                   |

La prueba de conexión traduce cualquier 401/403 a «falló la autenticación» (`auth_failed`).

## 6. Pruebas

- Con `fetch` simulado (compuerta): `src/lib/integrations/catalogs/cabbity-health.test.ts`
  (contrato contra el OpenAPI) y `cabbity-health.execute.test.ts` (peticiones exactas).
- Contra el servicio real, opcional: `cabbity-health.live.test.ts`, que se salta si no existe
  `CABBITY_HEALTH_KEY`. La clave se teclea, no se copia a ningún archivo:

  ```bash
  read -rs CABBITY_HEALTH_KEY && export CABBITY_HEALTH_KEY
  npx vitest run src/lib/integrations/catalogs/cabbity-health.live.test.ts
  unset CABBITY_HEALTH_KEY
  ```

  Solo lecturas (`/me`, `/practitioners`, `/availability`, un `lookup` por un teléfono
  inexistente, y un `status=` escalar que Health rechaza con 422). Las escrituras no se prueban contra el centro real: crearían datos reales.

## 7. Deuda

- Filtros de lista estilo PHP (`status[]=`): sin arrays en `params` no hay filtro `status` en
  `list_appointments`; la IA filtra sobre el resultado.
- Paginación automática (hoy el `cursor` se encadena a mano).
- Reutilizar la misma `Idempotency-Key` en reintentos: el ejecutor no reintenta y cada llamada,
  también un reintento del flow o de la IA, lleva clave nueva.
- Guardar `remoteError.code` en `integration_calls` (exige columna y migración).
- `PATCH`/`DELETE /patients/{id}` y el alias `DELETE /appointments/{id}`.
- Campos no secretos por cuenta (p. ej. sede por defecto) y `base_url` por cuenta.
- Importador genérico de OpenAPI (el test de contrato es el sustituto mínimo).
