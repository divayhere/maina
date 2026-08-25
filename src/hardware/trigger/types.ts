/**
 * SWAP-SEAM (hardware isolation): Trigger source.
 * The physical button that starts/stops recording. A cheap BT shutter clicker
 * (HID keypress) today; Flic SDK later; the on-screen button is just another
 * implementation. Everything above only ever sees TriggerEvent.
 */

export type TriggerEvent = 'click' | 'double' | 'hold';

export interface TriggerSource {
  readonly id: string;
  readonly label: string;
  /** Whether this source is available/paired right now. */
  isAvailable(): Promise<boolean>;
  /** Begin listening. Returns an unsubscribe function. */
  subscribe(onEvent: (e: TriggerEvent) => void): () => void;
}

/**
 * Maps a raw hardware signal to an app action. Kept as data so re-mapping a
 * button (e.g. Flic double-click → "mark moment") is config, not code.
 */
export type TriggerAction = 'toggleRecord' | 'pauseResume' | 'markMoment' | 'none';

export const DEFAULT_TRIGGER_MAP: Record<TriggerEvent, TriggerAction> = {
  click: 'toggleRecord',
  double: 'markMoment',
  hold: 'pauseResume',
};
