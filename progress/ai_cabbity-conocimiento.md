# Asistente de IA de Cabbity: contexto, derivación y base de conocimiento

Material para pegar en Asistentes IA → Setup (contexto e instrucciones, mensaje de
derivación) y en la base de conocimiento (un documento por sección de la parte 3).
Fuente: cabbity.com y sus subpáginas y blog (leídas el 2026-09-25), crm.cabbity.com,
terapiacloud.com y el catálogo de planes del CRM en `supabase/migrations/041`, `059`
y `065`. Horario de atención indicado por el humano: lunes a viernes, 9:00 a 17:00.

Cómo funciona la derivación: el CRM ya instruye al modelo, en modo respuesta
automática, a contestar exactamente `[[HANDOFF]]` cuando no tenga la información o
el cliente pida un humano; entonces envía el "mensaje de derivación" y deja el chat
en la cola de agentes. El contexto de abajo refuerza esa regla y la acota a la base
de conocimiento.

---

## 1. Contexto e instrucciones (campo "Contexto del negocio / instrucciones")

```
Eres el asistente de Cabbity por WhatsApp. Cabbity SRL es una empresa de software
de Santo Domingo, República Dominicana (Jesús de Galíndez 91, Ensanche Ozama).
Desarrolla Cabbity ERP (facturación electrónica e-CF, inventario, compras,
contabilidad), Cabbity CRM (CRM de WhatsApp con agente de IA), TerapiaCloud
(software para centros de fisioterapia) y desarrollo de software a medida.
Atiendes a clientes actuales y a personas interesadas.

Reglas:
1. Responde solo con lo que diga la base de conocimiento o este contexto. Si la
   pregunta no está cubierta, responde exactamente [[HANDOFF]] y nada más. Nunca
   inventes precios, descuentos, fechas, funciones ni plazos.
2. Deriva también con [[HANDOFF]] cuando: pidan hablar con una persona; pidan
   cotización personalizada (plan Corporación, desarrollo a medida, IA a medida);
   sea soporte técnico de una cuenta concreta (errores, accesos, rechazos de la
   DGII, certificados); pidan cambiar, cancelar o pagar un plan; haya una queja o
   reclamo; o pidan asesoría fiscal o legal para su caso particular.
3. Antes de derivar, si la duda sí está en la base, respóndela primero. Si son
   varias preguntas y una no está cubierta, responde las que sí y deriva solo si la
   persona insiste en la que no.
4. Español cordial y cercano, de "tú". Mensajes cortos, de 2 a 5 líneas, sin
   listas largas ni formato de documento. Una idea por mensaje.
5. Cuando encaje, invita a probar gratis 14 días sin tarjeta: app.cabbity.com
   para el ERP y crm.cabbity.com para el CRM. Correo: hola@cabbity.com.
6. Precios en dólares (US$). Si preguntan en pesos, di el equivalente aproximado
   que indique la base y aclara que se calcula a la tasa del Banco Central.
7. El equipo humano atiende de lunes a viernes de 9:00 a. m. a 5:00 p. m., hora
   de República Dominicana. Si preguntan por horario, dilo. No prometas llamadas
   ni tiempos de respuesta.
8. No hables de la competencia ni compares precios con otros sistemas.
```

## 2. Mensaje de derivación (campo "Mensaje al derivar")

```
Gracias por escribirnos. Un miembro del equipo de Cabbity continuará esta
conversación en nuestro horario de atención: lunes a viernes de 9:00 a. m. a
5:00 p. m. Si quieres, deja aquí tu consulta y tu nombre para adelantar.
```

Recomendación de configuración: proveedor Gemini, modelo gemini-3.5-flash-lite,
modo de derivación "cola" o "automático" según haya agentes conectados, máximo 3
respuestas automáticas por conversación (el valor por defecto), y activar el
asistente solo después de cargar la base de conocimiento.

---

## 3. Base de conocimiento (un documento por sección)

