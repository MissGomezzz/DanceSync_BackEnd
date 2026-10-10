import type { Song } from "../model/Song.js";

/**
 * Songs the chooser can pick from. Replace with a catalog service when one exists.
 *
 * durationSeconds is the battle clip length, deliberately 90 s for every song:
 * the videos themselves run 199-258 s, but a battle only plays their first 90 s.
 * Do not "fix" it to the video length; change it only to change the clip.
 *
 * Every youtubeId must allow embedded playback. Record labels block embedding for
 * many songs (the player then fails with error 101/150), and oEmbed or the Data
 * API "embeddable" flag do not catch it: check a new id with the IFrame API from
 * the app's own origin before adding it. "Beauty and a Beat", "Moves Like Jagger"
 * and "Call Me Maybe" were replaced on 2026-10-09 because every upload of them
 * that was tried returned error 150.
 */
export const SONG_CATALOG: readonly Song[] = [
  { id: "song-1", title: "Rasputin", artist: "Boney M.", durationSeconds: 90, youtubeId: "flS0SVqTGT0" },
  { id: "song-2", title: "Happy", artist: "Pharrell Williams", durationSeconds: 90, youtubeId: "t1arWxAn3VI" },
  { id: "song-3", title: "Uptown Funk", artist: "Mark Ronson ft. Bruno Mars", durationSeconds: 90, youtubeId: "4LUct4rqPGE" },
  { id: "song-4", title: "Dynamite", artist: "Taio Cruz", durationSeconds: 90, youtubeId: "8sEGKP8i-Ps" },
  { id: "song-5", title: "Hot N Cold", artist: "Katy Perry", durationSeconds: 90, youtubeId: "UUeiSHQ8dSM" },
  { id: "song-6", title: "Cotton Eye Joe", artist: "Rednex", durationSeconds: 90, youtubeId: "CicMt6tQqEQ" },
];
