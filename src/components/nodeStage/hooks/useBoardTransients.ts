import { useCallback, useEffect, useRef, useState } from 'react';
import type { PlannedFeed } from './useFeedPlan';
import type { InspectorKey } from '../shared';
import type { Dispatch, SetStateAction } from 'react';

/**
 * The board's one-shot states, and the rule that a new programme starts quiet.
 *
 * Three transient things live here: which destination row the bottom strip is
 * tuning, which row has just joined the plan and deserves to be scrolled to, and
 * how many times a proposal has become the truth on this programme's board. Each
 * one is a fact about the programme on screen, so switching programme drops all
 * three — a key naming last programme's device must not survive, and whatever the
 * last programme was doing, the new board starts quiet.
 *
 * The effects run in the order the board has always run them: the reset, then the
 * strip's staleness, then the reveal diff, then the landing beat.
 */
export function useBoardTransients({
  pid,
  drawn,
  planFeedStates,
  answered,
  setHoverKey,
  setPickerOpen,
  setPrimaryPickerOpen,
  setFeedQuery,
}: {
  pid: number | undefined;
  /** The device plan, in the order it goes out. */
  drawn: string[];
  planFeedStates: PlannedFeed[];
  answered: boolean;
  setHoverKey: (key: string | null) => void;
  setPickerOpen: Dispatch<SetStateAction<boolean>>;
  setPrimaryPickerOpen: Dispatch<SetStateAction<boolean>>;
  setFeedQuery: Dispatch<SetStateAction<string>>;
}) {
  /** The row the bottom strip is tuning. */
  const [inspectorKey, setInspectorKey] = useState<InspectorKey | null>(null);

  /** How far the copies panel has been scrolled — its wires ride with it. */
  const [copyScroll, setCopyScroll] = useState(0);
  /** The copies-panel row a just-added destination landed in, one-shot: the
   *  panel scrolls it into view and hands null back. */
  const [revealIndex, setRevealIndex] = useState<number | null>(null);
  /** How many times a proposal has become the truth on this programme's board —
   *  the key that replays the hub's landing beat. */
  const [landPulse, setLandPulse] = useState(0);

  /** The number badge the strip was opened from: closing the strip with its own
   *  ✕ must not leave the caret in the air where the strip just unmounted. */
  const inspectorReturnRef = useRef<HTMLElement | null>(null);

  /** The board's rows as of the last pass, as one signature — what the reveal
   *  diff reads to find the destination that has just arrived. */
  const prevRowsRef = useRef<string | null>(null);
  /** The last programme and answered-ness this component saw, so the landing
   *  beat fires on a press and never on a programme switch. */
  const prevApplyRef = useRef<{ pid: number | undefined; answered: boolean }>({
    pid: undefined,
    answered: false,
  });

  // Selecting a different programme resets the inspector to the card that is
  // actually on screen — a key naming last programme's device must not survive —
  // and puts the copies panel back at the top, where it always starts. The
  // pending reveal and the landing beat's memory are dropped too: whatever the
  // last programme was doing, the new board starts quiet.
  useEffect(() => {
    setInspectorKey(null);
    setPickerOpen(false);
    setPrimaryPickerOpen(false);
    setFeedQuery('');
    setHoverKey(null);
    setCopyScroll(0);
    setRevealIndex(null);
    prevRowsRef.current = null;
    inspectorReturnRef.current = null;
  }, [pid]);

  // The strip names a device and shows the levers that belong to it. If that
  // device leaves the plan — its row removed, or the plan come down to a single
  // device, which has no engine and therefore no levers — the strip has nothing
  // left to describe, so it closes with the row it was opened from. Read from a
  // joined signature rather than the array itself: `drawn` is a fresh array on
  // every render, and depending on it here would re-run this on every pass.
  const drawnSignature = drawn.join('|');
  useEffect(() => {
    if (inspectorKey === null) return;
    const ids = drawnSignature === '' ? [] : drawnSignature.split('|');
    if (ids.length <= 1 || !ids.includes(inspectorKey.slice(4))) setInspectorKey(null);
  }, [drawnSignature, inspectorKey]);

  // A destination that has just joined the plan deserves to be seen: if its row
  // landed below the copies panel's cut, one scroll brings it into view. Only a
  // single-row change reveals — a batch (remembered routes restoring, a
  // programme switch re-filling the plan) decides nothing about where the eye
  // should go, and a removal never scrolls anything.
  const feedSig = planFeedStates.map((f) => f.session.pid).join(',');
  useEffect(() => {
    const sig = `${drawnSignature}#${feedSig}`;
    const prev = prevRowsRef.current;
    prevRowsRef.current = sig;
    if (prev === null) return;
    const [prevDev = '', prevFeed = ''] = prev.split('#');
    const prevDeviceIds = prevDev === '' ? [] : prevDev.split('|');
    const nextDeviceIds = drawnSignature === '' ? [] : drawnSignature.split('|');
    const prevFeedPids = prevFeed === '' ? [] : prevFeed.split(',');
    const nextFeedPids = feedSig === '' ? [] : feedSig.split(',');
    const addedDevices = nextDeviceIds.filter((id) => !prevDeviceIds.includes(id));
    const addedFeeds = nextFeedPids.filter((p) => !prevFeedPids.includes(p));
    if (addedDevices.length === 1 && addedFeeds.length === 0) {
      // The new device's copies-panel seat is its drawn index minus the
      // primary — unless it took the primary seat itself, which the top panel
      // always shows and needs no scroll.
      const index = nextDeviceIds.indexOf(addedDevices[0] ?? '');
      if (index > 0) setRevealIndex(index - 1);
    } else if (addedFeeds.length === 1 && addedDevices.length === 0) {
      const feedIndex = nextFeedPids.indexOf(addedFeeds[0] ?? '');
      if (feedIndex >= 0) setRevealIndex(Math.max(0, nextDeviceIds.length - 1) + feedIndex);
    }
  }, [drawnSignature, feedSig]);

  // One beat when the plan becomes the truth: `answered` flipping while the
  // same programme is on screen keys a single expanding hairline on the hub.
  // Restoring a remembered route starts answered, and selecting a programme
  // that already answers does not count — only a press lands.
  useEffect(() => {
    if (pid === prevApplyRef.current.pid && answered && !prevApplyRef.current.answered) {
      setLandPulse((n) => n + 1);
    }
    prevApplyRef.current = { pid, answered };
  }, [pid, answered]);

  const clearReveal = useCallback(() => setRevealIndex(null), []);

  /** Close the strip from its own ✕ and hand the keyboard back to the number
   *  badge that opened it — the strip is about to unmount, and focus left in a
   *  dead subtree restarts the Tab walk at the top of the window. Other closes
   *  (a programme switch, the inspected row leaving the plan) are presses that
   *  already moved the keyboard somewhere, so only this one reaches back. */
  const clearInspector = () => {
    setInspectorKey(null);
    inspectorReturnRef.current?.focus();
    inspectorReturnRef.current = null;
  };

  return {
    inspectorKey,
    setInspectorKey,
    inspectorReturnRef,
    clearInspector,
    copyScroll,
    setCopyScroll,
    revealIndex,
    clearReveal,
    landPulse,
  };
}
