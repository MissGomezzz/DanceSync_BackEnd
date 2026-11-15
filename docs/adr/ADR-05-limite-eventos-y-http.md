# ADR-05: Límite de eventos en el Battle Service y límite HTTP en el gateway

| | |
|---|---|
| Estado | Aceptada e implementada |
| Fecha | 15 de noviembre de 2026 |
| Escenario | SEG-3 (protección ante abuso o denegación de servicio) |
| Depende de | [ADR-01: estado en Redis](ADR-01-estado-en-redis.md) (Redis para bloqueos y contadores compartidos) |
| Evidencia | [SEG-3: Protección ante abuso o denegación de servicio](../quality/SEG-3-proteccion-abuso.md) |

## Contexto

Un cliente con una sesión válida, o con un token de invitado que cualquiera puede pedir con el código de una sala, puede abusar de DanceSync de dos formas:

- **Inundar una conexión abierta** con eventos de Socket.IO (chat, votos, respuestas de Word Race). Cada evento pasa por un caso de uso que lee y escribe la sala en Redis y difunde el resultado a toda la sala, así que un solo cliente puede degradar a todos los demás.
- **Inundar con peticiones HTTP**: crear salas, pedir tokens de invitado o abrir conexiones sin parar.

El API Gateway ve las peticiones HTTP y el handshake de Socket.IO, pero no los eventos: una vez abierta la conexión, la reenvía sin leer su contenido. El Battle Service ve los eventos, pero cada réplica solo los de sus propias conexiones, y un cliente bloqueado podría reconectarse a otra réplica.

## Decisión

Limitar en cada capa lo que esa capa ve, con cubos de fichas, y compartir en Redis lo que debe valer en todas las réplicas.

- **Battle Service: eventos por conexión.** Un middleware de Socket.IO (`socket.use`), antes de cualquier manejador, gasta una ficha por evento: 20 por segundo sostenidos y ráfaga de 40. Sin ficha, el evento se descarta, se responde `RATE_LIMITED` si esperaba respuesta y se avisa con `rate:limited` (como máximo una vez por segundo).
- **Battle Service: bloqueo temporal.** Más de 40 eventos descartados en 10 s bloquean 30 s la identidad del token **y** la IP del cliente. El bloqueo se guarda en Redis con expiración propia, el cliente recibe `rate:blocked` y su conexión se cierra, y el handshake rechaza con `BLOCKED` a quien está bloqueado, en cualquier réplica.
- **API Gateway: peticiones por IP.** Un filtro dentro de la cadena de seguridad, después del CORS y antes de la autenticación, aplica un cubo por IP y por tipo de petición (crear sala, token de invitado, handshake, long-polling y el resto) y responde `429` con `Retry-After`. Con `REDIS_URL`, los cubos viven en Redis (un script Lua atómico) y los comparten todas las instancias del gateway.
- **Registro e información.** Cada incidente deja una línea JSON con el formato de la auditoría de SEG-1, y el frontend muestra al usuario cuánto debe esperar.
- **IP real** solo de las entradas de `X-Forwarded-For` que agregan proxies de confianza (`TRUSTED_PROXY_HOPS`).
- **Si Redis falla, se deja pasar** y se registra el error: el limitador no debe convertirse en una caída del servicio.

## Alternativas consideradas

| Alternativa | Por qué se descartó |
|---|---|
| Límite solo en el gateway | No ve los eventos de Socket.IO una vez abierta la conexión, que es justamente donde ocurre la inundación del escenario |
| Límite solo en el Battle Service | No protege la creación de salas ni la emisión de tokens de invitado, que no pasan por una conexión de Socket.IO. Además, el gateway corta una inundación HTTP antes de verificar tokens |
| `RequestRateLimiter` de Spring Cloud Gateway | Es un filtro de ruta: correría después de la cadena de seguridad, así que una inundación con tokens falsos pasaría primero por la verificación de firmas y llenaría la auditoría de SEG-1. Además, dejaría las rutas sin límite si alguien agrega una nueva y olvida el filtro |
| Ventana fija (N eventos por segundo) | Castiga las ráfagas legítimas, como la apertura de una ronda, o deja pasar el doble de eventos en el cambio de ventana |
| Bloquear solo la identidad | Se esquiva pidiendo otro token de invitado |
| Bloquear solo la IP | Castiga más a una red compartida y no sigue al cliente que cambia de red |
| Bloqueo en la memoria de cada réplica | El cliente bloqueado se reconecta a otra réplica y sigue |
| Fallar cerrado si Redis cae | Una caída de Redis dejaría a todos los usuarios fuera |

## Consecuencias

**Positivas**

- Un cliente que inunda queda limitado en menos de medio segundo (422 ms en el peor caso de 50 conexiones) y bloqueado en menos de uno. De 300.000 eventos que intentaría enviar el ataque del escenario, solo se enviaron 4.756.
- Los usuarios normales no tuvieron errores ni batallas afectadas durante el ataque.
- El bloqueo vale en todas las réplicas y no se esquiva cambiando de identidad.
- Se agregó sin modificar los manejadores de eventos ni la autenticación de SEG-1, salvo una línea en cada armado.

**Negativas y riesgos**

- **IP compartida.** Usuarios detrás de la misma red comparten los límites del gateway y un bloqueo de 30 s.
- **`TRUSTED_PROXY_HOPS` debe coincidir con el despliegue.** Si es menor que el número real de proxies, todos los clientes parecen venir del proxy; si es mayor, un cliente puede falsificar su IP.
- **El límite es por conexión.** Un cliente con varias conexiones tiene varios cubos; lo acotan el límite de handshakes del gateway y el bloqueo por identidad e IP.
- **Con Redis caído**, se pierde la protección compartida mientras dure la caída.
- **Valores elegidos sin datos de producción.** Las políticas del gateway (crear sala, token de invitado, handshake) se eligieron holgadas y se ajustan por variables de entorno.
