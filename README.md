# DanceSync_BackEnd

Backend monorepo for **DanceSync**, a Just-Dance-style web app. Up to 7 users join a room and each chooses to dance or to spectate: at least two dancers battle in real time while the spectators chat and vote for their favourite; a live ranking follows every vote and every word-race win, and every finished match is stored.

## Overview

| Service | Stack | Port | Responsibility |
|---|---|---|---|
| `api-gateway` | Spring Boot 4.1.1, Spring Cloud Gateway (reactive/WebFlux), Java 17 | 8080 | Single entry point for the frontend; routes HTTP and WebSocket traffic, applies CORS |
| `users-service` | Spring Boot 4.1.1, Spring Web MVC, Spring Data JPA, Flyway, PostgreSQL, Java 17 | 8081 | User profiles and match history |
| `battle-service` | Node 22, Express 5, TypeScript, Socket.IO 4 | 3000 | Rooms, real-time battles, spectator chat, votes and live scoring (in-memory) |
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
cd api-gateway && mvnw.cmd -DskipTests package && mvnw.cmd test

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
| `PAGEHIDE_GRACE_MS` | `3000` | battle-service (`0` or more; how long a seat is kept after a `pagehide` leave beacon before it is released, unless the player rejoined - a reload) |
| `SONG_CHALLENGE_MS` | `15000` | battle-service (`> 0`; time to type the song-selection phrase) |
| `SONG_CHOOSE_MS` | `20000` | battle-service (`> 0`; time the chooser has to pick a song before one is picked at random) |
| `BATTLE_START_COUNTDOWN_MS` | `5000` | battle-service (`0` or more; countdown between the battle start and the moment dancing and voting begin) |
| `VOTE_POINTS` | `2` | battle-service (positive whole number; points each spectator vote is worth: `score = VOTE_POINTS x votes + WORD_BONUS_POINTS x wordsWon`) |
| `WORD_RACE_ROUNDS` / `WORD_RACE_WINDOW_MS` | `3` / `10000` | battle-service (whole number `0` or more / `> 0`; word race rounds per battle, time to type each word) |
| `WORD_BONUS_POINTS` | `1` | battle-service (positive whole number; points for each word round won, added to the battle score) |
| `WORD_RACE_MIN_GAP_MS` / `WORD_RACE_FALLBACK_DURATION_MS` | `12000` / `90000` | battle-service (`0` or more / `> 0`; time between round openings, song length when there is no song, used for the word race and the automatic battle end) |

`battle-service` reads its own `battle-service/.env` (see `battle-service/.env.example`). `RATING_GRACE_MS` no longer exists: a battle ends exactly when the song clip ends. `USERS_SERVICE_URL` is also where battle-service stores finished matches (`PUT /api/matches/{battleId}`, service to service).

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

### users-service (`/api/matches`, HU 21)

- `PUT /api/matches/{id}` - **internal**: battle-service stores a finished battle (`id` = battle id, a UUID). Idempotent upsert: sending the same id again replaces the stored match (participants included), so retries never duplicate it. Body: `{ roomCode, songId?, songTitle?, startedAt, finishedAt, winnerPlayerId?, endReason: "song-end" | "not-enough-dancers", participants: [{ playerId, displayName, role: "dancer" | "spectator", votes?, wordsWon?, score?, rank?, leftEarly }] }`; `200` with the stored match, `400` on an invalid body or id. The gateway does **not** route it.
- `GET /api/matches/{id}` - the stored match (same shape plus `id`; participants: ranked dancers first, then spectators); `404` when missing.
- `GET /api/matches?roomCode=XYZ` - the room's matches, newest first (`roomCode` is case-insensitive; `400` when missing).

Through the gateway only `GET /api/matches` and `GET /api/matches/**` are exposed (route `users-service-matches`, `Method=GET`); any other method there answers `404`.

