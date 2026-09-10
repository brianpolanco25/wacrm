# Fase 3 — Facturación con PayPal

**Peso**: 3–4 semanas · **Depende de**: fase 0

Enciende el ingreso. El modelo de datos y la capa de permisos ya existen
desde la fase 0; aquí se conecta la pasarela y se empiezan a aplicar los
límites.

## Fuera de alcance

- Impuestos. El ITBIS se calcula y declara aparte; la página de precios
  indica si el importe lo incluye.
- Facturación por consumo medido. PayPal no la soporta y no se emula:
  se venden cuotas fijas con tope duro y paquetes adicionales de compra
  única.
- Prorrateo. Ver más abajo.

## 1. Catálogo en PayPal

Un producto y **seis planes de facturación**: tres niveles por dos ciclos
(mensual y anual). Se crean una vez, contra el entorno de pruebas
primero, y sus identificadores se guardan en `plans` en columnas nuevas
`provider_plan_id_month` y `provider_plan_id_year`.

Los planes de PayPal son en gran medida inmutables una vez tienen
suscriptores. Cambiar precio significa crear un plan nuevo y migrar a los
clientes nuevos, dejando a los existentes en el viejo. **Conviene no
publicar precios hasta tenerlos decididos.**

## 2. Contratación

1. El cliente elige plan en la aplicación.
2. El backend crea la suscripción contra PayPal y recibe un enlace de
   aprobación.
3. Se redirige al cliente a PayPal.
4. El cliente aprueba y vuelve a nuestra URL de retorno.

### La trampa que hay que evitar

**La verdad viene del webhook, no de la redirección de vuelta.**

El cliente puede cerrar el navegador después de aprobar y antes de
volver. Si el plan se activa en la URL de retorno, habrá clientes que
pagaron y no tienen servicio; y peor, un atacante que llame a esa URL a
mano se regala el plan.

La página de retorno **solo informa**: «estamos confirmando tu pago».
Quien activa es el evento. Cuando el webhook llega, la interfaz se
actualiza sola.

## 3. Webhook

### Eventos

| Evento | Efecto |
|--------|--------|
| `BILLING.SUBSCRIPTION.ACTIVATED` | `status = active`, fijar `current_period_end` |
| `BILLING.SUBSCRIPTION.UPDATED` | reconciliar plan y cantidad |
| `BILLING.SUBSCRIPTION.CANCELLED` | `cancel_at_period_end`, servicio hasta fin de ciclo |
| `BILLING.SUBSCRIPTION.SUSPENDED` | `status = suspended` |
| `BILLING.SUBSCRIPTION.PAYMENT.FAILED` | `status = past_due`, `grace_until = now() + 7d` |
| `PAYMENT.SALE.COMPLETED` | renovación: extender `current_period_end`, volver a `active` |

### Verificación de firma

PayPal **no** firma con HMAC. Hay que llamar a su endpoint de
verificación pasándole las cinco cabeceras `paypal-transmission-*`, el
identificador del webhook y **el cuerpo crudo sin parsear**.

En un manejador de ruta de Next eso significa `await request.text()`
antes de tocar el JSON. Es exactamente el patrón que el repositorio ya
usa para el webhook de Meta en `verifyMetaWebhookSignature`; se reutiliza
la forma, no el algoritmo.

Fallar cerrado: sin verificación posible, se rechaza.

### Idempotencia

PayPal reenvía eventos. El flujo es: insertar en `billing_events` con
`UNIQUE (provider, provider_event_id)` **antes** de procesar; si el
insert choca, ya se procesó y se devuelve 200 sin hacer nada.

Los eventos pueden llegar **desordenados**. Cada manejador comprueba
coherencia antes de escribir en vez de asumir secuencia: un
`PAYMENT.SALE.COMPLETED` que llegue antes que su `ACTIVATED` no debe
dejar la suscripción en un estado imposible.

## 4. Aplicar los límites

Ocho puntos, todos donde ya hay un `requireRole` al que sumar la
comprobación.

