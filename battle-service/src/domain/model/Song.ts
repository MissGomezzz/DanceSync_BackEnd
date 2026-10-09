export interface Song {
  id: string;
  title: string;
  artist: string;
  /**
   * Length of the battle clip in seconds, NOT the length of the full video: a
   * battle dances to the first `durationSeconds` of the video (the frontend
   * stops playback there). The word race timeline and the automatic end of the
   * battle are planned on this value.
   */
  durationSeconds: number;
  youtubeId: string;
}