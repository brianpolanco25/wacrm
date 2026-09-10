# Fase 2 — Cierre de seguridad

**Peso**: 2 semanas · **Puerta: bloquea el lanzamiento comercial**

Nada de esta fase añade valor visible al cliente. Toda ella es la
diferencia entre alojar tus propios datos y alojar los de otras empresas.
No se abre el registro público sin esto cerrado.

## 1. Adjuntos privados

### Problema

Los buckets `chat-media` (`023_chat_media.sql`) y `flow-media`
(`016_flow_media.sql`) se crean con `public = TRUE` y una política de
lectura que es literalmente:

```sql
CREATE POLICY "Chat media is publicly readable"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'chat-media');
```

Las **escrituras** sí están acotadas por empresa: el primer segmento de
la ruta debe ser `account-<uuid>` de una cuenta a la que pertenece quien
sube. Las **lecturas** no lo están en absoluto: cualquiera con la URL lee
el adjunto de cualquier empresa.

En un producto autoalojado es un compromiso defendible y está documentado
en la propia migración: el bucket es público **porque Meta necesita
descargar el archivo** cuando enviamos multimedia saliente. Alojando
datos de clientes ajenos —facturas, documentos de identidad, notas de
voz— deja de serlo.

### Cambio

**Romper la dependencia con Meta primero.** Antes de cerrar el bucket hay
que dejar de darle URLs públicas: se sube el archivo a Meta y se envía
por identificador de medio, que es el camino que Meta recomienda y que
además evita que su descarga falle por latencia o por un dominio nuevo
sin reputación.

Orden de trabajo, que importa:

1. Cambiar el envío saliente a subida por identificador de medio.
   Verificar en producción que los envíos siguen llegando.
2. Solo entonces, `public = FALSE` en ambos buckets y sustituir la
   política de lectura por una acotada a miembros de la cuenta dueña de
   la ruta, con la misma forma que ya tienen las de escritura.
3. La interfaz pasa a pedir URLs firmadas de vida corta. Ya existe
   `use-media-blob-url.ts`, que es el punto natural donde engancharlo.

**Rutas heredadas.** La migración 020 dejó escribibles las rutas antiguas
con forma `<auth.uid()>/...` por compatibilidad. La política de lectura
nueva tiene que cubrirlas también, o los adjuntos viejos dejan de verse.
Merece un paso de migración de rutas o una cláusula explícita.

### Criterios de aceptación

- [ ] Un adjunto de la empresa A no es descargable por un usuario de la
      empresa B, ni autenticado ni con la URL directa.
- [ ] Un adjunto sigue siendo visible para los miembros de su empresa.
- [ ] Los envíos multimedia salientes a WhatsApp siguen funcionando.
- [ ] Los adjuntos subidos antes del cambio siguen viéndose.
- [ ] Las URLs firmadas caducan y una caducada devuelve 403.

## 2. Pruebas de fuga entre empresas

### Problema

El webhook, las rutas de `/api/v1` y las tareas programadas usan el
cliente de rol de servicio, que **salta la RLS por completo**. El
aislamiento ahí no lo garantiza la base de datos: depende de que cada
consulta lleve su `.eq('account_id', …)` escrito a mano.

La disciplina está documentada de forma explícita en
`src/lib/auth/api-context.ts` y hoy se respeta. Pero con quinientos
inquilinos, un filtro olvidado en una ruta nueva es una fuga entre
empresas, y no hay nada que lo detecte.

### Cambio

Una batería de pruebas dedicada que, para **cada** ruta que use el
cliente de rol de servicio, monte dos cuentas con datos y verifique que
un actor de la empresa A no puede leer ni escribir nada de la B.

Cobertura mínima: todas las rutas bajo `/api/v1`, el webhook de WhatsApp,
`/api/whatsapp/send`, `/api/whatsapp/broadcast`, las dos tareas
programadas y las rutas de IA.

