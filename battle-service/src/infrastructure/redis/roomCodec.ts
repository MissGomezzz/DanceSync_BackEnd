import type { Room } from "../../domain/model/Room.js";

/**
 * A Room holds Dates (battle deadlines, challenge expiry...) that JSON would
 * turn into strings. They are tagged on the way out and revived on the way in,
 * so a room read from Redis is the same value the domain wrote.
 */
interface DateTag {
  $date: string;
}

function isDateTag(value: unknown): value is DateTag {
  return typeof value === "object" && value !== null && Object.keys(value).length === 1 && typeof (value as DateTag).$date === "string";
}

/** JSON that keeps Date values as Dates (rooms, outbox entries). */
export function encodeWithDates(value: unknown): string {
  return JSON.stringify(value, function (this: Record<string, unknown>, key: string, current: unknown) {
    // JSON.stringify calls Date#toJSON before the replacer, so the original is read from the holder.
    const original = this[key];
    return original instanceof Date ? ({ $date: original.toISOString() } satisfies DateTag) : current;
  });
}

export function decodeWithDates<T>(raw: string): T {
  return JSON.parse(raw, (_key, value: unknown) => (isDateTag(value) ? new Date(value.$date) : value)) as T;
}

export function encodeRoom(room: Room): string {
  return encodeWithDates(room);
}

export function decodeRoom(raw: string): Room {
  return decodeWithDates<Room>(raw);
}
