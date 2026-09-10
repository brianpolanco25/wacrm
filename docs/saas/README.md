# Programa SaaS — índice de especificaciones

Conversión de wacrm de plantilla autoalojada a servicio multiempresa con
cobro. Este directorio es la fuente de verdad del programa: cada fase es
un documento, y cada documento debería resolverse en uno o dos PR.

El resumen ejecutivo para compartir fuera del equipo vive aparte, como
página publicada. Estos documentos son la versión de ingeniería.

## Estado del punto de partida

El aislamiento por empresa **ya está construido** y no se toca: la
migración `017_account_sharing.sql` puso `account_id` en las 36 tablas,
reescribió toda la RLS sobre `is_account_member()` y montó los cuatro
roles. El enrutado del webhook de Meta por `phone_number_id` ya resuelve
a qué empresa pertenece cada mensaje entrante.

Lo que falta no es arquitectura de datos. Es capa comercial, tres huecos
de operación en la bandeja y un cierre de seguridad.

## Fases

| Fase | Documento | Peso | Puerta |
|------|-----------|------|--------|
| 0 | [Cimientos](./fase-0-cimientos.md) | 1 sem | bloquea todo lo demás |
| 1 | [Operación de la bandeja](./fase-1-bandeja.md) | 1,5 sem | — |
| 2 | [Cierre de seguridad](./fase-2-seguridad.md) | 2 sem | **bloquea el lanzamiento** |
| 3 | [Facturación con PayPal](./fase-3-facturacion.md) | 3–4 sem | inicio del ingreso |
| 4 | [Plataforma y alta de clientes](./fase-4-plataforma.md) | 2–3 sem | — |
| 5 | [Escala](./fase-5-escala.md) | 2 sem | diferible |

**Secuencia de salida sugerida.** Fases 0, 1 y 2 → beta cerrada con cinco
empresas sin cobrar. Ahí se mide el consumo real de IA y de mensajes, que
es lo que convierte los números de los planes en decisiones informadas.
Después la fase 3 enciende el cobro sobre clientes que ya usan el
producto, y la fase 4 abre el registro público.

## Vía paralela que no depende de nosotros

**Verificación de negocio ante Meta.** Para operar como proveedor hace
falta la verificación de la empresa, la app en modo producción y revisión
aprobada de los permisos de gestión y mensajería de WhatsApp Business. Es
trámite, no código, y los plazos no los controlamos. Arranca junto con la
fase 0 porque tiene todas las papeletas de marcar la fecha de
lanzamiento. Detalle en [fase 4](./fase-4-plataforma.md).

## Decisiones tomadas

Estas están cerradas y los specs las dan por hechas.

1. **Una empresa = un espacio de trabajo aislado.** No hay pertenencia
   múltiple: un usuario pertenece a una sola empresa. Es el invariante
   que ya impone `idx_accounts_one_per_owner` y la RPC de invitaciones.
2. **Un administrador y varios operadores.** Mapea a los roles que ya
   existen: `owner`/`admin` administran, `agent` opera, `viewer` observa.
3. **Bandeja compartida.** Todos los operadores ven todos los chats de su
   empresa. No se segmenta la visibilidad; se indica quién atiende cada
   conversación.
4. **La IA atiende primero cuando está configurada.** Si no lo está, los
   chats caen sin atender para que los tome un operador.
5. **La IA cede a un humano** cuando la pregunta se sale de su base de
   conocimiento, y la cesión va al operador disponible con menos carga.
6. **Cobro con PayPal**, facturado en dólares.

## Supuestos que aplican estos specs

No están confirmados. Están escritos como recomendación y **cambiarlos es
barato ahora y caro después**. Si alguno no coincide con la intención,
corrígelo aquí y los documentos que dependen de él lo señalan.

| # | Supuesto | Alternativa | Impacto si cambia |
|---|----------|-------------|-------------------|
| S1 | **La IA la paga el servicio**, con cuota por plan. La clave del proveedor de modelos la ponemos nosotros. | Cada empresa trae su propia clave, como hoy. | Fases 0 y 3. Pedirle a una PYME que abra cuenta en OpenAI hunde la conversión del plan que más queremos vender. |
| S2 | **El operador no lanza difusiones ni edita automatizaciones.** Esas pasan a requerir `admin`. | Se queda como hoy, donde `agent` puede ambas cosas. | Fase 1, cuatro políticas RLS y un predicado. |
| S3 | **Prueba de 14 días sin tarjeta**, no plan gratuito permanente. | Nivel gratuito eterno con límites bajos. | Fase 3. |
| S4 | **Un número de WhatsApp por empresa** hasta la fase 4. | Varios números desde el lanzamiento. | Fase 4. Hoy hay un `UNIQUE(account_id)` en `whatsapp_config`. |
| S5 | **Se mantiene el modo autoalojado** junto al modo servicio, separados por una bandera de despliegue. | Solo modo servicio. | Fases 2 y 4. Preserva el proyecto abierto y cuesta poco. |

## Convenciones

- **Migraciones**: numeración correlativa desde `040`, idempotentes, y
  validadas por el workflow `migrations.yml` contra una base limpia. Se
  aplican siempre con `--local` en desarrollo; contra un proyecto remoto,
  se pregunta antes.
- **Criterios de aceptación**: cada spec lista los suyos en forma
  verificable. Un PR no cierra su fase hasta que todos pasan.
- **Pruebas**: vitest, junto al código. No hay end-to-end en este
  proyecto; no lo propongas como si existiera.
- **Aislamiento**: cualquier ruta nueva que use el cliente de rol de
  servicio filtra por `account_id` a mano y lleva su prueba de fuga entre
  empresas. La RLS no protege ahí.
