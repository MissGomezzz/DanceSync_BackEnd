# ADR-06: Failover of battle-service replicas without losing rooms, rounds or results

| | |
|---|---|
| Status | Accepted and implemented (backend and local prototype); Azure settings pending (see Consequences) |
| Date | 15 November 2026 |
| Scenario | DIS-1 (availability: fault tolerance and horizontal scaling) |
| Depends on | [ADR-01: room and round state in Redis](ADR-01-estado-en-redis.md), [ADR-02: load balancer and WebSocket without session affinity](ADR-02-balanceador-solo-websocket.md) |

## Context

DIS-1: one of two battle-service replicas stops abruptly while 20 rooms (140 users) are battling. The service must be restored in under 30 s, at least 95 % of the rooms must keep their state and scores, no finished-match result may be lost and no score may be counted twice.

ADR-01 and ADR-02 already made any replica able to serve any connection (state in Redis, Socket.IO Redis adapter, WebSocket without affinity, idempotent `room:join`). A review of what a replica keeps only for itself found four things that died with it:

1. **Word race timers.** Only the replica that started a battle armed the timers that open and close its word rounds. A probe killing that replica opened 0 of the 3 rounds; an open round was never closed.
2. **Finished-match results.** The finishing replica sent the result to users-service fire-and-forget (3 in-memory tries over about 1.5 s). Killing it mid-request, or a users-service outage longer than that, lost the result.
3. **Kick and leave.** They detached only the sockets of the replica that handled them; a kicked player's tab on the other replica kept receiving and sending room events.
4. **Seats during a failover.** A disconnected player keeps the seat for the disconnect grace (15 s). A seat is released only after it was seen without a socket for that long, never on a single observation: the deadline that reaps a room whose host never connected (20 s after `POST /api/rooms`, on the replica that served it) only applies while the host is alone in the lobby, because during a failover the host of a running battle is legitimately unbound for a few seconds. Every release is logged with its cause.

**Failure detection.** The health endpoint was static (a replica without Redis looked healthy), the Socket.IO heartbeat used the 25 s + 20 s defaults, and nginx needed 2 failures to take a replica out.

## Decision

**State resynchronization instead of ownership.** No replica owns a room. Every replica can take over the timers of any battling room from the state in Redis:

- `WordRaceScheduler.resume(room)` re-arms an opening timer at `opensAt` for every scheduled round and an expiry timer at `closesAt` for the open one, from the absolute times stored with the race. It runs on `room:join` of a battling room (the clients of the dead replica reconnect and rejoin) and on the periodic sweep of every replica (every 15 s), for rooms whose clients were all on the survivor.
- Duplicate timers on several replicas are safe by construction: opening, claiming and expiring a round are atomic compare-and-set operations in Redis (Lua), and only the replica whose transition applied broadcasts it, so each `word:round-started` / `word:round-ended` goes out once.
- The round claim and its bonus are two writes. The bonus is idempotent per round (`battle.wordRoundsAwarded`), and `resume` pays the bonus of any won round that is still unpaid.
- Claim and expiry decide with the Redis server clock (`TIME` inside the script), not the calling replica's clock, so clock skew between replicas cannot change who wins a round.

**Transactional outbox for match results.** The finishing replica (the one whose update finished the battle) enqueues the result in a Redis outbox keyed by battle id before sending it, and removes it only after a 2xx. Every replica's sweep delivers what is pending, with exponential backoff, and re-enqueues the result of any finished room that is neither pending nor delivered (the finisher died between the finish and the enqueue). users-service stores results with an idempotent upsert (`PUT /api/matches/{battleId}`), so duplicate deliveries are harmless.

**Cross-replica unbinding.** Kick and leave find the player's sockets through the adapter (`fetchSockets` on the player channel) and move them out of the room channels wherever they are; `requireOwnSeat` additionally requires the socket to still be in the room channel.

**Seats during a failover.** A disconnected player keeps the seat for the disconnect grace (15 s). A seat is released only after it was seen without a socket for that long, never on a single observation: the deadline that reaps a room whose host never connected (20 s after `POST /api/rooms`, on the replica that served it) only applies while the host is alone in the lobby, because during a failover the host of a running battle is legitimately unbound for a few seconds. Every release is logged with its cause.

