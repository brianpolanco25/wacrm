# Fase 4 — Plataforma y alta de clientes

**Peso**: 2–3 semanas · **Depende de**: fases 0 y 2

Dos bloques sin relación técnica entre sí, agrupados porque ambos son
condición para abrir el registro al público: poder **operar** el servicio
y poder **dar de alta** a un cliente sin que sea desarrollador.

## 1. Una app de Meta, muchas empresas

### El modelo, que ya es el correcto

Es fácil leer el `META_APP_ID` global como una deuda de multiempresa. No
lo es: **es la pieza que hace posible el servicio.**

| Pieza | Dueño | Dónde vive |
|-------|-------|------------|
| App de Meta (identificador y secreto) | **el proveedor** | entorno, una vez |
| Cuenta de WhatsApp Business | cada empresa | `whatsapp_config.waba_id` |
| Número e identificador | cada empresa | `whatsapp_config.phone_number_id` |
| Token de acceso | cada empresa | `whatsapp_config.access_token`, cifrado |

La empresa no necesita app propia: **autoriza la nuestra** para gestionar
su cuenta de WhatsApp Business. Es el rol de proveedor tecnológico que
define Meta.

Si cada empresa tuviera la suya, cada cliente tendría que abrir cuenta de
desarrollador, crear una app, pasar verificación de negocio, configurar
su webhook y pedir revisión de permisos. Es lo que hoy hace quien
autoaloja, y es justamente lo que impide vender esto como servicio.

### La incoherencia que se resuelve aquí

Hoy conviven dos supuestos contradictorios: cada empresa pega el token de
*su* app, mientras que `verifyMetaWebhookSignature` usa **un secreto
global**. Meta firma cada webhook con el secreto de la app dueña del
número, así que con uno solo configurado únicamente se verifican los de
una app y el resto se rechazan — en silencio, porque la función falla
cerrado, que es lo correcto.

El modelo actual solo es coherente en dos escenarios: una instancia por
empresa, o una app nuestra para todas. Esta fase adopta el segundo.

### Lo que hay que construir

El registro integrado: el cliente pulsa «Conectar WhatsApp», se abre el
diálogo de Meta con nuestro identificador de app, inicia sesión, elige o
crea su cuenta de negocio y su número, y recibimos un código que
intercambiamos por un token de acceso a su cuenta.

**La mitad difícil ya está hecha.** La migración
`015_whatsapp_config_registration.sql` implementa las dos llamadas de
registro y suscripción de la cuenta a nuestra app, con seguimiento de
estado, reintentos y diagnóstico. Su comentario dice literalmente que
sirven para hacer el número «enrutable a *nuestra* app»: la arquitectura
ya asumía esto. Falta el diálogo en el navegador y el intercambio de
código por token.

### Simplificación que viene incluida

Con el registro integrado, el webhook se configura **una vez a nivel de
app**, con nuestro propio token de verificación. Las empresas dejan de
configurar webhooks, y el bucle que descifra el token de verificación de
todas las configuraciones en cada llamada de Meta se vuelve código
muerto. El problema de escala anotado en la [fase 2](./fase-2-seguridad.md)
se cierra aquí.

### Varios números por empresa

Retirar el `UNIQUE(account_id)` que la migración 017 puso en
`whatsapp_config` y convertir la relación en uno a varios. Afecta al
selector de número en el envío, a las difusiones y a la interfaz de
configuración. Es lo que justifica el plan Negocio (supuesto S4).

### Criterios de aceptación

- [ ] Una empresa conecta WhatsApp sin salir de la aplicación y sin
      tocar la consola de Meta.
- [ ] Su cuenta queda suscrita a nuestra app y los mensajes entrantes
      llegan enrutados a esa empresa.
- [ ] La verificación de firma funciona con el secreto de nuestra app
      para todos los inquilinos.
- [ ] Una empresa con varios números envía por el que elige y recibe
      correctamente en todos.
- [ ] El modo autoalojado sigue funcionando con app propia (supuesto S5).

### Vía paralela: el trámite con Meta

**Arranca junto con la fase 0, no aquí.** Hace falta verificación de
negocio de la empresa, la app en modo producción y revisión aprobada de
los permisos de gestión y mensajería de WhatsApp Business.

Es trámite, no código, y los plazos no los controlamos. Es el candidato
más probable a marcar la fecha de lanzamiento, y es la única partida de
todo el programa que no se puede acelerar con más manos.

## 2. Panel de plataforma

Hoy no existe rol de super-administrador. No se puede listar cuentas, ver
consumo agregado, suspender a un moroso ni ayudar a un cliente que
reporta un problema. Sin esto no se puede operar un servicio, solo
mantenerlo.

Alcance mínimo:

- **Listado de cuentas**: nombre, plan, estado, miembros, consumo del
  ciclo, fecha de alta, última actividad.
- **Ficha de cuenta**: detalle de consumo, historial de facturación,
  estado de la conexión de WhatsApp.
- **Suspender y reactivar** a mano, independiente de la escalera
  automática de la fase 3.
- **Impersonar** para soporte, **con registro de auditoría**: quién,
  cuándo, qué cuenta y por qué. Sin bitácora, esto es una puerta trasera.

### Diseño

Fuera del modelo de roles de empresa: `account_role_enum` describe roles
**dentro** de una cuenta, y el operador de la plataforma está por encima
de todas. Tabla aparte, `platform_admins`, y rutas bajo su propio prefijo
con su propia guarda.

**No reutilizar el rol `owner` para esto bajo ningún concepto**: mezclaría
el permiso de administrar una empresa con el de administrarlas todas.

### Criterios de aceptación

- [ ] Un administrador de plataforma ve todas las cuentas; un `owner`
      normal no ve más que la suya.
- [ ] Toda impersonación queda registrada con actor, cuenta, momento y
      motivo.
- [ ] Suspender una cuenta corta lo saliente y **no** lo entrante, igual
      que la suspensión automática.
- [ ] Las rutas de plataforma son inaccesibles para cualquier usuario
      que no esté en `platform_admins`, comprobado con prueba.
