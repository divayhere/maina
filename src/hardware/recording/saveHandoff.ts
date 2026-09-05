export type RecordingSaveHandoff = 'native-terminal-owner' | 'legacy-js-presentation';

/**
 * The native-qwen engine must issue STOP/ABORT before Android may display a
 * terminal state. Legacy capture keeps its save presentation in React state;
 * it must never manufacture a native-service finalizing state.
 */
export function recordingSaveHandoff(captureEngine: string): RecordingSaveHandoff {
  return captureEngine === 'native-qwen' ? 'native-terminal-owner' : 'legacy-js-presentation';
}