Cada bloque `###` es un documento: el título va en "Título" y el texto en
"Contenido". Los párrafos son autocontenidos a propósito: la búsqueda devuelve
fragmentos sueltos y cada uno debe entenderse solo.

### Cabbity: quiénes somos, contacto y horario

Cabbity SRL es una empresa de software con sede en Santo Domingo, República
Dominicana (Jesús de Galíndez 91, Ensanche Ozama). Su lema es "Toda tu empresa.
Un solo sistema". Desarrolla software hecho en y para República Dominicana,
pensado para pymes dominicanas.

Productos de Cabbity: Cabbity ERP (facturación electrónica e-CF, inventario,
compras, ventas y contabilidad en un solo sistema, en app.cabbity.com); Cabbity
CRM (CRM de WhatsApp con bandeja compartida y agente de IA, en crm.cabbity.com);
TerapiaCloud (agenda, fichas y sesiones para centros de fisioterapia y
rehabilitación, en terapiacloud.com); FactiOne (API de facturación electrónica
para desarrolladores, en factione.com); y desarrollo de software a medida.

Contacto de Cabbity: WhatsApp +1 849-352-8096 (wa.me/18493528096), correo
hola@cabbity.com, Instagram @cabbityrd, sitio web cabbity.com.

Horario de atención humana de Cabbity: lunes a viernes de 9:00 a. m. a 5:00 p. m.,
hora de República Dominicana. Fuera de ese horario los mensajes se responden el
siguiente día laborable.

Cómo empezar con Cabbity ERP: crea tu cuenta en app.cabbity.com con el RNC y los
datos de la empresa. Tienes 14 días de prueba gratis sin tarjeta de crédito. El
equipo te acompaña por WhatsApp en la configuración y en tu primera factura
electrónica.

Soporte de Cabbity: el soporte es por WhatsApp, en español, con personas que
conocen los procesos de la DGII. Está incluido en todos los planes.

### Cabbity ERP: planes y precios

Los precios de Cabbity ERP se pagan en dólares (US$). El equivalente en pesos
dominicanos se calcula a la tasa del Banco Central y se revisa una vez al año.
Todos los planes tienen 14 días de prueba gratis sin tarjeta. Se puede pagar
mensual o anual; con el pago anual se regalan 2 meses (pagas 10 de 12).

Plan Emprendedor de Cabbity ERP: US$20 al mes (unos RD$1,195). Incluye hasta 100
e-CF (facturas electrónicas) al mes, 1 usuario, 1 almacén, reportes comerciales de
los últimos 3 meses, facturación electrónica, compras con NCF e ITBIS, contactos
de clientes y suplidores, reportes DGII 606/607/608 sin límite de historial y
soporte por WhatsApp.

Plan Pyme de Cabbity ERP (el recomendado): US$45 al mes (unos RD$2,690). Incluye
hasta 500 e-CF al mes, 3 usuarios, 3 almacenes e historial de reportes ilimitado.
Añade sobre Emprendedor: suplidores, órdenes de compra, recepciones de mercancía y
acceso a los complementos (add-ons).

Plan Empresa de Cabbity ERP: US$85 al mes (unos RD$5,080). Incluye hasta 2,000
e-CF al mes, 8 usuarios, almacenes ilimitados e historial ilimitado. Añade sobre
Pyme: facturas recurrentes y acompañamiento asistido en la puesta en marcha
(onboarding).

Plan Corporación de Cabbity ERP: cotización a medida según volumen. Para 20
usuarios o más, almacenes ilimitados, capacidad de e-CF personalizada y
condiciones negociadas. Se cotiza con el equipo comercial.

Complementos (add-ons) de Cabbity ERP, disponibles desde el plan Pyme, precio
mensual: módulo de contabilidad completa US$30; activos fijos US$12; proyectos
US$12; nómina hasta 10 empleados US$35, hasta 25 empleados US$50, hasta 50
empleados US$75, hasta 100 empleados US$100.

Qué pasa si se supera el límite de facturas del plan en Cabbity ERP: no se bloquea
la facturación. El sistema avisa y se cobran US$0.40 por cada e-CF adicional ese
mes. Siempre puedes subir de plan.

