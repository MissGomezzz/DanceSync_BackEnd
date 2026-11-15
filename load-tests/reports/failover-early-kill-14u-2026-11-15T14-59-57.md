# DIS-1 failover run: early-kill-14u

DIS-1 failover: one of two battle-service replicas killed mid-battle. Started 2026-11-15T14:59:57.793Z.

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
| Load generator: worst event loop delay | 51 ms (all bots run in one process; a large value delays every client) |

| Measure | Target | Result | Verdict |
|---|---|---|---|
| Service restored (kill -> every disconnected client receives room events again) | < 30 s | max 3610 ms, p95 3610 ms, p50 3385 ms; 7/7 clients | PASS |
| Rooms with state and scores intact | >= 95 % | 2/2 (100 %) | PASS |
| Finished-match results lost | 0 | 0 of 2 (2 rows in PostgreSQL) | PASS |
| Duplicated results / scores | 0 | 0 duplicated rows, 0 persisted scores different from the room, 0 duplicated round-end events | PASS |

Other observations: 0 failed rejoins, 0 failed chat messages (sent while disconnected or refused), 0 votes that could not be cast, 0 rooms that failed during setup.
