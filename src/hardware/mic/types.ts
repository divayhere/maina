/**
 * SWAP-SEAM (hardware isolation): Mic source.
 * The app records from the OS-default input, so ANY mic (phone, Hollyland via
 * USB-C, DJI, Bluetooth headset) works with zero per-device code. This layer
 * only surfaces which input is active and watches for connect/disconnect so a
 * mic unplugged mid-meeting is handled gracefully instead of crashing.
 */

export type MicKind = 'phone' | 'wired' | 'usb' | 'bluetooth' | 'unknown';

export interface MicInfo {
  id: string;
  label: string;
  kind: MicKind;
}

export interface MicSource {
  /** Currently active input Android will record from. */
  getActive(): Promise<MicInfo>;
  list(): Promise<MicInfo[]>;
  /** Fires on plug/unplug so recording can pause + log instead of failing. */
  onChange(cb: (active: MicInfo) => void): () => void;
}
