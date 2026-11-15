# Pruebas de carga y estrés (REN-1)

Pruebas de rendimiento y latencia del Battle Service de DanceSync con [Artillery](https://www.artillery.io/).
Verifican el escenario **REN-1**: 140 usuarios (20 salas de 7), 1 evento cada 2 s por usuario,
p95 <= 300 ms y menos del 1 % de errores.

## Cómo funciona

Cada "usuario virtual" de Artillery es **una sala completa** de 7 bots (2 bailarines y 5 espectadores) que
juega el flujo real y lo repite con `room:rematch` hasta que acaba el tiempo de la prueba:

crear sala (HTTP) -> `room:join` -> `role:select` -> `player:ready` -> `song-challenge:start` -> frase ->
`song:choose` -> `battle:started` -> chat, votos y `word:submit` (ráfaga al abrir cada ronda) ->
`battle:finished` -> `room:rematch`.

La sala se coordina dentro de una función de Artillery (`lib/room-bot.cjs`) que usa `socket.io-client`,
porque el motor `socketio` en YAML no puede coordinar 7 jugadores que dependen unos de otros
(la frase del reto, el ganador que elige la canción, la palabra de cada ronda).
Artillery sigue siendo quien programa las fases de llegada y genera el reporte JSON.

### Qué se mide (desde el cliente, incluye la red)

| Métrica | Definición |
|---|---|
| `dancesync.chat_e2e_ms` | `chat:message` enviado -> la misma difusión recibida por el emisor |
| `dancesync.vote_e2e_ms` | `vote:cast` enviado -> `vote:mine` recibido (se emite justo después de publicar el estado nuevo) |
| `dancesync.word_e2e_ms` | `word:submit` ganador -> `word:round-ended` recibido |
| `dancesync.ack_ms` | cualquier evento -> acuse del servidor |

Verificaciones de correctitud (deben quedar en 0): `errors`, `duplicate_round_end`, `winner_mismatch`, `score_mismatch`.
`domain_rejections` son rechazos esperados en una carrera (por ejemplo, el bailarín que pierde el reto de la frase).

## Autenticación (SEG-1)

Desde SEG-1 el Battle Service exige token en HTTP y en el handshake de Socket.IO, y rechaza todo si no está configurado.
La carga se autentica como un usuario real, sin tocar tu Azure:

- **Anfitrión:** token tipo Entra ID (RS256) firmado con una clave local. `scripts/fake-entra.mjs` publica la clave
  pública como JWKS y el Battle Service la valida con su verificador real (`ENTRA_JWKS_URI`).
- **Los otros 6 de cada sala:** entran como invitados (`POST /api/rooms/:code/guest-token`), con token firmado por el servicio.

Pasos:

1. `node scripts/fake-entra.mjs` (déjalo corriendo; imprime las variables que necesita el Battle Service).
2. Pon esas variables en `battle-service/.env` junto con `GUEST_TOKEN_SECRET` (32 o más caracteres) y arranca `pnpm dev`.
   Si el servicio imprime los avisos "AZURE_TENANT_ID / AZURE_CLIENT_ID are not set" o "GUEST_TOKEN_SECRET is not set", falta algo.
3. Ejecuta la prueba normalmente.

Para un servidor anterior a SEG-1 (sin autenticación) usa `AUTH_MODE=none`.
El `.env` de pruebas no debe subirse al repositorio.

## Uso

```sh
cd load-tests
npm install          # en Windows CMD: set PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 antes, para no bajar navegadores
node scripts/run.mjs smoke   --target http://localhost:3000   # ~100 s, 3 salas, comprueba que todo funciona
node scripts/run.mjs nominal --target http://localhost:3000 --label base-1-replica   # 20 salas, ~11-13 min
node scripts/run.mjs stress  --target http://localhost:3000 --label estres-1-replica  # rampa hasta saturar
```

- `--target` es la URL del Battle Service (directo, o el balanceador/gateway).
- `--label` queda en el nombre del reporte: `results/<escenario>-<label>-<fecha>.json`.
- `node scripts/summary.mjs results/<archivo>.json` vuelve a imprimir el resumen y el veredicto.
- `node scripts/compare.mjs <estres-1-replica.json> <estres-2-replicas.json>` compara el máximo de usuarios sostenido (evidencia de escalabilidad horizontal).
- `node scripts/chart.mjs <estres-1-replica.json> <estres-2-replicas.json> <salida.svg>` dibuja el p95 contra los usuarios concurrentes de las dos corridas (SVG sin dependencias).
- Los escenarios están en `scenarios/*.yml`; `totalS` debe ser la suma de las fases (subida + sostenido).
- Cada sala termina el ciclo de batalla en curso al acabar `totalS`, así que la corrida dura hasta ~100 s más.

## Variables opcionales

`TRANSPORTS` (por defecto `websocket`), `AUTH_MODE` (`fake` por defecto, o `none`), `ACK_TIMEOUT_MS` (10000).

## Advertencias para interpretar resultados

- Si el generador de carga y el servidor corren en la misma máquina, compiten por CPU: anótalo en el informe.
- Con 1 sola réplica y sin límite de CPU, 140 usuarios son una carga baja. La comparación 1 vs 2 réplicas
  se hace en la prueba de estrés, limitando la CPU de cada contenedor para poder saturar una réplica.

## Entorno de escala (Redis + 2 réplicas + balanceador)

`../docker-compose.scale.yml` levanta Redis, un Entra ID falso, dos réplicas del Battle Service y nginx
(punto de entrada: `http://localhost:8088`). Cada réplica tiene el mismo límite de recursos
(`BATTLE_CPUS`, por defecto 0.5, y `BATTLE_MEMORY`, 512m), así 1 vs 2 réplicas es una comparación justa.

En la carpeta del backend (la que contiene `docker-compose.scale.yml`), en CMD de Windows:

```sh
docker compose -f docker-compose.scale.yml up -d --build
docker compose -f docker-compose.scale.yml ps                 # todo en "healthy"
curl http://localhost:8088/api/battles/health
```

Para elegir cuántas réplicas reciben tráfico (en CMD, el `set` va en su propia línea):

```sh
set LB_REPLICAS=2
docker compose -f docker-compose.scale.yml up -d              # 2 réplicas (por defecto)
set LB_REPLICAS=1
docker compose -f docker-compose.scale.yml up -d              # solo battle-1 recibe tráfico
```

Qué réplica atendió cada conexión: `docker logs dancesync-lb` (campo `upstream=`).
Consumo por réplica durante una prueba: `docker stats dancesync-battle-1 dancesync-battle-2`.
Para apagar todo: `docker compose -f docker-compose.scale.yml down`.

El balanceador de este prototipo hace verificación de salud pasiva (nginx de código abierto): si una réplica falla,
las conexiones nuevas van a la otra. En Azure Container Apps el ingreso hace sondeos activos.
Las credenciales del compose son de prueba y no deben usarse fuera de una máquina de pruebas.

## Reglas para que una prueba sea válida

- **Una sola prueba a la vez.** `run.mjs` crea `results/.running` y se niega a arrancar si otra corrida sigue activa
  (dos generadores en la misma máquina se disputan CPU y red). El candado se libera solo al terminar o con Ctrl+C.
- **El entorno debe estar limpio y en el modo correcto antes de cada corrida de estrés:**
  `docker compose -f ../docker-compose.scale.yml down`, luego `set LB_REPLICAS=1` (o 2) en su propia línea y `up -d`.
  `run.mjs` detecta cuántas réplicas reciben tráfico y lo guarda en `results/<corrida>.meta.json`.
- **Recursos:** cada corrida guarda `results/<corrida>.recursos.csv` (CPU de la máquina y de cada contenedor cada 5 s)
  y al final imprime el máximo y el promedio. El 100 % de `docker stats` es UN núcleo: con 0,5 CPU por réplica el tope es ~50 %.
- **Salud del generador:** el resumen incluye el retraso del bucle de eventos de Artillery. Si sale "SATURADO", las
  latencias incluyen el retraso del propio generador y no son del servidor.
- `compare.mjs` rechaza la comparación si las dos pruebas se solaparon en el tiempo y avisa si el número de réplicas o el
  límite de CPU no corresponde.

## Protección ante abuso (SEG-3)

`scenarios/abuse.yml` reproduce el escenario SEG-3: las 20 salas de la carga nominal (140 usuarios) y, con el
tráfico ya sostenido (a los 240 s), 5 clientes abusivos que envían 200 eventos por segundo durante 5 minutos.
Cada abusivo crea su sala, inunda el chat y, cuando el servidor lo bloquea y cierra la conexión, insiste: intenta
reconectarse cada segundo con el mismo token y una vez con un token de invitado nuevo desde la misma dirección.
`abuse-smoke.yml` es la versión corta (3 salas, 2 abusivos, ~2 min) para comprobar el entorno.

**Direcciones simuladas.** El bloqueo de SEG-3 es por identidad y por dirección IP, y todos los bots salen de la
misma máquina. Por eso cada sala envía `X-Forwarded-For` con una dirección propia (rango de pruebas 198.18.0.0/15,
RFC 2544) y cada abusivo la suya (198.19.255.x). En `docker-compose.scale.yml` las réplicas confían en 2 saltos
(`TRUSTED_PROXY_HOPS=2`): nginx y, antes, el bot haciendo de ingreso de la plataforma. Sin eso, el bloqueo de un
abusivo caería sobre los 140 usuarios normales.

**Qué mide** (además de lo de REN-1):

| Métrica | Definición |
|---|---|
| `dancesync.abuse.first_limited_ms` | inicio de la inundación -> primer `rate:limited` (criterio: < 1 s) |
| `dancesync.abuse.blocked_ms` | inicio de la inundación -> `rate:blocked` |
| `dancesync.abuse.reconnect_refused` | reconexiones rechazadas con `BLOCKED` mientras dura el bloqueo |
| `dancesync.abuse.ip_block_held` | un token nuevo desde la misma dirección también fue rechazado |
| `dancesync.attack_window.*` | latencias de los usuarios normales solo mientras dura el ataque |

Las métricas de los abusivos no se mezclan con las de los usuarios normales: sus eventos rechazados no cuentan
como errores.

**Cómo correrla** (en el entorno de escala, con 2 réplicas, una prueba a la vez):

```sh
node scripts/run.mjs abuse-smoke --target http://localhost:8088 --label humo-abuso
node scripts/run.mjs nominal --target http://localhost:8088 --label base-seg3-a
node scripts/run.mjs nominal --target http://localhost:8088 --label base-seg3-b
node scripts/run.mjs abuse   --target http://localhost:8088 --label ataque
node scripts/abuse-compare.mjs results/nominal-base-seg3-a-<fecha>.json results/abuse-ataque-<fecha>.json results/nominal-base-seg3-b-<fecha>.json
```

`abuse-compare.mjs` compara el p95 de los usuarios normales en **el mismo tramo de cada prueba**: del segundo 245 al
540, que en `abuse` cae dentro del ataque (`windowFromS`/`windowToS` en los escenarios; el bot registra ese tramo
aparte como `dancesync.window.*` en toda corrida). Comparar el ataque contra la corrida completa estaría sesgado:
el inicio de una corrida, con pocas salas, tiene latencias más bajas que su parte central. Criterio: el p95 no
aumenta más de un 5 %. Con una segunda línea base muestra también cuánto varía el p95 entre dos corridas sin ataque
(el ruido de la medición) y compara contra la peor de las dos bases. Con reportes anteriores, sin
`dancesync.window.*`, estima el p95 del tramo con los resúmenes de 10 s de Artillery, con el mismo método para los
tres archivos (`--from` y `--to` cambian el tramo).
