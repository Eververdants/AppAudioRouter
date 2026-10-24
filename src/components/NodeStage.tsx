import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import type { Variants } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { SourceLevelDial } from '@/components/SourceLevelDial';
import { ProcessIcon } from '@/components/ui/ProcessIcon';
import { ScrubReadout } from '@/components/ui/ScrubReadout';
import { Ring } from '@/components/ui/Ring';
import { Spinner } from '@/components/ui/Spinner';
import { useElementHeight } from '@/hooks/useElementHeight';
import { useLiveness } from '@/hooks/useLiveness';
import { useProgramRoutes } from '@/hooks/useProgramRoutes';
import { DELAY_MAX_MS, clampDelay, formatDelaySigned, formatStep } from '@/lib/delay';
import {
  FADE,
  MAIN_THREAD_TRANSFORM,
  SPRING_GLIDE,
  SPRING_ROUTE,
  SPRING_TAP,
  charSwapTransitions,
} from '@/lib/motion';
import { programEntryOf } from '@/lib/routes';
import {
  BOARD_H,
  BOARD_W,
  FEEDER_X,
  GROUP_HEADER_H,
  GROUP_PAD,
  GROUP_W,
  GROUP_X,
  HUB_H,
  HUB_W,
  HUB_X,
  MINI_H,
  MINI_W,
  PANEL_BORDER,
  ROW_H,
  ROW_W,
  alreadyApplied,
  boardCentre,
  effectiveFallback,
  feederColumn,
  feederOutPort,
  feederY,
  hubInPort,
  hubOutPort,
  nodePath,
  orderLabel,
  panelBodyHeight,
  panelColumn,
  rowContentY,
  rowInPort,
  rowVisible,
} from '@/lib/stage';
import { PRIMARY_VOLUME_MAX, PRIMARY_VOLUME_MIN } from '@/lib/types';
import type { AudioSession } from '@/lib/types';
import { feedLiveness, useRouterStore } from '@/stores/routerStore';

/** Which card the bottom strip is tuning right now: a destination row. The
 *  strip only exists while one is picked — there is no standing bar under the
 *  board. */
type InspectorKey = `dev:${string}`;

/**
 * A wire drawn on the board, in the shape the SVG layer needs.
 *
 * `key` is what a hovered row lights: every wire of the hub lights together
 * when the hub is under the pointer, one wire when its own row is. The key
 * doubles as the e2e hook (`data-wire`), which the old stage's spokes already
 * answered to.
 */
interface WireSpec {
  key: string;
  d: string;
  /** The wire moves only when sound is actually flowing through it. */
  live: boolean;
  /** Overrides the default proposal mark. A staged-but-unlanded feed draws
   *  itself in regardless of the device plan's answered-ness — it is the feed's
   *  own proposal, not the route's. */
  proposed?: boolean;
}

/** Card chrome for things that sit straight on the well: the continuous-
 *  curvature corner, the plane, and the strong hairline — flat blocks with
 *  nothing cast and nothing lifted. */
const CARD_CLASS = 'cc absolute rounded-panel bg-surface border border-line-strong';
/** The role word colour, by role. Literal classes: Tailwind scans source text. */
const ROLE_TEXT_CLASS = {
  primary: 'text-type-primary',
  mirror: 'text-type-mirror',
  feed: 'text-type-feed',
} as const;

/**
 * The pickers' items light up one after another as the menu opens: a stagger
 * carried by variants, opacity only — the menu's own glide brings the travel,
 * and items that never write a transform keep their `.pressable` press intact
 * (Motion and the CSS transform must never sit on one element).
 */
const PICKER_VARIANTS: Variants = {
  closed: { opacity: 0, y: 6, scale: 0.98 },
  open: {
    opacity: 1,
    y: 0,
    scale: 1,
    transition: { ...SPRING_GLIDE, staggerChildren: 0.024, delayChildren: 0.02 },
  },
};

const PICKER_ITEM_VARIANTS: Variants = {
  closed: { opacity: 0 },
  open: { opacity: 1, transition: FADE },
};

/**
 * The node board: the one place a route is drawn.
 *
 * One programme per board. The hub card sits mid-left; down the right edge are
 * two grouped panels — the primary device alone in the first, and under it one
 * box holding every copy and every programme this sound is fed into, numbered
 * in route order (01 is the one Windows plays itself). A wire from the hub's
 * out-pin to a row is the route; the wires are one grey line each, and the
 * colour lives on the number badges and role words, the way a colourist's graph
 * stays quiet.
 *
 * The board takes the well's own height, so the panels always fit the stage and
 * the stage never scrolls: the copies panel grows to fill what is left, and
 * scrolls inside itself when its rows outnumber the room. That is why a wire to
 * a row that has been scrolled out of that panel is not drawn at all — it would
 * otherwise run out past the panel's edge and point at nothing. The feeders'
 * column has no room to scroll in, so it is cut instead: `feederColumn` says
 * which cards the board can show, the half-cut one keeps its card and its wire,
 * and the edge it is cut by fades.
 *
 * The board is a proposal, exactly as the ring stage was: rows toggle
 * membership in the plan, and the hub — which wears a "click to apply" capsule
 * whenever the plan is not yet the truth — lands it. Feeds are plan members
 * like every destination: picking a programme input stages the row, the hub
 * connects it, and the hub lands taking it back out too. One landing point for
 * everything this board proposes, and no undo card beside it.
 *
 * Nothing here measures a card: every position comes from `lib/stage.ts` and
 * the single height the well reports, so a row and the wire meeting it cannot
 * disagree. The one standing animation — dashes on wires that carry sound — is
 * gated on visibility, focus and the system's motion preference
 * (`useLiveness`), and a resting board paints nothing.
 */
