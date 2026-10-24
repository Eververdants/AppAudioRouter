import type { AudioDevice, AudioSession, RememberedRouteEntry } from '@/lib/types';
import { programEntryOf } from '@/lib/routes';
import type { RememberedFeedEntry } from '../liveness';
import { autoRestoreDecided } from '../gates';

/** localStorage key holding the auto-remember switch, next to the other
 * webview-side preferences. */
export const AUTO_REMEMBER_STORAGE_KEY = 'aar-auto-remember';

export function readAutoRemember(): boolean {
  try {
    return localStorage.getItem(AUTO_REMEMBER_STORAGE_KEY) === '1';
  } catch {
    /* storage may be unavailable; the preference just does not persist */
    return false;
  }
}

/**
 * The targets remembered for an executable.
 *
 * Matched on the lowercased name: the memory is keyed by image name, and an
 * image name carries whatever case the launch used, so two launches of the same
 * program can differ in it.
 */
export function rememberedFor(
  entries: RememberedRouteEntry[],
  exeName: string,
): string[] | undefined {
  const wanted = exeName.toLowerCase();
  return entries.find((entry) => entry.exeName.toLowerCase() === wanted)?.deviceIds;
}

/**
 * Whether an executable name can carry a memory at all.
 *
 * A process this app cannot open — running more elevated than the app, or
 * protected — has no readable image name, and the session list labels it
 * `PID 1234` so the row still says something rather than nothing. That label is
 * the key every memory is hung on, and a PID is not a program: it is gone next
 * launch and the number is handed to whatever runs then. So such a route is
 * applied — the sound moves now, which is what was asked for — but not
 * remembered, and the log says why instead of leaving the 自动记忆 switch to
 * look broken and the settings list to show a row that can never be found again.
 */
export function isRememberableName(exeName: string): boolean {
  return !/^PID \d+$/i.test(exeName);
}

/** The remembered list with every one of `exeNames` pointing at `deviceIds`. */
export function rememberTargets(
  entries: RememberedRouteEntry[],
  exeNames: string[],
  deviceIds: string[],
): RememberedRouteEntry[] {
  const claimed = new Set(exeNames.map((name) => name.toLowerCase()));
  const next = entries.filter((entry) => !claimed.has(entry.exeName.toLowerCase()));
  for (const exeName of exeNames) next.push({ exeName, deviceIds: [...deviceIds] });
  return next;
}

/**
 * The feed memory with `sourceExe` pointing at `targetExe` (added) or without
 * it (removed). Matched case-insensitively, like the route memory; the first
 * spelling seen is the one kept.
 *
 * `atIndex` puts the target where it stood before it was taken out: this memory
 * is what the live feed map is rebuilt from, and the map's order is the board's
 * numbering, so a rollback that appended would renumber the user's other feeds.
 */
export function rememberFeedTargets(
  entries: RememberedFeedEntry[],
  sourceExe: string,
  targetExe: string,
  added: boolean,
  atIndex?: number,
): RememberedFeedEntry[] {
  const key = sourceExe.toLowerCase();
  const existing = entries.find((entry) => entry.sourceExe.toLowerCase() === key);
  const others = entries.filter((entry) => entry.sourceExe.toLowerCase() !== key);
  if (!added) {
    const remaining = (existing?.targetExe ?? []).filter(
      (name) => name.toLowerCase() !== targetExe.toLowerCase(),
    );
    if (existing === undefined || remaining.length === 0) return others;
    return [...others, { sourceExe: existing.sourceExe, targetExe: remaining }];
  }
  const already = (existing?.targetExe ?? []).some(
    (name) => name.toLowerCase() === targetExe.toLowerCase(),
  );
  if (already) return entries;
  const targets = [...(existing?.targetExe ?? [])];
  // A negative position is `findIndex`'s way of saying the rule was never
  // remembered, which is where a new one belongs: at the end.
  targets.splice(atIndex !== undefined && atIndex >= 0 ? atIndex : targets.length, 0, targetExe);
  return [
    ...others,
    {
      sourceExe: existing?.sourceExe ?? sourceExe,
      targetExe: targets,
    },
  ];
}

/** One process whose remembered route is due to be put back. */
export interface RestorableProcess {
  pid: number;
  exeName: string;
  deviceIds: string[];
}

/**
 * The processes a remembered route should be restored on.
 *
 * One per executable, lowest PID: the assignment Windows stores is per
 * executable, so a browser with a dozen processes needs one route rather than a
 * dozen engines duplicating the same audio. A target that has been unplugged
 * since is dropped, and a memory whose devices are all gone is left alone —
 * which is also what keeps the boot pass from misreading a device list that has
 * not arrived yet.
 */
export function pickRestorable(
  sessions: AudioSession[],
  remembered: RememberedRouteEntry[],
  routedPids: Record<number, string[]>,
  devices: AudioDevice[],
): RestorableProcess[] {
  if (devices.length === 0) return [];
  const liveDeviceIds = new Set(devices.map((device) => device.id));
  const firstPidByExe = new Map<string, number>();
  for (const session of sessions) {
    const key = session.exe_name.toLowerCase();
    const known = firstPidByExe.get(key);
    if (known === undefined || session.pid < known) firstPidByExe.set(key, session.pid);
  }

  const targets: RestorableProcess[] = [];
  for (const session of sessions) {
    if (firstPidByExe.get(session.exe_name.toLowerCase()) !== session.pid) continue;
    if (autoRestoreDecided.has(session.pid)) continue;
    // The program is routed when *any* of its processes holds the route — the
    // assignment is per executable — so a sibling-owned route also means there
    // is nothing to restore, and writing one here would run a second engine
    // over the same audio.
    if (programEntryOf(sessions, routedPids, session.pid) !== undefined) continue;
    const deviceIds = rememberedFor(remembered, session.exe_name)?.filter((id) =>
      liveDeviceIds.has(id),
    );
    if (deviceIds === undefined || deviceIds.length === 0) continue;
    targets.push({ pid: session.pid, exeName: session.exe_name, deviceIds });
  }
  return targets;
}
