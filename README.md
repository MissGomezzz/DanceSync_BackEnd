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

Defaults live in `.env.example`; every service falls back to the same values when a variable is absent. For `battle-service` the source of truth is `battle-service/src/config/env.ts`: every numeric variable is validated once at startup and the service refuses to start (with a message naming the variable) when a value is not a number, is negative, is `0` where it must be positive, or is not whole where a count is expected.

| Variable | Default | Used by |
|---|---|---|
| `POSTGRES_DB` / `POSTGRES_USER` / `POSTGRES_PASSWORD` | `dancesync` | docker-compose, users-service |
| `POSTGRES_HOST` / `POSTGRES_PORT` | `localhost` / `5432` | users-service |
| `GATEWAY_PORT` | `8080` | api-gateway |
| `USERS_SERVICE_PORT` | `8081` | users-service |
| `USERS_SERVICE_URL` | `http://localhost:8081` | api-gateway, battle-service |
| `BATTLE_SERVICE_URL` | `http://localhost:3000` | api-gateway (HTTP and Socket.IO routes; the gateway upgrades to WebSocket automatically) |
| `FRONTEND_ORIGIN` | `http://localhost:5173` | api-gateway (CORS) |
| `PORT` | `3000` | battle-service (whole number, `0` or more) |
| `CORS_ORIGIN` | `http://localhost:5173` | battle-service |
| `DISCONNECT_GRACE_MS` | `15000` | battle-service (`0` or more; how long a disconnected player keeps their seat; rooms created over HTTP wait this plus 5 s for their host) |
| `SONG_CHALLENGE_MS` | `15000` | battle-service (`> 0`; time to type the song-selection phrase) |
| `SONG_CHOOSE_MS` | `20000` | battle-service (`> 0`; time the chooser has to pick a song before one is picked at random) |
| `BATTLE_START_COUNTDOWN_MS` | `5000` | battle-service (`0` or more; countdown between the battle start and the moment dancing and rating begin) |
| `RATING_GRACE_MS` | `30000` | battle-service (`0` or more; time spectators keep to rate after the song clip ends, then the battle finishes on its own) |
| `WORD_RACE_ROUNDS` / `WORD_RACE_WINDOW_MS` | `3` / `10000` | battle-service (whole number `0` or more / `> 0`; word race rounds per battle, time to type each word) |
| `WORD_BONUS_POINTS` | `1` | battle-service (positive whole number; bonus points for each word round won, added to the battle score) |
| `WORD_RACE_MIN_GAP_MS` / `WORD_RACE_FALLBACK_DURATION_MS` | `12000` / `90000` | battle-service (`0` or more / `> 0`; time between round openings, song length when there is no song, used for the word race and the automatic battle end) |

`battle-service` reads its own `battle-service/.env` (see `battle-service/.env.example`).

## Docker images

Each service has a multi-stage `Dockerfile` in its folder; build them from the service folder, e.g. `docker build -t battle-service ./battle-service`.

- `api-gateway` / `users-service`: Maven + JDK 17 build stage (`mvn -DskipTests package`), then a JRE 17 image running as a non-root user (ports 8080 / 8081).
- `battle-service`: pnpm build stage (`pnpm build`, then `pnpm prune --prod`), then a Node 22 slim image running `node dist/server.js` as `node` (port 3000).

The images do not run the tests: CI does, and only commits that passed CI are deployed (see below).

## CI

`.github/workflows/backend-ci.yml` ("Backend CI") runs on every push and pull request to `main` and `develop`, one job per service:

- `api-gateway`: `./mvnw -B verify`
- `users-service`: `./mvnw -B verify` against a PostgreSQL 16 service container
- `battle-service`: `pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm test`, `pnpm build`

## CD (Azure Container Apps)

`deploy-api-gateway.yml`, `deploy-battle-service.yml` and `deploy-user-service.yml` call the reusable `_deploy-service.yml`, which logs in to Azure with OIDC, builds the service image, pushes it to Azure Container Registry tagged with the commit SHA, and updates the Container App of the same name.

- **Gated by CI.** They trigger on `workflow_run` of "Backend CI" (`completed`, branch `main`) and deploy only when that run succeeded for a push to this repository. They check out and tag `github.event.workflow_run.head_sha`, the exact commit CI tested. `workflow_dispatch` remains for manual redeploys.
- **All three on green CI.** `workflow_run` cannot filter by path, so every green CI run on `main` redeploys the three services; an unchanged image only creates a new Container App revision.
- **One deploy at a time per service** (`concurrency: deploy-<service>`, never cancelling a deploy in progress), with least-privilege permissions (`contents: read`; `id-token: write` only for the OIDC login).

