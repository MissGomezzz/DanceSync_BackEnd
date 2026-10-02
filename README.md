# DanceSync_BackEnd

Backend monorepo for **DanceSync**, a Just-Dance-style web app. Up to 8 users join a room: two of them dance-battle in real time while the other six spectate, chat, and rate the dancers when the battle ends.

## Overview

| Service | Stack | Port | Responsibility |
|---|---|---|---|
| `api-gateway` | Spring Boot 4.1.1, Spring Cloud Gateway (reactive/WebFlux), Java 17 | 8080 | Single entry point for the frontend; routes HTTP and WebSocket traffic, applies CORS |
| `users-service` | Spring Boot 4.1.1, Spring Web MVC, Spring Data JPA, Flyway, PostgreSQL, Java 17 | 8081 | User profiles and match history |
| `battle-service` | Node 22, Express 5, TypeScript, Socket.IO 4 | 3000 | Rooms, real-time battles, spectator chat, and ratings (in-memory) |
| `postgres` | PostgreSQL 16 (Docker) | 5432 | Persistence for `users-service` |

## Architecture

```
                 +-----------------------+
                 |   Frontend (Vite)     |
                 |   http://localhost:5173
                 +-----------+-----------+
                             |  HTTP / WebSocket
                             v
                 +-----------------------+
                 |      api-gateway      |
                 |         :8080         |
                 +-----+-----------+-----+
      /api/users/**    |           |   /api/rooms/**  /api/battles/**  /socket.io/**
                       v           v
          +------------------+   +--------------------+
          |  users-service   |   |   battle-service   |
          |      :8081       |   |       :3000        |
          +---------+--------+   +--------------------+
                    | JDBC
                    v
          +------------------+
          |   PostgreSQL     |
          |      :5432       |
          +------------------+
```

Both Java services and the Node service follow a hexagonal layout: `domain` (models, ports, rules) has no framework dependencies, `application` holds the use cases, and `infrastructure` contains the inbound (REST, WebSocket) and outbound (JPA, in-memory) adapters.

## Prerequisites

- Java 17, Maven wrapper included (`mvnw` / `mvnw.cmd`)
- Node 22 and pnpm 10
- Docker with Compose v2+

## Running everything locally

1. Copy the environment template and adjust if needed:

   ```sh
   cp .env.example .env
   ```

2. Start PostgreSQL:

   ```sh
   docker compose up -d
   ```

3. Start `users-service` (Flyway creates the schema on first start):

   ```sh
   cd users-service
   mvnw.cmd spring-boot:run      # Windows
   ./mvnw spring-boot:run        # macOS / Linux
   ```

4. Start `battle-service`:

   ```sh
   cd battle-service
   pnpm install
   pnpm dev
   ```

5. Start `api-gateway`:

   ```sh
   cd api-gateway
   mvnw.cmd spring-boot:run      # Windows
   ./mvnw spring-boot:run        # macOS / Linux
   ```

Smoke checks through the gateway:

```sh
curl http://localhost:8080/api/battles/health
curl -X POST http://localhost:8080/api/users \
  -H "Content-Type: application/json" \
  -d '{"externalId":"azure-oid-123","displayName":"Alice","email":"alice@example.com"}'
```

### Build and test

```sh
# users-service
cd users-service && mvnw.cmd -DskipTests package && mvnw.cmd test

# api-gateway
cd api-gateway && mvnw.cmd -DskipTests package

# battle-service
cd battle-service && pnpm typecheck && pnpm build && pnpm test
```

## Environment variables

Defaults live in `.env.example`; every service falls back to the same values when a variable is absent.

| Variable | Default | Used by |
|---|---|---|
| `POSTGRES_DB` / `POSTGRES_USER` / `POSTGRES_PASSWORD` | `dancesync` | docker-compose, users-service |
| `POSTGRES_HOST` / `POSTGRES_PORT` | `localhost` / `5432` | users-service |
| `GATEWAY_PORT` | `8080` | api-gateway |
| `USERS_SERVICE_PORT` | `8081` | users-service |
| `USERS_SERVICE_URL` | `http://localhost:8081` | api-gateway, battle-service |
| `BATTLE_SERVICE_URL` | `http://localhost:3000` | api-gateway (HTTP and Socket.IO routes; the gateway upgrades to WebSocket automatically) |
| `FRONTEND_ORIGIN` | `http://localhost:5173` | api-gateway (CORS) |
| `PORT` | `3000` | battle-service |
| `CORS_ORIGIN` | `http://localhost:5173` | battle-service |
| `WORD_RACE_ROUNDS` / `WORD_RACE_WINDOW_MS` | `3` / `10000` | battle-service (word race rounds per battle, time to type each word) |
| `WORD_RACE_MIN_GAP_MS` / `WORD_RACE_FALLBACK_DURATION_MS` | `12000` / `90000` | battle-service (time between round openings, song length when there is no song) |

