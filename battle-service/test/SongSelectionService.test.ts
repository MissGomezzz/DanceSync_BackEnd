import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DomainError } from "../src/domain/errors/DomainError.js";
import type { Room } from "../src/domain/model/Room.js";
import { RoomService } from "../src/domain/services/RoomService.js";
import { allReady } from "./support/ready.js";
import { SongSelectionService, type RandomIndex } from "../src/domain/services/SongSelectionService.js";

const T0 = new Date("2026-01-01T00:00:00.000Z");
const DURATION = 10_000;
const PHRASES = ["baila conmigo", "paso a paso", "ritmo"];
const first: RandomIndex = () => 0;
const last: RandomIndex = (n) => n - 1;

function at(ms: number): Date {
  return new Date(T0.getTime() + ms);
}

/** Lobby with host + two dancers (a, b) and one spectator (s). */
function lobby(): Room {
  let room = RoomService.create({ id: "host", displayName: "Host" }, "ROOM01");
  for (const id of ["a", "b", "s"]) room = RoomService.join(room, { id, displayName: id.toUpperCase() });
  room = RoomService.selectRole(room, "a", "dancer");
  room = RoomService.selectRole(room, "b", "dancer");
  room = RoomService.selectRole(room, "s", "spectator");
  return allReady(room);
}

function started(room = lobby(), random: RandomIndex = first): Room {
  return SongSelectionService.start(room, { now: T0, durationMs: DURATION, random, phrases: PHRASES });
}

function assertDomainError(fn: () => unknown, code: string): void {
  assert.throws(fn, (error: unknown) => error instanceof DomainError && error.code === code);
}

describe("Escenario 1: visualización de la palabra o frase", () => {
  it("muestra una frase del catálogo elegida al azar con su temporizador", () => {
    const room = started(lobby(), last);
    const selection = room.songSelection!;
    assert.equal(selection.phase, "typing");
    assert.equal(selection.challenge.phrase, "ritmo");
    assert.equal(selection.challenge.startedAt.getTime(), T0.getTime());
    assert.equal(selection.challenge.expiresAt.getTime(), T0.getTime() + DURATION);
    assert.ok(selection.songOptions.length > 0);
  });

  it("solo los bailarines participan en el reto", () => {
    assert.deepEqual(started().songSelection!.participantIds, ["a", "b"]);
  });

  it("no repite la frase de la ronda anterior", () => {
    let room = started(lobby(), first);
    room = SongSelectionService.submit(room, "a", "baila conmigo", at(1000)).room;
    room = SongSelectionService.choose(room, "a", room.songSelection!.songOptions[0].id);
    const next = SongSelectionService.start(room, { now: at(5000), random: first, phrases: PHRASES });
    assert.notEqual(next.songSelection!.challenge.phrase, "baila conmigo");
  });

  it("exige al menos dos bailarines", () => {
    const room = RoomService.selectRole(
      RoomService.join(RoomService.create({ id: "host", displayName: "Host" }), { id: "a", displayName: "A" }),
      "a",
      "dancer",
    );
    assertDomainError(() => SongSelectionService.start(room), "NOT_ENOUGH_DANCERS");
  });

  it("no permite iniciar otro reto mientras uno está en curso", () => {
    assertDomainError(() => started(started()), "SONG_SELECTION_IN_PROGRESS");
  });
});

describe("Escenario 2: escritura correcta y elección de la canción", () => {
  it("acepta la frase exacta antes del tiempo y otorga el privilegio de elegir", () => {
    const { room, outcome } = SongSelectionService.submit(started(), "b", "baila conmigo", at(3000));
    assert.equal(outcome, "accepted");
    assert.equal(room.songSelection!.phase, "choosing");
    assert.equal(room.songSelection!.chooserId, "b");
    assert.equal(room.songSelection!.chooserReason, "typed");
  });

  it("ignora espacios al inicio y al final", () => {
    const { outcome } = SongSelectionService.submit(started(), "a", "  baila conmigo \n", at(1));
    assert.equal(outcome, "accepted");
  });

  it("el ganador elige la canción y queda guardada en la sala y en la batalla", () => {
    let room = SongSelectionService.submit(started(), "a", "baila conmigo", at(1000)).room;
    const song = room.songSelection!.songOptions[2];
    room = SongSelectionService.choose(room, "a", song.id);
    assert.equal(room.songSelection!.phase, "done");
    assert.deepEqual(room.selectedSong, song);

    const battle = RoomService.startBattle(allReady(room)).battle!;
    assert.deepEqual(battle.song, song);
  });

  it("solo el ganador puede elegir, y solo canciones ofrecidas", () => {
    const room = SongSelectionService.submit(started(), "a", "baila conmigo", at(1000)).room;
    assertDomainError(() => SongSelectionService.choose(room, "b", "song-1"), "NOT_SONG_CHOOSER");
    assertDomainError(() => SongSelectionService.choose(room, "a", "no-existe"), "INVALID_SONG");
  });

  it("después de que alguien gana ya no se aceptan más intentos", () => {
    const room = SongSelectionService.submit(started(), "a", "baila conmigo", at(1000)).room;
    assertDomainError(() => SongSelectionService.submit(room, "b", "baila conmigo", at(1100)), "SONG_SELECTION_NOT_ACTIVE");
  });

  it("no se puede iniciar la batalla mientras se elige la canción", () => {
    assertDomainError(() => RoomService.startBattle(started()), "SONG_SELECTION_IN_PROGRESS");
  });

  it("no se puede iniciar la batalla sin haber elegido la canción", () => {
    assertDomainError(() => RoomService.startBattle(lobby()), "SONG_NOT_SELECTED");
  });

  it("el reto de la frase exige que todos los jugadores estén listos", () => {
    const room = RoomService.setReady(lobby(), "s", false);
    assertDomainError(() => SongSelectionService.start(room), "PLAYERS_NOT_READY");
    assert.equal(SongSelectionService.start(RoomService.setReady(room, "s", true)).songSelection?.phase, "typing");
  });
});

