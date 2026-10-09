import type { Song } from "../model/Song.js";

/** Songs the chooser can pick from. Replace with a catalog service when one exists. */
export const SONG_CATALOG: readonly Song[] = [
  { id: "song-1", title: "Rasputin", artist: "Boney M.", durationSeconds: 90, youtubeId: "flS0SVqTGT0" },
  { id: "song-2", title: "Beauty and a Beat", artist: "Justin Bieber", durationSeconds: 90, youtubeId: "ilp23H9dS_U" },
  { id: "song-3", title: "Moves Like Jagger", artist: "Maroon 5", durationSeconds: 90, youtubeId: "rE7q1uhj4g4" },
  { id: "song-4", title: "Call Me Maybe", artist: "Carly Rae Jepsen", durationSeconds: 90, youtubeId: "6DvEMAx5T9w" },
  { id: "song-5", title: "Hot N Cold", artist: "Katy Perry", durationSeconds: 90, youtubeId: "UUeiSHQ8dSM" },
  { id: "song-6", title: "Cotton Eye Joe", artist: "Rednex", durationSeconds: 90, youtubeId: "CicMt6tQqEQ" },
];