Cómo se cuenta una factura del mes en Cabbity ERP: cada factura de venta creada
en el mes calendario cuenta como una unidad. Editar una factura no suma otra
unidad. Las compras, las cotizaciones, los pagos y el monto facturado no afectan
el conteo. Cabbity no cobra comisión sobre el monto facturado.

Cambios de plan y precio en Cabbity ERP: Cabbity no cambia tu plan ni tu precio
sin que tú lo solicites y apruebes. No hay contratos amarrados: puedes cambiar o
cancelar tu plan cuando quieras.

Roles personalizados en Cabbity ERP: disponibles en todos los planes comerciales.
Permiten perfiles distintos para cajeros, vendedores, administradores y contador,
con permisos a medida.

### Cabbity ERP: facturación electrónica (e-CF) con Cabbity

Cabbity ERP emite comprobantes fiscales electrónicos (e-CF) con firma digital,
timbre y código QR desde el primer día, y registra ventas, compras, inventario y
cobros en el mismo sistema. Cada e-CF se firma y se transmite a la DGII
automáticamente en el momento de emitirla.

Tipos de comprobantes que maneja Cabbity ERP: e-CF de crédito fiscal (E31) y de
consumo (E32), y también las secuencias tradicionales de NCF (B01 crédito fiscal,
B02 consumidor final, B14 regímenes especiales, B15 gubernamental) para quien aún
no ha migrado.

Validaciones antes de enviar a la DGII en Cabbity ERP: el sistema valida el RNC
del cliente y la estructura del documento antes de transmitir, para reducir
rechazos. Si la DGII rechaza un e-CF, el usuario ve el código de error y una guía
para corregir y reenviar. Los estados posibles de la DGII son: Aceptado, Aceptado
condicional, Rechazado y En proceso.

Certificado digital en Cabbity ERP: cargas una vez tu certificado digital en
Cabbity y el sistema firma y transmite cada e-CF automáticamente. El certificado
lo emite una entidad de certificación acreditada por el INDOTEL; tiene fecha de
vencimiento y hay que renovarlo antes de que expire para no interrumpir la
emisión. Cabbity no vende certificados ni fija su precio: eso se gestiona con la
entidad certificadora.

Pasos para empezar a facturar electrónicamente con Cabbity ERP: 1) crear la cuenta
en app.cabbity.com con el RNC (14 días gratis, sin tarjeta); 2) configurar la
empresa y los comprobantes electrónicos con ayuda del soporte por WhatsApp; 3)
emitir la primera e-CF, que se firma, se timbra y se transmite a la DGII sola, y
al mismo tiempo se registran la venta, el inventario y el cobro.

Pruebas de certificación con la DGII usando Cabbity ERP: las pruebas técnicas en
el ambiente de certificación de la DGII se hacen con el mismo sistema de
producción; Cabbity genera el XML, lo firma y lo transmite, y muestra el estado
que responde la DGII en tiempo real.

### Facturación electrónica en República Dominicana: plazos, obligados y sanciones

Qué es un e-CF: el comprobante fiscal electrónico es el documento que sustituye al
NCF en papel. Es una factura, nota de crédito o nota de débito firmada
digitalmente y validada por la DGII en el momento de emitirla. Es un archivo XML
con un e-NCF, firma digital, timbre y un código QR verificable.

Diferencia entre NCF y e-CF: el NCF tradicional se solicita en secuencias, se
emite en papel o PDF y se reporta a la DGII semanas después. El e-CF se genera y
se valida en tiempo real con la DGII, con firma digital, y es verificable al
instante.

Cómo se compone un e-NCF: 13 caracteres. La letra E indica que es electrónico,
luego dos dígitos del tipo de comprobante y diez dígitos de secuencia autorizada.

Tipos de e-CF y su equivalente en papel: E31 crédito fiscal (B01); E32 consumo
(B02); E33 nota de débito (B03); E34 nota de crédito (B04); E41 compras con
retención (B11); E43 gastos menores (B12); E44 regímenes especiales (B13); E45
gubernamental (B14); E46 exportaciones (B15); E47 pagos al exterior (B16/B17). La
mayoría de los negocios usa E31 para ventas entre empresas y E32 para ventas al
consumidor.

