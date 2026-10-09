# DanceSync_BackEnd

Backend monorepo for **DanceSync**, a Just-Dance-style web app. Up to 7 users join a room and each chooses to dance or to spectate: at least two dancers battle in real time while the spectators chat and rate them.

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
| `WORD_BONUS_POINTS` | `1` | battle-service (bonus points for each word round won, added to the battle score) |
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
| server -> client | `word:round-ended` | `{ roomCode, roundId, roundNumber, totalRounds, word, winnerId, winnerName, reason: "won" \| "expired", wins, bonusPoints }` - exactly once per round; `bonusPoints` is what the winner earned (0 when expired) |

**Identity.** `room:join` binds the socket to `(roomCode, playerId)`. Every other client event must name that same room and player (`playerId`, `requesterId`, `senderId`, `raterId` or `from`); otherwise the ack returns `PLAYER_NOT_IN_ROOM` and nothing happens, so nobody can kick, start as the host, chat or rate as someone else. Authentication is mocked for now: once Azure Entra ID is wired, the identity bound on `room:join` will come from the validated token instead of the payload. Host-only actions sent by a non-host fail with `NOT_HOST`.

Rooms hold at most 7 players. In the lobby each player chooses `dancer` or `spectator` (`role:select`) and can mark themselves ready to dance, or cancel it, with `player:ready` (`{ roomCode, playerId, ready }`); every change is broadcast as `room:updated` (`players[].ready`) and is only accepted while the room is waiting. Starting a battle is a three-step flow: (1) once every player is ready (`PLAYERS_NOT_READY` otherwise) and at least 2 chose to dance, the host sends `song-challenge:start`; (2) the dancers race to type the phrase and the winner picks a song with `song:choose`; (3) choosing the song starts the battle by itself (`battle:started`). `battle:start` alone is only for a room whose song is already chosen and fails with `SONG_NOT_SELECTED` otherwise. Anyone still undecided spectates. The battle finishes automatically, with a result, once every spectator in the room has rated every dancer in the battle.

**Leaving mid-battle.** A dancer who leaves (or whose seat is released after the disconnect grace period) is withdrawn from `battle.dancerIds` and can no longer be rated. With at least 2 dancers left the battle goes on: no rating for the departed dancer is required, and ratings they already received stay in `battle.ratings` as history but are excluded from `battle.result`. With fewer than 2 dancers left the battle ends early with `result: null`. A departure (dancer or spectator) that leaves every remaining spectator having rated every remaining dancer finishes the battle with a result; ratings from spectators who left still count. Every path that finishes a battle (last rating, leave, released seat) emits `room:updated` and `battle:finished` and stops the word race.

**Song selection.** In the lobby the host starts a typing challenge: the server picks a random phrase, sets `room.songSelection` (phase `typing`, `challenge.phrase`, `challenge.expiresAt`) and broadcasts it. The first dancer who submits the exact phrase (case sensitive, surrounding spaces ignored) wins the right to pick the song (phase `choosing`). A misspelled submission is rejected and costs that player their chance for the round. When the countdown (`SONG_CHALLENGE_MS`, default 15 s) runs out, or every dancer misspelled it, the server passes the turn to a random dancer still in the room, preferring those who did not misspell. The chosen song is stored in `room.selectedSong` and copied to `battle.song` when the battle starts; the battle cannot start while a selection is in progress.

**Word race.** When a battle starts the server plans a few rounds (`WORD_RACE_ROUNDS`, default 3) at random moments of the song (between 10% and 85% of it; `WORD_RACE_FALLBACK_DURATION_MS` when the battle has no song), each with a different Spanish word from `src/domain/catalog/words.ts`. When a round opens, everyone gets `word:round-started` with the time left (`WORD_RACE_WINDOW_MS`, default 10 s; openings at least `WORD_RACE_MIN_GAP_MS` apart). Dancers send `word:submit`; the comparison ignores case and surrounding spaces, and a typo does not lock the dancer out. The first correct submission wins (`won`); a correct one that arrives after it gets `late`. The room then receives a single `word:round-ended` with the winner, or with reason `expired` when nobody typed it in time. The winner earns `WORD_BONUS_POINTS` (default 1) at once: it is added to `battle.bonusPoints[dancerId]`, broadcast with `room:updated` so the current score is visible while the song plays, and summed with the spectators' ratings in `battle.result.scores`. A typo, a late answer or an expired round earns nothing and leaves the points already accumulated untouched. A bonus arriving after the battle finished, or for a dancer who left, is ignored. The race stops when the battle finishes or the room is deleted.

### Concurrency

**Why it matters even with one process.** Node runs one callback at a time, but a handler that `await`s gives way to others. Socket.IO also dispatches the events of a socket through `process.nextTick`, so two frames that arrive in the same TCP read (two ratings sent back to back, `role:select` immediately followed by `battle:start`) start both handlers before either one finishes. With a plain read -> decide -> save, both read version N of the room, both save, and the second save silently drops the first change (lost update): one rating vanishes and the battle never finishes, or the battle starts from the role list before the change. An async store (Redis, Postgres) or a second battle-service instance only widens that window. The repository answering synchronously does not make read -> save safe.

