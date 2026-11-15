# ADR-02: Balanceador con verificaciones de salud y conexión solo por WebSocket

| | |
|---|---|
| Estado | Aceptada. Implementada en el backend y el prototipo local; falta el cambio en el frontend |
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

- **Los clientes se conectan solo por WebSocket** (`transports: ['websocket']` en el cliente de Socket.IO). Sin long-polling no hace falta afinidad de sesión.
- **Un balanceador con verificaciones de salud** delante de las réplicas:
  - **Prototipo local:** nginx (`load-balancer/`) con `least_conn`, que envía cada conexión nueva a la réplica con menos conexiones abiertas. Hace la actualización a WebSocket, usa tiempos de espera de 1 hora para conexiones largas y verificación de salud pasiva: tras 2 fallos en 5 s, la réplica sale de rotación y el siguiente intento va a la otra.
  - **Azure:** el ingreso de Azure Container Apps, con sondeos de salud sobre `GET /api/battles/health`, sin afinidad de sesión.
- **Prueba justa.** El entorno de escala puede enviar tráfico a 1 o a 2 réplicas (`LB_REPLICAS`) con la misma pila, para comparar capacidad cambiando solo esa variable.

## Alternativas consideradas

| Alternativa | Por qué se descartó |
|---|---|
| Long-polling con afinidad de sesión | Ata cada cliente a una réplica por medio de una cookie. Si la réplica cae, la sesión se pierde igual, y el reparto depende de quién llegó primero, no de la carga. Además agrega una cookie que pasa por el API Gateway |
| Un único Battle Service sin balanceador | No hay escalabilidad horizontal ni tolerancia a la caída de una instancia |
| Round robin | Con conexiones de varios minutos, una réplica puede acumular más conexiones abiertas que otra |
| Verificación de salud activa en el prototipo | nginx de código abierto solo tiene verificación pasiva; la activa es de nginx Plus o HAProxy. En Azure la da el ingreso, así que para el prototipo bastó la pasiva |

## Consecuencias

**Positivas**

- No se necesita afinidad de sesión: cualquier réplica atiende cualquier conexión.
- El reparto fue parejo en las pruebas. Con la carga nominal, las dos réplicas recibieron 202 MB y 186 MB de tráfico; en la prueba de estrés usaron en promedio 29,7 % y 29,5 % de CPU.
- Si una réplica cae, los clientes reconectan y el balanceador los envía a la que queda. Como `room:join` es idempotente y el estado está en Redis, retoman la sala (base de DIS-1).

**Negativas y riesgos**

- **Sin respaldo de transporte.** Un cliente detrás de una red que bloquee WebSocket no podrá conectarse, porque ya no hay long-polling de reserva. Se acepta: los navegadores actuales y las redes habituales lo soportan.
- **Detección pasiva en el prototipo.** nginx descubre una réplica caída cuando falla una conexión hacia ella, no con sondeos periódicos.
- **El endpoint de salud no comprueba Redis.** Una réplica sin acceso a Redis seguiría recibiendo tráfico. Hay que agregarlo.
- **El frontend aún no está cambiado.** Hoy arranca con long-polling; con varias réplicas y sin afinidad, esa fase fallaría. Es el cambio pendiente de este ADR.
- **El API Gateway queda en el camino** en producción (Spring Cloud Gateway hace de proxy del WebSocket). Las pruebas de rendimiento entraron directamente por el balanceador, así que falta medir con el gateway.