Calendario de obligatoriedad de la facturación electrónica en República
Dominicana (Ley 32-23): grandes contribuyentes nacionales desde mayo de 2024;
grandes locales y medianos desde el 15 de noviembre de 2025; pequeños,
microempresas y no clasificados hasta el 15 de noviembre de 2026. La DGII otorgó
el 6 de mayo de 2026 una prórroga automática de seis meses para mipymes y no
clasificados; no hay que solicitarla.

Sanciones por no facturar electrónicamente cuando ya es obligatorio: multas de 5
a 50 salarios mínimos; los comprobantes en papel pierden validez fiscal; y los
clientes no pueden usar esas facturas como crédito fiscal. Cuando el e-CF es
obligatorio para tu categoría, emitir en papel equivale a no facturar.

Cómo convertirse en emisor electrónico autorizado ante la DGII, en cinco pasos:

1. elegir un software homologado que genere, firme y transmita el XML del e-CF;
2. hacer las pruebas técnicas en el ambiente de certificación de la DGII, que
   suelen tomar de una a tres semanas; 3) firmar la declaración jurada de
   cumplimiento; 4) recibir la autorización y los rangos oficiales de e-NCF; 5)
   emitir todas las facturas como e-CF. Requisitos previos: certificado digital de
   una entidad acreditada por el INDOTEL y datos fiscales al día (RNC activo y
   actividad económica correcta).

Cómo se verifica un e-CF: cada e-CF lleva un código QR que enlaza a la página de
verificación de la DGII con el RNC del emisor, el e-NCF, el monto total y un
código de seguridad de seis caracteres derivado de la firma electrónica.

### Cabbity ERP: módulos de facturación, inventario, compras, contabilidad e IA

Módulo de facturación de Cabbity ERP: crea facturas en segundos con plantillas
guardadas; maneja todos los tipos de NCF y e-CF; valida el RNC del cliente
automáticamente; calcula el ITBIS (18 %) solo; guarda el historial completo de
cada cliente; descuenta el inventario al facturar; genera los reportes 606 y 607
de la DGII; y exporta facturas a PDF y Excel. Facturas recurrentes en el plan
Empresa.

Módulo de inventario de Cabbity ERP: stock en tiempo real consultable en
cualquier momento; alertas de reorden con stock mínimo por producto; descuento
automático al facturar; códigos de barras y SKU propios, con lectura desde la
cámara del celular o un lector USB; reportes de existencias, rotación y valoración
exportables a Excel; varios almacenes según el plan (1 en Emprendedor, 3 en Pyme,
ilimitados en Empresa). Pensado para tiendas, colmados, supermercados y negocios
con productos.

Módulo de compras de Cabbity ERP: registro de compras con NCF del suplidor y
cálculo de ITBIS; contactos de suplidores; órdenes de compra y recepciones de
mercancía desde el plan Pyme; alimenta el reporte 606 de la DGII.

Módulo de contabilidad de Cabbity ERP (complemento de US$30 al mes desde el plan
Pyme): estado de situación y estado de resultados con un clic; flujo de caja en
tiempo real; cuentas por cobrar con recordatorios de pago; cuentas por pagar con
vencimientos; asientos automáticos generados por las facturas, sin trabajo manual;
reportes en los formatos que exige la DGII; exportación a PDF y Excel.

Otros complementos de Cabbity ERP: activos fijos (US$12 al mes), proyectos (US$12
al mes) y nómina por tramos de empleados (US$35 hasta 10, US$50 hasta 25, US$75
hasta 50, US$100 hasta 100). Disponibles desde el plan Pyme.

Reportes DGII en Cabbity ERP: los formatos 606 (compras), 607 (ventas) y 608
(anulados) se generan automáticamente, listos para enviar, en todos los planes y
sin límite de historial.