export function NodeStage() {
  const { t } = useTranslation();
  const liveness = useLiveness();
  const devices = useRouterStore((s) => s.devices);
  const sessions = useRouterStore((s) => s.sessions);
  const selectedPids = useRouterStore((s) => s.selectedPids);
  const selectedDeviceIds = useRouterStore((s) => s.selectedDeviceIds);
  const defaultDeviceId = useRouterStore((s) => s.defaultDeviceId);
  // The route read by the process being drawn: a sibling process of a routed
  // program carries the same route as the one holding it, so selecting one
  // reports the program as answered instead of proposing what is already on.
  const routesByPid = useProgramRoutes();
  const deviceDelays = useRouterStore((s) => s.deviceDelays);
  const deviceLatencyMs = useRouterStore((s) => s.deviceLatencyMs);
  const feeds = useRouterStore((s) => s.feeds);
  const feedCarrier = useRouterStore((s) => s.feedCarrier);
  const feedTapFailures = useRouterStore((s) => s.feedTapFailures);
  const applying = useRouterStore((s) => s.applying);
  const toggleDeviceSelection = useRouterStore((s) => s.toggleDeviceSelection);
  const appendDeviceTarget = useRouterStore((s) => s.appendDeviceTarget);
  const setPrimaryDevice = useRouterStore((s) => s.setPrimaryDevice);
  const promoteDevice = useRouterStore((s) => s.promoteDevice);
  const applyRoute = useRouterStore((s) => s.applyRoute);
  const selectedFeedPids = useRouterStore((s) => s.selectedFeedPids);
  const appendFeedTarget = useRouterStore((s) => s.appendFeedTarget);
  const dropFeedTarget = useRouterStore((s) => s.dropFeedTarget);
  const selectProcess = useRouterStore((s) => s.selectProcess);

  /** The row whose wire(s) light up under the pointer. */
  const [hoverKey, setHoverKey] = useState<string | null>(null);
  /** The row the bottom strip is tuning. */
  const [inspectorKey, setInspectorKey] = useState<InspectorKey | null>(null);
  /** The add-destination picker, anchored to the copies panel's title row. */
  const [pickerOpen, setPickerOpen] = useState(false);
  /** The change-primary picker, anchored to the primary panel's title row. */
  const [primaryPickerOpen, setPrimaryPickerOpen] = useState(false);
  /** How far the copies panel has been scrolled — its wires ride with it. */
  const [copyScroll, setCopyScroll] = useState(0);
  /** The copies-panel row a just-added destination landed in, one-shot: the
   *  panel scrolls it into view and hands null back. */
  const [revealIndex, setRevealIndex] = useState<number | null>(null);
  /** How many times a proposal has become the truth on this programme's board —
   *  the key that replays the hub's landing beat. */
  const [landPulse, setLandPulse] = useState(0);
  const wellRef = useRef<HTMLDivElement | null>(null);
  /** The hub card: what the level dial belongs to, and the place its focus goes
   *  back to when the dial unmounts with the caret still inside it. */
  const hubRef = useRef<HTMLButtonElement | null>(null);
  /** The button a picker came from, so closing hands the keyboard back to it. */
  const pickerReturnRef = useRef<HTMLElement | null>(null);
  /** The number badge the strip was opened from: closing the strip with its own
   *  ✕ must not leave the caret in the air where the strip just unmounted. */
  const inspectorReturnRef = useRef<HTMLElement | null>(null);
  /** The two menu surfaces, for the focus an open `role=menu` is expected to take. */
  const addMenuRef = useRef<HTMLDivElement | null>(null);
  const primaryMenuRef = useRef<HTMLDivElement | null>(null);
  /** The board's rows as of the last pass, as one signature — what the reveal
   *  diff reads to find the destination that has just arrived. */
  const prevRowsRef = useRef<string | null>(null);
  /** The last programme and answered-ness this component saw, so the landing
   *  beat fires on a press and never on a programme switch. */
  const prevApplyRef = useRef<{ pid: number | undefined; answered: boolean }>({
    pid: undefined,
    answered: false,
  });
  const measured = useElementHeight(wellRef);

  const pid = selectedPids[0];
  const session = sessions.find((s) => s.pid === pid);
  const name = session?.display_name ?? session?.exe_name;
  // The hub card remounts on every programme switch (`key={session.pid}` on
  // the button), which would reset a name swap held inside the card — the
  // words would simply be there, animation dropped on the floor. Tracked one
  // level up, where the switch is just a prop change, the remount instead
  // carries the swap in: ghost and arrivals play on the fresh mount exactly
  // as they would in place.
  const hubName = clampHubName(name ?? '');
  const [nameSwap, setNameSwap] = useState({ text: hubName, prev: null as string | null, key: 0 });
  if (hubName !== nameSwap.text) {
    setNameSwap({ text: hubName, prev: nameSwap.text, key: nameSwap.key + 1 });
  }
  // The tile swaps on the executable, not the name — a display_name can change
  // under a running programme without the programme changing. The ghost tile's
  // fallback letter reads the name this render is replacing (nameSwap still
  // holds it here, both adjustments reading pre-update state), so a
  // not-yet-loaded icon dissolves as a letter instead of a blank.
  const exe = session?.exe_name ?? '';
  // Sounding, subscribed per programme rather than as the whole table: any
  // program in the system flipping play/pause rebuilds the fold, and the board
  // owes a repaint only to the programme it draws (its feeders are covered by
  // their own selector below). The snapshot is one primitive, so a stable false
  // costs no re-render — and it is the programme's answer, not this one
  // process's, because the sound is usually made by a sibling.
  const hubExeKey = exe.toLowerCase();
  const sounding = useRouterStore((s) => s.soundingExes[hubExeKey] === true);
  const [iconSwap, setIconSwap] = useState<{
    exe: string;
    prev: { exeName: string; name: string } | null;
    key: number;
  }>({ exe, prev: null, key: 0 });
  if (exe !== iconSwap.exe) {
    setIconSwap({
      exe,
      prev: iconSwap.exe ? { exeName: iconSwap.exe, name: nameSwap.text || iconSwap.exe } : null,
      key: iconSwap.key + 1,
    });
  }
  // The plan draws in its own order: the first device the user staged is the
  // primary, and the apply lands exactly this order — preview and fact are the
  // same sequence, so a delay value can never push another device onto the
  // seat behind the user's back.
  const drawn = selectedDeviceIds;
  // What an unrouted programme plays through, so a plan that is only the
  // system default reads as the answer it is rather than as a proposal to
  // press: "where this already goes" is not a change, and pressing it would
  // pin the programme to the endpoint it is on without moving any sound.
  const fallback = effectiveFallback(defaultDeviceId, devices);
  // The feed plan: the programme inputs staged on this board. The board draws
  // the plan, not the live map — an input the user picked but has not landed
  // yet is a proposal with a row and a wire of its own, the way a staged
  // device is, and the hub is what turns it into a feed.
  const planFeedSessions = useMemo(
    () =>
      selectedFeedPids
        .map((targetPid) => sessions.find((s) => s.pid === targetPid))
        .filter((s) => s !== undefined),
    [selectedFeedPids, sessions],
  );
  // The landed half: the program's live feeds, resolved through its holder
  // like every per-program map read here.
  const landedFeedPids = useMemo(() => {
    if (pid === undefined) return [];
    const owner = programEntryOf(sessions, feeds, pid);
    return owner === undefined ? [] : (feeds[owner] ?? []);
  }, [feeds, sessions, pid]);
  const landedFeedSet = useMemo(() => new Set(landedFeedPids), [landedFeedPids]);
  const devicesAnswered = alreadyApplied(drawn, selectedPids, routesByPid, fallback);
  const feedsAnswered =
    landedFeedPids.length === selectedFeedPids.length &&
    selectedFeedPids.every((target) => landedFeedSet.has(target));
  const answered = devicesAnswered && feedsAnswered;
  const canApply =
    pid !== undefined &&
    (drawn.length > 0 || planFeedSessions.length > 0) &&
    !answered &&
    !applying;
  const hasPlan = drawn.length > 0 || planFeedSessions.length > 0;

  const primaryDeviceId = drawn[0];
  const copyDeviceIds = drawn.slice(1);

  // The feed carrier's playback side is a pipe, not an output: the user named it
  // in settings, and offering it back as a destination invites routing a
  // programme straight into the pipe — which is a feed's own job, and a feed owns
  // both of its ends. A device already on the plan stays listed all the same: the
  // board draws plans, and a staged row the user can no longer see is a row they
  // cannot take back out (the system default may well be the carrier). The filter
  // lives here rather than in the store because the settings page picks the
  // carrier from the same list — narrowing it there would leave the user no way
  // to change or clear what they configured.
  const pickableDevices = devices.filter(
    (d) => d.id !== feedCarrier.render || drawn.includes(d.id),
  );
  const addableDevices = pickableDevices.filter((d) => !drawn.includes(d.id));
  // What "play here instead" can name: every device but the one already in the
  // seat. Picking one hands it the primary seat and takes the seat's old
  // occupant out of the plan — the opposite question from "also play here",
  // which is why the menu asks the two separately instead of guessing which of
  // them a press meant.
  const switchableDevices = pickableDevices.filter((d) => d.id !== primaryDeviceId);
  // A machine Windows reports no render endpoint for must not be told its plan
  // is already full — "nothing left to add" reads as a finished action, and
  // there was nothing to act on.
  const devicePickerEmpty = devices.length === 0 ? t('stage.pickNoDevices') : t('stage.pickNone');

  // The wires move only when what is drawn is what is playing — a plan waiting
  // for the hub is a proposal, and a proposal does not hum. A feed staged
  // beside an answered device plan does not hold the route's own wires still:
  // they answer the device half of the plan, not the whole of it.
  const flowing = sounding && devicesAnswered && liveness;
  /**
   * The number badge is the inspector's entry, and it is only a control once
   * there is something to tune: a single-device route starts no engine, so a
   * delay and a share have nowhere to act. Drawn as plain chrome otherwise —
   * a button that answers nothing is a trap, not an affordance.
   */
  const badgeIsButton = drawn.length > 1;

  /** Programmes feeding sound *into* the hub, as sessions. */
  const feeders = useMemo(() => {
    if (pid === undefined) return [];
    // A feed is stored under — and aimed at — the program's lowest pid, while
    // the board opens on whichever process the list offered: the same address
    // `programEntryOf` resolves for the feeds going out, read from this side.
    // Matching the bare pid here left a browser's sibling show no feeder at all
    // — the wire, its card and the hub's in-pin were simply missing.
    const hubExe = sessions.find((s) => s.pid === pid)?.exe_name.toLowerCase();
    if (hubExe === undefined) return [];
    const answersForHub = (targetPid: number): boolean =>
      targetPid === pid ||
      sessions.find((s) => s.pid === targetPid)?.exe_name.toLowerCase() === hubExe;
    return Object.entries(feeds)
      .filter(([, targets]) => targets.some(answersForHub))
      .map(([sourcePid]) => sessions.find((s) => s.pid === Number(sourcePid)))
      .filter((s) => s !== undefined);
  }, [feeds, sessions, pid]);

  /** Which of the hub's feeders are sounding, as their executable names joined:
   *  a string snapshot, so only a flip inside this subset re-renders the board.
   *  Read per programme like the hub's own ring is. */
  const feederExeKeys = useMemo(
    () => feeders.map((feeder) => feeder.exe_name.toLowerCase()),
    [feeders],
  );
  const soundingFeederKey = useRouterStore((s) =>
    feederExeKeys.filter((feederExeKey) => s.soundingExes[feederExeKey] === true).join(','),
  );
  const soundingFeeders = useMemo(
    () => new Set(soundingFeederKey === '' ? [] : soundingFeederKey.split(',')),
    [soundingFeederKey],
  );

  /** The board's feed rows: the plan, each with whether it has landed. A
   *  landed row speaks in the three honest states; a staged one is a proposal
   *  wearing the role word it will carry once the hub connects it. */
  const planFeedStates = planFeedSessions.map((targetSession) => ({
    session: targetSession,
    landed: landedFeedSet.has(targetSession.pid),
    state: feedLiveness(exe, feedCarrier, feedTapFailures),
  }));
  /** What the add menu can offer as a programme input: neither the programme
   *  being drawn nor one of its own siblings (a feed into itself), and no
   *  programme the plan already names — one rule per program, on either side. */
  const feedableSessions = sessions.filter(
    (s) =>
      s.pid !== pid &&
      s.exe_name.toLowerCase() !== (session?.exe_name ?? '').toLowerCase() &&
      !planFeedSessions.some(
        (planned) => planned.exe_name.toLowerCase() === s.exe_name.toLowerCase(),
      ),
  );
  /** Every row in the copies panel: the copies first, then the feeds. */
  const copiesRows = copyDeviceIds.length + planFeedStates.length;

  // The board is as tall as the well it sits in, and no taller: that is the
  // whole reason the stage never scrolls. Until the well has reported a height
  // (the very first frame), the app's own default window stands in.
  const height = measured > 0 ? Math.floor(measured) : BOARD_H;
  // The two panels, as one column centred on the hub: whatever the route's
  // length, the hub sits in the middle of it with wires reaching both ways.
  const column = panelColumn(height, copiesRows);
  const hubY = Math.round(boardCentre(height) - HUB_H / 2);

  // The pickers scroll instead of growing past the board: each caps itself to
  // the room under its anchor (bounded by a sane maximum), and the menu's own
  // border and padding (2 + 12 px) come off what the inner list may take.
  const addPickerTop = Math.min(column.copiesY + GROUP_HEADER_H + 8, height - 190);
  const addPickerCap = Math.max(96, Math.min(288, height - addPickerTop - 6));
  const primaryPickerTop = Math.min(column.primaryY + column.primaryHeight + 6, height - 190);
  const primaryPickerCap = Math.max(96, Math.min(288, height - primaryPickerTop - 6));

  // Escape closes a picker and a pointerdown anywhere outside one closes it
  // too — blank space on the board included. Both listeners are registered
  // only while one of the two pickers is open, so a standing listener never
  // swallows the search box's Escape (the same rule the routed capsule
  // follows). Both pickers are shut together: they are never open at once, and
  // whichever key or press arrives belongs to the one on screen.
  /** Close the pickers. `toTrigger` puts the keyboard back on the button the
   *  menu came out of: one dismissed with Escape, or answered by choosing a row,
   *  must not leave the caret in the air — the next Tab would start wherever the
   *  unmounted menu last stood. A press somewhere else is its own answer, so
   *  that door does not reach back. */
  const closePicker = (toTrigger: boolean) => {
    setPickerOpen(false);
    setPrimaryPickerOpen(false);
    if (toTrigger) pickerReturnRef.current?.focus();
    pickerReturnRef.current = null;
  };

  useEffect(() => {
    if (!pickerOpen && !primaryPickerOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        closePicker(true);
      }
    };
    const onPointerDown = (event: PointerEvent) => {
      // A press that does not land on a picker surface — or on the buttons
      // that toggle one, where the close must not race the button's own click
      // and turn "toggle shut" into "close then reopen" — shuts both. Those
      // surfaces carry `data-owns-picker`; everything else on the board (the
      // well, the halo, the cards, the strip) closes them.
      const target = event.target;
      if (target instanceof Element && target.closest('[data-owns-picker]')) return;
      closePicker(false);
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('pointerdown', onPointerDown, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('pointerdown', onPointerDown, true);
    };
  }, [pickerOpen, primaryPickerOpen]);

  // A menu is walked, not Tabbed through: its rows sit after the whole panel in
  // the document, so Tab would visit every device on the board before reaching
  // one. Opening moves the focus to the first row, which is where the arrows the
  // menus already answer have to start.
  useEffect(() => {
    const menu = pickerOpen
      ? addMenuRef.current
      : primaryPickerOpen
        ? primaryMenuRef.current
        : null;
    menu?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
  }, [pickerOpen, primaryPickerOpen]);

  // Selecting a different programme resets the inspector to the card that is
  // actually on screen — a key naming last programme's device must not survive —
  // and puts the copies panel back at the top, where it always starts. The
  // pending reveal and the landing beat's memory are dropped too: whatever the
  // last programme was doing, the new board starts quiet.
  useEffect(() => {
    setInspectorKey(null);
    setPickerOpen(false);
    setPrimaryPickerOpen(false);
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

  const wires: WireSpec[] = [];
  // Hub → the primary row, then → every row of the copies panel. The hub's own
  // wires light together when it is hovered.
  const from = hubOutPort(height);
  if (primaryDeviceId !== undefined) {
    const to = rowInPort(column.primaryY, 0, 0);
    wires.push({
      key: `dev:${primaryDeviceId}`,
      d: nodePath(from.x, from.y, to.x, to.y),
      live: flowing,
    });
  }
  copyDeviceIds.forEach((deviceId, index) => {
    // A row the panel has scrolled away has no wire to meet: the row is not on
    // screen, and neither is the line that would point at it.
    if (!rowVisible(column.copiesY, column.copiesHeight, index, copyScroll)) return;
    const to = rowInPort(column.copiesY, index, copyScroll);
    wires.push({
      key: `dev:${deviceId}`,
      d: nodePath(from.x, from.y, to.x, to.y),
      live: flowing,
    });
  });
  planFeedStates.forEach(({ session: targetSession, landed, state }, offset) => {
    const index = copyDeviceIds.length + offset;
    if (!rowVisible(column.copiesY, column.copiesHeight, index, copyScroll)) return;
    const to = rowInPort(column.copiesY, index, copyScroll);
    wires.push({
      key: `feed:${targetSession.pid}`,
      d: nodePath(from.x, from.y, to.x, to.y),
      // A landed feed's wire reports the feed itself — not the state of the
      // device plan beside it. A programme whose device rows are still waiting
      // for the hub can be feeding perfectly well. A staged one is a proposal:
      // it draws itself in once, and its sound has nowhere to go until the hub
      // lands it.
      live: landed && sounding && liveness && state === 'live',
      proposed: !landed,
    });
  });
  // Feeders → hub. The column is centred on the hub and compresses only to the
  // cards' tightest pitch, so past `feedersFitting(height)` its ends leave the
  // board. The seats are what `feederColumn` hands back: a card still showing
  // half of itself keeps its seat *and* its wire — the half-cut card is the
  // "there are more of these" cue, and the wire is the only thing saying where
  // they go — while a card with nothing of itself left is drawn neither.
  const feederSeats = feederColumn(feeders.length, height);
  const feederHasSeat = (index: number): boolean =>
    index >= feederSeats.first && index < feederSeats.first + feederSeats.seated;
  feeders.forEach((feeder, index) => {
    if (!feederHasSeat(index)) return;
    const source = feederOutPort(index, feeders.length, height);
    const to = hubInPort(height);
    wires.push({
      key: `feeder:${feeder.pid}`,
      d: nodePath(source.x, source.y, to.x, to.y),
      // The same rule the feed-target wires follow on the feeder's own board:
      // this wire reports sound actually arriving here, and a feed whose
      // source is itself routed (its render slot is taken) or whose carrier is
      // not configured delivers nothing — the row reads 挂起 / 未接通, and a
      // moving wire would say the opposite of the row it hangs from.
      live:
        soundingFeeders.has(feeder.exe_name.toLowerCase()) &&
        liveness &&
        feedLiveness(feeder.exe_name, feedCarrier, feedTapFailures) === 'live',
    });
  });

  const lit = (key: string): boolean =>
    hoverKey === 'hub' && !key.startsWith('feeder:') ? true : hoverKey === key;

  /**
   * Add or remove one device row.
   *
   * The last device cannot be switched off: a route whose sound goes nowhere is
   * not a state this app offers, and the guard lives here rather than in the
   * store because it is a fact about this screen — the same rule the disc stage
   * always carried.
   */
  const toggleTarget = (deviceId: string): void => {
    if (drawn.length === 1 && drawn[0] === deviceId) return;
    toggleDeviceSelection(deviceId);
  };

  // The hub's accessible name lists every device the plan reaches, joined the
  // way the disc stage always joined them: a screen reader hears the whole
  // answer, not just the primary. A device that has left `devices` is said as
  // one that has left, never as its GUID — that string answers nothing, and
  // the mismatch only lasts until the next refresh anyway.
  const deviceNameOf = (id: string): string =>
    devices.find((d) => d.id === id)?.name ?? t('stage.deviceGone');
  const targets = drawn.map(deviceNameOf).join(' + ');
  // The name is a question while there is something to press and a statement
  // once the screen already shows the answer — the same split the affordance
  // makes, said in words so the hub is never an unlabelled button.
  const hubAria = canApply
    ? selectedPids.length > 1
      ? t('stage.applyAriaMany', { n: selectedPids.length, device: targets })
      : t('stage.applyAriaOne', {
          process: name ?? '',
          device: targets,
        })
    : t('stage.hubAria', {
        process: name ?? '',
        device: targets === '' ? t('stage.groupPrimaryEmpty') : targets,
      });

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* The well: the plane the board sits on. Flat, sunken, hairlined from
          the rail — and it never scrolls: the board is exactly as tall as the
          well, so what used to make it grow now scrolls inside the copies
          panel. A narrower window still gets a horizontal bar, because the
          board's width is what the app's own default window measures. */}
      <div
        ref={wellRef}
        className="min-h-0 flex-1 overflow-x-auto overflow-y-hidden bg-surface-sunken"
      >
        <div
          className="relative mx-auto"
          style={{ width: BOARD_W, height }}
          onMouseLeave={() => setHoverKey(null)}
        >
          {/* The halo: the hub's own concentric rings, drawn into the well as
              line work. The interface's every indicator is two circles sharing
              a centre; here the same mark is scaled up until it is scenery —
              the plane declaring whose board this is without lighting, filling
              or shadowing anything. Pure hairline, behind every card and every
              wire. */}
          <svg
            aria-hidden="true"
            width={BOARD_W}
            height={height}
            className="pointer-events-none absolute inset-0"
          >
            {[96, 152, 208].map((r) => (
              <circle
                key={r}
                cx={HUB_X + HUB_W / 2}
                cy={height / 2}
                r={r}
                fill="none"
                stroke="var(--hairline-strong)"
                strokeWidth={1}
                opacity={0.45}
              />
            ))}
          </svg>

          {/* The wires. One grey line each — the role colour lives on the rows
              (number badge, role word), not on the wire, so a fan of routes
              reads as plumbing rather than as spaghetti. */}
          <svg
            aria-hidden="true"
            width={BOARD_W}
            height={height}
            className="pointer-events-none absolute inset-0"
          >
            {wires.map((wire) => {
              // The draw-in is a proposal's own mark, so it is carried only
              // while the plan is not yet the route. A settled route that
              // merely went quiet — paused, or the window losing the gate — has
              // to fall back to the steady line: swapping `stage-flow` for
              // `stage-draw` restarts that keyframe, and every wire would then
              // redraw itself as though it had just been proposed. A staged
              // feed proposes on its own: it carries the draw-in until the hub
              // lands it, whatever the device half of the plan is doing.
              const proposed = wire.proposed ?? (!wire.live && !devicesAnswered);
              return (
                <path
                  key={wire.key}
                  data-wire={
                    wire.key.startsWith('dev:') ? `${pid}:${wire.key.slice(4)}` : undefined
                  }
                  data-live={wire.live ? 'true' : undefined}
                  d={wire.d}
                  // A proposal wire draws itself once, out of the hub's pin; the
                  // `pathLength` normalization is what lets one fixed dasharray
                  // cover a path of any shape. A flowing wire never carries the
                  // attribute — a normalized length would rescale the flow's own
                  // dash pattern into a solid line — so it leaves the moment the
                  // route lands, together with the class.
                  pathLength={proposed ? 1 : undefined}
                  // `live` is the route carrying sound right now, and that alone
                  // is what the moving dash reports. `lit` is the cursor, and only
                  // brightens the line: gating the flow on it made the animation
                  // unreachable in the steady state it describes, because a wire
                  // you are not hovering over was a still line even while playing.
                  className={`nwire ${
                    wire.live ? 'stage-flow' : proposed ? 'stage-draw' : ''
                  } ${lit(wire.key) ? 'lit' : ''}`}
                />
              );
            })}
          </svg>

          {/* Feeders: the programmes sending sound into the hub. A click walks
              to that programme's own board — the graph answers one programme at
              a time, and this is the door between them. */}
          {feeders.map((feeder, index) => {
            // The well clips vertically and never scrolls, so a card the board
            // cannot show by half is one nobody can aim at or reach with the
            // keyboard — and a focusable button nobody can see is not on the
            // board. The seated half-cards are the column's end, and the fading
            // edge below says the column goes on.
            if (!feederHasSeat(index)) return null;
            const feederName = feeder.display_name ?? feeder.exe_name;
            const feederSounding = soundingFeeders.has(feeder.exe_name.toLowerCase());
            return (
              <motion.button
                key={feeder.pid}
                type="button"
                // A source taking its seat: it grows out of the edge its wire
                // leaves from, so the pin stays put and the line never chases.
                initial={{ opacity: 0, scaleX: 0.94 }}
                animate={{ opacity: 1, scaleX: 1 }}
                transition={SPRING_TAP}
                transformTemplate={MAIN_THREAD_TRANSFORM}
                onMouseEnter={() => setHoverKey(`feeder:${feeder.pid}`)}
                onMouseLeave={() => setHoverKey(null)}
                onClick={() => selectProcess(feeder.pid)}
                aria-label={t('stage.feederAria', { process: feederName, target: name ?? '' })}
                title={t('stage.feederTitle', { target: name ?? '' })}
                className={`${CARD_CLASS} flex flex-col items-start justify-center gap-1 px-3 text-left hover:border-line-strong focus-visible:border-accent focus-visible:outline-none`}
                style={{
                  left: FEEDER_X,
                  top: feederY(index, feeders.length, height),
                  width: MINI_W,
                  height: MINI_H,
                  transformOrigin: 'right center',
                }}
              >
                <span className="pin pin-out" aria-hidden="true" />
                <span className="flex w-full items-center gap-2">
                  <Ring tone="idle" size={12} live={feederSounding && liveness} />
                  <ProcessIcon exeName={feeder.exe_name} name={feederName} size={16} />
                  <span className="truncate text-[11.5px] font-semibold text-text-primary">
                    {feederName}
                  </span>
                </span>
                <span className="w-full truncate pl-[22px] text-xs text-text-muted">
                  {t('stage.feederSub', { target: name ?? '' })}
                </span>
              </motion.button>
            );
          })}

          {/* The cut edges of the feeders' column: the same soft edge the copies
              panel paints, and for the same reason — a card that ends mid-height
              has to read as the column going on, not as a card that failed to
              render. The well's own background closing over the cards, so it is
              a gradient of one colour into nothing, never a mask. It paints
              nothing while every card has its seat. */}
          <div
            aria-hidden="true"
            className="pointer-events-none absolute top-0 h-4 bg-gradient-to-b from-surface-sunken to-transparent transition-opacity duration-200"
            style={{ left: FEEDER_X, width: MINI_W, opacity: feederSeats.cutAbove ? 1 : 0 }}
          />
          <div
            aria-hidden="true"
            className="pointer-events-none absolute bottom-0 h-6 bg-gradient-to-t from-surface-sunken to-transparent transition-opacity duration-200"
            style={{ left: FEEDER_X, width: MINI_W, opacity: feederSeats.cutBelow ? 1 : 0 }}
          />

          {/* The hub: the programme under the cursor. A proposal waiting for
              the press wears the apply capsule; already-applied, it is a card
              like the others and clicking it opens the strip below. */}
          {session === undefined ? (
            <motion.div
              className={`${CARD_CLASS} flex items-center justify-center px-4 text-center`}
              style={{ left: HUB_X, top: hubY, width: HUB_W, height: HUB_H }}
            >
              <span className="text-[12px] leading-relaxed text-text-muted">
                {t('stage.guide')}
              </span>
            </motion.div>
          ) : (
            <motion.button
              key={session.pid}
              ref={hubRef}
              type="button"
              data-source-node="subject"
              // The card is a button only while it lands something: once what is
              // drawn is what is playing, it goes back to being a label — a
              // board never asks anyone to confirm what they can hear. The
              // programme's own summary lives in the strip below either way.
              //
              // `aria-disabled` rather than `disabled`, because Chromium
              // dispatches no mouse events on a disabled control and this card
              // is where the hover that lights its wires begins — which is to
              // say the hovering never happened exactly when the wires were
              // flowing. The press is guarded below, and `cursor-default` says
              // what the answer already is.
              aria-disabled={!canApply}
              onMouseEnter={() => setHoverKey('hub')}
              onMouseLeave={() => setHoverKey(null)}
              onClick={() => {
                if (canApply) void applyRoute();
              }}
              aria-label={hubAria}
              whileTap={canApply ? { scale: 0.98 } : undefined}
              transformTemplate={MAIN_THREAD_TRANSFORM}
              transition={SPRING_TAP}
              className={`${CARD_CLASS} ${
                canApply
                  ? 'cursor-pointer border-accent/60 hover:border-accent focus-visible:border-accent'
                  : 'cursor-default'
              } flex flex-col items-center justify-center gap-1 px-4 text-center focus-visible:outline-none`}
              style={{ left: HUB_X, top: hubY, width: HUB_W, height: HUB_H }}
            >
              {/* The apply capsule pops in when the plan departs from the truth
                  and shrinks back the moment it lands — both ends animated,
                  because an instant swap makes the landing itself unread.
                  Motion owns the whole transform: a Tailwind
                  `-translate-x-1/2` centering would be overridden by the inline
                  transform, so the centering rides inside the animated values
                  as a constant `x`. With more than one destination it counts
                  them: "also play here" is the one press on this board that
                  makes sound come out of a second place, and the count is said
                  before it happens rather than noticed after. */}
              <AnimatePresence initial={false}>
                {canApply && (
                  <motion.span
                    key="apply-hint"
                    initial={{ opacity: 0, x: '-50%', y: -4, scale: 0.9 }}
                    animate={{ opacity: 1, x: '-50%', y: 0, scale: 1 }}
                    exit={{ opacity: 0, x: '-50%', y: -3, scale: 0.96 }}
                    transition={SPRING_TAP}
                    transformTemplate={MAIN_THREAD_TRANSFORM}
                    className="absolute -top-3 left-1/2 whitespace-nowrap rounded-full bg-accent px-2.5 py-0.5 text-xs font-semibold text-accent-ink"
                  >
                    {drawn.length > 1
                      ? t('stage.applyHintMany', { n: drawn.length })
                      : t('stage.applyHint')}
                  </motion.span>
                )}
              </AnimatePresence>
              {/* One beat when a proposal becomes the truth: a single accent
                  hairline expands off the card and dies. While the programme is
                  silent this is the landing's only feedback — a flowing wire and
                  a pulsing ring both need sound to report — and it plays once,
                  never standing. */}
              {landPulse > 0 && (
                <motion.span
                  key={landPulse}
                  aria-hidden="true"
                  initial={{ opacity: 0.55, scale: 0.94 }}
                  animate={{ opacity: 0, scale: 1.06 }}
                  transition={SPRING_ROUTE}
                  transformTemplate={MAIN_THREAD_TRANSFORM}
                  className="pointer-events-none absolute inset-0 rounded-panel border border-accent"
                />
              )}
              {/* Balanced around the name: icon prefix + name slot + trailing
                  ring total exactly the card's inner width (18 + 8 + 106 + 10
                  + 16 = 158), so the slot's centre — and with it every name
                  that swaps inside — sits on the card's centreline, the same
                  axis as the status line below and the apply capsule above. */}
              <span className="flex items-center gap-2">
                <ProcessIcon
                  exeName={session.exe_name}
                  name={name ?? session.exe_name}
                  size={18}
                  prev={iconSwap.prev}
                  swapKey={iconSwap.key}
                />
                <CharSwapText text={hubName} prev={nameSwap.prev} swapKey={nameSwap.key} />
                <Ring
                  tone={hasPlan ? 'main' : 'idle'}
                  size={16}
                  live={sounding && liveness}
                  className="ml-0.5"
                />
              </span>
              <span className="text-xs text-text-muted">
                {applying && (
                  <Spinner size={10} className="mr-1 inline-block align-[-1px] text-accent" />
                )}
                {sounding ? t('stage.sounding') : t('stage.quiet')}
                {planFeedStates.length > 0 && (
                  <span className="text-type-feed">
                    {' '}
                    · {t('stage.feedCount', { n: planFeedStates.length })}
                  </span>
                )}
              </span>
              {/* The in-pin exists only when someone is feeding this programme;
                  an unused pin is not drawn, so the hub does not grow sockets
                  that mean nothing. */}
              {feeders.length > 0 && <span className="pin pin-in" aria-hidden="true" />}
              <span className="pin pin-out" aria-hidden="true" />
            </motion.button>
          )}

          {/* The level dial rides under the hub, exactly where the ring stage
              kept it: multi-device routes only, program-scoped. It rises the
              few pixels it sits below the hub on the way in — an arrival, not
              a pop. */}
          {session !== undefined && drawn.length > 1 && (
            <motion.div
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              transition={SPRING_GLIDE}
              transformTemplate={MAIN_THREAD_TRANSFORM}
              className="absolute flex justify-center"
              style={{ left: HUB_X - 40, top: hubY + HUB_H + 12, width: HUB_W + 80 }}
            >
              <SourceLevelDial
                exeName={session.exe_name}
                displayName={session.display_name ?? undefined}
                hostRef={hubRef}
              />
            </motion.div>
          )}

          {/* The primary device, alone in the first panel: 01 is the endpoint
              Windows plays itself, and it sits above the copies because that is
              the order the numbering teaches. */}
          <Panel
            label={t('stage.groupPrimary')}
            top={column.primaryY}
            height={column.primaryHeight}
            rows={primaryDeviceId !== undefined ? 1 : 0}
            empty={t('stage.groupPrimaryEmpty')}
          >
            {primaryDeviceId !== undefined && (
              <DeviceRow
                deviceId={primaryDeviceId}
                deviceName={deviceNameOf(primaryDeviceId)}
                index={0}
                top={rowContentY(0) - ROW_H / 2}
                isPrimary
                delay={0}
                badgeIsButton={badgeIsButton}
                removable={false}
                inspected={inspectorKey === `dev:${primaryDeviceId}`}
                onRemove={() => undefined}
                onPromote={() => undefined}
                onPrimaryPick={() => {
                  pickerReturnRef.current = document.activeElement as HTMLElement | null;
                  // The two pickers are never open at once: opening this one
                  // shuts the add picker, so a key or press always belongs to the
                  // menu that is on screen.
                  setPickerOpen(false);
                  setPrimaryPickerOpen((value) => !value);
                }}
                onInspect={(source) => {
                  inspectorReturnRef.current = source;
                  setInspectorKey(`dev:${primaryDeviceId}`);
                }}
                onHover={setHoverKey}
              />
            )}
          </Panel>

          {/* Everything else: the copies, then the programmes this sound is fed
              into. It is as tall as its rows — one too many to fit and it
              scrolls here, rather than the stage scrolling around it. */}
          <Panel
            label={t('stage.groupCopies')}
            top={column.copiesY}
            height={column.copiesHeight}
            rows={copiesRows}
            empty={t('stage.groupCopiesEmpty')}
            onScroll={setCopyScroll}
            resetKey={pid}
            revealIndex={revealIndex}
            onRevealed={clearReveal}
            headerAction={
              <button
                type="button"
                data-owns-picker
                aria-label={t('stage.addTarget')}
                title={t('stage.addTargetTitle')}
                onClick={(event) => {
                  pickerReturnRef.current = event.currentTarget;
                  // As above: one picker at a time.
                  setPrimaryPickerOpen(false);
                  setPickerOpen((value) => !value);
                }}
                className="pressable hit flex h-[18px] w-[18px] flex-none items-center justify-center rounded-full border border-dashed border-line-strong text-[11px] leading-none text-text-muted hover:border-accent/60 hover:text-accent focus-visible:border-accent focus-visible:outline-none"
              >
                ＋
              </button>
            }
          >
            {copyDeviceIds.map((deviceId, offset) => {
              const delay = deviceDelays[deviceId] ?? 0;
              return (
                <DeviceRow
                  key={deviceId}
                  deviceId={deviceId}
                  deviceName={deviceNameOf(deviceId)}
                  index={offset + 1}
                  top={rowContentY(offset) - ROW_H / 2}
                  isPrimary={false}
                  delay={delay}
                  badgeIsButton={badgeIsButton}
                  removable
                  inspected={inspectorKey === `dev:${deviceId}`}
                  onRemove={() => toggleTarget(deviceId)}
                  onPromote={() => promoteDevice(deviceId)}
                  onInspect={(source) => {
                    inspectorReturnRef.current = source;
                    setInspectorKey(`dev:${deviceId}`);
                  }}
                  onHover={setHoverKey}
                />
              );
            })}
            {planFeedStates.map(({ session: targetSession, landed, state }, offset) => (
              <FeedRow
                key={targetSession.pid}
                session={targetSession}
                landed={landed}
                state={state}
                index={copyDeviceIds.length + offset + 1}
                top={rowContentY(copyDeviceIds.length + offset) - ROW_H / 2}
                sourceName={name ?? ''}
                onRemove={() => dropFeedTarget(targetSession.pid)}
                onHover={setHoverKey}
              />
            ))}
          </Panel>

          <AnimatePresence>
            {pickerOpen && (
              <motion.div
                key="picker"
                ref={addMenuRef}
                role="menu"
                data-owns-picker
                aria-label={t('stage.addTarget')}
                initial="closed"
                animate="open"
                exit="closed"
                variants={PICKER_VARIANTS}
                transformTemplate={MAIN_THREAD_TRANSFORM}
                onKeyDown={walkPickerMenu}
                className="cc absolute z-30 w-[230px] overflow-hidden rounded-card border border-line-strong bg-surface p-1.5"
                style={{
                  left: Math.min(GROUP_X - 40, BOARD_W - 250),
                  top: addPickerTop,
                  maxHeight: addPickerCap,
                }}
              >
                <div className="overflow-y-auto" style={{ maxHeight: addPickerCap - 14 }}>
                  <PickerSection label={t('stage.pickSwitch')} section="switch">
                    {switchableDevices.length === 0 && <PickerEmpty text={devicePickerEmpty} />}
                    {switchableDevices.map((d) => (
                      <motion.button
                        key={d.id}
                        type="button"
                        role="menuitem"
                        variants={PICKER_ITEM_VARIANTS}
                        transformTemplate={MAIN_THREAD_TRANSFORM}
                        onClick={() => {
                          // The seat, not a second output: the device that held
                          // it leaves the plan, because "play here instead" was
                          // never "play here as well".
                          setPrimaryDevice(d.id);
                          closePicker(true);
                        }}
                        className="pressable w-full rounded-seg px-2.5 py-1.5 text-left text-[12px] text-text-secondary hover:bg-surface-hover hover:text-text-primary"
                      >
                        {d.name}
                      </motion.button>
                    ))}
                  </PickerSection>
                  <PickerSection label={t('stage.pickCopy')} section="copy">
                    {addableDevices.length === 0 && <PickerEmpty text={t('stage.pickNone')} />}
                    {addableDevices.map((d) => (
                      <motion.button
                        key={d.id}
                        type="button"
                        role="menuitem"
                        variants={PICKER_ITEM_VARIANTS}
                        transformTemplate={MAIN_THREAD_TRANSFORM}
                        onClick={() => {
                          // Append, never toggle: "also" has to leave the plan's
                          // membership alone and put the new device on the tail.
                          // The seat it ends up in is the delay order's call,
                          // exactly as for any other row.
                          appendDeviceTarget(d.id);
                          closePicker(true);
                        }}
                        className="pressable w-full rounded-seg px-2.5 py-1.5 text-left text-[12px] text-text-secondary hover:bg-surface-hover hover:text-text-primary"
                      >
                        {d.name}
                      </motion.button>
                    ))}
                  </PickerSection>
                  <PickerSection label={t('stage.pickFeed')} section="feed">
                    {feedableSessions.length === 0 && <PickerEmpty text={t('stage.pickNone')} />}
                    {feedableSessions.map((s) => (
                      <motion.button
                        key={s.pid}
                        type="button"
                        role="menuitem"
                        variants={PICKER_ITEM_VARIANTS}
                        transformTemplate={MAIN_THREAD_TRANSFORM}
                        onClick={() => {
                          if (pid !== undefined) appendFeedTarget(s.pid);
                          closePicker(true);
                        }}
                        className="pressable flex w-full items-center gap-2 rounded-seg px-2.5 py-1.5 text-left text-[12px] text-text-secondary hover:bg-surface-hover hover:text-text-primary"
                      >
                        <span className="text-type-feed" aria-hidden="true">
                          ◧
                        </span>
                        <span className="truncate">
                          {t('stage.pickFeedItem', {
                            process: s.display_name ?? s.exe_name,
                          })}
                        </span>
                      </motion.button>
                    ))}
                  </PickerSection>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* The change-primary picker: the way to hand the primary seat to
              another device without touching the copies. Every row is
              selectable — a device already carrying a delay compensation may
              take the seat too (the values are the copies' alignment figures,
              not a gate on who sits first); recalibrating after the move is
              the wizard's job. */}
          <AnimatePresence>
            {primaryPickerOpen && (
              <motion.div
                key="primary-picker"
                ref={primaryMenuRef}
                role="menu"
                data-owns-picker
                aria-label={t('stage.changePrimary')}
                initial="closed"
                animate="open"
                exit="closed"
                variants={PICKER_VARIANTS}
                transformTemplate={MAIN_THREAD_TRANSFORM}
                onKeyDown={walkPickerMenu}
                className="cc absolute z-30 w-[230px] overflow-hidden rounded-card border border-line-strong bg-surface p-1.5"
                style={{
                  left: Math.min(GROUP_X - 40, BOARD_W - 250),
                  top: primaryPickerTop,
                  maxHeight: primaryPickerCap,
                }}
              >
                <div className="overflow-y-auto" style={{ maxHeight: primaryPickerCap - 14 }}>
                  <PickerSection label={t('stage.pickPrimary')} section="primary">
                    {pickableDevices.length === 0 && <PickerEmpty text={devicePickerEmpty} />}
                    {pickableDevices.map((d) => {
                      const picked = d.id === primaryDeviceId;
                      return (
                        <motion.button
                          key={d.id}
                          type="button"
                          role="menuitem"
                          variants={PICKER_ITEM_VARIANTS}
                          transformTemplate={MAIN_THREAD_TRANSFORM}
                          aria-current={picked ? 'true' : undefined}
                          onClick={() => {
                            setPrimaryDevice(d.id);
                            closePicker(true);
                          }}
                          className="pressable flex w-full items-center gap-2 rounded-seg px-2.5 py-1.5 text-left text-[12px] text-text-secondary outline-none hover:bg-surface-hover hover:text-text-primary focus-visible:bg-surface-hover focus-visible:text-text-primary"
                        >
                          <span
                            className={`flex h-3 w-3 flex-none items-center justify-center text-xs ${
                              picked ? 'text-accent' : 'text-transparent'
                            }`}
                            aria-hidden="true"
                          >
                            ✓
                          </span>
                          <span className="min-w-0 flex-1 truncate">{d.name}</span>
                        </motion.button>
                      );
                    })}
                  </PickerSection>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>

      {/* The strip: what a clicked card tunes. It exists only while something
          is being tuned — there is no standing status bar under the board any
          more, because a bar that is always there is a bar nobody reads. It
          makes room for itself as it arrives, and gives the room back as it
          leaves. */}
      <AnimatePresence initial={false}>
        {inspectorKey !== null && (
          <motion.div
            key="inspector"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={SPRING_GLIDE}
            transformTemplate={MAIN_THREAD_TRANSFORM}
            className="flex-none overflow-hidden"
          >
            <Inspector
              inspectorKey={inspectorKey}
              onClear={clearInspector}
              drawn={drawn}
              deviceLatencyMs={deviceLatencyMs}
            />
          </motion.div>
        )}
      </AnimatePresence>

      {/* A route with one destination starts no engine, so the strip has no
          lever to offer — and the question "how do I turn this program down"
          had no answer anywhere in the app. It is not a lever this board can
          pull: the volume of a program Windows plays itself belongs to the
          system mixer. So the band says where it lives, and only while a route
          is actually single-destination — a note about a plan nobody landed
          would be a bar talking to itself. */}
      <AnimatePresence initial={false}>
        {inspectorKey === null && answered && drawn.length === 1 && session !== undefined && (
          <motion.div
            key="single-note"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={SPRING_GLIDE}
            transformTemplate={MAIN_THREAD_TRANSFORM}
            className="flex-none overflow-hidden"
          >
            <div
              data-single-note
              className="flex items-center gap-2 border-t border-line px-4 py-2.5 text-xs text-text-muted"
            >
              <Ring tone="main" size={12} />
              <span className="truncate" title={t('stage.singleNoteTitle')}>
                {t('stage.singleNote', { device: targets })}
              </span>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/**
 * One of the two grouped panels down the right edge.
 *
 * A dashed rounded rectangle rather than a solid one: the panel holds cards,
 * so it must not read as a card itself. Its title row stays put while the rows
 * below it scroll, because the way in for a new direction has to be reachable
 * however long the list has grown.
 */
function Panel({
  label,
  top,
  height,
  rows,
  empty,
  headerAction,
  onScroll,
  resetKey,
  revealIndex,
  onRevealed,
  children,
}: {
  label: string;
  top: number;
  height: number;
  rows: number;
  empty: string;
  headerAction?: React.ReactNode;
  onScroll?: (scrollTop: number) => void;
  /** Changing this sends the panel back to its top. The scroll position lives
   *  in the DOM, where no parent state can reach it: a programme switch resets
   *  the wires' scroll and leaves the rows where they were, so every wire ends
   *  up pointing at the place its row used to hold. */
  resetKey?: string | number;
  /** One-shot: the row index to bring into view; handed back via
   *  `onRevealed` once the panel has done its single scroll. */
  revealIndex?: number | null;
  onRevealed?: () => void;
  children: React.ReactNode;
}) {
  const bodyHeight = height - PANEL_BORDER * 2 - GROUP_HEADER_H;
  const contentHeight = rows > 0 ? panelBodyHeight(rows) : 0;
  const [scrollTop, setScrollTop] = useState(0);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // When the content or the room changes, the browser clamps the scroll itself;
  // read the clamped value back so a hint does not stay lit over a panel that
  // has just come to rest at its new bottom — and report it too, so the wires
  // that ride the parent's `copyScroll` do not keep pointing where the rows were
  // before the clamp.
  useEffect(() => {
    const clamped = scrollRef.current?.scrollTop ?? 0;
    setScrollTop(clamped);
    onScroll?.(clamped);
  }, [rows, bodyHeight, onScroll]);
  // A new programme on the hub means a new list of rows, and the panel starts
  // at its top for it — the DOM's own scroll is reset here, because the parent
  // can reset only the number it draws wires from.
  useEffect(() => {
    if (resetKey === undefined) return;
    const el = scrollRef.current;
    if (el !== null) el.scrollTop = 0;
    setScrollTop(0);
    onScroll?.(0);
  }, [resetKey]);
  // A destination that has just joined the plan may have landed below the cut:
  // one instant scroll brings its row fully into view — the row's own entrance
  // spring carries the "it arrived" moment, and the wire draws in after the
  // scroll settles it. It only ever reaches down: a row the eye can already
  // see never pulls the panel back up.
  useEffect(() => {
    if (revealIndex === undefined || revealIndex === null) return;
    const el = scrollRef.current;
    if (el === null) return;
    const maxScroll = Math.max(0, contentHeight - bodyHeight);
    const target = rowContentY(revealIndex) + ROW_H / 2 + GROUP_PAD - bodyHeight;
    const next = Math.max(el.scrollTop, Math.min(target, maxScroll));
    if (next !== el.scrollTop) {
      el.scrollTop = next;
      // Reported here as well as through the scroll event the DOM fires a task
      // later: the wires are drawn from the parent's copy of the scroll, and
      // waiting for that event would spend one frame with every line pointing at
      // where its row sat before the reveal.
      setScrollTop(next);
      onScroll?.(next);
    }
    onRevealed?.();
  }, [revealIndex, bodyHeight, contentHeight, onScroll, onRevealed]);
  const canScrollUp = rows > 0 && scrollTop > 0.5;
  const canScrollDown = rows > 0 && scrollTop + bodyHeight < contentHeight - 0.5;
  return (
    <div
      className="cc absolute overflow-hidden rounded-card border border-dashed border-line-strong bg-surface-sunken"
      style={{ left: GROUP_X, top, width: GROUP_W, height }}
    >
      <div
        className="flex items-center justify-between gap-2 px-2"
        style={{ height: GROUP_HEADER_H }}
      >
        <span className="truncate text-xs font-semibold uppercase tracking-[0.08em] text-text-muted">
          {label}
        </span>
        {headerAction}
      </div>
      <div className="relative" style={{ height: bodyHeight }}>
        <div
          ref={scrollRef}
          className="h-full overflow-y-auto"
          onScroll={(event) => {
            setScrollTop(event.currentTarget.scrollTop);
            onScroll?.(event.currentTarget.scrollTop);
          }}
        >
          {rows > 0 ? (
            <div className="relative" style={{ height: contentHeight }}>
              {children}
            </div>
          ) : (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={FADE}
              transformTemplate={MAIN_THREAD_TRANSFORM}
              className="px-3 py-2.5 text-xs leading-relaxed text-text-muted"
            >
              {empty}
            </motion.div>
          )}
        </div>
        {/* The soft edge: the panel's own background closing over whatever runs
            past it. It is what makes the half-row cut below read as "there is
            more down there" rather than as a card that failed to render — a
            gentle pull towards the content that is out of sight, fading in only
            while there is something on that side to reach. Never interactive,
            and it paints nothing while the rows fit. */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 top-0 h-4 bg-gradient-to-b from-surface-sunken to-transparent transition-opacity duration-200"
          style={{ opacity: canScrollUp ? 1 : 0 }}
        />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 bottom-0 h-6 bg-gradient-to-t from-surface-sunken to-transparent transition-opacity duration-200"
          style={{ opacity: canScrollDown ? 1 : 0 }}
        />
      </div>
    </div>
  );
}

/**
 * One output device, as a row inside a panel.
 *
 * The row is placed by `lib/stage.ts` rather than by flow, so the wire that
 * meets its in-pin cannot be a frame out of step with it; the panel's own
 * scrolling moves the row and its wire together.
 */
function DeviceRow({
  deviceId,
  deviceName,
  index,
  top,
  isPrimary,
  delay,
  badgeIsButton,
  removable,
  inspected,
  onRemove,
  onPromote,
  onPrimaryPick,
  onInspect,
  onHover,
}: {
  deviceId: string;
  deviceName: string;
  index: number;
  top: number;
  isPrimary: boolean;
  delay: number;
  badgeIsButton: boolean;
  removable: boolean;
  inspected: boolean;
  onRemove: () => void;
  onPromote: () => void;
  /** Present on the primary row only: clicking the row opens the picker that
   *  hands the primary seat to another device. */
  onPrimaryPick?: () => void;
  /** Opens the strip, with the control that was pressed: closing the strip
   *  later puts the keyboard back there. */
  onInspect: (source: HTMLElement) => void;
  onHover: (key: string | null) => void;
}) {
  const { t } = useTranslation();
  const roleWord = isPrimary ? t('stage.main') : t('stage.copy');
  const wireKey = `dev:${deviceId}`;

  return (
    <motion.div
      data-device-row={deviceId}
      // A destination taking its seat: it grows out of the edge its wire meets,
      // so the pin stays put and the line never chases it into place.
      initial={{ opacity: 0, scaleX: 0.94 }}
      animate={{ opacity: 1, scaleX: 1 }}
      transition={SPRING_TAP}
      transformTemplate={MAIN_THREAD_TRANSFORM}
      onMouseEnter={() => onHover(wireKey)}
      onMouseLeave={() => onHover(null)}
      className={`group/copy group absolute flex items-center gap-2 rounded-ctl bg-surface pl-3 pr-2 ${
        inspected ? 'ring-1 ring-accent' : 'hover:bg-surface-hover'
      }`}
      style={{ left: GROUP_PAD, top, width: ROW_W, height: ROW_H, transformOrigin: 'left center' }}
    >
      <span className="pin pin-in" aria-hidden="true" />
      {/* The number badge opens the strip — but only once there is something to
          tune: a single-device route starts no engine, so neither a delay nor a
          share exists for it, and the primary volume alone is not a control this
          route offers. Same rule the disc stage always carried. */}
      {badgeIsButton ? (
        <button
          type="button"
          className="no pressable hit cursor-pointer hover:border-accent hover:text-accent focus-visible:ring-2 focus-visible:ring-accent/60"
          onClick={(event) => onInspect(event.currentTarget)}
          aria-label={t('stage.inspectAria', { name: deviceName })}
          title={t('stage.inspectTitle', { name: deviceName })}
        >
          {orderLabel(index)}
        </button>
      ) : (
        <span className="no" aria-hidden="true">
          {orderLabel(index)}
        </span>
      )}
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        {/* One control per row, and it opens the row: the primary's name opens
            the picker that hands the seat over, a copy's name opens the strip
            that tunes it. Neither removes anything — a press that takes a
            destination out of the plan is the ✕, and it says so. */}
        <button
          type="button"
          // The primary row's name opens the change-primary picker: the press
          // that opens it must not be the press that closes it, so the button
          // is exempt from the outside-close like the pickers themselves.
          data-owns-picker={onPrimaryPick !== undefined ? 'true' : undefined}
          aria-label={
            onPrimaryPick === undefined
              ? t('stage.rowAria', { name: deviceName })
              : t('stage.changePrimaryAria', { name: deviceName })
          }
          title={
            onPrimaryPick === undefined
              ? t('stage.inspectTitle', { name: deviceName })
              : t('stage.changePrimaryTitle')
          }
          onClick={onPrimaryPick ?? ((event) => onInspect(event.currentTarget))}
          className="pressable flex items-center gap-1 truncate rounded-seg text-left text-[12px] font-bold text-text-primary outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
        >
          <span className="truncate">{deviceName}</span>
          {/* The chevron is the one mark that says this name opens something:
              without it the row reads as a label that happens to be bold. */}
          {onPrimaryPick !== undefined && (
            <span aria-hidden="true" className="flex-none text-[9px] leading-none text-text-muted">
              ⌄
            </span>
          )}
        </button>
        <span className="flex items-center gap-1.5">
          {/* The role word is a label and nothing else. It used to be the
              button that handed the seat over — a state word that changed under
              the pointer and, with no hover to reveal it, changed nothing at
              all before acting. The action now has a control of its own. */}
          <span
            title={isPrimary ? t('stage.primaryTitle') : t('stage.promoteTitle')}
            className={`text-xs font-semibold ${
              isPrimary ? ROLE_TEXT_CLASS.primary : ROLE_TEXT_CLASS.mirror
            }`}
          >
            {roleWord}
          </span>
          {!isPrimary && (
            <button
              type="button"
              aria-label={t('stage.promote')}
              title={t('stage.promoteTitle')}
              onClick={onPromote}
              className="pressable hit relative flex h-[18px] w-[18px] flex-none items-center justify-center rounded-full text-text-muted opacity-60 outline-none hover:bg-accent-muted hover:text-accent hover:opacity-100 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-accent/60"
            >
              <span aria-hidden="true" className="text-[11px] leading-none">
                ⇄
              </span>
            </button>
          )}
          {!isPrimary && delay !== 0 && (
            <span className="font-mono text-xs tabular-nums text-text-muted">
              {formatDelaySigned(delay)}
            </span>
          )}
        </span>
      </span>
      {/* Removal is a plan edit like any other: it toggles the row out of the
          selection, and the hub asks the same question it always does. The last
          device cannot leave — a route to zero devices is not a state this app
          offers — so the primary row carries no ✕ at all. */}
      {removable && (
        <button
          type="button"
          title={t('stage.removeTarget', { name: deviceName })}
          // The glyph is the picture, not the name: read as text it is a
          // multiplication sign, so the action has to be said.
          aria-label={t('stage.removeTarget', { name: deviceName })}
          onClick={onRemove}
          className="pressable hit flex h-4 w-4 flex-none items-center justify-center rounded-full border border-line-strong text-[9px] leading-none text-text-muted hover:border-error hover:text-error focus-visible:border-error focus-visible:text-error"
        >
          ✕
        </button>
      )}
    </motion.div>
  );
}

/**
 * The name slot is a fixed stage: the words swap inside it without ever
 * moving the ring or the icon, and nothing on it may be clipped — the blur
 * and the travel spill freely, so overflow is impossible by construction.
 * Names longer than the slot are therefore capped in data, estimated per
 * character width (fullwidth ≈ 1em at 12.5px, everything else ≈ 0.55em),
 * with an ellipsis where the cut happened.
 */
const NAME_SLOT_PX = 106;
const NAME_BUDGET_PX = 96;

function clampHubName(name: string): string {
  let w = 0;
  const chars = Array.from(name);
  for (let i = 0; i < chars.length; i++) {
    const code = chars[i]!.codePointAt(0) ?? 0;
    w += code > 0x2e7f ? 12.5 : 7;
    if (w > NAME_BUDGET_PX) return `${chars.slice(0, i).join('')}…`;
  }
  return name;
}

/**
 * The hub's programme name, swapping character by character when the programme
 * changes. The old word dips for a beat, then lifts away up, smaller, fainter
 * and blurring; the new word arrives from below and settles with a slight
 * overshoot — anticipation before the move, follow-through after it
 * (`charSwapTransitions` in lib/motion.ts owns the timings). Each character is
 * its own box; the slot itself is fixed (`NAME_SLOT_PX`) and clips nothing, so
 * both the blur and the travel stay whole — the slot's other occupant, the
 * arriving word, owns the layout while the departing word rides over it as an
 * absolutely positioned ghost sharing the slot's centre, so every name — long
 * or short — lives at the same fixed position and the row never moves. A
 * rapid re-selection cuts the previous ghost where it stands rather than
 * queueing it.
 *
 * The swap itself lives in the parent (`nameSwap`) — the hub card remounts on
 * every programme switch, and a swap held here would be reset by the very
 * switch it describes. Held one level up, this component may mount fresh mid-
 * swap and still play it: ghost and arrivals start from their keyframes either
 * way. `swapKey === 0` is the board's first landing, which renders in place.
 */
function CharSwapText({
  text,
  prev,
  swapKey,
}: {
  text: string;
  prev: string | null;
  swapKey: number;
}) {
  const chars = Array.from(text);
  const prevChars = prev === null ? null : Array.from(prev);
  const first = swapKey === 0;
  return (
    <span
      className="relative inline-block h-[17px] text-[12.5px] font-bold leading-none text-text-primary"
      style={{ width: NAME_SLOT_PX }}
    >
      <span className="flex h-full items-center justify-center">
        {chars.map((ch, i) => {
          const { enter } = charSwapTransitions(i, chars.length);
          return (
            <motion.span
              key={`${swapKey}:${i}`}
              initial={first ? false : { y: 9, scale: 0.9, opacity: 0, filter: 'blur(3px)' }}
              animate={{
                y: first ? 0 : [9, -2, 0],
                scale: first ? 1 : [0.9, 1.03, 1],
                opacity: first ? 1 : [0, 1, 1],
                filter: first ? 'blur(0px)' : ['blur(3px)', 'blur(0.5px)', 'blur(0px)'],
              }}
              transition={enter}
              transformTemplate={MAIN_THREAD_TRANSFORM}
              className="inline-block whitespace-pre leading-none"
            >
              {ch}
            </motion.span>
          );
        })}
      </span>
      {prevChars !== null && (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 flex items-center justify-center"
        >
          {prevChars.map((ch, i) => {
            const { exit } = charSwapTransitions(i, prevChars.length);
            return (
              <motion.span
                key={`g:${swapKey}:${i}`}
                initial={{ y: 0, scale: 1, opacity: 1, filter: 'blur(0px)' }}
                animate={{
                  y: [0, 2.5, -11],
                  scale: [1, 0.985, 0.86],
                  opacity: [1, 0.9, 0],
                  filter: ['blur(0px)', 'blur(1.5px)', 'blur(3px)'],
                }}
                transition={exit}
                transformTemplate={MAIN_THREAD_TRANSFORM}
                className="inline-block whitespace-pre leading-none"
              >
                {ch}
              </motion.span>
            );
          })}
        </span>
      )}
    </span>
  );
}

/**
 * One programme the hub's sound is fed into. Amber, immediate to read, and
 * honest about what is missing. The row is the plan: staged with the picker,
 * connected by the hub, and taken back out by the hub after its ✕ stages the
 * removal — the same two beats a device row plays, and no undo card beside
 * them.
 */
function FeedRow({
  session,
  landed,
  state,
  index,
  top,
  sourceName,
  onRemove,
  onHover,
}: {
  session: AudioSession;
  /** Whether this planned feed is already connected. A staged one reads as
   *  the proposal it is; its three honest states only mean something once the
   *  hub has landed it. */
  landed: boolean;
  state: 'live' | 'suspended' | 'no-carrier';
  index: number;
  top: number;
  sourceName: string;
  onRemove: () => void;
  onHover: (key: string | null) => void;
}) {
  const { t } = useTranslation();
  const targetName = session.display_name ?? session.exe_name;
  const title = !landed
    ? t('stage.feedTitlePlanned', { name: targetName })
    : state === 'live'
      ? t('stage.feedTitleLive', { name: targetName })
      : state === 'suspended'
        ? t('stage.feedTitleSuspended', { source: sourceName, name: targetName })
        : t('stage.feedTitleNoCarrier', { name: targetName });
  const stateWord =
    !landed || state === 'live'
      ? t('stage.feedRole')
      : state === 'suspended'
        ? t('stage.feedHeld')
        : t('stage.feedNoCarrier');

  return (
    <motion.div
      data-feed-row={session.pid}
      // Same seat-taking entrance the device rows carry: it grows out of the
      // edge the amber wire meets, pin first, line never chasing.
      initial={{ opacity: 0, scaleX: 0.94 }}
      animate={{ opacity: 1, scaleX: 1 }}
      transition={SPRING_TAP}
      transformTemplate={MAIN_THREAD_TRANSFORM}
      onMouseEnter={() => onHover(`feed:${session.pid}`)}
      onMouseLeave={() => onHover(null)}
      title={title}
      className={`absolute flex items-center gap-2 rounded-ctl bg-surface pl-3 pr-2 ${landed && state !== 'live' ? 'opacity-90' : ''}`}
      style={{ left: GROUP_PAD, top, width: ROW_W, height: ROW_H, transformOrigin: 'left center' }}
    >
      <span className="pin pin-in pin-amber" aria-hidden="true" />
      <span className="no" aria-hidden="true">
        {orderLabel(index)}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-center gap-1.5">
          <ProcessIcon
            exeName={session.exe_name}
            name={session.display_name ?? session.exe_name}
            size={15}
          />
          <span className="truncate text-[12px] font-bold text-text-primary">{targetName}</span>
        </span>
        <span className="flex items-center gap-1">
          <span
            className={`text-xs font-semibold ${ROLE_TEXT_CLASS.feed} ${state !== 'live' ? 'opacity-60' : ''}`}
          >
            {stateWord}
          </span>
          <span className="truncate text-xs text-text-muted">{t('stage.feedInputSuffix')}</span>
        </span>
      </span>
      <button
        type="button"
        title={t('stage.removeFeed', { name: targetName })}
        aria-label={t('stage.removeFeed', { name: targetName })}
        onClick={onRemove}
        className="pressable hit flex h-4 w-4 flex-none items-center justify-center rounded-full border border-line-strong text-[9px] leading-none text-text-muted hover:border-error hover:text-error focus-visible:border-error focus-visible:text-error"
      >
        ✕
      </button>
    </motion.div>
  );
}

/**
 * The arrows a `role=menu` promises.
 *
 * The rows are real buttons, so `Tab` already reaches every one of them — but a
 * device list walked one Tab press per device is not walked, and the board's own
 * `Select` (settings) answers the arrows. Focus moves rather than a highlight,
 * so the browser scrolls the row into view by itself.
 */
function walkPickerMenu(event: React.KeyboardEvent<HTMLDivElement>): void {
  const rows = Array.from(
    event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
  );
  if (rows.length === 0) return;
  const current = rows.findIndex((row) => row === document.activeElement);
  let next: number | null = null;
  if (event.key === 'ArrowDown') next = current < 0 ? 0 : (current + 1) % rows.length;
  else if (event.key === 'ArrowUp')
    next = current < 0 ? rows.length - 1 : (current - 1 + rows.length) % rows.length;
  else if (event.key === 'Home') next = 0;
  else if (event.key === 'End') next = rows.length - 1;
  if (next === null) return;
  event.preventDefault();
  rows[next]?.focus();
}

/** One section of the add-destination picker. `section` is the stable hook the
 *  end-to-end specs scope a row to: the same device can appear in more than one
 *  section, and "which one did you mean" is the question the sections answer. */
function PickerSection({
  label,
  section,
  children,
}: {
  label: string;
  section: string;
  children: React.ReactNode;
}) {
  return (
    <div data-picker-section={section} className="mb-0.5 last:mb-0">
      <div className="px-2 pb-1 pt-1.5 text-xs font-semibold uppercase tracking-[0.08em] text-text-muted">
        {label}
      </div>
      <div className="flex flex-col">{children}</div>
    </div>
  );
}

function PickerEmpty({ text }: { text: string }) {
  return <div className="px-2.5 py-1.5 text-[11px] text-text-muted">{text}</div>;
}

/**
 * One figure in the strip, as the shared scrub control.
 *
 * The same number the settings page and the level ring read with: drag it,
 * wheel it, arrow-key it, or click it and type. The strip used to offer two
 * 16px ± buttons and nothing else — twenty clicks to take a copy from 100% to
 * silence, and a different vocabulary from every other figure in the app.
 */
function StripValue({
  kind,
  label,
  title,
  value,
  min,
  max,
  step,
  format,
  unit,
  neutral,
  ariaLabel,
  stepLabels,
  onCommit,
}: {
  /** Which lever this is — the hook the specs address it by. */
  kind: 'primary' | 'delay' | 'share';
  label: string;
  title?: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format: (value: number) => string;
  unit: string;
  neutral: boolean;
  ariaLabel: string;
  stepLabels: { up: string; down: string };
  onCommit: (value: number) => void;
}) {
  return (
    <div data-strip-value={kind} className="flex items-center gap-2.5" title={title}>
      <span className="text-xs text-text-secondary">{label}</span>
      <ScrubReadout
        value={value}
        min={min}
        max={max}
        step={step}
        format={format}
        unit={unit}
        label={ariaLabel}
        hint={stepLabels.up}
        neutral={neutral}
        onCommit={onCommit}
      />
    </div>
  );
}

/** The bottom strip of the board: the levers that exist for the clicked row.
 *  It is only mounted while a row is picked — the caller decides that — so
 *  everything here may assume the row it names is on the plan. */
function Inspector({
  inspectorKey,
  onClear,
  drawn,
  deviceLatencyMs,
}: {
  inspectorKey: InspectorKey;
  onClear: () => void;
  drawn: string[];
  deviceLatencyMs: Record<string, number>;
}) {
  const { t } = useTranslation();
  const devices = useRouterStore((s) => s.devices);
  const sessions = useRouterStore((s) => s.sessions);
  const selectedPids = useRouterStore((s) => s.selectedPids);
  const deviceDelays = useRouterStore((s) => s.deviceDelays);
  const delayStepMs = useRouterStore((s) => s.delayStepMs);
  const deviceVolumes = useRouterStore((s) => s.deviceVolumes);
  const primaryVolumes = useRouterStore((s) => s.primaryVolumes);
  const setPrimaryVolume = useRouterStore((s) => s.setPrimaryVolume);
  const setDeviceVolume = useRouterStore((s) => s.setDeviceVolume);
  const setDeviceDelayValue = useRouterStore((s) => s.setDeviceDelayValue);

  const exeName = sessions.find((s) => s.pid === selectedPids[0])?.exe_name;
  const deviceId = inspectorKey.slice(4);
  const device = devices.find((d) => d.id === deviceId);
  // A staged device that has left `devices` is named as one that has left, not
  // by its GUID — the strip speaks to the user, and between two refreshes the
  // honest sentence is "this one is gone", not an unreadable identifier.
  const deviceLabel = device?.name ?? t('stage.deviceGone');
  // The strip only exists while the plan has copies (`drawn.length > 1`, the
  // caller's guard), so a device at index 0 is the primary and every other one
  // is a copy. A device whose delay is not the group's smallest is still a
  // mirror; the role words below follow the plan's own order.
  const isPrimary = drawn.indexOf(deviceId) === 0;

  let body: React.ReactNode;
  if (isPrimary) {
    const volume = primaryVolumes[exeName ?? ''] ?? 100;
    // The strip keeps painting for as long as its exit animation runs, and by
    // then the program it tunes may have left the session list. Writing through
    // an empty key would land in the user's config as a rule no process matches.
    const stepPrimary = (percent: number) => {
      if (exeName === undefined) return;
      void setPrimaryVolume(exeName, percent);
    };
    body = (
      <>
        <div className="flex items-center gap-2.5">
          <Ring tone="main" size={14} />
          <span>
            <span className="block text-[12.5px] font-bold">{deviceLabel}</span>
            <span className="text-xs text-text-muted">{t('stage.main')}</span>
          </span>
        </div>
        <StripValue
          kind="primary"
          label={t('stage.stripPrimaryVolume')}
          title={t('primaryVolume.hint')}
          value={volume}
          min={PRIMARY_VOLUME_MIN}
          max={PRIMARY_VOLUME_MAX}
          step={5}
          format={(v) => `${v}%`}
          unit=""
          neutral={volume === 100}
          ariaLabel={t('primaryVolume.hint')}
          stepLabels={{
            up: t('primaryVolume.stepUp', { step: '5%' }),
            down: t('primaryVolume.stepDown', { step: '5%' }),
          }}
          onCommit={(next) => stepPrimary(next)}
        />
        <span className="text-xs text-text-muted">{t('stage.stripPrimaryNote')}</span>
      </>
    );
  } else {
    const delay = deviceDelays[deviceId] ?? 0;
    const share = deviceVolumes[deviceId] ?? 100;
    const latency = deviceLatencyMs[deviceId];
    body = (
      <>
        <div className="flex items-center gap-2.5">
          <Ring tone="copy" size={14} />
          <span>
            <span className="block text-[12.5px] font-bold">{deviceLabel}</span>
            <span className="text-xs text-text-muted">{t('stage.copy')}</span>
          </span>
        </div>
        <StripValue
          kind="delay"
          label={t('stage.stripDelay')}
          title={
            latency !== undefined
              ? t('deviceLatency.reading', { ms: latency })
              : t('deviceDelay.valueLabel', { device: deviceLabel })
          }
          value={delay}
          min={-DELAY_MAX_MS}
          max={DELAY_MAX_MS}
          step={delayStepMs}
          format={(v) => formatDelaySigned(v)}
          unit="ms"
          neutral={delay === 0}
          ariaLabel={t('deviceDelay.valueLabel', { device: deviceLabel })}
          stepLabels={{
            up: t('deviceDelay.stepUp', { step: formatStep(delayStepMs) }),
            down: t('deviceDelay.stepDown', { step: formatStep(delayStepMs) }),
          }}
          onCommit={(next) => void setDeviceDelayValue(deviceId, clampDelay(next))}
        />
        <StripValue
          kind="share"
          label={t('stage.stripShare')}
          title={t('deviceVolume.valueLabel', { device: deviceLabel })}
          value={share}
          min={0}
          max={100}
          step={5}
          format={(v) => `${v}%`}
          unit=""
          neutral={share === 100}
          ariaLabel={t('deviceVolume.valueLabel', { device: deviceLabel })}
          stepLabels={{
            up: t('deviceVolume.stepUp', { step: '5%' }),
            down: t('deviceVolume.stepDown', { step: '5%' }),
          }}
          onCommit={(next) => void setDeviceVolume(deviceId, next)}
        />
      </>
    );
  }

  return (
    <div
      data-tuner-strip
      className="flex flex-none items-center gap-4 overflow-x-auto border-t border-line px-4 py-2.5"
    >
      <button
        type="button"
        onClick={onClear}
        className="pressable hit flex h-5 w-5 flex-none items-center justify-center rounded-full text-xs text-text-muted hover:bg-surface-hover hover:text-text-primary focus-visible:bg-surface-hover focus-visible:text-text-primary"
        title={t('stage.inspectClear')}
        aria-label={t('stage.inspectClear')}
      >
        ✕
      </button>
      {body}
      {/* A primary delay reading would describe a stream that does not exist:
          the system plays this device itself. The strip says so in words. */}
      {isPrimary && (
        <span className="text-xs text-text-muted">{t('stage.stripPrimaryLatency')}</span>
      )}
    </div>
  );
}
