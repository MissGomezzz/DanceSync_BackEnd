# DIS-1 failover run: 140u

DIS-1 failover: one of two battle-service replicas killed mid-battle. Started 2026-11-15T14:24:14.485Z.

| Setup | Value |
|---|---|
| Rooms battling / requested | 20 / 20 (7 users each) |
| Users in battle | 140 |
| Replica killed (SIGKILL) | battle-2, 37 s after the last battle started |
| Connections per replica at the kill | battle-1: 63, battle-2: 65 |
| Word rounds still pending at the kill | 60 |
| Load balancer | nginx OSS, least_conn, passive checks (max_fails=1 fail_timeout=10s, proxy_connect_timeout 2s) |
| Clients | socket.io-client defaults (1 s delay, x0.5 jitter, 5 s max), WebSocket only |
| Machine | win32 10.0.26200, 8 CPUs, 16 GB |
| Load generator: worst event loop delay | 594 ms (all bots run in one process; a large value delays every client) |

| Measure | Target | Result | Verdict |
|---|---|---|---|
| Service restored (kill -> every disconnected client receives room events again) | < 30 s | max 3997 ms, p95 3975 ms, p50 3335 ms; 45/49 clients | FAIL |
| Rooms with state and scores intact | >= 95 % | 5/20 (25 %) | FAIL |
| Finished-match results lost | 0 | 0 of 13 (13 rows in PostgreSQL) | PASS |
| Duplicated results / scores | 0 | 0 duplicated rows, 7 persisted scores different from the room, 0 duplicated round-end events | FAIL |

Other observations: 11 failed rejoins, 327 failed chat messages (sent while disconnected or refused), 61 votes that could not be cast, 0 rooms that failed during setup.

Rooms not intact:
- JFJCG9: sameBattleFinishedAtSongEnd, everyPlayerStillSeated, votesKept, everyRoundOpenedAndClosed
- 7MP6KR: sameBattleFinishedAtSongEnd, everyPlayerStillSeated, votesKept, everyRoundOpenedAndClosed
- PY3E6Z: sameBattleFinishedAtSongEnd, everyPlayerStillSeated, votesKept, everyRoundOpenedAndClosed
- RP9BMV: sameBattleFinishedAtSongEnd, everyPlayerStillSeated, votesKept, everyRoundOpenedAndClosed
- 4B8XBE: sameBattleFinishedAtSongEnd, everyPlayerStillSeated, votesKept, everyRoundOpenedAndClosed
- ZL4KJE: everyRoundOpenedAndClosed
- 55DRY4: everyRoundOpenedAndClosed
- 2V8VN4: sameBattleFinishedAtSongEnd, everyPlayerStillSeated, votesKept, everyRoundOpenedAndClosed
- GRFJ78: everyRoundOpenedAndClosed
- BGQLXH: sameBattleFinishedAtSongEnd, everyPlayerStillSeated, votesKept, everyRoundOpenedAndClosed
- QSR9B4: everyRoundOpenedAndClosed
- LBH7H3: sameBattleFinishedAtSongEnd, everyPlayerStillSeated, votesKept, everyRoundOpenedAndClosed
- L52BE9: everyRoundOpenedAndClosed
- 5C7GWM: sameBattleFinishedAtSongEnd, everyPlayerStillSeated, votesKept, everyRoundOpenedAndClosed
- EN84CM: everyRoundOpenedAndClosed