`battle-service` reads its own `battle-service/.env` (see `battle-service/.env.example`).

## API surface

### users-service (`/api/users`)

- `POST /api/users` - register a user (`externalId`, `displayName`, `email`); returns `201`
- `GET /api/users/{id}` - fetch a user by UUID; `404` when missing

### battle-service

HTTP:

- `GET /api/battles/health`
- `POST /api/rooms` (`hostId`, `displayName`) - create a room; returns `201` with the room code
- `GET /api/rooms/:code`

Socket.IO (path `/socket.io`):

| Direction | Event | Payload |
|---|---|---|
| client -> server | `room:join` | `{ roomCode, playerId, displayName }` |
| client -> server | `room:leave` | `{ roomCode, playerId }` |
| client -> server | `battle:start` | `{ roomCode, requesterId, dancerIds? }` (host only) |
| client -> server | `chat:message` | `{ roomCode, senderId, content }` |
| client -> server | `rating:submit` | `{ roomCode, raterId, dancerId, score }` (spectators, 1-5) |
| client -> server | `song-challenge:start` | `{ roomCode, requesterId }` (host only, needs 2+ dancers) - shows a random phrase with a countdown |
| client -> server | `song-challenge:submit` | `{ roomCode, playerId, text }` (dancers in the challenge) - ack data `{ room, outcome: "accepted" \| "incorrect" \| "expired" }` |
| client -> server | `song:choose` | `{ roomCode, playerId, songId }` (only the challenge winner) |
| client -> server | `webrtc:ready` | `{ roomCode, playerId }` - the sender is ready to (re)negotiate its camera connections |
| client -> server | `webrtc:signal` | `{ roomCode, from, to, negotiationId, description?, candidate? }` - SDP offer/answer or ICE candidate |
| client -> server | `word:submit` | `{ roomCode, playerId, roundId, text }` (dancers in the battle) - ack data `{ outcome: "won" \| "late" \| "incorrect" \| "expired", winnerId }` |
| server -> client | `room:updated` | `Room` |
| server -> client | `battle:started` | `Room` |
| server -> client | `chat:message` | `ChatMessage` |
| server -> client | `battle:finished` | `Room` (includes `battle.result`) |
| server -> client | `webrtc:peer-ready` | `{ playerId }` - broadcast to the rest of the room after `webrtc:ready` |
| server -> client | `webrtc:signal` | same payload as the client event, delivered only to the `to` player |
| server -> client | `word:round-started` | `{ roomCode, roundId, roundNumber, totalRounds, word, expiresInMs }` - to the whole room, and to a single socket that (re)joins mid-round |
| server -> client | `word:round-ended` | `{ roomCode, roundId, roundNumber, totalRounds, word, winnerId, winnerName, reason: "won" \| "expired", wins }` - exactly once per round |

**Identity.** `room:join` binds the socket to `(roomCode, playerId)`. Every other client event must name that same room and player (`playerId`, `requesterId`, `senderId`, `raterId` or `from`); otherwise the ack returns `PLAYER_NOT_IN_ROOM` and nothing happens, so nobody can kick, start as the host, chat or rate as someone else. Authentication is mocked for now: once Azure Entra ID is wired, the identity bound on `room:join` will come from the validated token instead of the payload. Host-only actions sent by a non-host fail with `NOT_HOST`.

Rooms hold at most 8 players. When the host starts the battle, two players become dancers and the rest spectate; the battle finishes automatically once every spectator has rated both dancers.

**Song selection.** In the lobby the host starts a typing challenge: the server picks a random phrase, sets `room.songSelection` (phase `typing`, `challenge.phrase`, `challenge.expiresAt`) and broadcasts it. The first dancer who submits the exact phrase (case sensitive, surrounding spaces ignored) wins the right to pick the song (phase `choosing`). A misspelled submission is rejected and costs that player their chance for the round. When the countdown (`SONG_CHALLENGE_MS`, default 15 s) runs out, or every dancer misspelled it, the server passes the turn to a random dancer still in the room, preferring those who did not misspell. The chosen song is stored in `room.selectedSong` and copied to `battle.song` when the battle starts; the battle cannot start while a selection is in progress.

