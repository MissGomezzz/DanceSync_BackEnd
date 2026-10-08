export type PlayerRole = "undecided" | "dancer" | "spectator";

/** Longest accepted player id (users-service ids and Entra ID object ids fit easily). */
export const MAX_PLAYER_ID_LENGTH = 64;
/** Longest accepted display name, counted after trimming. */
export const MAX_DISPLAY_NAME_LENGTH = 32;

export interface Player {
  /** User id issued by users-service (Azure Entra ID subject once wired). */
  id: string;
  displayName: string;
  role: PlayerRole;
  /** Marked "ready to dance" in the lobby; toggled by the player until the battle starts. */
  ready: boolean;
}
