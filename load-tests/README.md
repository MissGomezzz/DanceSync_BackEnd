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
- Los escenarios están en `scenarios/*.yml`; `totalS` debe ser la suma de las fases (subida + sostenido).
- Cada sala termina el ciclo de batalla en curso al acabar `totalS`, así que la corrida dura hasta ~100 s más.

## Variables opcionales

`TRANSPORTS` (por defecto `websocket`), `AUTH_MODE` (`fake` por defecto, o `none`), `ACK_TIMEOUT_MS` (10000).

## Advertencias para interpretar resultados

- Si el generador de carga y el servidor corren en la misma máquina, compiten por CPU: anótalo en el informe.
- Con 1 sola réplica y sin límite de CPU, 140 usuarios son una carga baja. La comparación 1 vs 2 réplicas
  se hace en la prueba de estrés, limitando la CPU de cada contenedor para poder saturar una réplica.
