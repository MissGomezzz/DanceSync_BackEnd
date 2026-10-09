# PRD: Live scoring, spectator voting and match closure (HU 15–22)

Spectators stop rating with stars and instead vote for their favourite dancer, a
vote they can change until the song ends. Every vote and every word-race win
updates a live, colour-coded ranking that dancers and spectators watch during the
battle. When the song ends the match closes, everyone sees a final results
dashboard, the result is stored in PostgreSQL through users-service, and the host
can start a rematch in the same room while anyone can leave.

| | |
|---|---|
| Status | Draft for review |
| Scope | HU 15, 16, 17, 18, 19, 20, 21, 22 (Azure Boards) |
| Repos | DanceSync_BackEnd (battle-service, users-service, api-gateway), DanceSync_FrontEnd |
| Delivery | Local commits only; push only when the product owner says so |

## Quick path (implementation order)

1. **Scoring core** (HU 20, 17): replace star ratings with changeable votes and recompute standings on every vote and word win.
2. **Live ranking** (HU 16, 17, 19): ship `battle.standings` in every room payload; frontend live table with rank colours and change indicators; player names dashboard.
3. **Match closure** (HU 18, 21): battle ends at song end; end announcement; final results dashboard; persist the match in users-service.
4. **Rematch and exit** (HU 18, 22): host rematch back to the lobby; HTTP leave endpoint plus `sendBeacon` on tab close; pressed state for the exit button.
5. **Verify** HU 15 (already delivered) against its acceptance criteria.

## Product decisions

Decisions confirmed with the product owner on 2026-10-09.

| Topic | Decision |
|-------|----------|
| How spectators vote (HU 20) | One vote per spectator for a single favourite dancer, by tapping the dancer's name. Replaces the 1–5 star ratings. |
| When votes count | During the dance. A spectator can change or withdraw the vote until the song ends. |
| Points | Vote = **2** points, word-race round won = **1** point. Configurable: `VOTE_POINTS`, `WORD_BONUS_POINTS`. |
| Score formula | `score = VOTE_POINTS × votes + WORD_BONUS_POINTS × wordsWon`. |
| When the match ends (HU 18) | When the song clip ends. Early only if fewer than 2 dancers remain. The 30 s rating grace is removed. |
| After the match | Results dashboard. The host may start a rematch in the same room; any player may leave instead. |
| Persistence (HU 21) | Final results are stored in PostgreSQL by users-service and served by a results endpoint. |
| Dance animations (HU 15) | Already delivered: the Just Dance choreography video players follow. No new pictograms. |

## Assumptions (reasonable defaults, not asked)

| Topic | Assumption |
|-------|------------|
| Vote privacy | Only totals are public; who voted for whom is not shown. Each spectator sees their own vote. |
| Ties in the ranking | Competition ranking: equal scores share a rank (1, 1, 3). A tie at the top ends as a draw (no winner). |
| Leavers | A spectator who leaves loses their vote. Votes for a dancer who leaves are discarded and those spectators can vote again. |
| Rematch | Same players and roles; everyone's `ready` resets; song selection restarts; the previous result stays visible in the lobby as "Last battle". |
| Duplicate names (HU 19) | The server disambiguates a display name already used in the room by appending ` 2`, ` 3`, ... |
| Rank colours (HU 16) | 1st gold, 2nd silver, 3rd bronze, others neutral; ties share the colour of their rank. |
| Leave endpoint identity (HU 22) | Uses the mocked guest identity like every other action until Azure Entra ID. Documented as a known limitation. |

## User stories

Each story lists its Azure Boards tasks and the acceptance criteria this PRD commits to.

### HU 15 — Mostrar animaciones/diagramas de baile (Jugador) · already delivered

- [x] The chosen song's choreography video plays during the battle for every player.
- [x] Playback starts on server time (`battle.startsInMs`), unaffected by client clock skew.
- [x] When the browser blocks autoplay, a "Tap to start the music" control appears.
- [ ] Verify in the end-to-end run of this PRD (no code change expected).

### HU 16 — Visualizar puntajes (Jugador)

Tasks: Color en los puntajes dependiendo de su ranking actual · Ranking en tiempo real (backend) · Tabla de puntajes en vivo (frontend).

- [ ] Every room payload during a battle carries `battle.standings`, sorted by rank.
- [ ] Dancers and spectators see a live scoreboard: rank, name, votes, words won, score.
- [ ] Rows are coloured by current rank (gold, silver, bronze, neutral); tied dancers share the colour.
- [ ] The scoreboard updates within one round trip of a vote or a word win, without a page refresh.

