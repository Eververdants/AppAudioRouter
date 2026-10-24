import i18next from 'i18next';
import type { AudioDevice } from '@/lib/types';
import { programEntryOf } from '@/lib/routes';
import type { RouterState } from '../types';

/** The system default device as a route target, when it is still present. */
function defaultTargets(state: Pick<RouterState, 'devices' | 'defaultDeviceId'>): string[] {
  const id = state.defaultDeviceId;
  return id !== null && state.devices.some((d) => d.id === id) ? [id] : [];
}

/**
 * Where one process's program plays right now: the live route the program
 * holds, or the system default it already plays through. The route is read
 * through the program's owner — it is one per executable, so a sibling process
 * of a routed program plays where that route says, and the board must draw that
 * rather than a default the program is not on. The remembered route is
 * deliberately not a guess: until it has been restored into a live route the
 * program is playing through the default, and proposing a route the user just
 * stopped back at them is not a guess about where the process plays.
 */
export function selectionTargets(
  state: Pick<RouterState, 'sessions' | 'routedPids' | 'devices' | 'defaultDeviceId'>,
  pid: number,
): string[] {
  const owner = programEntryOf(state.sessions, state.routedPids, pid);
  const routed = owner !== undefined ? state.routedPids[owner] : undefined;
  return routed ?? defaultTargets(state);
}

/**
 * The live feed targets of the program `pid` belongs to, as the feeds map holds
 * them — the answer the feed plan is prefilled with, and what the prefilled
 * plan keeps tracking. Like `selectionTargets`, it resolves through the
 * program's holder: the map is keyed by the lowest pid, and the board can be
 * open on any sibling.
 */
export function feedTargetsOf(
  state: Pick<RouterState, 'sessions' | 'feeds'>,
  pid: number,
): number[] {
  const owner = programEntryOf(state.sessions, state.feeds, pid);
  return owner === undefined ? [] : [...(state.feeds[owner] ?? [])];
}

/** A device's name for a user-visible string, or its id when it is not in the
 * list. Never the raw id: an endpoint GUID answers nothing, and the store's
 * strings have the same hole the components were called out for — they name a
 * device that has left, with the words `stage.deviceGone` already carries. */
export function deviceName(deviceId: string | undefined, devices: AudioDevice[]): string {
  if (deviceId === undefined) return '';
  return devices.find((device) => device.id === deviceId)?.name ?? i18next.t('stage.deviceGone');
}
