import type { AudioDevice, FeedCarrier } from './types';

/** A loopback driver the carrier picker knows by name. Its two endpoints carry
 * stable friendly names, so their presence on the device lists is how
 * "installed" reads — the app never ships or installs a driver, it only
 * recognizes the ones that are already there. */
export interface CarrierDriver {
  /** The Rust command's allowlist key for the download page. */
  key: 'vb-cable' | 'voicemeeter';
  /** The product name as the user knows it — locale-independent. */
  display: string;
  /** Substring of the pair's playback-side friendly name. */
  renderMarker: string;
  /** Substring of the pair's recording-side friendly name. */
  captureMarker: string;
}

/** The drivers worth naming, in preference order. Markers are substrings of
 * the names Windows shows, checked case-insensitively. The VoiceMeeter markers
 * deliberately miss the Aux pair — "… Aux Input" breaks the substring — so a
 * Banana/Potato install pairs with the VAIO pair, not a monitoring side. */
const DRIVERS: CarrierDriver[] = [
  {
    key: 'vb-cable',
    display: 'VB-Cable',
    renderMarker: 'CABLE Input',
    captureMarker: 'CABLE Output',
  },
  {
    key: 'voicemeeter',
    display: 'VoiceMeeter',
    renderMarker: 'VoiceMeeter Input',
    captureMarker: 'VoiceMeeter Output',
  },
];

/** One driver's endpoint pair, found on the two device lists. */
export interface CarrierMatch {
  driver: CarrierDriver;
  renderId: string;
  captureId: string;
}

/** Find the first known loopback driver whose playback and recording sides
 * are both present. `null` means none is — the pickers stay manual and the
 * settings page offers the free download instead. */
export function detectCarrierPair(
  renderDevices: AudioDevice[],
  captureDevices: AudioDevice[],
): CarrierMatch | null {
  for (const driver of DRIVERS) {
    const render = renderDevices.find((device) => containsMarker(device.name, driver.renderMarker));
    const capture = captureDevices.find((device) =>
      containsMarker(device.name, driver.captureMarker),
    );
    if (render !== undefined && capture !== undefined) {
      return { driver, renderId: render.id, captureId: capture.id };
    }
  }
  return null;
}

/** Whether the carrier already points at this match's two endpoints. */
export function matchesCarrier(match: CarrierMatch, carrier: FeedCarrier): boolean {
  return carrier.render === match.renderId && carrier.capture === match.captureId;
}

function containsMarker(name: string, marker: string): boolean {
  return name.toLowerCase().includes(marker.toLowerCase());
}
