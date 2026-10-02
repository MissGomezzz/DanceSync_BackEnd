import type { Song } from "../model/Song.js";

/** Songs the chooser can pick from. Replace with a catalog service when one exists. */
export const SONG_CATALOG: readonly Song[] = [
  { id: "song-1", title: "Dance Monkey", artist: "Tones and I", durationSeconds: 209 },
  { id: "song-2", title: "Uptown Funk", artist: "Mark Ronson ft. Bruno Mars", durationSeconds: 270 },
  { id: "song-3", title: "Bailando", artist: "Enrique Iglesias", durationSeconds: 243 },
  { id: "song-4", title: "Levitating", artist: "Dua Lipa", durationSeconds: 203 },
  { id: "song-5", title: "Despacito", artist: "Luis Fonsi ft. Daddy Yankee", durationSeconds: 229 },
  { id: "song-6", title: "Can't Stop the Feeling!", artist: "Justin Timberlake", durationSeconds: 236 },
];