Importar datos a Cabbity ERP: puedes importar clientes, productos e inventario
desde Excel en unos clics, al empezar o cuando lo necesites.

Inteligencia artificial en Cabbity: automatiza trabajo repetitivo y reduce
errores; analiza ventas, gastos y rentabilidad; puede anticipar tendencias y
comportamiento de clientes; y ofrece chatbots de atención por WhatsApp y web. No
requiere conocimientos técnicos. Las soluciones de IA a medida se cotizan según
alcance, volumen de datos e integraciones, definiendo primero el alcance del
proyecto.

### Cabbity ERP para contadores

Programa de contadores de Cabbity: está en preparación. Cabbity quiere hablar con
las primeras firmas contables antes de fijar las condiciones definitivas. Como
referencia se han anunciado comisiones recurrentes por referidos del 10 % con
hasta 5 clientes, 15 % de 6 a 20 y 20 % con 21 o más, pero las condiciones
formales aún no están publicadas. Los contadores interesados escriben a
hola@cabbity.com o por WhatsApp.

Rol de contador en Cabbity ERP (disponible hoy): ver y exportar reportes y datos
contables; crear, ver y editar facturas y compras; cambiar estados de documentos y
registrar pagos; consultar y reenviar e-CF; acceder a nómina, activos y proyectos.
No puede eliminar documentos ni gestionar las credenciales de la DGII.

Cómo accede un contador a la empresa de un cliente en Cabbity ERP: cada cliente
invita al contador a su propia empresa con el rol Contador. El primer usuario
contador está incluido y no consume asientos del plan; un segundo contador sí
consume un asiento. Todavía no existe un panel para manejar varias empresas desde
una sola cuenta: se entra a cada empresa por separado. El panel multiempresa está
en desarrollo.

### Cabbity CRM: CRM de WhatsApp con agente de IA

Qué es Cabbity CRM: un CRM simple y potente para atender clientes por WhatsApp
desde crm.cabbity.com. Tiene bandeja de entrada compartida para el equipo,
contactos y etiquetas, embudos de oportunidades, automatizaciones y flujos,
difusiones a contactos que dieron su consentimiento, plantillas de WhatsApp,
respuestas rápidas, agente de IA con base de conocimiento y respuesta automática,
y una API para desarrolladores.

Cómo conecta un negocio su WhatsApp en Cabbity CRM: desde Ajustes → WhatsApp con
el botón "Conectar con Facebook", sin salir de la aplicación ni entrar al panel
de Meta. Hace falta una cuenta personal de Facebook, un portafolio empresarial
(se puede crear en el mismo paso) y un número de teléfono que no esté registrado
en la app de WhatsApp. Meta cobra las conversaciones directamente al negocio a
través de su portafolio.

Prueba gratis de Cabbity CRM: 14 días con todas las funciones del plan Pro, sin
tarjeta. Al terminar, se elige un plan.

Plan Inicio de Cabbity CRM: US$35 al mes o US$350 al año. Incluye 3 operadores,
2,000 contactos, 3,000 mensajes salientes al mes, 500 respuestas de IA al mes,
difusiones de hasta 2,000 destinatarios, 10 documentos en la base de conocimiento,
1 número de WhatsApp y 12 meses de historial. No incluye API ni webhooks.

Plan Pro de Cabbity CRM: US$100 al mes o US$1,000 al año. Incluye 10 operadores,
10,000 contactos, 15,000 mensajes salientes al mes, 3,000 respuestas de IA al mes,
difusiones de hasta 10,000 destinatarios, 50 documentos en la base de
conocimiento, 1 número de WhatsApp, 24 meses de historial, API para
desarrolladores y webhooks.

Plan Negocio de Cabbity CRM: US$199 al mes o US$1,990 al año. Incluye 30
operadores, 50,000 contactos, 60,000 mensajes salientes al mes, 15,000 respuestas
de IA al mes, difusiones de hasta 50,000 destinatarios, 200 documentos en la base
de conocimiento, hasta 3 números de WhatsApp, historial ilimitado, API, webhooks y
soporte prioritario.