Required configuration (names only): secrets `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`; variables `ACR_NAME`, `AZURE_RESOURCE_GROUP`.

## API surface

### users-service (`/api/users`)

- `POST /api/users` - register a user (`externalId`, `displayName`, `email`); returns `201`
- `GET /api/users/{id}` - fetch a user by UUID; `404` when missing

### battle-service

HTTP:

- `GET /api/battles/health`
- `POST /api/rooms` (`hostId`, `displayName`) - create a room; returns `201` with the room. If the host never connects a socket to it within `DISCONNECT_GRACE_MS` + 5 s, the room is deleted.
- `GET /api/rooms/:code`
- A malformed JSON body answers `400 { "error": "Malformed JSON body" }`; domain errors answer `{ error, code }` with the status in the table below.

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
| client -> server | `player:kick` | `{ roomCode, requesterId, playerId }` (host only, lobby only, not themselves) - ack data `Room` |
| server -> client | `room:updated` | `Room` |
| server -> client | `battle:started` | `Room` |
| server -> client | `chat:message` | `ChatMessage` |
| server -> client | `battle:finished` | `Room` (includes `battle.result`) |
| server -> client | `room:kicked` | `{ roomCode }` - only to the sockets of a kicked player, right before they are unbound from the room |
| server -> client | `webrtc:peer-ready` | `{ playerId }` - broadcast to the rest of the room after `webrtc:ready` |
| server -> client | `webrtc:signal` | same payload as the client event, delivered only to the `to` player |
| server -> client | `word:round-started` | `{ roomCode, roundId, roundNumber, totalRounds, word, expiresInMs }` - to the whole room, and to a single socket that (re)joins mid-round |
| server -> client | `word:round-ended` | `{ roomCode, roundId, roundNumber, totalRounds, word, winnerId, winnerName, reason: "won" \| "expired", wins, bonusPoints }` - exactly once per round; `bonusPoints` is what the winner earned (0 when expired) |

**Room payloads.** Every `Room` the server sends (events, acks, the join resync and the HTTP API) goes through one serializer, `toRoomDto(room, now)` (`src/infrastructure/serialization/roomDto.ts`). It keeps every stored field and adds times relative to the moment it was sent, so clients count down without comparing clocks:

| Field | Meaning |
|---|---|
| `songSelection.challenge.expiresInMs` | time left to type the phrase (never negative) |
| `songSelection.chooseExpiresInMs` | time the current chooser has left while the phase is `choosing`; `null` otherwise |
| `songSelection.autoPicked` | `true` when the server picked the song because the chooser let the deadline pass |
| `battle.startsInMs` | time until the dancing begins; negative once it began (elapsed time) |
| `battle.endsInMs` | time until the battle finishes on its own while it runs; `null` once finished |
| `battle.roster` | `{ id, displayName }[]` of every dancer, snapshotted at the start (dancers who leave keep their name here) |

**Errors.** A failed client event acks `{ ok: false, error: { code, message } }` (or emits `error:domain` when no ack was given). The HTTP API answers the same codes with these statuses:

| Code | HTTP | Code | HTTP |
|---|---|---|---|
| `ROOM_NOT_FOUND` | 404 | `INVALID_SCORE` | 400 |
| `ROOM_FULL` | 409 | `DUPLICATE_RATING` | 409 |
| `ROOM_NOT_WAITING` | 409 | `INVALID_MESSAGE` | 400 |
| `ROOM_NOT_BATTLING` | 409 | `SONG_SELECTION_IN_PROGRESS` | 409 |
| `BATTLE_NOT_STARTED` | 409 | `SONG_SELECTION_NOT_ACTIVE` | 409 |
| `PLAYER_ALREADY_IN_ROOM` | 409 | `NOT_CHALLENGE_PARTICIPANT` | 403 |
| `PLAYER_NOT_IN_ROOM` | 403 | `ATTEMPT_ALREADY_USED` | 409 |
| `INVALID_PLAYER` | 400 | `NOT_SONG_CHOOSER` | 403 |
| `NOT_ENOUGH_PLAYERS` / `NOT_ENOUGH_DANCERS` | 409 | `INVALID_SONG` | 400 |
| `INVALID_DANCER` | 400 | `WORD_RACE_NOT_ACTIVE` | 409 |
| `PLAYERS_NOT_READY` / `SONG_NOT_SELECTED` | 409 | `WORD_ROUND_NOT_OPEN` | 409 |
| `INVALID_RATER` / `NOT_HOST` | 403 | `INTERNAL_ERROR` (socket only) | 500 |