**Persistence.** Flyway `V2__matches.sql` drops the unused `match_history` table and creates `matches` (`id` = battle id, `room_code`, `song_id`, `song_title`, `started_at`, `finished_at`, `winner_player_id`, `end_reason`) and `match_participants` (`match_id`, `player_id`, `display_name`, `role`, `votes`, `words_won`, `score`, `rank`, `left_early`; PK `(match_id, player_id)`). Player ids are opaque strings (guests today, Entra ID subjects later), so there is no foreign key to `users`. Dancer statistics are `NULL` for spectators and for dancers who left before the end (they keep `words_won`). Hibernate runs with `ddl-auto: validate`; `MatchPersistenceAdapterPostgresTest` checks the migrations against a Testcontainers PostgreSQL 16 (skipped without Docker). Two racing first `PUT`s of the same id: the loser hits the primary key and is retried once as an update.

### battle-service

HTTP:

- `GET /api/battles/health`
- `POST /api/rooms` (`hostId`, `displayName`) - create a room; returns `201` with the room. If the host never connects a socket to it within `DISCONNECT_GRACE_MS` + 5 s, the room is deleted.
- `GET /api/rooms/:code`
- `POST /api/rooms/:code/leave` (`{ playerId, reason?: "explicit" | "pagehide" }`) - HU 22. The body is accepted as `application/json` **or** as JSON text in a `text/plain` body, which is what `navigator.sendBeacon` can send without a CORS preflight.
  - `reason: "explicit"` (default): the player leaves at once through the same flow as `room:leave` (seat released, host handed over, battle settled, every socket of the player unbound, `room:updated` / `battle:finished` broadcast); `204`.
  - `reason: "pagehide"`: the beacon a page sends when it is hidden. Browsers fire `pagehide` on a reload as well as on a tab close, so the seat is **not** released at once: the per-seat grace timer is armed with `PAGEHIDE_GRACE_MS` (default 3 s) and, when it fires, the seat is released only if no socket of the player is bound to the room; a rejoin cancels it. `202`. A reload therefore keeps the seat, the host role and a running battle, while a closed tab frees them in seconds. A grace never postpones a shorter pending one, so the socket drop that follows the beacon does not stretch it back to `DISCONNECT_GRACE_MS`.
  - `400` for a malformed body, player id or reason, `404` unknown room, `403` (`PLAYER_NOT_IN_ROOM`) when the player is not in it. Identity is the mocked guest id, like every other action until Entra ID (known limitation).
- A malformed JSON body answers `400 { "error": "Malformed JSON body" }`; domain errors answer `{ error, code }` with the status in the table below.

Socket.IO (path `/socket.io`):

| Direction | Event | Payload |
|---|---|---|
| client -> server | `room:join` | `{ roomCode, playerId, displayName }` |
| client -> server | `room:leave` | `{ roomCode, playerId }` |
| client -> server | `battle:start` | `{ roomCode, requesterId, dancerIds? }` (host only) |
| client -> server | `chat:message` | `{ roomCode, senderId, content }` |
| client -> server | `vote:cast` | `{ roomCode, voterId, dancerId \| null }` (spectators, while the song plays) - casts, moves or (`null`) withdraws the voter's single vote; ack data `{ dancerId \| null }` (the voter's current vote) |
| client -> server | `room:rematch` | `{ roomCode, requesterId }` (host only, room `finished`) - back to the lobby for another battle; ack data `Room` |
| client -> server | ~~`rating:submit`~~ | **Removed** (star ratings were replaced by votes) |
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
| server -> client | `battle:finished` | `Room` (includes `battle.result` and `battle.endReason`) - exactly once per battle |
| server -> client | `room:kicked` | `{ roomCode }` - only to the sockets of a kicked player, right before they are unbound from the room |
| server -> client | `vote:mine` | `{ roomCode, dancerId \| null }` - only to the voter's `player:<id>` channel (every tab of theirs): after each `vote:cast`, when their vote is discarded (their dancer left) or cleared (rematch), and to a spectator's socket when it (re)joins a room with a battle |
| server -> client | `webrtc:peer-ready` | `{ playerId }` - broadcast to the rest of the room after `webrtc:ready` |
| server -> client | `webrtc:signal` | same payload as the client event, delivered only to the `to` player |
| server -> client | `word:round-started` | `{ roomCode, roundId, roundNumber, totalRounds, word, expiresInMs }` - to the whole room, and to a single socket that (re)joins mid-round |
| server -> client | `word:round-ended` | `{ roomCode, roundId, roundNumber, totalRounds, word, winnerId, winnerName, reason: "won" \| "expired", wins, bonusPoints }` - exactly once per round; `bonusPoints` is what the winner earned (`WORD_BONUS_POINTS`, 0 when expired) |