### HU 17 — Actualización puntajes (Jugador)

Tasks: Cambio de colores en los puntajes a medida de que cambian · Actualización del puntaje del jugador (backend) · Indicador de cambio de puntaje (frontend).

- [ ] The server recomputes standings atomically on every vote cast, changed or withdrawn, every word win, and every leave.
- [ ] Concurrent votes never lose updates (optimistic concurrency on Room, as today).
- [ ] When a dancer's score changes, the row shows a temporary `+N` / `−N` chip (green up, red down) for about 2 s.
- [ ] When a dancer's rank changes, the row colour transitions to the new rank colour and shows an up/down arrow.

### HU 18 — Finalización partida (Jugador) · owner: Samuel

Tasks: Anuncio para jugadores de finalización de la partida · Cierre de partida (backend) · Cierre de partida en la interfaz (frontend).

- [ ] The server finishes the battle exactly at song end (`startedAt + song.durationSeconds`), or early when fewer than 2 dancers remain.
- [ ] Finishing freezes votes (`BATTLE_FINISHED` for late votes), stops the word race and emits `battle:finished` once.
- [ ] Every player sees an end announcement (overlay: "Battle over!" + winner or draw) and then the results dashboard.
- [ ] Voting controls are disabled once the battle is finished.
- [ ] The host sees "Rematch"; everyone sees "Leave room".
- [ ] Rematch returns the room to the lobby with the rules in Assumptions; non-hosts get `NOT_HOST`.

### HU 19 — Visualización nombre jugadores (Jugador)

Tasks: Dashboard con nombres de jugadores · Nombre visible del jugador (backend) · Etiqueta de nombre en pantalla (frontend).

- [ ] During the battle a players panel lists every player with role (dancer/spectator) and a "you" marker.
- [ ] Every video tile shows the dancer's name label; it stays readable over the video.
- [ ] Display names are validated (1–32 chars, trimmed) and unique within a room (server suffixes duplicates).

### HU 20 — Votación espectadores (Espectador)

Tasks: Botones de votación de jugadores por nombre · Registro de votos (backend) · Control del voto en la interfaz (frontend).

- [ ] Spectators see one button per dancer, labelled with the dancer's name.
- [ ] Tapping a name casts the vote; tapping another moves it; tapping the selected one withdraws it.
- [ ] The selected button is visibly pressed (`aria-pressed`), and "Your vote: <name>" is shown.
- [ ] Dancers cannot vote (`INVALID_VOTER`); votes before the start are rejected (`BATTLE_NOT_STARTED`); votes after the end are rejected (`BATTLE_FINISHED`).
- [ ] The server stores at most one vote per spectator and validates socket identity like every other event.

### HU 21 — Conocer puntajes finales (Jugador)

Tasks: Dashboard final de resultados de la partida · Endpoint de resultados finales (backend) · Resaltado del ganador y diferencias (frontend).

- [ ] On finish, battle-service stores the match in users-service (idempotent `PUT`, retried with backoff).
- [ ] `GET /api/matches/{matchId}` (through the gateway) returns the stored results; `GET /api/matches?roomCode=XYZ` lists a room's matches.
- [ ] The final dashboard shows a podium, a table (rank, name, votes, words, score) and each dancer's gap to the winner (`−N pts`).
- [ ] The winner is highlighted; a draw shows "It is a tie!" with all tied leaders highlighted.
- [ ] After a refresh on a finished battle, the dashboard still loads (from the room payload or the results endpoint).

### HU 22 — Botón de salida (Jugador) · owner: Samuel

Tasks: Cambio del color del botón una vez oprimido · Endpoint de salida de sala (backend) · Botón "Salir" (frontend).

- [ ] A visible "Leave room" button exists in the lobby, the battle and the results dashboard.
- [ ] Once pressed it changes colour and label ("Leaving…") and is disabled; navigation home is immediate.
- [ ] `POST /api/rooms/{code}/leave` with `{ playerId }` runs the same leave flow as the socket event (seat released, host handed over, battle settled, broadcast).
- [ ] Closing the tab sends the same request with `navigator.sendBeacon`, so the seat is released at once instead of after the disconnect grace period.

## Technical design

### Domain changes (battle-service)

| Area | Change |
|------|--------|
| `Battle` | Replace `ratings` with `votes: Record<voterId, dancerId>`. Rename `bonusPoints` to `wordsWon` (counts, not points). Keep `roster`. Add `endReason: 'song-end' \| 'not-enough-dancers' \| null`. |
| `BattleResult` | `standings: Standing[]` + `winnerId: string \| null`. |
| `Standing` | `{ dancerId, displayName, votes, wordsWon, score, rank }`. |
| Scoring | Pure `ScoringService.standings(battle, points)` used live and at finish. |
| End rule | `endsAt = startedAt + song clip`; remove the rating grace and the "all spectators rated" early finish. |
| Room | `lastResult: BattleResult \| null` kept across a rematch. |
| Names | `RoomService.join` disambiguates duplicate display names. |

