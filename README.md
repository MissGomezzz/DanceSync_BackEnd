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
cd battle-service && pnpm typecheck && pnpm build
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
| server -> client | `room:updated` | `Room` |
| server -> client | `battle:started` | `Room` |
| server -> client | `chat:message` | `ChatMessage` |
| server -> client | `battle:finished` | `Room` (includes `battle.result`) |

Rooms hold at most 8 players. When the host starts the battle, two players become dancers and the rest spectate; the battle finishes automatically once every spectator has rated both dancers.

## Roadmap

- **Authentication with Azure Entra ID**: validate JWTs at the `api-gateway` (`spring-boot-starter-oauth2-resource-server`), propagate identity downstream, and configure `users-service` and `battle-service` as resource servers. `users.external_id` is already reserved for the Entra ID object id. `TODO`: wire `spring-security` once the tenant and app registrations exist.
- **Payments**: dedicated payments service behind the gateway; provider to be decided.
- **Match history persistence**: `battle-service` will call `users-service` (`USERS_SERVICE_URL`) when a battle finishes to store the result in `match_history`.
- **Horizontal scaling of battle-service**: replace `InMemoryRoomRepository` with Redis and enable the Socket.IO Redis adapter.
