import type { AudioDevice, AudioSession } from '@/lib/types';

/**
 * Identity of the device list, so a refresh that came from a Core Audio
 * notification can tell "the audio engine moved" apart from "what the screen
 * shows moved" — the first happens several times per hotplug, the second is the
 * only one worth a log line.
 */
export function deviceSignature(devices: AudioDevice[]): string {
  // Sorted by id, because the enumeration order is the audio service's own and
  // the same unchanged machine can hand the list back permuted after a hotplug.
  // Signed as sent, that reads as a change and buys a log line about a device
  // list that is the same list. The process list is sorted for this exact
  // reason before it is signed.
  return [...devices]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((d) => `${d.id}|${d.name}`)
    .join('\n');
}

/** Same idea for the process list. `display_name` is deliberately left out:
 *  it belongs to the window, not the list, and a browser switching tabs would
 *  otherwise log "the process list changed" on every title change. */
export function sessionSignature(sessions: AudioSession[]): string {
  return sessions.map((s) => `${s.pid}|${s.exe_name}`).join('\n');
}

/**
 * List order for the process panel: by executable name, then by PID for the
 * processes that share one.
 *
 * The backend hands the list back in the order the device walk produced it, so
 * it shuffles whenever any session anywhere comes or goes — rows jumped under
 * the cursor between two refreshes of an unchanged machine.
 */
export function compareSessions(a: AudioSession, b: AudioSession): number {
  const byName = a.exe_name.localeCompare(b.exe_name, undefined, { sensitivity: 'base' });
  return byName !== 0 ? byName : a.pid - b.pid;
}
