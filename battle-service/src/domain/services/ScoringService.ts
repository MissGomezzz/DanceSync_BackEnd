import type { Battle, BattleResult, ScoringPoints, Standing } from "../model/Battle.js";

/**
 * Pure scoring of a battle, used for the live ranking (every room payload) and
 * for the final result, so both always agree:
 *
 *   score = votePoints x votes + wordBonusPoints x wordsWon
 *
 * Only dancers still in the battle (battle.dancerIds) are ranked. A vote for a
 * dancer who left is discarded when they leave (see RoomService.leave), and is
 * ignored here anyway.
 */
export const ScoringService = {
  /** Current votes per remaining dancer (0 for a dancer nobody votes for). */
  voteCounts(battle: Battle): Record<string, number> {
    const counts: Record<string, number> = Object.fromEntries(battle.dancerIds.map((id) => [id, 0]));
    for (const dancerId of Object.values(battle.votes)) {
      if (dancerId in counts) counts[dancerId] += 1;
    }
    return counts;
  },

  /**
   * The ranking, best first. Equal scores share a rank (competition ranking:
   * 1, 1, 3) and keep the order of the battle roster, so tied rows do not jump
   * around between two updates.
   */
  standings(battle: Battle, points: ScoringPoints = battle.scoring): Standing[] {
    const counts = ScoringService.voteCounts(battle);
    const names = new Map(battle.roster.map((entry) => [entry.id, entry.displayName]));
    const rows = battle.dancerIds.map((dancerId, order) => {
      const votes = counts[dancerId] ?? 0;
      const wordsWon = battle.wordsWon[dancerId] ?? 0;
      return {
        order,
        standing: {
          dancerId,
          displayName: names.get(dancerId) ?? dancerId,
          votes,
          wordsWon,
          score: points.votePoints * votes + points.wordBonusPoints * wordsWon,
          rank: 0,
        },
      };
    });
    rows.sort((a, b) => b.standing.score - a.standing.score || a.order - b.order);
    return rows.map(({ standing }, index) => {
      const previous = index > 0 ? rows[index - 1].standing : undefined;
      // Same score as the row above: same rank. Otherwise the rank is the position.
      standing.rank = previous && previous.score === standing.score ? previous.rank : index + 1;
      return standing;
    });
  },

  /** Final result: the standings plus the winner, null on a draw at the top. */
  result(battle: Battle, points: ScoringPoints = battle.scoring): BattleResult {
    const standings = ScoringService.standings(battle, points);
    const leaders = standings.filter((s) => s.rank === 1);
    return { standings, winnerId: leaders.length === 1 ? leaders[0].dancerId : null };
  },
};
