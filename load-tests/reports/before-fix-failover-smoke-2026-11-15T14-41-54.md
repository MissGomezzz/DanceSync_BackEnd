# DIS-1 failover run: smoke

DIS-1 failover: one of two battle-service replicas killed mid-battle. Started 2026-11-15T14:41:54.819Z.

| Setup | Value |
|---|---|
| Rooms battling / requested | 2 / 2 (7 users each) |
| Users in battle | 14 |
| Replica killed (SIGKILL) | battle-1, 17 s after the last battle started |
| Connections per replica at the kill | battle-1: 7, battle-2: 7 |
| Word rounds still pending at the kill | 5 |
| Load balancer | nginx OSS, least_conn, passive checks (max_fails=1 fail_timeout=10s, proxy_connect_timeout 2s) |
| Clients | socket.io-client defaults (1 s delay, x0.5 jitter, 5 s max), WebSocket only |
| Machine | win32 10.0.26200, 8 CPUs, 16 GB |
| Load generator: worst event loop delay | 37 ms (all bots run in one process; a large value delays every client) |

| Measure | Target | Result | Verdict |
|---|---|---|---|
| Service restored (kill -> every disconnected client receives room events again) | < 30 s | max 3821 ms, p95 3821 ms, p50 3708 ms; 5/7 clients | FAIL |
| Rooms with state and scores intact | >= 95 % | 0/2 (0 %) | FAIL |
| Finished-match results lost | 0 | 0 of 2 (2 rows in PostgreSQL) | PASS |
| Duplicated results / scores | 0 | 0 duplicated rows, 0 persisted scores different from the room, 0 duplicated round-end events | PASS |

Other observations: 2 failed rejoins, 35 failed chat messages (sent while disconnected or refused), 0 votes that could not be cast, 0 rooms that failed during setup.

Rooms not intact:
- NU8GFB: sameBattleFinishedAtSongEnd, everyPlayerStillSeated, votesKept, everyRoundOpenedAndClosed
- HHUK7X: sameBattleFinishedAtSongEnd, everyPlayerStillSeated, votesKept, everyRoundOpenedAndClosed
