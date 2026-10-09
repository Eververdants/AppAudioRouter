import { describe, expect, it } from 'vitest';
import type { AudioSession } from '@/lib/types';
import { programEntryOf, programRoutes } from './routes';

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