`BATTLE_NOT_STARTED` is a rating sent during the start countdown. `player:kick` answers `NOT_HOST` (not the host), `ROOM_NOT_WAITING` (battle running), `INVALID_PLAYER` (yourself or a malformed id) and `PLAYER_NOT_IN_ROOM` (unknown target).

**Identity.** `room:join` binds the socket to `(roomCode, playerId)`. Every other client event must name that same room and player (`playerId`, `requesterId`, `senderId`, `raterId` or `from`); otherwise the ack returns `PLAYER_NOT_IN_ROOM` and nothing happens, so nobody can kick, start as the host, chat or rate as someone else. Authentication is mocked for now: once Azure Entra ID is wired, the identity bound on `room:join` will come from the validated token instead of the payload. Host-only actions sent by a non-host fail with `NOT_HOST`.

Rooms hold at most 7 players. In the lobby each player chooses `dancer` or `spectator` (`role:select`) and can mark themselves ready to dance, or cancel it, with `player:ready` (`{ roomCode, playerId, ready }`); every change is broadcast as `room:updated` (`players[].ready`) and is only accepted while the room is waiting. Starting a battle is a three-step flow: (1) once every player is ready (`PLAYERS_NOT_READY` otherwise) and at least 2 chose to dance, the host sends `song-challenge:start`; (2) the dancers race to type the phrase and the winner picks a song with `song:choose`; (3) choosing the song starts the battle by itself (`battle:started`). `battle:start` alone is only for a room whose song is already chosen and fails with `SONG_NOT_SELECTED` otherwise. Anyone still undecided spectates. Because every player must be ready, the host can remove an idle player from the lobby with `player:kick`: the player leaves through the normal departure rules, every tab of theirs receives `room:kicked` and is unbound (it can no longer act nor receive the room's events), and the room gets `room:updated`.

**Battle timing.** `battle.startedAt` is the start command plus `BATTLE_START_COUNTDOWN_MS`; ratings sent before it fail with `BATTLE_NOT_STARTED`. The battle finishes, with a result, as soon as every spectator in the room has rated every dancer in the battle. Otherwise it finishes on its own at `battle.endsAt` = `startedAt` + the song clip (`song.durationSeconds`, the length of the clip played, not of the full video) + `RATING_GRACE_MS`: with the ratings and word bonuses collected so far when there are any, with `result: null` when nothing was collected (for example a battle without spectators, or whose last spectator left).

**Leaving mid-battle.** A dancer who leaves (or whose seat is released after the disconnect grace period) is withdrawn from `battle.dancerIds` and can no longer be rated. With at least 2 dancers left the battle goes on: no rating for the departed dancer is required, and ratings they already received stay in `battle.ratings` as history but are excluded from `battle.result`. With fewer than 2 dancers left the battle ends early with `result: null`. A departure (dancer or spectator) that leaves every remaining spectator having rated every remaining dancer finishes the battle with a result; ratings from spectators who left still count. Every path that finishes a battle (last rating, leave, released seat, deadline) emits `room:updated` and `battle:finished`, stops the word race and clears the battle deadline.

**Abandoned rooms.** Besides the per-seat disconnect grace timer, a sweep runs every 60 s: it releases every seat that has had no socket bound to it for longer than `DISCONNECT_GRACE_MS` (through the normal leave path, so a release can finish a battle like any departure), deletes rooms without players, and re-arms each room's deadlines. A room created over HTTP whose host never connects is released after `DISCONNECT_GRACE_MS` + 5 s.

**Song selection.** In the lobby the host starts a typing challenge: the server picks a random phrase, sets `room.songSelection` (phase `typing`, `challenge.phrase`, `challenge.expiresAt`) and broadcasts it. The first dancer who submits the exact phrase (case sensitive, surrounding spaces ignored) wins the right to pick the song (phase `choosing`). A misspelled submission is rejected and costs that player their chance for the round. When the countdown (`SONG_CHALLENGE_MS`, default 15 s) runs out, or every dancer misspelled it, the server passes the turn to a random dancer still in the room, preferring those who did not misspell. Every chooser gets `SONG_CHOOSE_MS` (default 20 s, `songSelection.chooseDeadline`) to pick, renewed when the turn passes to someone else; when it runs out the server picks a random option for them through the same path as a manual choice (so the battle starts by itself) and sets `songSelection.autoPicked`. The chosen song is stored in `room.selectedSong` and copied to `battle.song` when the battle starts; the battle cannot start while a selection is in progress.

**Word race.** When a battle starts the server plans a few rounds (`WORD_RACE_ROUNDS`, default 3) at random moments of the song (between 10% and 85% of it; `WORD_RACE_FALLBACK_DURATION_MS` when the battle has no song), each with a different Spanish word from `src/domain/catalog/words.ts`. When a round opens, everyone gets `word:round-started` with the time left (`WORD_RACE_WINDOW_MS`, default 10 s; openings at least `WORD_RACE_MIN_GAP_MS` apart). Dancers send `word:submit`; the comparison ignores case and surrounding spaces, and a typo does not lock the dancer out. The first correct submission wins (`won`); a correct one that arrives after it gets `late`. The room then receives a single `word:round-ended` with the winner, or with reason `expired` when nobody typed it in time. The winner earns `WORD_BONUS_POINTS` (default 1) at once: it is added to `battle.bonusPoints[dancerId]`, broadcast with `room:updated` so the current score is visible while the song plays, and summed with the spectators' ratings in `battle.result.scores`. A typo, a late answer or an expired round earns nothing and leaves the points already accumulated untouched. A bonus arriving after the battle finished, or for a dancer who left, is ignored. The race stops when the battle finishes or the room is deleted.

### Concurrency

**Why it matters even with one process.** Node runs one callback at a time, but a handler that `await`s gives way to others. Socket.IO also dispatches the events of a socket through `process.nextTick`, so two frames that arrive in the same TCP read (two ratings sent back to back, `role:select` immediately followed by `battle:start`) start both handlers before either one finishes. With a plain read -> decide -> save, both read version N of the room, both save, and the second save silently drops the first change (lost update): one rating vanishes and the battle never finishes, or the battle starts from the role list before the change. An async store (Redis, Postgres) or a second battle-service instance only widens that window. The repository answering synchronously does not make read -> save safe.

**Room: optimistic concurrency.** `Room` carries a `version` (0 when created, +1 on every stored change, also sent to clients). `RoomRepository` has no blind `save`: every change goes through `update(code, mutate)`, which runs the pure domain decision (`mutate`) on the latest stored state and writes only if nobody wrote in between. A mutation can return a new room (stored, version bumped), the same room (nothing written), `null` (room deleted, e.g. the last player left) or throw a `DomainError` (nothing written, the error reaches the client). Every use case that changes a room (join, leave, kick, role, battle start, rating, song challenge start/submit/expiry, song choice and automatic pick, battle deadline, empty-room deletion) takes its decision inside `mutate`, and values it returns besides the room (the `finished` flag of a rating, the outcome of a typed phrase, whether a departure ended the battle) are computed there too, so they describe the state that was actually stored. Creating a room uses `insert`, which fails instead of overwriting when the code is taken.

| Operation | SQL | Redis |
|---|---|---|
| `update` | `SELECT data, version FROM rooms WHERE code = $1`, run `mutate`, then `UPDATE rooms SET data = $1, version = version + 1 WHERE code = $2 AND version = $3`; `rowCount 0` = someone else wrote first: re-read and run `mutate` again (bounded, e.g. 5 attempts with jittered backoff) | `WATCH room:{code}`, `GET`, run `mutate`, `MULTI` / `SET` / `EXEC`; a nil `EXEC` is the conflict, retried the same way |
| `insert` | `INSERT ... ON CONFLICT DO NOTHING` (`rowCount 1` = stored) | `SET room:{code} <json> NX` |

`InMemoryRoomRepository.update` reads, runs `mutate`, checks the version and writes in one synchronous block (no `await` in between), so concurrent updates are serialized and never conflict; it still refuses a state derived from an older version (the read -> save misuse). Rooms are stored and handed out as copies.

**Timers never decide on their own.** The per-room deadlines (song challenge expiry, chooser deadline, battle end) live in `RoomTimers` (`src/infrastructure/scheduling`), are re-armed from the stored state every time a room is published, and are cleared when the room is deleted or on shutdown. A timer only triggers a use case that re-checks, inside `update`, that the same challenge or battle is still in the same phase and that the deadline really passed; a late, early or stale timer therefore changes nothing (an early one is simply re-armed). Every timer is `unref()`ed.

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
