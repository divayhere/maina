/** Shared recording paths, used by both the native-speech path and Whisper. */
import * as FileSystem from 'expo-file-system/legacy';

import { segmentName } from './segment';

export { segmentIndexFromUri, segmentName } from './segment';

export function recordingDir(meetingId: string): string {
  return `${FileSystem.documentDirectory}rec-${meetingId}/`;
}

export function segmentPath(dir: string, index: number): string {
  return `${dir}${segmentName(index)}`;
}
