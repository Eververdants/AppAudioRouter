import { readDelayStep } from '@/lib/delay';
import { readAutoRemember } from './pure/memory';
import type { RouterData } from './types';

/** The state the store is created with, before any read has landed.
 *
 *  Two of these values come from localStorage rather than the backend — the
 *  delay step and the auto-remember switch are webview-side preferences, like
 *  the theme — and they are read once, here, at creation. */
export const initialState: RouterData = {
  devices: [],
  sessions: [],
  sessionsLoaded: false,
  sessionsRefreshing: false,
  selectedPids: [],
  selectedDeviceIds: [],
  deviceSelectionPrefilled: false,
  selectedFeedPids: [],
  feedSelectionPrefilled: false,
  routedPids: {},
  deviceLatencyMs: {},
  defaultDeviceId: null,
  deviceDelays: {},
  delayStepMs: readDelayStep(),
  deviceVolumes: {},
  primaryVolumes: {},
  sourceVolumes: {},
  iconByExe: {},
  soundingPids: {},
  soundingExes: {},
  autoRemember: readAutoRemember(),
  rememberedRoutes: [],
  rememberedFeeds: [],
  feeds: {},
  feedCarrier: { render: null, capture: null },
  feedTapFailures: {},
  captureDevices: [],
  windowApps: [],
  closeToTray: false,
  autostart: false,
  startupNotice: null,
  startupNoticeLoaded: false,
  logs: [],
  errorNotice: null,
  applying: false,
  view: 'router',
  tab: 'router',
  unreadErrors: 0,
  // Why the last enumeration of each list failed, in the backend's own words.
  // An empty list is a claim about the machine; a failed read is a claim about
  // this moment, and the two must never render as the same sentence.
  sessionsError: null,
  devicesError: null,
  engineGenerations: {},
  undoSnapshot: null,
};