describe("Escenario 3: escritura incorrecta o tiempo agotado", () => {
  it("rechaza una ortografía incorrecta y el jugador pierde su oportunidad", () => {
    const { room, outcome } = SongSelectionService.submit(started(), "a", "baila conmig", at(1000));
    assert.equal(outcome, "incorrect");
    assert.equal(room.songSelection!.phase, "typing");
    assert.deepEqual(room.songSelection!.failedIds, ["a"]);
    assertDomainError(() => SongSelectionService.submit(room, "a", "baila conmigo", at(1100)), "ATTEMPT_ALREADY_USED");
  });

  it("la comparación distingue mayúsculas", () => {
    const { outcome } = SongSelectionService.submit(started(), "a", "Baila conmigo", at(1000));
    assert.equal(outcome, "incorrect");
  });

  it("tras un fallo, otro jugador aún puede ganar el turno", () => {
    let room = SongSelectionService.submit(started(), "a", "mal", at(1000)).room;
    const result = SongSelectionService.submit(room, "b", "baila conmigo", at(2000));
    room = result.room;
    assert.equal(result.outcome, "accepted");
    assert.equal(room.songSelection!.chooserId, "b");
  });

  it("si todos fallan, el turno se asigna con la lógica predefinida", () => {
    let room = SongSelectionService.submit(started(), "a", "mal", at(1000)).room;
    room = SongSelectionService.submit(room, "b", "tambien mal", at(2000), last).room;
    assert.equal(room.songSelection!.phase, "choosing");
    assert.equal(room.songSelection!.chooserReason, "all-failed");
    assert.equal(room.songSelection!.chooserId, "b");
  });

  it("un envío después de que el tiempo llegó a cero se rechaza", () => {
    const { room, outcome } = SongSelectionService.submit(started(), "a", "baila conmigo", at(DURATION), last);
    assert.equal(outcome, "expired");
    assert.equal(room.songSelection!.chooserReason, "timeout");
  });

  it("reports expired, not a used attempt, when a dancer who misspelled submits after the countdown", () => {
    const failedA = SongSelectionService.submit(started(), "a", "mal", at(1000)).room;
    const { room, outcome } = SongSelectionService.submit(failedA, "a", "baila conmigo", at(DURATION + 1), first);
    assert.equal(outcome, "expired");
    assert.equal(room.songSelection!.phase, "choosing");
    assert.equal(room.songSelection!.chooserReason, "timeout");
    // The fallback still prefers the dancer who did not misspell.
    assert.equal(room.songSelection!.chooserId, "b");
  });

  it("al expirar, el turno pasa a un jugador que no falló", () => {
    const failedA = SongSelectionService.submit(started(), "a", "mal", at(1000)).room;
    const expired = SongSelectionService.expire(failedA, failedA.songSelection!.challenge.id, first)!;
    assert.equal(expired.songSelection!.phase, "choosing");
    assert.equal(expired.songSelection!.chooserReason, "timeout");
    assert.equal(expired.songSelection!.chooserId, "b");
  });

  it("expirar un reto ya resuelto o reemplazado no hace nada", () => {
    const room = started();
    assert.equal(SongSelectionService.expire(room, "otro-reto"), null);
    const won = SongSelectionService.submit(room, "a", "baila conmigo", at(1)).room;
    assert.equal(SongSelectionService.expire(won, room.songSelection!.challenge.id), null);
  });

  it("los espectadores no pueden participar", () => {
    assertDomainError(() => SongSelectionService.submit(started(), "s", "baila conmigo", at(1)), "NOT_CHALLENGE_PARTICIPANT");
  });

  it("si el elegido abandona la sala, el turno pasa a otro jugador", () => {
    const won = SongSelectionService.submit(started(), "a", "baila conmigo", at(1)).room;
    const left = RoomService.leave(won, "a");
    assert.equal(left.songSelection!.chooserId, "b");
    assert.equal(left.songSelection!.chooserReason, "chooser-left");
  });

  it("a participant who left the room can no longer type the phrase", () => {
    const room = RoomService.leave(started(), "a");
    assertDomainError(() => SongSelectionService.submit(room, "a", "baila conmigo", at(1)), "PLAYER_NOT_IN_ROOM");
  });

  it("everyone failed counts only the participants still in the room", () => {
    let room = RoomService.join(lobby(), { id: "c", displayName: "C" });
    room = allReady(RoomService.selectRole(room, "c", "dancer"));
    room = SongSelectionService.start(room, { now: T0, durationMs: DURATION, random: first, phrases: PHRASES });
    room = SongSelectionService.submit(room, "a", "mal", at(1000)).room;
    room = RoomService.leave(room, "c");
    // b is the last participant still here: their miss resolves the round at once.
    room = SongSelectionService.submit(room, "b", "mal", at(2000), last).room;
    assert.equal(room.songSelection!.phase, "choosing");
    assert.equal(room.songSelection!.chooserReason, "all-failed");
    assert.ok(["a", "b"].includes(room.songSelection!.chooserId!));
  });

  it("al expirar sin participantes en la sala, la selección se cancela", () => {
    let room = started();
    room = RoomService.leave(RoomService.leave(room, "a"), "b");
    const expired = SongSelectionService.expire(room, room.songSelection!.challenge.id);
    assert.equal(expired!.songSelection, null);
  });
});
