export interface SelectedImage {
  id: string;
  file: File;
  previewUrl: string;
}

export interface Subtitle {
  id: number;
  start: number; // in seconds
  end: number; // in seconds
  text: string;
}

export interface Block {
  id: string;
  subtitles: Subtitle[];
  text: string; // combined text of subtitles in the block
  duration: number; // in seconds
  image?: SelectedImage;
}

export interface SrtAnalysis {
  totalSubtitles: number;
  totalDurationSeconds: number;
  totalWords: number;
  averageWPM: number;
  blockCount: number;
}

export interface GeneratedImage {
  base64Data: string;
  mimeType: string;
}
