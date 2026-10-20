import { describe, expect, it } from 'vitest';
import type { AudioSession } from '@/lib/types';
import { programEntryOf, programOwners, programRoutes } from './routes';

const BROWSER_TAB: AudioSession = { pid: 2002, exe_name: 'browser.exe' };
const BROWSER_MAIN: AudioSession = { pid: 2001, exe_name: 'browser.exe' };
const OTHER: AudioSession = { pid: 2003, exe_name: 'other.exe' };

/** Deliberately not sorted by pid: the walk must not depend on list order. */
const SESSIONS = [BROWSER_TAB, BROWSER_MAIN, OTHER];

describe('programEntryOf', () => {
  it('returns the process itself when it holds the entry', () => {
    expect(programEntryOf(SESSIONS, { 2001: ['tv'] }, 2001)).toBe(2001);
  });

  it('resolves a sibling process to the entry its program holds', () => {
    // The route is one per executable, written under the lowest pid.
    expect(programEntryOf(SESSIONS, { 2001: ['tv'] }, 2002)).toBe(2001);
  });

  it('does not cross programs', () => {
    expect(programEntryOf(SESSIONS, { 2003: ['tv'] }, 2001)).toBeUndefined();
  });

  it('returns undefined when the program holds no entry', () => {
    expect(programEntryOf(SESSIONS, {}, 2001)).toBeUndefined();
    expect(programEntryOf(SESSIONS, { 9999: ['tv'] }, 2001)).toBeUndefined();
  });

  it('matches the executable without minding its case', () => {
    // The same image can be spelled two ways: two paths, or the file's own
    // version info against the process list's. The route belongs to the program,
    // so a `Music.exe` entry has to answer for a `music.exe` session.
    const UPPER: AudioSession = { pid: 2101, exe_name: 'Music.exe' };
    const LOWER: AudioSession = { pid: 2102, exe_name: 'music.exe' };
    expect(programEntryOf([UPPER, LOWER], { 2101: ['tv'] }, 2102)).toBe(2101);
    expect(programEntryOf([UPPER, LOWER], { 2102: ['tv'] }, 2101)).toBe(2102);
  });

  it('names the lowest pid when the keys are of mixed width', () => {
    // `programEntryOf` walks the map's own key order and stops at the first
    // sibling that answers, so the answer has to come out numeric: `999` before
    // `1000`, where a string sort — or an insertion-order walk of a map built
    // some other way — would hand the entry to the *larger* process and the
    // board would show the route on a sibling the audio service never named.
    // `Object.keys` does order integer-like keys ascending; this is the pin.
    const sessions: AudioSession[] = [
      { pid: 1000, exe_name: 'browser.exe' },
      { pid: 999, exe_name: 'browser.exe' },
      { pid: 1001, exe_name: 'browser.exe' },
    ];
    expect(programEntryOf(sessions, { 1000: ['tv'], 999: ['tv'] }, 1001)).toBe(999);
    // And the whole-list pass agrees with the per-process one, whatever order
    // the sessions arrive in: two holders of the same program, one answer.
    expect(programOwners(sessions, { 1000: ['tv'], 999: ['tv'] })).toEqual({
      999: 999,
      1000: 999,
      1001: 999,
    });
  });
});

describe('programOwners', () => {
  it('answers every process of a program with the one holding its entry', () => {
    // The rail draws one row per process and its ✕ addresses the holder, so the
    // whole list needs the answer at once rather than a re-scan per row.
    expect(programOwners(SESSIONS, { 2001: ['tv'] })).toEqual({
      2001: 2001,
      2002: 2001,
      2003: 2003,
    });
  });

  it('names the lowest pid when a program holds two entries', () => {
    // The address every write to these maps uses. Picking by the order the
    // entries, or the sessions, happen to come in would move the ✕ between two
    // refreshes of the same state.
    expect(programOwners(SESSIONS, { 2002: ['tv'], 2001: ['speakers'] })).toEqual({
      2001: 2001,
      2002: 2001,
      2003: 2003,
    });
  });

  it('treats an empty entry as holding nothing', () => {
    expect(programOwners(SESSIONS, { 2001: [] })).toEqual({
      2001: 2001,
      2002: 2002,
      2003: 2003,
    });
  });

  it('leaves a process whose program is not on the list to itself', () => {
    // A route can outlive the session that was applied to it by a breath; the
    // row that is still on screen addresses itself, and the stop finds nothing.
    expect(programOwners([BROWSER_TAB], { 2001: ['tv'] })).toEqual({ 2002: 2002 });
  });
});

describe('programRoutes', () => {
  it('gives every process of a routed program the same route', () => {
    expect(programRoutes(SESSIONS, { 2001: ['speakers', 'tv'] })).toEqual({
      2001: ['speakers', 'tv'],
      2002: ['speakers', 'tv'],
    });
  });

  it('leaves unrouted programs and processes out', () => {
    expect(programRoutes(SESSIONS, {})).toEqual({});
    // A route for a process no longer on the list answers for nobody.
    expect(programRoutes(SESSIONS, { 9999: ['tv'] })).toEqual({});
  });
});
