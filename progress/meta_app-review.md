# Revisión de la app de Meta «Cabbity» (id 869616119418762)

Borrador para pegar en Revisión → Revisión de la aplicación cuando la verificación del
negocio y la de acceso estén aprobadas. Meta revisa en inglés: los textos van en inglés.
Una vez enviado, **no se puede editar ni cancelar**.

Estado al 2026-09-25: app publicada (modo activo); marcada como Tech Provider;
verificación del negocio «Negocio de Brian Polanco» **aprobada** (CABBITY SRL, verificada el
2026-09-23); ícono subido; JS SDK activado para `https://crm.cabbity.com/`.
Configuración de Embedded Signup creada: «Cabbity Embedded Signup»,
`META_CONFIG_ID=4722841751306607` (variación Registro insertado de WhatsApp, token de
usuario del sistema, activo Cuentas de WhatsApp, producto WhatsApp Cloud API, permisos
`whatsapp_business_management` y `whatsapp_business_messaging`). **El token caduca a los 60
días**: Meta solo ofrece la variación de WhatsApp vía plantilla y esa fija la caducidad; el
asistente desde cero no lista «Cuentas de WhatsApp». `META_CONFIG_ID` ya está en el
entorno. La renovación automática la hace el barrido de `GET /api/webhooks/cron`
(migración 067, `src/lib/whatsapp/token-renewal.ts`): en producción ese cron tiene que
estar programado cada minuto con `WEBHOOK_CRON_SECRET`, o los números mueren a los 60 días.

## Descripción general de la app

Cabbity CRM (https://crm.cabbity.com) is a multi-tenant SaaS operated by CABBITY SRL
(Dominican Republic) that lets small and medium businesses manage their WhatsApp Business
conversations: a shared team inbox, contacts and tags, automations, broadcasts to opted-in
contacts, optional AI-drafted replies, and a REST API. Each business connects its own
WhatsApp Business Account through Embedded Signup; Meta bills conversations directly to
that business.

## Por permiso

### whatsapp_business_messaging

Cabbity uses this permission to send and receive WhatsApp messages on behalf of the
businesses that connect their WhatsApp Business Account. Incoming messages arrive through
our webhook and are shown in the business's shared inbox; agents reply from the inbox, and
the business can send approved template messages and broadcasts to contacts who opted in.
Without it the core product (the inbox) cannot work.

### whatsapp_business_management

Cabbity uses this permission to read the phone numbers and display names of the WhatsApp
Business Account the business connected, register the phone number for Cloud API, subscribe
our app to the account's webhooks, and create, list and sync message templates from the
Templates screen. It is used only on accounts the business explicitly shared with us.

### whatsapp_business_manage_events

Used to receive account and template status events (template approval/rejection, phone
number quality and status changes) so the business sees up-to-date template status and
number health in Cabbity.

### manage_app_solution / public_profile

Requested by the WhatsApp use case / Facebook Login for Business flow; public_profile
identifies the Facebook user who completes Embedded Signup.

## Guion del video (screencast, 2–3 min, en inglés o con subtítulos)

1. Abrir https://crm.cabbity.com, iniciar sesión como dueño de una cuenta de prueba.
2. Ajustes → WhatsApp → «Connect with Facebook». Completar Embedded Signup: elegir
   portafolio, crear/elegir la cuenta de WhatsApp, verificar el número.
3. Volver al panel: el número aparece conectado (muestra `whatsapp_business_management`).
4. Desde otro teléfono, escribir al número: el mensaje aparece en la bandeja.
5. Responder desde la bandeja y mostrar que llega al teléfono
   (`whatsapp_business_messaging`).
6. Plantillas: crear una plantilla, sincronizar y mostrar su estado.
7. Mostrar /privacy y /data-deletion.

## URLs

- Privacidad: https://crm.cabbity.com/privacy
- Términos: https://crm.cabbity.com/terms
- Eliminación de datos: https://crm.cabbity.com/data-deletion
