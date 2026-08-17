/** Types for @fugood/react-native-audio-pcm-stream (ships under a different module name). */
declare module '@fugood/react-native-audio-pcm-stream' {
  export interface Options {
    sampleRate: number;
    channels: 1 | 2;
    bitsPerSample: 8 | 16;
    audioSource?: number;
    wavFile: string;
    bufferSize?: number;
  }
  interface IAudioRecord {
    init: (options: Options) => void;
    start: () => void;
    stop: () => Promise<string>;
    on: (event: 'data', callback: (data: string) => void) => { remove: () => void };
  }
  const AudioRecord: IAudioRecord;
  export default AudioRecord;
}
