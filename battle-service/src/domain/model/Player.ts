export type PlayerRole = "dancer" | "spectator";

export interface Player {
  /** User id issued by users-service (Azure Entra ID subject once wired). */
  id: string;
  displayName: string;
  role: PlayerRole;
}
