import type { AudioSession } from '@/lib/types';
import type { RememberedFeedEntry } from '../liveness';

/**
 * Lowest live PID per executable name — the address a per-app assignment is
 * written to, since the audio service keeps them per executable and one browser
 * holds a dozen processes.
 */
export function lowestPidByExe(sessions: AudioSession[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const session of sessions) {
    const key = session.exe_name.toLowerCase();
    const known = map.get(key);
    if (known === undefined || session.pid < known) map.set(key, session.pid);
  }
  return map;
}

/**
 * The address book for feed **targets**: every session process plus every
 * windowed app, lowest pid per executable.
 *
 * The sending half of a feed keeps answering to the session list alone — no
 * session, no sound to send — but the receiving half is legitimately a running
 * app that has never opened a render session, and the capture pin it is given
 * covers sessions started after it. One exe appearing in both lists folds to
 * one address, the way its own siblings already do.
 */
export function feedTargetPool(
  sessions: AudioSession[],
  windowApps: AudioSession[],
): Map<string, number> {
  const map = lowestPidByExe(sessions);
  for (const app of windowApps) {
    const key = app.exe_name.toLowerCase();
    const known = map.get(key);
    if (known === undefined || app.pid < known) map.set(key, app.pid);
  }
  return map;
}

/** The first entry of either list that answers for `pid` — a feed target may
 *  be a session process or a windowed app, and its display half (name, icon)
 *  is read from wherever it lives. The board's plan rows resolve through this. */
export function findInPool(
  sessions: AudioSession[],
  windowApps: AudioSession[],
  pid: number,
): AudioSession | undefined {
  return sessions.find((s) => s.pid === pid) ?? windowApps.find((s) => s.pid === pid);
}

/**
 * The selected processes, folded to one per executable — the lowest PID, which
 * is the address the audio service keeps a per-app assignment at.
 *
 * Routing is keyed by executable everywhere else in this store, and the reason
 * is audible: a process-loopback capture takes in the whole process *tree*, so
 * two engines for one browser both capture that browser's sound and both mirror
 * it to the same devices. Two copies of one audio, offset by each copy's own
 * pipeline depth, is a comb filter — and the memory would gain the same
 * executable twice, so the settings list shows one program on two rows and one
 * ✕ forgets both. A batch picked with the row toggle can easily hold two of a
 * program's processes, which is how this gets reached.
 */
export function oneProcessPerExe(
  sessions: AudioSession[],
  pids: number[],
): { pid: number; exeName: string }[] {
  const byExe = new Map<string, { pid: number; exeName: string }>();
  for (const pid of pids) {
    const session = sessions.find((s) => s.pid === pid);
    if (session === undefined) continue;
    const key = session.exe_name.toLowerCase();
    const known = byExe.get(key);
    if (known === undefined || session.pid < known.pid) {
      byExe.set(key, { pid: session.pid, exeName: session.exe_name });
    }
  }
  return [...byExe.values()];
}

/**
 * Rebuild the live feed map from the memory and the two candidate lists: a rule
 * exists on the board only while its source holds a session — no session, no
 * sound to send — and its target is a live process, which a windowed app that
 * has never opened a session still is. A process leaving both lists takes its
 * half of the wire with it.
 */
export function deriveFeeds(
  memory: RememberedFeedEntry[],
  sessions: AudioSession[],
  windowApps: AudioSession[],
): Record<number, number[]> {
  const sourceByExe = lowestPidByExe(sessions);
  const targetByExe = feedTargetPool(sessions, windowApps);
  const feeds: Record<number, number[]> = {};
  for (const entry of memory) {
    const sourcePid = sourceByExe.get(entry.sourceExe.toLowerCase());
    if (sourcePid === undefined) continue;
    for (const targetExe of entry.targetExe) {
      if (targetExe.toLowerCase() === entry.sourceExe.toLowerCase()) continue;
      const targetPid = targetByExe.get(targetExe.toLowerCase());
      if (targetPid === undefined) continue;
      const existing = feeds[sourcePid] ?? [];
      if (!existing.includes(targetPid)) existing.push(targetPid);
      feeds[sourcePid] = existing;
    }
  }
  return feeds;
}

/**
 * The programs that are making sound, folded from the processes that are: a
 * program is sounding when any of its processes is, and the one making the
 * sound is often a sibling of the one holding the route. Keyed lower-cased,
 * like every other executable key in this store.
 *
 * Walking the list covers every reading it is given: both places that record
 * sound only record one for a process the list has, so no reading can be left
 * out of the fold and the two tables always report the same fact.
 */
export function foldSounding(
  sessions: AudioSession[],
  soundingPids: Record<number, boolean>,
): Record<string, true> {
  const soundingExes: Record<string, true> = {};
  for (const session of sessions) {
    if (soundingPids[session.pid] === true) soundingExes[session.exe_name.toLowerCase()] = true;
  }
  return soundingExes;
}