Agente de IA de Cabbity CRM: cada negocio usa su propia clave de OpenAI,
Anthropic o Google Gemini. La IA redacta borradores en la bandeja, puede responder
sola a los clientes y deriva a un humano cuando no sabe la respuesta. Aprende de
la base de conocimiento que carga el negocio.

### Desarrollo de software a medida y otros productos de Cabbity

Desarrollo a medida de Cabbity: aplicaciones web (sistemas, paneles y plataformas),
aplicaciones móviles iOS y Android, chatbots y asistentes con IA, APIs e
integraciones entre sistemas, aplicaciones de escritorio para Windows, Mac y
Linux, y modelos de machine learning y analítica predictiva.

Proceso de un proyecto a medida con Cabbity: descubrimiento (entender el negocio),
diseño (bocetos y prototipos), desarrollo (código limpio con pruebas automáticas)
y despliegue con soporte posterior. Duración orientativa: proyectos pequeños de 2
a 4 semanas; aplicaciones complejas de 2 a 6 meses.

Precio del desarrollo a medida en Cabbity: no hay tarifa fija. Cabbity trabaja con
presupuestos adaptados a pymes dominicanas, desde proyectos pequeños hasta
soluciones empresariales. Cada proyecto se cotiza tras definir el alcance;
escribe a hola@cabbity.com.

TerapiaCloud, de Cabbity: sistema en la nube para centros de fisioterapia y
rehabilitación. Organiza la agenda, las fichas de pacientes y las sesiones, con
reserva de citas asistida por IA por chat. Acceso en app.terapiacloud.com; demos y
precios se solicitan a hola@cabbity.com.

FactiOne, de Cabbity: API de facturación electrónica (e-CF) para desarrolladores y
empresas que quieren integrar la emisión de comprobantes electrónicos en sus
propios sistemas. Más información en factione.com o escribiendo a
hola@cabbity.com.

### Preguntas frecuentes sobre Cabbity

¿Cabbity cambia mi plan o mi precio automáticamente? No. Cabbity no cambia tu plan
ni tu precio sin que tú lo solicites y lo apruebes.

¿Qué pasa si supero el límite de facturas de mi plan de Cabbity ERP? No se bloquea
nada: el sistema te avisa y cobra US$0.40 por cada e-CF adicional ese mes.

¿Necesito tarjeta para probar Cabbity? No. La prueba de 14 días de Cabbity ERP y
de Cabbity CRM es gratis y sin tarjeta.

¿Puedo cancelar cuando quiera? Sí. No hay contratos amarrados; puedes cambiar o
cancelar tu plan cuando quieras.

¿Cabbity cobra comisión sobre lo que facturo? No. Pagas un plan mensual según la
cantidad de facturas, no un porcentaje del monto facturado.

¿En qué moneda se paga Cabbity? En dólares (US$). El equivalente en pesos se
calcula a la tasa del Banco Central y se revisa una vez al año.

¿Cabbity me ayuda a configurar la facturación electrónica? Sí. El soporte por
WhatsApp te acompaña en la configuración y en tu primera e-CF. El plan Empresa
incluye acompañamiento asistido en la puesta en marcha.

¿Hasta cuándo tengo para facturar electrónicamente? Pequeños contribuyentes,
microempresas y no clasificados tienen hasta el 15 de noviembre de 2026. Los
medianos y grandes locales desde el 15 de noviembre de 2025 y los grandes
nacionales desde mayo de 2024.

¿Cabbity me vende el certificado digital? No. El certificado lo emite una entidad
acreditada por el INDOTEL; tú lo cargas en Cabbity y el sistema firma con él.

¿Puedo traer mis datos de otro sistema a Cabbity ERP? Sí: importas clientes,
productos e inventario desde Excel.

¿Cuál es el horario de atención de Cabbity? Lunes a viernes de 9:00 a. m. a 5:00
p. m., hora de República Dominicana, por WhatsApp (+1 849-352-8096) y correo
(hola@cabbity.com).
