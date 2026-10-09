/** What a room timer is for; at most one timer of each kind per room. */
export type RoomTimerKind = "song-challenge" | "song-choose" | "battle-end";

/**
 * Owns the per-room deadline timers (song challenge expiry, song choice
 * deadline, automatic battle end). Timers only trigger use cases; whether the
 * deadline really passed, and for which challenge or battle, is decided again
 * on the stored room, so a late, early or stale timer is harmless.
 *
 * Every timer is unref()ed: a pending deadline never keeps the process (or a
 * test run) alive, and close() clears them all on shutdown.
 */
export class RoomTimers {
  private readonly timers = new Map<string, NodeJS.Timeout>();

  constructor(private readonly clock: () => Date = () => new Date()) {}

  /** (Re)schedules the `kind` timer of a room at `at`; a passed deadline fires right away. */
  set(roomCode: string, kind: RoomTimerKind, at: Date, task: () => Promise<void>): void {
    const key = timerKey(roomCode, kind);
    clearTimeout(this.timers.get(key));
    const delay = Math.max(0, at.getTime() - this.clock().getTime());
    const timer = setTimeout(() => {
      if (this.timers.get(key) === timer) this.timers.delete(key);
      task().catch((error: unknown) => console.error(`Room timer ${key} failed`, error));
    }, delay);
    timer.unref();
    this.timers.set(key, timer);
  }

  clear(roomCode: string, kind: RoomTimerKind): void {
    const key = timerKey(roomCode, kind);
    clearTimeout(this.timers.get(key));
    this.timers.delete(key);
  }

  /** Clears every timer of a room (the room was deleted). */
  clearRoom(roomCode: string): void {
    const prefix = `${roomCode.toUpperCase()}|`;
    for (const [key, timer] of this.timers) {
      if (!key.startsWith(prefix)) continue;
      clearTimeout(timer);
      this.timers.delete(key);
    }
  }

  /** Pending timers, for one room or overall. Used by tests to prove nothing leaks. */
  pending(roomCode?: string): number {
    if (roomCode === undefined) return this.timers.size;
    const prefix = `${roomCode.toUpperCase()}|`;
    let count = 0;
    for (const key of this.timers.keys()) if (key.startsWith(prefix)) count++;
    return count;
  }

  has(roomCode: string, kind: RoomTimerKind): boolean {
    return this.timers.has(timerKey(roomCode, kind));
  }

  close(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }
}

function timerKey(roomCode: string, kind: RoomTimerKind): string {
  return `${roomCode.toUpperCase()}|${kind}`;
}
