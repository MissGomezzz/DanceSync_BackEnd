import type { MatchParticipantRecord, MatchRecord } from "../model/MatchRecord.js";
import type { Room } from "../model/Room.js";

export const MatchRecordService = {
  /**
   * Builds the match history document of a finished battle: every dancer of the
   * roster (ranked ones with their final statistics) and every spectator who
   * watched it from the start, each flagged when they left early. Returns null
   * when the room holds no finished battle.
   */
  fromFinishedRoom(room: Room): MatchRecord | null {
    const battle = room.battle;
    if (room.status !== "finished" || !battle?.result || !battle.finishedAt || !battle.endReason) return null;
    const standings = new Map(battle.result.standings.map((s) => [s.dancerId, s]));
    const present = new Set(room.players.map((p) => p.id));

    const dancers: MatchParticipantRecord[] = battle.roster.map(({ id, displayName }) => {
      const standing = standings.get(id);
      return {
        playerId: id,
        displayName,
        role: "dancer",
        votes: standing?.votes ?? null,
        wordsWon: standing?.wordsWon ?? battle.wordsWon[id] ?? 0,
        score: standing?.score ?? null,
        rank: standing?.rank ?? null,
        leftEarly: !battle.dancerIds.includes(id),
      };
    });
    const spectators: MatchParticipantRecord[] = battle.audience.map(({ id, displayName }) => ({
      playerId: id,
      displayName,
      role: "spectator",
      votes: null,
      wordsWon: null,
      score: null,
      rank: null,
      leftEarly: !present.has(id),
    }));

    return {
      id: battle.id,
      roomCode: room.code,
      songId: battle.song?.id ?? null,
      songTitle: battle.song?.title ?? null,
      startedAt: battle.startedAt,
      finishedAt: battle.finishedAt,
      winnerPlayerId: battle.result.winnerId,
      endReason: battle.endReason,
      participants: [...dancers, ...spectators],
    };
  },
};