**Word race.** When a battle starts the server plans a few rounds (`WORD_RACE_ROUNDS`, default 3) at random moments of the song (between 10% and 85% of it; `WORD_RACE_FALLBACK_DURATION_MS` when the battle has no song), each with a different Spanish word from `src/domain/catalog/words.ts`. When a round opens, everyone gets `word:round-started` with the time left (`WORD_RACE_WINDOW_MS`, default 10 s; openings at least `WORD_RACE_MIN_GAP_MS` apart). Dancers send `word:submit`; the comparison ignores case and surrounding spaces, and a typo does not lock the dancer out. The first correct submission wins (`won`); a correct one that arrives after it gets `late`. The room then receives a single `word:round-ended` with the winner, or with reason `expired` when nobody typed it in time. Wins are tallied per dancer (`wins`) but do not change the battle score yet. The race stops when the battle finishes or the room is deleted.

### Concurrency: who wins the word

The song challenge decides its winner with read -> decide -> save on the whole `Room` (`findByCode`, pure `submit`, `save`). It is correct today only by accident: the in-memory `Map` answers synchronously and Node runs one callback at a time. With an async store (Redis and Postgres are on the roadmap) or two battle-service instances, two dancers can both read "nobody won yet" and both be told they won (lost update). On top of that, spectators save ratings on the same `Room` while the battle runs, so race state stored inside `Room` could be overwritten by a concurrent rating save. The word race therefore:

1. Keeps its state in its own aggregate and repository (`WordRace`, `WordRaceRepository`), not inside `Room`.
2. Decides the winner with an atomic compare-and-set on the repository port, `claimRound(roomCode, roundId, playerId, now)`: it succeeds only if the round is open, before `closesAt` and without a winner, and it increments the winner's tally in the same step. `SubmitWord` validates the text (`WordRaceService.judge`) but never decides from its own earlier read; a failed claim is reported as `late` (or `expired`). Expiring a round is the complementary CAS (`open`, no winner, at or after `closesAt`), so a claim and an expiry can never both succeed, and only the code path whose CAS succeeded broadcasts `word:round-ended`.
3. Proves it with tests.

How the port maps to a real store:

| Operation | Redis | SQL |
|---|---|---|
| `claimRound` | `SET word:{room}:{round}:winner <playerId> NX PX <ttl>` (`OK` = you won), or a Lua script that also bumps the tally | `UPDATE word_rounds SET winner_id = $1, status = 'won' WHERE id = $2 AND status = 'open' AND winner_id IS NULL AND closes_at > now()`; `rowCount === 1` = you won |
| `expireRound` | Lua script that expires only when the winner key is absent | `UPDATE word_rounds SET status = 'expired' WHERE id = $1 AND status = 'open' AND winner_id IS NULL AND closes_at <= now()` |

`InMemoryWordRaceRepository` implements each CAS as one synchronous block (no `await` between read and write), the in-memory equivalent of the Lua script or the conditional `UPDATE`.

`test/wordRace.concurrency.test.ts` wraps the in-memory store in a decorator that waits a random 0-5 ms before every call (like a network round trip), fires 100 simultaneous correct submissions 50 times and asserts exactly one `won` and 99 `late` each time. A negative control runs a naive read-then-save version through the same slow store and asserts it does hand out several wins, which shows the test can catch the bug. Run it with `pnpm test` (all tests) or `npx tsx --test test/wordRace.concurrency.test.ts`.

Recommendation: migrate the song challenge to the same pattern (its own `SongSelection` repository with a `claimChooser` CAS) before moving rooms to Redis or Postgres.

The `webrtc:*` events are a thin signaling relay for the dancers' live cameras (media flows peer to peer, never through the server). The server only checks that the sender joined that room as `playerId`/`from` and that `to` is connected to the same room; otherwise the ack returns `{ ok: false }` and nothing is relayed. Each socket also joins a `player:<playerId>` channel on `room:join` so signals can target a single player.

## Roadmap

- **Authentication with Azure Entra ID**: validate JWTs at the `api-gateway` (`spring-boot-starter-oauth2-resource-server`), propagate identity downstream, and configure `users-service` and `battle-service` as resource servers. `users.external_id` is already reserved for the Entra ID object id. `TODO`: wire `spring-security` once the tenant and app registrations exist.
- **Payments**: dedicated payments service behind the gateway; provider to be decided.
- **Match history persistence**: `battle-service` will call `users-service` (`USERS_SERVICE_URL`) when a battle finishes to store the result in `match_history`.
- **Horizontal scaling of battle-service**: replace `InMemoryRoomRepository` with Redis and enable the Socket.IO Redis adapter.
