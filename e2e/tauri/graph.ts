import type { BridgeState } from './types';

/** The default graph the specs start from: three devices, two apps playing. */
export const DEFAULT_STATE: BridgeState = {
  devices: [
    { id: 'speakers', name: 'Speakers' },
    { id: 'tv', name: 'TV' },
    // The carrier's playback side, enumerated like anything else on the
    // machine: it exists, the settings page can still name it, and the board
    // must not hand it out as a destination.
    { id: 'cable-in', name: 'CABLE Input (VB-Audio Virtual Cable)' },
  ],
  sessions: [
    { pid: 1001, exe_name: 'music.exe' },
    { pid: 1002, exe_name: 'game.exe' },
  ],
  defaultDeviceId: 'speakers',
  remembered: [],
  delays: [],
  volumes: [],
  primaryVolumes: [],
  sourceVolumes: [],
  captureDevices: [{ id: 'cable-out', name: 'CABLE Output' }],
  // Pre-configured so the specs that concern the board's feed behaviour do not
  // have to walk through settings first; the carrier's own specs override it.
  feedCarrier: { render: 'cable-in', capture: 'cable-out' },
  feeds: [],
  windowApps: [],
};
