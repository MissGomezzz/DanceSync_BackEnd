/**
 * Tells when a signed-in user starts a session (OBS-1). Sign-in happens with
 * Entra ID in the browser, so the backend only sees the user's Socket.IO
 * handshakes: a session starts at a handshake of a user with no handshake in
 * the last window (30 min). Reconnects and page reloads inside the window do
 * not count, and with several replicas the window is shared (Redis), so a
 * user is counted once whichever replica they reach.
 */
export interface SessionTracker {
  /** Records a handshake of `userId`; true when it starts a new session. */
  touch(userId: string): Promise<boolean>;
}

/** Thirty minutes, the usual web analytics session window. */
export const SESSION_WINDOW_MS = 30 * 60_000;