El objetivo no es solo encontrar fugas hoy —probablemente no las haya—
sino **que añadir una ruta sin filtro rompa la suite**. Es una prueba de
regresión sobre una propiedad, no una auditoría puntual.

Complemento barato: una regla de ESLint que marque el uso del cliente
administrador en un archivo bajo `src/app/api/` que no contenga
`account_id`. Ruidosa, pero convierte el olvido en un fallo de CI.

### Criterios de aceptación

- [ ] Existe al menos una prueba de fuga por ruta que usa rol de
      servicio.
- [ ] Quitar a mano un `.eq('account_id', …)` de cualquier ruta hace
      fallar la suite.
- [ ] La suite corre en CI dentro del `npm test` actual.

## 3. Rotación de la clave de cifrado

### Problema

`ENCRYPTION_KEY` es única y global: cifra los tokens de WhatsApp y las
claves de proveedor de IA de **todas** las empresas. Se lee al cargar el
módulo en `src/lib/whatsapp/encryption.ts`, así que cambiarla exige
reiniciar el proceso.

Hoy no hay forma de rotarla sin dejar indescifrable todo lo guardado. La
propia interfaz ya contempla el síntoma: la ruta de configuración de
WhatsApp devuelve un `token_corrupted` con instrucciones de reconectar.
Con un cliente eso es una molestia; con quinientos es un incidente.

### Cambio

Cifrado versionado. El formato actual es `<iv>:<ct>:<tag>` para GCM y
`<iv>:<ct>` para el CBC heredado, y `decrypt()` ya distingue por número
de partes. Se añade un prefijo de versión de clave, de modo que
`decrypt()` sepa con cuál descifrar y `encrypt()` use siempre la vigente.

Con eso, la rotación es: publicar la clave nueva junto a la vieja, cifrar
lo nuevo con la nueva, recifrar lo viejo en segundo plano, retirar la
vieja.

No hace falta ejecutar una rotación en esta fase. Hace falta **poder
hacerla** antes de tener clientes, porque después ya no hay ventana.

### Criterios de aceptación

- [ ] Con dos claves configuradas, se descifra lo cifrado con cualquiera
      de las dos.
- [ ] Lo nuevo se cifra siempre con la vigente.
- [ ] Los valores en formato antiguo, sin prefijo de versión, se siguen
      descifrando.
- [ ] Existe un procedimiento de recifrado ejecutable y documentado.

## 4. El bucle de verificación del webhook

### Problema

El `GET` del webhook de WhatsApp recorre **todas** las configuraciones y
descifra el token de verificación de cada una hasta encontrar la que
coincide. Correcto con diez inquilinos; caro con cinco mil, y cada
descifrado es trabajo criptográfico.

### Cambio

Depende del supuesto S5, sobre mantener el modo autoalojado:

- **En modo servicio**, el problema desaparece solo en la fase 4: con el
  registro integrado, el webhook se configura una vez a nivel de app con
  nuestro propio token de verificación, y las empresas dejan de tener
  uno. El bucle se vuelve código muerto.
- **En modo autoalojado**, hay una sola configuración y el bucle es
  trivial.

Por tanto, aquí no se optimiza: se **acota**. Se añade un camino corto
que use el token de verificación de la plataforma cuando esté definido, y
se deja el bucle como reserva para el modo autoalojado.

Registrarlo aquí y resolverlo en la fase 4 es deliberado: optimizar ahora
un bucle que va a desaparecer sería trabajo tirado.

### Criterios de aceptación

- [ ] Con el token de plataforma definido, la verificación no consulta la
      tabla de configuraciones.
- [ ] Sin él, el comportamiento actual se mantiene intacto.

## Nota sobre lo que esta fase no arregla

El modo autoalojado sigue teniendo `META_APP_SECRET` global mientras cada
inquilino trae tokens de su propia app de Meta — una combinación que solo
es coherente con una instancia por empresa. No se arregla porque en modo
servicio deja de existir: todos los inquilinos pasan a estar bajo la
misma app. Ver [fase 4](./fase-4-plataforma.md).
