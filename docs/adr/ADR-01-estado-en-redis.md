# ADR-01: Externalizar el estado de salas y rondas a Redis

| | |
|---|---|
| Estado | Aceptada e implementada |
| Fecha | 14 de noviembre de 2026 |
| Escenarios | REN-1 (rendimiento y latencia), DIS-1 (disponibilidad); base para SEG-3 (contadores y bloqueos compartidos) |
| Evidencia | [REN-1: Rendimiento y latencia en tiempo real](../quality/REN-1-rendimiento-latencia.md) |

## Contexto

El Battle Service era una sola instancia que guardaba en memoria el estado de las salas, de las batallas y de la carrera de palabras (Word Race). Con ese diseño:

- No se puede agregar una segunda réplica: cada una tendría su propia copia de las salas, y los jugadores de una misma sala que caigan en réplicas distintas no se verían.
- Si el proceso cae, se pierden todas las salas y los puntajes de las batallas en curso.
- Una difusión (`io.to(sala).emit`) solo llega a los sockets del propio proceso.

REN-1 pide demostrar escalabilidad horizontal (2 réplicas sostienen más usuarios que 1) y DIS-1 pide conservar las salas si cae una réplica. Las dos cosas exigen que el estado viva fuera de las réplicas.

El dominio ya estaba preparado. Los puertos `RoomRepository` y `WordRaceRepository` definen operaciones atómicas en lugar de un `save` ciego: `update(code, mutate)` con concurrencia optimista por versión para las salas, y compare-and-set (`openRound`, `claimRound`, `expireRound`) para las rondas. La regla "un único ganador por ronda" ya se verificaba en memoria con 100 envíos simultáneos.

## Decisión

Guardar el estado de salas y rondas en **Redis 7** y conectar el **adaptador de Socket.IO sobre Redis**, implementando los puertos existentes sin tocar `domain` ni `application`.

- **Salas** (`RedisRoomRepository`). Un hash `room:{CODE}` con el JSON de la sala (`data`) y su `version`. `update` lee ambos, ejecuta la regla de dominio y escribe con un script Lua que solo escribe si la versión no cambió. Si otra réplica escribió antes, vuelve a decidir sobre el estado nuevo (hasta `REDIS_UPDATE_MAX_ATTEMPTS`, con una pausa aleatoria corta). `insert` es otro script que solo escribe si la sala no existe.
- **Word Race** (`RedisWordRaceRepository`). Un hash `wordrace:{CODE}` con los datos fijos de la carrera y un campo por ronda para su estado, su ganador y su cierre. Abrir, ganar (con el punto del ganador) y expirar una ronda son, cada uno, un script Lua atómico. Ganar y expirar son condiciones complementarias, así que nunca suceden las dos.
- **Difusiones**. `@socket.io/redis-adapter` publica cada difusión en Redis y cada réplica la entrega a sus sockets. `io.in(sala).fetchSockets()` cuenta los sockets de todas las réplicas.
- **Activación**. Con `REDIS_URL` se usa Redis; sin ella, los repositorios en memoria de siempre. Las claves expiran si nadie las toca (`REDIS_STATE_TTL_SECONDS`), y el código de sala va entre llaves para que las claves de una sala caigan en el mismo nodo de un Redis Cluster.

Se usa Lua en lugar de `WATCH`/`MULTI`, que es lo que sugería la documentación del puerto, porque `WATCH` queda atado a una conexión y el repositorio comparte una sola. La garantía de compare-and-set es la misma.

## Alternativas consideradas

| Alternativa | Por qué se descartó |
|---|---|
| Mantener el estado en memoria con afinidad de sesión | Se pierde la sala si cae su réplica. Además, la afinidad agrupa por cliente, no por sala: dos jugadores de la misma sala pueden quedar en réplicas distintas y no verse. Agrupar por código de sala exigiría un balanceador que entienda el protocolo |
| Guardar el estado en PostgreSQL | Cada evento de juego haría un viaje a la base de datos con más latencia que Redis, y PostgreSQL no resuelve la difusión entre réplicas: haría falta otro canal de mensajes |
| `WATCH`/`MULTI` para las salas | Requiere una conexión dedicada por cada actualización en curso. Lua da la misma atomicidad sobre una conexión compartida |
| Adaptador de Socket.IO sobre Redis Streams | Tolera desconexiones breves de Redis, pero cuesta más por mensaje. Queda como opción si DIS-1 lo necesita |

## Consecuencias

**Positivas**

- Las réplicas no guardan estado propio: cualquiera atiende cualquier conexión. En la prueba de estrés, con 0,5 CPU por réplica, 1 réplica sostuvo 238 usuarios y 2 réplicas 427 (×1,79) con p95 ≤ 300 ms.
- La correctitud se conserva entre réplicas: en todas las pruebas, incluso con el sistema saturado, 0 puntajes duplicados o perdidos y un único ganador por ronda.
- El dominio no cambió. Las mismas pruebas de contrato se exigen a la implementación en memoria y a la de Redis.
- Una sala sobrevive a la caída de la réplica que la atendía (base de DIS-1).

**Negativas y riesgos**

- **Más latencia.** Con 140 usuarios, el p95 pasó de unos 2 ms (una instancia en memoria) a 17–30 ms. Sigue muy por debajo de los 300 ms del escenario.
- **Costo del adaptador.** Cada réplica recibe todas las difusiones y descarta las que no son suyas. Una réplica sin clientes usó cerca de una cuarta parte de la CPU de la réplica activa solo en eso; es la causa principal de que la ganancia sea ×1,79 y no ×2. El adaptador "sharded" (suscripción por sala) lo reduciría.
- **Redis es un punto único de falla.** Si Redis cae, ninguna réplica puede atender salas. En Azure debe ser un servicio administrado (Azure Cache for Redis) y el endpoint de salud debería reportarlo.
- **Los temporizadores siguen en cada réplica.** Si una réplica cae a mitad de batalla, sus temporizadores de ronda y de fin de batalla no se reprograman en otra. Queda para DIS-1.
- **Una pieza más que operar**: despliegue, secreto `REDIS_URL` y monitoreo (OBS-1).
