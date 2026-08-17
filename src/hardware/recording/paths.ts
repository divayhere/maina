/** Shared recording paths, used by both the native-speech path and Whisper. */
import * as FileSystem from 'expo-file-system/legacy';

export function recordingDir(meetingId: string): string {
  return `${FileSystem.documentDirectory}rec-${meetingId}/`;
}

export function segmentName(index: number): string {
  return `seg-${String(index).padStart(4, '0')}.wav`;
}

export function segmentPath(dir: string, index: number): string {
  return `${dir}${segmentName(index)}`;
}