### Wire contract

| Kind | Name | Payload | Notes |
|------|------|---------|-------|
| C→S | `vote:cast` | `{ roomCode, voterId, dancerId \| null }` | `null` withdraws. Ack: `{ dancerId \| null }` (the voter's current vote); the new totals arrive through `room:updated`. |
| C→S | `room:rematch` | `{ roomCode, requesterId }` | Host only, room `finished`. Ack: Room. |
| C→S | `rating:submit` | — | **Removed.** |
| S→C | `room:updated` etc. | Room DTO | DTO adds `battle.standings` and `battle.voteCounts` (live). Raw votes are never sent. |
| S→C | `vote:mine` | `{ roomCode, dancerId \| null }` | Sent only to the voter's `player:<id>` channel after each change and on join resync. |
| S→C | `battle:finished` | Room DTO | Unchanged event; `battle.result.standings` filled. |
| HTTP | `POST /api/rooms/{code}/leave` | `{ playerId }` | 204. Same flow as `room:leave`. |
| HTTP | `GET /api/matches/{id}` | — | users-service via gateway (GET only). |
| HTTP | `GET /api/matches?roomCode=` | — | users-service via gateway (GET only). |
| Internal | `PUT /api/matches/{id}` | match document | battle-service → users-service directly; NOT routed by the gateway. |

**Vote privacy on the wire:** room payloads are broadcast to everyone, so they only carry totals (`battle.voteCounts`, `battle.standings`). Each spectator learns their own choice through `vote:mine`, sent to their private `player:<id>` channel. The `vote:cast` ack also returns it. Raw `votes` never leave the server.

New error codes: `INVALID_VOTER` (dancer or non-member votes), `BATTLE_FINISHED` (late vote). Reused: `BATTLE_NOT_STARTED`, `NOT_HOST`, `ROOM_NOT_FINISHED` (rematch before the end, new).

### Persistence (users-service)

Flyway `V2__matches.sql`: drop the unused `match_history` (two-dancer, user-FK design) and create:

| Table | Columns |
|-------|---------|
| `matches` | `id UUID PK` (= battle id), `room_code`, `song_id`, `song_title`, `started_at`, `finished_at`, `winner_player_id VARCHAR(64) NULL`, `end_reason` |
| `match_participants` | `match_id FK`, `player_id VARCHAR(64)`, `display_name`, `role`, `votes`, `words_won`, `score`, `rank`, `left_early BOOLEAN`, PK (`match_id`, `player_id`) |

Player ids are opaque strings (guests today, Entra ID subjects later), so there is no FK to `users`.
`PUT /api/matches/{id}` is an idempotent upsert, so battle-service retries are safe. battle-service sends it on finish with 3 attempts and exponential backoff; a failure is logged and does not affect the live room (the room payload still carries the result).
The gateway exposes only `GET` on `/api/matches/**`.

### Concurrency notes

- Votes go through `rooms.update(code, mutate)`: the last vote of a spectator always wins, no lost updates under bursts.
- A vote racing the song-end finish is decided inside the same atomic mutation: before `finishedAt` it counts, after it is rejected.
- The match is persisted exactly once per battle id (idempotent `PUT`), even if the finish path is retried.

## Out of scope

- Authentication with Azure Entra ID (identities stay mocked).
- Choreography pictograms or pose detection.
- Match history page per user (the endpoint exists; the UI is a future HU).
- Spectator vote anti-abuse beyond one vote per seat.

## Verification checklist

- [ ] battle-service unit tests: scoring formula, ranks with ties, vote cast/move/withdraw, leavers, end at song end, rematch reset.
- [ ] Concurrency test: 50 spectators voting and changing votes concurrently → counts equal the final per-spectator choice.
- [ ] Socket tests for every new event, including identity spoofing and wrong roles.
- [ ] users-service tests: upsert idempotency, GET by id and by room code, migration under `ddl-auto: validate`.
- [ ] Frontend tests: live table colours and change chips, vote buttons, end announcement, results dashboard with gaps, rematch, leave pressed state.
- [ ] End-to-end in the browser: 2 dancers + 2 spectators, votes change live, words add points, match ends at song end, dashboard, stored match visible via `GET /api/matches/{id}`, rematch, leave.
