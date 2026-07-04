// Recording format negotiation. Chrome records webm/opus; WKWebView (the
// engine inside the Tauri Mac app) does not support webm and records mp4/aac
// instead. Everything that touches MediaRecorder must go through this helper
// and send the negotiated mime type along with the audio payload.

export interface AudioFormat {
  /** Passed to the MediaRecorder constructor */
  mimeType: string;
  /** Used when assembling the recorded chunks into a Blob */
  blobType: string;
  /** File extension matching the container (for upload filenames) */
  extension: string;
}

const CANDIDATES: AudioFormat[] = [
  { mimeType: "audio/webm;codecs=opus", blobType: "audio/webm", extension: "webm" },
  { mimeType: "audio/webm", blobType: "audio/webm", extension: "webm" },
  { mimeType: "audio/mp4", blobType: "audio/mp4", extension: "mp4" },
  { mimeType: "audio/aac", blobType: "audio/aac", extension: "aac" },
];

export function getSupportedAudioFormat(): AudioFormat {
  if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported) {
    for (const candidate of CANDIDATES) {
      if (MediaRecorder.isTypeSupported(candidate.mimeType)) {
        return candidate;
      }
    }
  }
  // Let the browser pick its default container; mp4 is the safe label on
  // WKWebView, which is the only engine that gets this far.
  return { mimeType: "", blobType: "audio/mp4", extension: "mp4" };
}

/** Build MediaRecorder options — omits mimeType entirely when empty. */
export function getRecorderOptions(format: AudioFormat): MediaRecorderOptions {
  return format.mimeType ? { mimeType: format.mimeType } : {};
}