| Punto | Métrica o prestación |
|-------|----------------------|
| `POST /api/account/invitations` | límite `operators` |
| `/api/whatsapp/send` y `engineSendText` | `messages_out` |
| `/api/whatsapp/broadcast` | `broadcast_recipients` |
| `dispatchInboundToAiReply` | `ai_replies` + prestación `ai_autoreply` |
| `requireApiKey` en `/api/v1` | prestación `api` |
| `/api/v1/webhooks` | prestación `webhooks` |
| `/api/whatsapp/config` | límite `numbers` |
| `/api/ai/knowledge` | límite `knowledge_documents` |

Los contadores se incrementan con `increment_usage`, la RPC atómica de la
fase 0, **después** de que la acción tenga éxito. Contar antes inflaría
el consumo con intentos fallidos.

### La regla que no se negocia

**Lo entrante nunca se bloquea.**

Aunque la suscripción esté vencida, el webhook sigue recibiendo y
guardando los mensajes de los clientes. Lo que se corta es lo saliente:
enviar, difundir y la IA.

Perder el mensaje de un cliente por una factura impaga es un daño que no
se repara, y además rompería la relación del inquilino con Meta, que es
quien de verdad le cobra las conversaciones.

## 5. Escalera de vencimiento

```
active
  └─ fallo de pago → past_due (7 días de gracia, aviso en la app)
       └─ suspended: solo lectura · entrante sigue llegando
            └─ a los 60 días: se ofrece exportación
```

**Nunca se borran datos automáticamente.** La exportación se ofrece; la
eliminación la pide el cliente.

En `suspended`, la cuenta se comporta como si todos sus miembros fueran
`viewer`, con un aviso persistente y un botón para regularizar. No se
tocan sus roles reales: se resuelve en la capa de permisos, para que al
reactivar todo vuelva solo.

## 6. Área de suscripción

En Ajustes, visible para `admin`+:

- Plan actual, estado y próxima fecha de cobro.
- Consumo del ciclo por métrica, contra el límite, con barras. Sale
  directo de `usage_counters`.
- Recibos.
- Cambiar de plan, cancelar, reactivar.

## Lo que PayPal no hace, y cómo se rodea

| Limitación | Decisión de diseño |
|------------|--------------------|
| Sin prorrateo | Los cambios de plan se aplican **al renovar**. Subir de plan a mitad de ciclo cobra el ciclo nuevo completo, avisándolo antes con claridad. |
| Subir de plan puede exigir re-aprobación | Otra redirección a PayPal. La interfaz contempla ese estado intermedio; no se asume cambio instantáneo. |
| Sin consumo medido | Cuotas fijas con tope duro. Los excedentes son paquetes de compra única, no facturación variable. |
| Sin motor de impuestos | Fuera de alcance. |
| No liquida en pesos dominicanos | Se factura en dólares. |

La columna `provider` de `subscriptions` existe justamente por esto: si
más adelante hace falta cobrar con tarjeta —que en algunos mercados
convierte bastante mejor— se añade un proveedor sin tocar la capa de
permisos ni las rutas.

## Criterios de aceptación

- [ ] Un webhook con firma inválida se rechaza.
- [ ] El mismo evento entregado dos veces se procesa una sola vez.
- [ ] Cerrar el navegador tras aprobar en PayPal activa igualmente la
      suscripción cuando llega el evento.
- [ ] La URL de retorno **no** activa nada por sí sola.
- [ ] Superar `messages_out` bloquea el envío con un error que dice qué
      límite se alcanzó y cómo ampliarlo.
- [ ] Una cuenta `suspended` **sigue recibiendo** mensajes entrantes.
- [ ] Una cuenta `suspended` no puede enviar, difundir ni usar IA.
- [ ] Un usuario autenticado no puede modificar su propia suscripción ni
      sus contadores, comprobado contra la RLS.
- [ ] El consumo mostrado coincide con `usage_counters`.
- [ ] Todo el flujo se prueba de extremo a extremo en el entorno de
      pruebas de PayPal, incluidos fallo de pago y cancelación.

## Variables de entorno nuevas

```
PAYPAL_CLIENT_ID
PAYPAL_CLIENT_SECRET
PAYPAL_WEBHOOK_ID          # necesario para verificar la firma
PAYPAL_ENV                 # sandbox | live
```

Todas de servidor. Ninguna se incrusta en la imagen: van como entorno de
ejecución en Dokploy, igual que el resto de secretos.