**Room: optimistic concurrency.** `Room` carries a `version` (0 when created, +1 on every stored change, also sent to clients). `RoomRepository` has no blind `save`: every change goes through `update(code, mutate)`, which runs the pure domain decision (`mutate`) on the latest stored state and writes only if nobody wrote in between. A mutation can return a new room (stored, version bumped), the same room (nothing written), `null` (room deleted, e.g. the last player left) or throw a `DomainError` (nothing written, the error reaches the client). Every use case that changes a room (join, leave, role, battle start, rating, song challenge start/submit/expiry, song choice) takes its decision inside `mutate`, and values it returns besides the room (the `finished` flag of a rating, the outcome of a typed phrase, whether a departure ended the battle) are computed there too, so they describe the state that was actually stored. Creating a room uses `insert`, which fails instead of overwriting when the code is taken.

| Operation | SQL | Redis |
|---|---|---|
| `update` | `SELECT data, version FROM rooms WHERE code = $1`, run `mutate`, then `UPDATE rooms SET data = $1, version = version + 1 WHERE code = $2 AND version = $3`; `rowCount 0` = someone else wrote first: re-read and run `mutate` again (bounded, e.g. 5 attempts with jittered backoff) | `WATCH room:{code}`, `GET`, run `mutate`, `MULTI` / `SET` / `EXEC`; a nil `EXEC` is the conflict, retried the same way |
| `insert` | `INSERT ... ON CONFLICT DO NOTHING` (`rowCount 1` = stored) | `SET room:{code} <json> NX` |

`InMemoryRoomRepository.update` reads, runs `mutate`, checks the version and writes in one synchronous block (no `await` in between), so concurrent updates are serialized and never conflict; it still refuses a state derived from an older version (the read -> save misuse). Rooms are stored and handed out as copies.

**Word race: compare-and-set.** The word race keeps its state in its own aggregate and repository (`WordRace`, `WordRaceRepository`), outside `Room`, so a rating saved on the room can never overwrite who won a round. Its transitions are single compare-and-set operations on the port, which is cheaper than a versioned retry for a "first one wins" race: `claimRound(roomCode, roundId, playerId, now)` succeeds only if the round is open, before `closesAt` and without a winner, and increments the winner's tally in the same step. `SubmitWord` validates the text (`WordRaceService.judge`) but never decides from its own earlier read; a failed claim is reported as `late` (or `expired`). Expiring a round is the complementary CAS (`open`, no winner, at or after `closesAt`), so a claim and an expiry can never both succeed, and only the code path whose CAS succeeded broadcasts `word:round-ended`.

| Operation | Redis | SQL |
|---|---|---|
| `claimRound` | `SET word:{room}:{round}:winner <playerId> NX PX <ttl>` (`OK` = you won), or a Lua script that also bumps the tally | `UPDATE word_rounds SET winner_id = $1, status = 'won' WHERE id = $2 AND status = 'open' AND winner_id IS NULL AND closes_at > now()`; `rowCount === 1` = you won |
| `expireRound` | Lua script that expires only when the winner key is absent | `UPDATE word_rounds SET status = 'expired' WHERE id = $1 AND status = 'open' AND winner_id IS NULL AND closes_at <= now()` |

`InMemoryWordRaceRepository` implements each CAS as one synchronous block, the in-memory equivalent of the Lua script or the conditional `UPDATE`.

**Tests.** The concurrency tests slow the stores down with a random 0-5 ms delay per call (like a network round trip) so concurrent commands genuinely interleave, and each one has a negative control running the naive read -> save version through the same slow store to show the test can catch the bug:

- `test/room.concurrency.test.ts`: 100 simultaneous ratings (50 spectators x 2 dancers) are all stored and exactly one reports finishing the battle; 100 dancers typing the right phrase at once produce exactly one chooser while the rest get `SONG_SELECTION_NOT_ACTIVE`. Both also run against a stand-in for SQL/Redis that implements `update` with the version compare-and-set and retries above (it logs how many conflicts it retried). The negative controls lose ratings and crown several dancers.
- `test/roomConcurrency.socket.test.ts`: over real sockets, back-to-back ratings from one socket, the last ratings of two spectators at once, a full room rating at once, and `role:select` immediately followed by `battle:start`.
- `test/wordRace.concurrency.test.ts`: 100 simultaneous correct words, 50 times, give exactly one `won` and 99 `late`; a claim racing the expiry takes effect exactly once.

Run them with `pnpm test` (all tests) or, for example, `npx tsx --test test/room.concurrency.test.ts`.

The `webrtc:*` events are a thin signaling relay for the dancers' live cameras (media flows peer to peer, never through the server). The server only checks that the sender joined that room as `playerId`/`from` and that `to` is connected to the same room; otherwise the ack returns `{ ok: false }` and nothing is relayed. Each socket also joins a `player:<playerId>` channel on `room:join` so signals can target a single player.

## Roadmap

- **Authentication with Azure Entra ID**: validate JWTs at the `api-gateway` (`spring-boot-starter-oauth2-resource-server`), propagate identity downstream, and configure `users-service` and `battle-service` as resource servers. `users.external_id` is already reserved for the Entra ID object id. `TODO`: wire `spring-security` once the tenant and app registrations exist.
- **Payments**: dedicated payments service behind the gateway; provider to be decided.
- **Match history persistence**: `battle-service` will call `users-service` (`USERS_SERVICE_URL`) when a battle finishes to store the result in `match_history`.
- **Horizontal scaling of battle-service**: replace `InMemoryRoomRepository` with Redis and enable the Socket.IO Redis adapter.