**Room payloads.** Every `Room` the server sends (events, acks, the join resync and the HTTP API) goes through one serializer, `toRoomDto(room, now)` (`src/infrastructure/serialization/roomDto.ts`). It keeps every stored field except the raw votes, adds times relative to the moment it was sent (so clients count down without comparing clocks) and the scoring computed from the state being sent:

| Field | Meaning |
|---|---|
| `songSelection.challenge.expiresInMs` | time left to type the phrase (never negative) |
| `songSelection.chooseExpiresInMs` | time the current chooser has left while the phase is `choosing`; `null` otherwise |
| `songSelection.autoPicked` | `true` when the server picked the song because the chooser let the deadline pass |
| `battle.startsInMs` | time until the dancing begins; negative once it began (elapsed time) |
| `battle.endsInMs` | time until the battle finishes on its own while it runs; `null` once finished |
| `battle.roster` | `{ id, displayName }[]` of every dancer, snapshotted at the start (dancers who leave keep their name here) |
| `battle.audience` | `{ id, displayName }[]` of every spectator when the battle started |
| `battle.standings` | `{ dancerId, displayName, votes, wordsWon, score, rank }[]` of the dancers still in the battle, sorted by rank: live while it runs, then the final ranking |
| `battle.voteCounts` | `{ [dancerId]: votes }`, the current (then final) totals |
| `battle.wordsWon` / `battle.scoring` | word rounds won per dancer; `{ votePoints, wordBonusPoints }` snapshotted at the start |
| `battle.endReason` | `"song-end"`, `"not-enough-dancers"`, or `null` while it runs |
| `battle.result` | `{ standings, winnerId }` once finished; `winnerId` is `null` on a tie at the top (draw) |
| `lastResult` | result of the latest finished battle, kept across a rematch (the lobby's "Last battle") |

**Vote privacy.** Room payloads are broadcast to everyone, so `battle.votes` (who voted for whom) never leaves the server: only `voteCounts` and `standings` do. Each spectator learns their own choice through the `vote:cast` ack and `vote:mine` on their private `player:<id>` channel.

**Errors.** A failed client event acks `{ ok: false, error: { code, message } }` (or emits `error:domain` when no ack was given). The HTTP API answers the same codes with these statuses:

| Code | HTTP | Code | HTTP |
|---|---|---|---|
| `ROOM_NOT_FOUND` | 404 | `BATTLE_FINISHED` | 409 |
| `ROOM_FULL` | 409 | `ROOM_NOT_FINISHED` | 409 |
| `ROOM_NOT_WAITING` | 409 | `INVALID_MESSAGE` | 400 |
| `ROOM_NOT_BATTLING` | 409 | `SONG_SELECTION_IN_PROGRESS` | 409 |
| `BATTLE_NOT_STARTED` | 409 | `SONG_SELECTION_NOT_ACTIVE` | 409 |
| `PLAYER_ALREADY_IN_ROOM` | 409 | `NOT_CHALLENGE_PARTICIPANT` | 403 |
| `PLAYER_NOT_IN_ROOM` | 403 | `ATTEMPT_ALREADY_USED` | 409 |
| `INVALID_PLAYER` | 400 | `NOT_SONG_CHOOSER` | 403 |
| `NOT_ENOUGH_PLAYERS` / `NOT_ENOUGH_DANCERS` | 409 | `INVALID_SONG` | 400 |
| `INVALID_DANCER` | 400 | `WORD_RACE_NOT_ACTIVE` | 409 |
| `PLAYERS_NOT_READY` / `SONG_NOT_SELECTED` | 409 | `WORD_ROUND_NOT_OPEN` | 409 |
| `INVALID_VOTER` / `NOT_HOST` | 403 | `INTERNAL_ERROR` (socket only) | 500 |

`INVALID_VOTER` is a vote from a dancer or from someone who is not a spectator of the battle; `BATTLE_NOT_STARTED` a vote during the start countdown; `BATTLE_FINISHED` a vote once the song ended; `INVALID_DANCER` a vote for someone not dancing (or no longer dancing) in the battle; `INVALID_MESSAGE` a `dancerId` that is neither text nor `null`. `room:rematch` answers `NOT_HOST` (not the host) and `ROOM_NOT_FINISHED` (the battle is still running, or there is none). `INVALID_RATER`, `INVALID_SCORE` and `DUPLICATE_RATING` were removed with the ratings. `player:kick` answers `NOT_HOST` (not the host), `ROOM_NOT_WAITING` (battle running), `INVALID_PLAYER` (yourself or a malformed id) and `PLAYER_NOT_IN_ROOM` (unknown target).

**Identity.** `room:join` binds the socket to `(roomCode, playerId)`. Every other client event must name that same room and player (`playerId`, `requesterId`, `senderId`, `voterId` or `from`); otherwise the ack returns `PLAYER_NOT_IN_ROOM` and nothing happens, so nobody can kick, start as the host, chat or vote as someone else. Authentication is mocked for now: once Azure Entra ID is wired, the identity bound on `room:join` will come from the validated token instead of the payload. Host-only actions sent by a non-host fail with `NOT_HOST`.

Rooms hold at most 7 players. Display names are trimmed, 1-32 characters, and unique within a room: a name already used there (ignoring case) gets the first free suffix ` 2`, ` 3`, ... (shortened to stay within 32 characters); a player rejoining keeps their own name. In the lobby each player chooses `dancer` or `spectator` (`role:select`) and can mark themselves ready to dance, or cancel it, with `player:ready` (`{ roomCode, playerId, ready }`); every change is broadcast as `room:updated` (`players[].ready`) and is only accepted while the room is waiting. Starting a battle is a three-step flow: (1) once every player is ready (`PLAYERS_NOT_READY` otherwise) and at least 2 chose to dance, the host sends `song-challenge:start`; (2) the dancers race to type the phrase and the winner picks a song with `song:choose`; (3) choosing the song starts the battle by itself (`battle:started`). `battle:start` alone is only for a room whose song is already chosen and fails with `SONG_NOT_SELECTED` otherwise. Anyone still undecided spectates. Because every player must be ready, the host can remove an idle player from the lobby with `player:kick`: the player leaves through the normal departure rules, every tab of theirs receives `room:kicked` and is unbound (it can no longer act nor receive the room's events), and the room gets `room:updated`.

**Votes and scoring (HU 16, 17, 20).** Each spectator has at most one vote, for a single dancer, cast with `vote:cast`; voting for another dancer moves it, `dancerId: null` withdraws it. Votes count from `battle.startedAt` until the song ends. `score = VOTE_POINTS x votes + WORD_BONUS_POINTS x wordsWon` (2 and 1 by default, snapshotted into `battle.scoring` when the battle starts). The ranking is a competition ranking: equal scores share a rank (1, 1, 3) and keep the start order; a tie at the top is a draw (`winnerId: null`). The pure `ScoringService` computes it for every room payload while the battle runs and once more, frozen, for `battle.result`, so the live table and the final one always agree.

**Battle timing (HU 18).** `battle.startedAt` is the start command plus `BATTLE_START_COUNTDOWN_MS`; votes sent before it fail with `BATTLE_NOT_STARTED`. The battle finishes exactly at `battle.endsAt` = `startedAt` + the song clip (`song.durationSeconds`, the length of the clip played, not of the full video), `endReason: "song-end"`, or earlier only when fewer than 2 dancers remain (`"not-enough-dancers"`). There is no rating grace any more and votes never end a battle. A finished battle always has a result (all-zero scores are a draw); it is also copied to `room.lastResult`. Finishing freezes the votes: a vote racing the end is decided inside the same atomic room update, counted before `endsAt` and refused with `BATTLE_FINISHED` from then on.

**Rematch (HU 18).** Once the battle is finished the host may send `room:rematch`: the room goes back to `waiting` with the same players and roles, everyone's `ready` resets, the song selection restarts (`selectedSong` and `songSelection` cleared), `battle` becomes `null` and `lastResult` keeps the previous result. Battle timers and the word race are stopped and the room is broadcast; spectators whose vote was cleared get `vote:mine` with `null`. Anyone may simply leave instead.

**Match history (HU 21).** Every finished battle (song end, leave, released seat) is sent, from the single finish path, to users-service with `PUT /api/matches/{battleId}` through the `MatchResultPublisher` port (`HttpMatchResultPublisher`, global `fetch`, 5 s timeout): every dancer of the roster with their final `votes`, `wordsWon`, `score` and `rank`, every spectator who watched from the start with their role, and `leftEarly` for whoever left before the end. It runs in the background with 3 attempts and exponential backoff (500 ms, 1 s); a `4xx` is not retried. A failure is logged and never affects the room, whose payload already carries the result. The id is the battle id and the `PUT` is an idempotent upsert, so a retry stores the match once.

**Leaving mid-battle.** Leaving works the same through `room:leave`, `POST /api/rooms/:code/leave` or a seat released after the disconnect (or pagehide) grace period. A spectator who leaves loses their vote. A dancer who leaves is withdrawn from `battle.dancerIds` (they stay in `battle.roster`): the votes for them are discarded, their former voters get `vote:mine` with `null` and may vote again. With at least 2 dancers left the battle goes on; with fewer it ends early (`endReason: "not-enough-dancers"`) with a result over the dancers who stayed. Every path that finishes a battle (song end, leave, released seat) emits `room:updated` and `battle:finished` once, stops the word race, clears the battle deadline and records the match.

**Abandoned rooms.** Besides the per-seat disconnect grace timer, a sweep runs every 60 s: it releases every seat that has had no socket bound to it for longer than `DISCONNECT_GRACE_MS` (through the normal leave path, so a release can finish a battle like any departure), deletes rooms without players, and re-arms each room's deadlines. A room created over HTTP whose host never connects is released after `DISCONNECT_GRACE_MS` + 5 s.

**Song selection.** In the lobby the host starts a typing challenge: the server picks a random phrase, sets `room.songSelection` (phase `typing`, `challenge.phrase`, `challenge.expiresAt`) and broadcasts it. The first dancer who submits the exact phrase (case sensitive, surrounding spaces ignored) wins the right to pick the song (phase `choosing`). A misspelled submission is rejected and costs that player their chance for the round. When the countdown (`SONG_CHALLENGE_MS`, default 15 s) runs out, or every dancer misspelled it, the server passes the turn to a random dancer still in the room, preferring those who did not misspell. Every chooser gets `SONG_CHOOSE_MS` (default 20 s, `songSelection.chooseDeadline`) to pick, renewed when the turn passes to someone else; when it runs out the server picks a random option for them through the same path as a manual choice (so the battle starts by itself) and sets `songSelection.autoPicked`. The chosen song is stored in `room.selectedSong` and copied to `battle.song` when the battle starts; the battle cannot start while a selection is in progress.

**Word race.** When a battle starts the server plans a few rounds (`WORD_RACE_ROUNDS`, default 3) at random moments of the song (between 10% and 85% of it; `WORD_RACE_FALLBACK_DURATION_MS` when the battle has no song), each with a different Spanish word from `src/domain/catalog/words.ts`. When a round opens, everyone gets `word:round-started` with the time left (`WORD_RACE_WINDOW_MS`, default 10 s; openings at least `WORD_RACE_MIN_GAP_MS` apart). Dancers send `word:submit`; the comparison ignores case and surrounding spaces, and a typo does not lock the dancer out. The first correct submission wins (`won`); a correct one that arrives after it gets `late`. The room then receives a single `word:round-ended` with the winner, or with reason `expired` when nobody typed it in time. The win is counted at once in `battle.wordsWon[dancerId]` (worth `WORD_BONUS_POINTS`, default 1) and broadcast with `room:updated`, so the live standings move while the song plays. A typo, a late answer or an expired round earns nothing and leaves the points already accumulated untouched. A win arriving after the battle finished, or for a dancer who left, is ignored. The race stops when the battle finishes or the room is deleted.

### Concurrency

**Why it matters even with one process.** Node runs one callback at a time, but a handler that `await`s gives way to others. Socket.IO also dispatches the events of a socket through `process.nextTick`, so two frames that arrive in the same TCP read (two votes sent back to back, `role:select` immediately followed by `battle:start`) start both handlers before either one finishes. With a plain read -> decide -> save, both read version N of the room, both save, and the second save silently drops the first change (lost update): one vote vanishes from the totals, or the battle starts from the role list before the change. An async store (Redis, Postgres) or a second battle-service instance only widens that window. The repository answering synchronously does not make read -> save safe.

**Room: optimistic concurrency.** `Room` carries a `version` (0 when created, +1 on every stored change, also sent to clients). `RoomRepository` has no blind `save`: every change goes through `update(code, mutate)`, which runs the pure domain decision (`mutate`) on the latest stored state and writes only if nobody wrote in between. A mutation can return a new room (stored, version bumped), the same room (nothing written), `null` (room deleted, e.g. the last player left) or throw a `DomainError` (nothing written, the error reaches the client). Every use case that changes a room (join, leave, kick, role, battle start, vote, word win, rematch, song challenge start/submit/expiry, song choice and automatic pick, battle deadline, empty-room deletion) takes its decision inside `mutate`, and values it returns besides the room (whether a vote changed anything, the outcome of a typed phrase, whether a departure ended the battle) are computed there too, so they describe the state that was actually stored. Creating a room uses `insert`, which fails instead of overwriting when the code is taken.

| Operation | SQL | Redis |
|---|---|---|
| `update` | `SELECT data, version FROM rooms WHERE code = $1`, run `mutate`, then `UPDATE rooms SET data = $1, version = version + 1 WHERE code = $2 AND version = $3`; `rowCount 0` = someone else wrote first: re-read and run `mutate` again (bounded, e.g. 5 attempts with jittered backoff) | `WATCH room:{code}`, `GET`, run `mutate`, `MULTI` / `SET` / `EXEC`; a nil `EXEC` is the conflict, retried the same way |
| `insert` | `INSERT ... ON CONFLICT DO NOTHING` (`rowCount 1` = stored) | `SET room:{code} <json> NX` |

`InMemoryRoomRepository.update` reads, runs `mutate`, checks the version and writes in one synchronous block (no `await` in between), so concurrent updates are serialized and never conflict; it still refuses a state derived from an older version (the read -> save misuse). Rooms are stored and handed out as copies.

**Timers never decide on their own.** The per-room deadlines (song challenge expiry, chooser deadline, battle end) live in `RoomTimers` (`src/infrastructure/scheduling`), are re-armed from the stored state every time a room is published, and are cleared when the room is deleted or on shutdown. A timer only triggers a use case that re-checks, inside `update`, that the same challenge or battle is still in the same phase and that the deadline really passed; a late, early or stale timer therefore changes nothing (an early one is simply re-armed). Every timer is `unref()`ed.

**Word race: compare-and-set.** The word race keeps its state in its own aggregate and repository (`WordRace`, `WordRaceRepository`), outside `Room`, so a vote saved on the room can never overwrite who won a round. Its transitions are single compare-and-set operations on the port, which is cheaper than a versioned retry for a "first one wins" race: `claimRound(roomCode, roundId, playerId, now)` succeeds only if the round is open, before `closesAt` and without a winner, and increments the winner's tally in the same step. `SubmitWord` validates the text (`WordRaceService.judge`) but never decides from its own earlier read; a failed claim is reported as `late` (or `expired`). Expiring a round is the complementary CAS (`open`, no winner, at or after `closesAt`), so a claim and an expiry can never both succeed, and only the code path whose CAS succeeded broadcasts `word:round-ended`.

| Operation | Redis | SQL |
|---|---|---|
| `claimRound` | `SET word:{room}:{round}:winner <playerId> NX PX <ttl>` (`OK` = you won), or a Lua script that also bumps the tally | `UPDATE word_rounds SET winner_id = $1, status = 'won' WHERE id = $2 AND status = 'open' AND winner_id IS NULL AND closes_at > now()`; `rowCount === 1` = you won |
| `expireRound` | Lua script that expires only when the winner key is absent | `UPDATE word_rounds SET status = 'expired' WHERE id = $1 AND status = 'open' AND winner_id IS NULL AND closes_at <= now()` |

`InMemoryWordRaceRepository` implements each CAS as one synchronous block, the in-memory equivalent of the Lua script or the conditional `UPDATE`.

**Tests.** The concurrency tests slow the stores down with a random 0-5 ms delay per call (like a network round trip) so concurrent commands genuinely interleave, and each one has a negative control running the naive read -> save version through the same slow store to show the test can catch the bug:

- `test/room.concurrency.test.ts`: 50 spectators voting and changing their votes at the same time (cast, move, sometimes withdraw; about 120 writes) end with exactly each spectator's last choice in the totals and the standings, 10 iterations; 100 dancers typing the right phrase at once produce exactly one chooser while the rest get `SONG_SELECTION_NOT_ACTIVE`. Both also run against a stand-in for SQL/Redis that implements `update` with the version compare-and-set and retries above (it logs how many conflicts it retried). The negative controls lose votes and crown several dancers.
- `test/roomConcurrency.socket.test.ts`: over real sockets, back-to-back vote changes from one socket, a full room voting in bursts at once, and `role:select` immediately followed by `battle:start`.
- `test/wordRace.concurrency.test.ts`: 100 simultaneous correct words, 50 times, give exactly one `won` and 99 `late`; a claim racing the expiry takes effect exactly once.

Run them with `pnpm test` (all tests) or, for example, `npx tsx --test test/room.concurrency.test.ts`.

The `webrtc:*` events are a thin signaling relay for the dancers' live cameras (media flows peer to peer, never through the server). The server only checks that the sender joined that room as `playerId`/`from` and that `to` is connected to the same room; otherwise the ack returns `{ ok: false }` and nothing is relayed. Each socket also joins a `player:<playerId>` channel on `room:join` so signals can target a single player.

## Roadmap

- **Authentication with Azure Entra ID**: validate JWTs at the `api-gateway` (`spring-boot-starter-oauth2-resource-server`), propagate identity downstream, and configure `users-service` and `battle-service` as resource servers. `users.external_id` is already reserved for the Entra ID object id. `TODO`: wire `spring-security` once the tenant and app registrations exist.
- **Payments**: dedicated payments service behind the gateway; provider to be decided.
- **Match history UI**: the `GET /api/matches` endpoints exist (HU 21); a per-user history page is a future story.
- **Horizontal scaling of battle-service**: replace `InMemoryRoomRepository` with Redis and enable the Socket.IO Redis adapter.
