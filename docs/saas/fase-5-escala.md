# Fase 5 — Escala

**Peso**: 2 semanas · **Diferible**

Nada de esta fase hace falta para lanzar. Todo hace falta cuando el
servicio crezca. Está escrita ahora para que las decisiones de las fases
anteriores no la hagan imposible, y para saber qué señal dispara cada
partida.

**Regla**: no se ejecuta por anticipación. Cada punto lista la señal
concreta que indica que llegó su momento.

## 1. Límite de peticiones compartido

**Señal**: se despliega una segunda instancia de la aplicación.

`src/lib/rate-limit.ts` es un `Map` en memoria del proceso. Su propio
comentario de cabecera lo advierte: con escala horizontal —varias
instancias, varias regiones, funciones sin estado— el límite se
multiplica por el número de procesos y deja de limitar.

Hoy, con una sola instancia en Dokploy, funciona correctamente. El día
que haya dos, el límite deja de existir en la práctica.

El módulo está bien diseñado para el cambio: la firma de `check` y la
forma de `RateLimitResult` se mantienen, y solo se sustituye la
implementación por un almacén compartido. **Los puntos de llamada no se
tocan.**

Afecta a los cinco cubos definidos hoy: envío individual, difusión,
reacciones, consulta pública de invitaciones y respuesta automática de
IA por cuenta.

## 2. Cola por empresa para difusiones

**Señal**: una difusión grande degrada la latencia del resto, o un
cliente reporta que sus mensajes salen lentos mientras otro difunde.

Hoy las difusiones se despachan en lotes desde el navegador, con el
asistente llamando a la ruta cada uno o dos segundos. Con un solo
inquilino es aceptable. Con varios, una difusión de veinticinco mil
destinatarios compite por los mismos recursos que las conversaciones en
vivo de las demás empresas.

Hace falta una cola persistente con reparto justo entre empresas, de modo
que el trabajo de una nunca desplace al de otra. La reanudación de
difusiones interrumpidas ya existe (`038_broadcast_resume.sql`), así que
el modelo de estado por destinatario está resuelto: lo que falta es el
despachador.

## 3. Equidad en las tareas programadas

**Señal**: el barrido no termina de drenar la cola entre ejecuciones.

`/api/automations/cron` toma las cincuenta ejecuciones pendientes más
antiguas, sin mirar de quién son. Una empresa que programe mil
ejecuciones a la misma hora acapara todos los barridos siguientes y las
demás no se ejecutan a tiempo.

El arreglo es tomar un cupo por empresa en lugar de las N más antiguas
globales. El mismo razonamiento aplica al barrido de flujos abandonados.

## 4. Recuento de carga materializado

**Señal**: un equipo supera el centenar de operadores.

`pick_available_agent`, de la [fase 1](./fase-1-bandeja.md), cuenta
conversaciones abiertas por candidato con una subconsulta. Con decenas de
operadores es irrelevante y el índice de la fase 0 la cubre. Con
centenares, conviene materializar el recuento.

## Lo que ya está resuelto y no hace falta tocar

Vale la pena registrarlo para que nadie lo «optimice» sin necesidad:

- **Índices de despacho**: la migración 020 ya añadió compuestos
  parciales por `account_id` para las consultas calientes de
  automatizaciones y flujos, precisamente pensando en cuentas
  compartidas.
- **Deduplicación de contactos y conversaciones**: resuelta con índices
  únicos y manejo de carrera en las migraciones 022 y 036.
- **Reanudación de difusiones**: resuelta en la 038.
- **Tope de respuestas de IA**: reclamo atómico vía RPC, correcto bajo
  concurrencia.