**Failure detection.**

- Liveness `GET /api/battles/health` (process up, cheap) and readiness `GET /api/battles/health/ready` (Redis answers a PING within 800 ms, otherwise 503).
- Socket.IO heartbeat 10 s + 5 s (`SOCKET_PING_INTERVAL_MS`, `SOCKET_PING_TIMEOUT_MS`): a client behind a hung replica reconnects within 15 s.
- Redis adapter `requestsTimeout` 1.5 s, so a replica that stops answering does not stall `fetchSockets`.
- nginx (prototype, OSS, passive checks): `max_fails=1 fail_timeout=10s`, `proxy_connect_timeout 2s`, retry once on the other replica. A crashed replica is detected by the first request that fails on it. nginx OSS has no active checks, so a replica that hangs while still accepting connections is only noticed through the clients' heartbeat; in Azure Container Apps the readiness probe removes it actively.

## Alternatives considered

| Alternative | Why it was discarded |
|---|---|
| Room ownership with leader election or leases (one replica owns each room's timers, another takes over when the lease expires) | More moving parts (lease renewal, fencing) for a result the atomic transitions already give: with idempotent timers every replica can arm them and the duplicates cost a few Redis calls |
| A dedicated scheduler (Redis keyspace notifications, BullMQ delayed jobs) | Another component to deploy and monitor; keyspace notifications are best effort and disabled by default in Azure Cache for Redis |
| Retrying the result in memory for longer | Still lost when the replica dies, which is exactly the DIS-1 stimulus |
| Writing the result inside the same Redis script that finishes the battle | The room update is a version compare-and-set over a decoded JSON document; doing it in Lua would move domain logic into the script. The sweep's re-enqueue of finished rooms closes the same gap |
| HAProxy or nginx Plus for active health checks in the prototype | Kept nginx OSS as decided in ADR-02; the active check exists where it matters (Azure ingress probes) |

## Consequences

**Positive**

- A replica can die at any point of a battle; the survivor resumes timers, pays missing bonuses and delivers pending results. Verified by tests (two replicas sharing Redis, the owner killed mid-race; the finisher killed mid-publish) and by `load-tests/scripts/failover.mjs` (reports in `load-tests/reports/`): with 140 users and one of two replicas killed with SIGKILL, every disconnected client received room events again within 3.9-6.1 s (p95), 20/20 rooms kept their state and scores, and every finished battle reached PostgreSQL exactly once, in each of 5 runs. Earlier runs exposed the defect described under "Seats during a failover" (fixed) and two stalls of the test machine (see the README).
- nginx keeps its upstream state in a shared `zone`, so least_conn balances across workers and a dead replica is marked down once for every worker.
- Nothing in `domain` depends on Redis: the outbox is a port with in-memory and Redis adapters.

**Negative and risks**

- Every replica arms the timers of every battling room after a sweep, so each round costs a few extra Redis calls per replica. Negligible at 2 replicas; worth revisiting beyond a handful.
- A replica that dies after applying a round transition and before broadcasting it loses that one broadcast (clients resync the open round on rejoin, but an end that was never announced stays unannounced). The window is a few milliseconds.
- A seat is still released after the 15 s disconnect grace, and a player whose seat was released cannot rejoin a battle in progress (`ROOM_NOT_WAITING`). If a stall keeps clients away longer than that (as in the stalled test runs), the room loses players and a battle left with one dancer ends early. Whether the grace should be longer during a battle, or a released player should be able to come back, is a product decision.
- The shorter heartbeat (10 s + 5 s) detects dead connections sooner but also drops healthy clients sooner when a replica's event loop stalls.
- A result refused for good by users-service (non-retryable 4xx) stays in the outbox at the maximum backoff (5 min) and is logged as an error: someone has to look at it. Dropping it or moving it to a dead-letter list is a product decision.
- **Still to configure in Azure** (checklist in the README): at least 2 replicas, liveness and readiness probes on the two endpoints, the `REDIS_URL` secret pointing to Azure Cache for Redis, and ingress without session affinity.
