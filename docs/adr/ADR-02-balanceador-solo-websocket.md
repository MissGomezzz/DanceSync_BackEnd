# ADR-02: Balanceador con verificaciones de salud y conexión por WebSocket sin afinidad de sesión

| | |
|---|---|
| Estado | Aceptada e implementada (backend, prototipo local y frontend) |
| Fecha | 14 de noviembre de 2026 |
| Escenarios | REN-1 (rendimiento y latencia), DIS-1 (disponibilidad) |
| Depende de | [ADR-01: estado de salas y rondas en Redis](ADR-01-estado-en-redis.md) |
| Evidencia | [REN-1: Rendimiento y latencia en tiempo real](../quality/REN-1-rendimiento-latencia.md) |

## Contexto

Con el estado en Redis (ADR-01), cualquier réplica del Battle Service puede atender cualquier conexión. Falta algo que reparta las conexiones entre réplicas y deje de enviarle tráfico a una réplica caída.

El transporte de Socket.IO condiciona cómo se reparte. Por defecto el cliente empieza con **long-polling** (varias peticiones HTTP seguidas) y luego sube a WebSocket. Con varias réplicas, todas las peticiones de una sesión de long-polling deben llegar a la misma réplica, la que creó la sesión; si no, el servidor responde "sesión desconocida". Eso obliga a usar **afinidad de sesión** (sticky sessions) en el balanceador.

Una conexión **WebSocket**, en cambio, es una sola conexión TCP que vive en una réplica de principio a fin. No necesita afinidad.

Las conexiones de una batalla duran minutos. Repartir por turno (round robin) cuenta conexiones nuevas, no conexiones abiertas, y puede dejar una réplica más cargada que otra.

## Decisión

- **Los clientes se conectan por WebSocket desde el inicio**, con long-polling solo como respaldo: `transports: ['websocket', 'polling']` y `tryAllTransports: true` en el cliente de Socket.IO (`DanceSync_FrontEnd`, `src/shared/lib/socket.ts`). En el caso normal no hay ninguna petición de long-polling, así que no hace falta afinidad de sesión. Si WebSocket no está disponible, el cliente cae a long-polling en lugar de no conectarse.
- **Un balanceador con verificaciones de salud** delante de las réplicas:
  - **Prototipo local:** nginx (`load-balancer/`) con `least_conn`, que envía cada conexión nueva a la réplica con menos conexiones abiertas. Hace la actualización a WebSocket, usa tiempos de espera de 1 hora para conexiones largas y verificación de salud pasiva: tras 1 fallo (conexión rechazada o sin respuesta en 2 s) la réplica sale de rotación por 10 s y el mismo intento se repite en la otra (ajustado por DIS-1, ver [ADR-06](ADR-06-availability-failover.md)).
  - **Azure:** el ingreso de Azure Container Apps, con sondeos de salud sobre `GET /api/battles/health` (vida) y `GET /api/battles/health/ready` (lista: Redis responde; DIS-1), sin afinidad de sesión.
- **Prueba justa.** El entorno de escala puede enviar tráfico a 1 o a 2 réplicas (`LB_REPLICAS`) con la misma pila, para comparar capacidad cambiando solo esa variable.

## Alternativas consideradas

| Alternativa | Por qué se descartó |
|---|---|
| Long-polling con afinidad de sesión | Ata cada cliente a una réplica por medio de una cookie. Si la réplica cae, la sesión se pierde igual, y el reparto depende de quién llegó primero, no de la carga. Además agrega una cookie que pasa por el API Gateway |
| Solo WebSocket (`transports: ['websocket']`) | Fue la configuración inicial del frontend y se quitó durante la integración, porque no conecta donde WebSocket no está disponible (por ejemplo, en un entorno que instrumenta el objeto `WebSocket` global). La opción elegida da el mismo resultado en el caso normal y conserva el respaldo |
| Transportes por defecto (long-polling que sube a WebSocket) | Era la configuración vigente. Cada conexión empieza con peticiones de long-polling (4 en la verificación), que con varias réplicas y sin afinidad pueden llegar a una réplica que no conoce la sesión |
| Un único Battle Service sin balanceador | No hay escalabilidad horizontal ni tolerancia a la caída de una instancia |
| Round robin | Con conexiones de varios minutos, una réplica puede acumular más conexiones abiertas que otra |
| Verificación de salud activa en el prototipo | nginx de código abierto solo tiene verificación pasiva; la activa es de nginx Plus o HAProxy. En Azure la da el ingreso, así que para el prototipo bastó la pasiva |

## Verificación del transporte

Con `socket.io-client` 4.8.3 contra un servidor Socket.IO, contando las peticiones HTTP de long-polling que recibe el servidor:

| Configuración del cliente | Servidor que acepta WebSocket | Entorno sin WebSocket |
|---|---|---|
| Por defecto (la anterior) | Conecta, después de 4 peticiones de long-polling | Conecta por long-polling |
| Solo `['websocket']` | Conecta, 0 peticiones de long-polling | No conecta |
| `['websocket', 'polling']` con `tryAllTransports` (la elegida) | **Conecta, 0 peticiones de long-polling** | **Conecta por long-polling** |

Sin `tryAllTransports`, el orden `['websocket', 'polling']` no cae al segundo transporte cuando falla el primero. Una prueba del frontend (`socket.test.ts`) fija la configuración y falla con la anterior.

## Consecuencias

**Positivas**

- No se necesita afinidad de sesión: cualquier réplica atiende cualquier conexión.
- El reparto fue parejo en las pruebas. Con la carga nominal, las dos réplicas recibieron 202 MB y 186 MB de tráfico; en la prueba de estrés usaron en promedio 29,7 % y 29,5 % de CPU.
- Si una réplica cae, los clientes reconectan y el balanceador los envía a la que queda. Como `room:join` es idempotente y el estado está en Redis, retoman la sala (base de DIS-1).

**Negativas y riesgos**

- **El respaldo necesita afinidad.** Un cliente que no pueda usar WebSocket cae a long-polling, y con varias réplicas sin afinidad esa conexión puede fallar. Se acepta: es un caso raro, y sin el respaldo ese cliente no se conectaría de ninguna forma.
- **Detección pasiva en el prototipo.** nginx descubre una réplica caída cuando falla una conexión hacia ella, no con sondeos periódicos.
- ~~**El endpoint de salud no comprueba Redis.**~~ Resuelto en DIS-1: `GET /api/battles/health/ready` responde 503 si Redis no contesta ([ADR-06](ADR-06-availability-failover.md)).
- **El API Gateway queda en el camino** en producción (Spring Cloud Gateway hace de proxy del WebSocket). Las pruebas de rendimiento entraron directamente por el balanceador, así que falta medir con el gateway.
