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

export function encodeRoom(room: Room): string {
  return JSON.stringify(room, function (this: Record<string, unknown>, key: string, value: unknown) {
    // JSON.stringify calls Date#toJSON before the replacer, so the original is read from the holder.
    const original = this[key];
    return original instanceof Date ? ({ $date: original.toISOString() } satisfies DateTag) : value;
  });
}

export function decodeRoom(raw: string): Room {
  return JSON.parse(raw, (_key, value: unknown) => (isDateTag(value) ? new Date(value.$date) : value)) as Room;
}
