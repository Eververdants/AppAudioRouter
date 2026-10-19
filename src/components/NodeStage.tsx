import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import type { Variants } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { SourceLevelDial } from '@/components/SourceLevelDial';
import { ProcessIcon } from '@/components/ui/ProcessIcon';
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
 * otherwise run out past the panel's edge and point at nothing.
 *
 * The board is a proposal, exactly as the ring stage was: rows toggle
 * membership in the plan, and the hub — which wears a "click to apply" capsule
 * whenever the plan is not yet the truth — lands it. Feeds are the exception,
 * because their endpoint pair is theirs alone: they connect and disconnect
 * immediately, with the toast carrying the way back.
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
  const routedPids = useRouterStore((s) => s.routedPids);
  // The route read by the process being drawn: a sibling process of a routed
  // program carries the same route as the one holding it, so selecting one
  // reports the program as answered instead of proposing what is already on.
  const routesByPid = useProgramRoutes();
  const deviceDelays = useRouterStore((s) => s.deviceDelays);
  const deviceLatencyMs = useRouterStore((s) => s.deviceLatencyMs);
  const feeds = useRouterStore((s) => s.feeds);
  const feedCarrier = useRouterStore((s) => s.feedCarrier);
  const applying = useRouterStore((s) => s.applying);
  const toggleDeviceSelection = useRouterStore((s) => s.toggleDeviceSelection);
  const appendDeviceTarget = useRouterStore((s) => s.appendDeviceTarget);
  const setPrimaryDevice = useRouterStore((s) => s.setPrimaryDevice);
  const promoteDevice = useRouterStore((s) => s.promoteDevice);
  const applyRoute = useRouterStore((s) => s.applyRoute);
  const addFeed = useRouterStore((s) => s.addFeed);
  const removeFeed = useRouterStore((s) => s.removeFeed);
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
  const answered = alreadyApplied(drawn, selectedPids, routesByPid);
  const canApply = pid !== undefined && drawn.length > 0 && !answered && !applying;
  const hasPlan = drawn.length > 0;

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
  // A machine Windows reports no render endpoint for must not be told its plan
  // is already full — "nothing left to add" reads as a finished action, and
  // there was nothing to act on.
  const devicePickerEmpty = devices.length === 0 ? t('stage.pickNoDevices') : t('stage.pickNone');

  // The wires move only when what is drawn is what is playing — a plan waiting
  // for the hub is a proposal, and a proposal does not hum.
  const flowing = sounding && answered && liveness;
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
    return Object.entries(feeds)
      .filter(([, targets]) => targets.includes(pid))
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

  /** Programmes the hub feeds, as sessions in feed order. */
  const feedTargets = useMemo(() => {
    if (pid === undefined) return [];
    // A feed is keyed by the process that holds it — one per program, like a
    // route — so a sibling process of the source resolves to it first.
    const owner = programEntryOf(sessions, feeds, pid);
    if (owner === undefined) return [];
    return (feeds[owner] ?? [])
      .map((targetPid) => sessions.find((s) => s.pid === targetPid))
      .filter((s) => s !== undefined);
  }, [feeds, sessions, pid]);

  // The board is as tall as the well it sits in, and no taller: that is the
  // whole reason the stage never scrolls. Until the well has reported a height
  // (the very first frame), the app's own default window stands in.
  const height = measured > 0 ? Math.floor(measured) : BOARD_H;
  const feedTargetStates = feedTargets.map((targetSession) => ({
    session: targetSession,
    state: feedLiveness(pid ?? -1, feedCarrier, routedPids, sessions),
  }));
  /** Every row in the copies panel: the copies first, then the feeds. */
  const copiesRows = copyDeviceIds.length + feedTargetStates.length;
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
  useEffect(() => {
    if (!pickerOpen && !primaryPickerOpen) return;
    const closePickers = () => {
      setPickerOpen(false);
      setPrimaryPickerOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        closePickers();
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
      closePickers();
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('pointerdown', onPointerDown, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('pointerdown', onPointerDown, true);
    };
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
  const feedSig = feedTargetStates.map((f) => f.session.pid).join(',');
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
  feedTargetStates.forEach(({ session: targetSession, state }, offset) => {
    const index = copyDeviceIds.length + offset;
    if (!rowVisible(column.copiesY, column.copiesHeight, index, copyScroll)) return;
    const to = rowInPort(column.copiesY, index, copyScroll);
    wires.push({
      key: `feed:${targetSession.pid}`,
      d: nodePath(from.x, from.y, to.x, to.y),
      live: flowing && state === 'live',
    });
  });
  // Feeders → hub.
  feeders.forEach((feeder, index) => {
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
        feedLiveness(feeder.pid, feedCarrier, routedPids, sessions) === 'live',
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
  // answer, not just the primary.
  const targets = drawn.map((id) => devices.find((d) => d.id === id)?.name ?? id).join(' + ');
  const applyAria =
    selectedPids.length > 1
      ? t('stage.applyAriaMany', { n: selectedPids.length, device: targets })
      : t('stage.applyAriaOne', {
          process: name ?? '',
          device: targets,
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
            {wires.map((wire) => (
              <path
                key={wire.key}
                data-wire={wire.key.startsWith('dev:') ? `${pid}:${wire.key.slice(4)}` : undefined}
                data-live={wire.live ? 'true' : undefined}
                d={wire.d}
                // A proposal wire draws itself once, out of the hub's pin; the
                // `pathLength` normalization is what lets one fixed dasharray
                // cover a path of any shape. A flowing wire never carries the
                // attribute — a normalized length would rescale the flow's own
                // dash pattern into a solid line — so it leaves the moment the
                // route lands, together with the class.
                pathLength={wire.live ? undefined : 1}
                // `live` is the route carrying sound right now, and that alone
                // is what the moving dash reports. `lit` is the cursor, and only
                // brightens the line: gating the flow on it made the animation
                // unreachable in the steady state it describes, because a wire
                // you are not hovering over was a still line even while playing.
                className={`nwire ${wire.live ? 'stage-flow' : 'stage-draw'} ${
                  lit(wire.key) ? 'lit' : ''
                }`}
              />
            ))}
          </svg>

          {/* Feeders: the programmes sending sound into the hub. A click walks
              to that programme's own board — the graph answers one programme at
              a time, and this is the door between them. */}
          {feeders.map((feeder, index) => {
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
                <span className="w-full truncate pl-[22px] text-[9.5px] text-text-muted">
                  {t('stage.feederSub', { target: name ?? '' })}
                </span>
              </motion.button>
            );
          })}

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
              aria-label={canApply ? applyAria : undefined}
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
                  as a constant `x`. */}
              <AnimatePresence initial={false}>
                {canApply && (
                  <motion.span
                    key="apply-hint"
                    initial={{ opacity: 0, x: '-50%', y: -4, scale: 0.9 }}
                    animate={{ opacity: 1, x: '-50%', y: 0, scale: 1 }}
                    exit={{ opacity: 0, x: '-50%', y: -3, scale: 0.96 }}
                    transition={SPRING_TAP}
                    transformTemplate={MAIN_THREAD_TRANSFORM}
                    className="absolute -top-3 left-1/2 whitespace-nowrap rounded-full bg-accent px-2.5 py-0.5 text-[10px] font-semibold text-accent-ink"
                  >
                    {t('stage.applyHint')}
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
                  tone={hasPlan || feedTargetStates.length > 0 ? 'main' : 'idle'}
                  size={16}
                  live={sounding && liveness}
                  className="ml-0.5"
                />
              </span>
              <span className="text-[9.5px] text-text-muted">
                {applying && (
                  <Spinner size={10} className="mr-1 inline-block align-[-1px] text-accent" />
                )}
                {sounding ? t('stage.sounding') : t('stage.quiet')}
                {feedTargetStates.length > 0 && (
                  <span className="text-type-feed">
                    {' '}
                    · {t('stage.feedCount', { n: feedTargetStates.length })}
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
                deviceName={devices.find((d) => d.id === primaryDeviceId)?.name ?? primaryDeviceId}
                index={0}
                top={rowContentY(0) - ROW_H / 2}
                isPrimary
                delay={0}
                badgeIsButton={badgeIsButton}
                removable={false}
                inspected={inspectorKey === `dev:${primaryDeviceId}`}
                onToggle={() => toggleTarget(primaryDeviceId)}
                onRemove={() => undefined}
                onPromote={() => undefined}
                onPrimaryPick={() => setPrimaryPickerOpen((value) => !value)}
                onInspect={() => setInspectorKey(`dev:${primaryDeviceId}`)}
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
            revealIndex={revealIndex}
            onRevealed={clearReveal}
            headerAction={
              <button
                type="button"
                data-owns-picker
                aria-label={t('stage.addTarget')}
                title={t('stage.addTargetTitle')}
                onClick={() => setPickerOpen((value) => !value)}
                className="pressable flex h-[18px] w-[18px] flex-none items-center justify-center rounded-full border border-dashed border-line-strong text-[11px] leading-none text-text-muted hover:border-accent/60 hover:text-accent focus-visible:border-accent focus-visible:outline-none"
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
                  deviceName={devices.find((d) => d.id === deviceId)?.name ?? deviceId}
                  index={offset + 1}
                  top={rowContentY(offset) - ROW_H / 2}
                  isPrimary={false}
                  delay={delay}
                  badgeIsButton={badgeIsButton}
                  removable
                  inspected={inspectorKey === `dev:${deviceId}`}
                  onToggle={() => toggleTarget(deviceId)}
                  onRemove={() => toggleTarget(deviceId)}
                  onPromote={() => promoteDevice(deviceId)}
                  onInspect={() => setInspectorKey(`dev:${deviceId}`)}
                  onHover={setHoverKey}
                />
              );
            })}
            {feedTargetStates.map(({ session: targetSession, state }, offset) => (
              <FeedRow
                key={targetSession.pid}
                session={targetSession}
                state={state}
                index={copyDeviceIds.length + offset + 1}
                top={rowContentY(copyDeviceIds.length + offset) - ROW_H / 2}
                sourceName={name ?? ''}
                onRemove={() => void removeFeed(pid ?? -1, targetSession.pid)}
                onHover={setHoverKey}
              />
            ))}
          </Panel>

          <AnimatePresence>
            {pickerOpen && (
              <motion.div
                key="picker"
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
                  <PickerSection label={t('stage.pickDevice')}>
                    {addableDevices.length === 0 && <PickerEmpty text={devicePickerEmpty} />}
                    {addableDevices.map((d) => (
                      <motion.button
                        key={d.id}
                        type="button"
                        role="menuitem"
                        variants={PICKER_ITEM_VARIANTS}
                        transformTemplate={MAIN_THREAD_TRANSFORM}
                        onClick={() => {
                          // Append, never toggle: "add" has to leave the plan's
                          // membership alone and put the new device on the tail.
                          // The seat it ends up in is the delay order's call,
                          // exactly as for any other row.
                          appendDeviceTarget(d.id);
                          setPickerOpen(false);
                        }}
                        className="pressable w-full rounded-seg px-2.5 py-1.5 text-left text-[12px] text-text-secondary hover:bg-surface-hover hover:text-text-primary"
                      >
                        {d.name}
                      </motion.button>
                    ))}
                  </PickerSection>
                  <PickerSection label={t('stage.pickFeed')}>
                    {sessions.filter(
                      (s) =>
                        s.pid !== pid &&
                        s.exe_name.toLowerCase() !== (session?.exe_name ?? '').toLowerCase() &&
                        !feedTargetStates.some((f) => f.session.pid === s.pid),
                    ).length === 0 && <PickerEmpty text={t('stage.pickNone')} />}
                    {sessions
                      .filter(
                        (s) =>
                          s.pid !== pid &&
                          s.exe_name.toLowerCase() !== (session?.exe_name ?? '').toLowerCase() &&
                          !feedTargetStates.some((f) => f.session.pid === s.pid),
                      )
                      .map((s) => (
                        <motion.button
                          key={s.pid}
                          type="button"
                          role="menuitem"
                          variants={PICKER_ITEM_VARIANTS}
                          transformTemplate={MAIN_THREAD_TRANSFORM}
                          onClick={() => {
                            if (pid !== undefined) void addFeed(pid, s.pid);
                            setPickerOpen(false);
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
                  <PickerSection label={t('stage.pickPrimary')}>
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
                            setPrimaryPickerOpen(false);
                          }}
                          className="pressable flex w-full items-center gap-2 rounded-seg px-2.5 py-1.5 text-left text-[12px] text-text-secondary outline-none hover:bg-surface-hover hover:text-text-primary focus-visible:bg-surface-hover focus-visible:text-text-primary"
                        >
                          <span
                            className={`flex h-3 w-3 flex-none items-center justify-center text-[10px] ${
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
              onClear={() => setInspectorKey(null)}
              drawn={drawn}
              deviceLatencyMs={deviceLatencyMs}
            />
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
  // has just come to rest at its new bottom.
  useEffect(() => {
    setScrollTop(scrollRef.current?.scrollTop ?? 0);
  }, [rows, bodyHeight]);
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
    if (next !== el.scrollTop) el.scrollTop = next;
    onRevealed?.();
  }, [revealIndex, bodyHeight, contentHeight, onRevealed]);
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
        <span className="truncate text-[10px] font-semibold uppercase tracking-[0.08em] text-text-muted">
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
              className="px-3 py-2.5 text-[10.5px] leading-relaxed text-text-muted"
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
  onToggle,
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
  onToggle: () => void;
  onRemove: () => void;
  onPromote: () => void;
  /** Present on the primary row only: clicking the row opens the picker that
   *  hands the primary seat to another device. */
  onPrimaryPick?: () => void;
  onInspect: () => void;
  onHover: (key: string | null) => void;
}) {
  const { t } = useTranslation();
  const selectedDeviceIds = useRouterStore((s) => s.selectedDeviceIds);
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
          className="no pressable cursor-pointer hover:border-accent hover:text-accent"
          onClick={onInspect}
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
        <button
          type="button"
          // The primary row's name opens the change-primary picker: the press
          // that opens it must not be the press that closes it, so the button
          // is exempt from the outside-close like the pickers themselves.
          data-owns-picker={onPrimaryPick !== undefined ? 'true' : undefined}
          aria-pressed={
            onPrimaryPick === undefined ? selectedDeviceIds.includes(deviceId) : undefined
          }
          aria-label={
            onPrimaryPick === undefined
              ? deviceName
              : t('stage.changePrimaryAria', { name: deviceName })
          }
          title={onPrimaryPick === undefined ? undefined : t('stage.changePrimaryTitle')}
          onClick={onPrimaryPick ?? onToggle}
          className="pressable truncate text-left text-[12px] font-bold text-text-primary outline-none focus-visible:text-accent"
        >
          {deviceName}
        </button>
        <span className="flex items-center gap-1.5">
          {isPrimary ? (
            onPrimaryPick === undefined ? (
              <span
                title={t('stage.primaryTitle')}
                className={`text-[10px] font-semibold ${ROLE_TEXT_CLASS.primary}`}
              >
                {roleWord}
              </span>
            ) : (
              // On the board the role word doubles as the way to hand the seat
              // over: it reads "Main" until the pointer or the keyboard arrives,
              // then it offers the move — the same gesture the copies carry.
              <button
                type="button"
                data-owns-picker
                aria-label={t('stage.changePrimary')}
                title={t('stage.changePrimaryTitle')}
                onClick={(event) => {
                  event.stopPropagation();
                  onPrimaryPick();
                }}
                className="pressable group/role text-[10px] font-semibold text-type-primary underline decoration-dotted underline-offset-2 outline-none hover:text-accent focus-visible:text-accent"
              >
                <span className="group-hover/copy:hidden group-focus-visible/role:hidden">
                  {roleWord}
                </span>
                <span className="hidden group-hover/copy:inline group-focus-visible/role:inline">
                  {t('stage.changePrimary')}
                </span>
              </button>
            )
          ) : (
            // The role word itself is the switch: it reads "Copy" until the
            // pointer or the keyboard arrives, then it offers the move. The
            // accessible name is the action, so a screen reader hears the
            // control and not the state.
            <button
              type="button"
              aria-label={t('stage.promote')}
              title={t('stage.promoteTitle')}
              onClick={(event) => {
                event.stopPropagation();
                onPromote();
              }}
              className="pressable group/role text-[10px] font-semibold text-type-mirror underline decoration-dotted underline-offset-2 outline-none hover:text-accent focus-visible:text-accent"
            >
              <span className="group-hover/copy:hidden group-focus-visible/role:hidden">
                {roleWord}
              </span>
              <span className="hidden group-hover/copy:inline group-focus-visible/role:inline">
                {t('stage.promote')}
              </span>
            </button>
          )}
          {!isPrimary && delay !== 0 && (
            <span className="font-mono text-[9.5px] tabular-nums text-text-muted">
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
          onClick={onRemove}
          className="pressable flex h-4 w-4 flex-none items-center justify-center rounded-full border border-line-strong text-[9px] leading-none text-text-muted hover:border-error hover:text-error"
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
 * One programme the hub's sound is fed into. Amber, immediate, and honest
 * about what is missing: the ✕ disconnects at once, the toast carries the way
 * back.
 */
function FeedRow({
  session,
  state,
  index,
  top,
  sourceName,
  onRemove,
  onHover,
}: {
  session: AudioSession;
  state: 'live' | 'suspended' | 'no-carrier';
  index: number;
  top: number;
  sourceName: string;
  onRemove: () => void;
  onHover: (key: string | null) => void;
}) {
  const { t } = useTranslation();
  const targetName = session.display_name ?? session.exe_name;
  const title =
    state === 'live'
      ? t('stage.feedTitleLive', { name: targetName })
      : state === 'suspended'
        ? t('stage.feedTitleSuspended', { source: sourceName, name: targetName })
        : t('stage.feedTitleNoCarrier', { name: targetName });
  const stateWord =
    state === 'live'
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
      className={`absolute flex items-center gap-2 rounded-ctl bg-surface pl-3 pr-2 ${state !== 'live' ? 'opacity-90' : ''}`}
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
            className={`text-[10px] font-semibold ${ROLE_TEXT_CLASS.feed} ${state !== 'live' ? 'opacity-60' : ''}`}
          >
            {stateWord}
          </span>
          <span className="truncate text-[9.5px] text-text-muted">
            {t('stage.feedInputSuffix')}
          </span>
        </span>
      </span>
      <button
        type="button"
        title={t('stage.removeFeed', { name: targetName })}
        onClick={onRemove}
        className="pressable flex h-4 w-4 flex-none items-center justify-center rounded-full border border-line-strong text-[9px] leading-none text-text-muted hover:border-error hover:text-error"
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

/** One section of the add-destination picker. */
function PickerSection({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mb-0.5 last:mb-0">
      <div className="px-2 pb-1 pt-1.5 text-[9.5px] font-semibold uppercase tracking-[0.08em] text-text-muted">
        {label}
      </div>
      <div className="flex flex-col">{children}</div>
    </div>
  );
}

function PickerEmpty({ text }: { text: string }) {
  return <div className="px-2.5 py-1.5 text-[11px] text-text-muted">{text}</div>;
}

/** A − value + row in the strip: one control, said once. The ± buttons carry
 *  the same wording the stage's tuner rows always did, so the vocabulary (and
 *  the tests that look for it) survive the move. */
function StripRow({
  label,
  title,
  value,
  onDown,
  onUp,
  canDown,
  canUp,
  downLabel,
  upLabel,
}: {
  label: string;
  title?: string;
  value: string;
  onDown: () => void;
  onUp: () => void;
  canDown: boolean;
  canUp: boolean;
  downLabel: string;
  upLabel: string;
}) {
  return (
    <div className="rounded-seg" title={title}>
      <span className="text-[10.5px] text-text-secondary">{label}</span>
      <span className="flex items-center gap-1 rounded-seg border border-line-strong px-1 py-0.5">
        <button
          type="button"
          aria-label={downLabel}
          onClick={onDown}
          disabled={!canDown}
          className="pressable flex h-4 w-4 items-center justify-center rounded-full text-[11px] leading-none text-text-muted hover:bg-accent-muted hover:text-accent disabled:opacity-30 disabled:hover:bg-transparent"
        >
          −
        </button>
        {/* The readout rolls a beat on every step: the old number is gone the
            instant the new one lands, and the arrival itself is the only
            animation — a key swap, no cross-fade, so rapid presses read as a
            counting roll rather than as a blur. */}
        <motion.span
          key={value}
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          transition={FADE}
          transformTemplate={MAIN_THREAD_TRANSFORM}
          className="min-w-[44px] text-center font-mono text-[10.5px] tabular-nums text-text-secondary"
        >
          {value}
        </motion.span>
        <button
          type="button"
          aria-label={upLabel}
          onClick={onUp}
          disabled={!canUp}
          className="pressable flex h-4 w-4 items-center justify-center rounded-full text-[11px] leading-none text-text-muted hover:bg-accent-muted hover:text-accent disabled:opacity-30 disabled:hover:bg-transparent"
        >
          ＋
        </button>
      </span>
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
            <span className="block text-[12.5px] font-bold">{device?.name ?? deviceId}</span>
            <span className="text-[9.5px] text-text-muted">{t('stage.main')}</span>
          </span>
        </div>
        <StripRow
          label={t('stage.stripPrimaryVolume')}
          title={t('primaryVolume.hint')}
          value={`${volume}%`}
          onDown={() => stepPrimary(Math.max(PRIMARY_VOLUME_MIN, volume - 5))}
          onUp={() => stepPrimary(Math.min(PRIMARY_VOLUME_MAX, volume + 5))}
          canDown={volume > PRIMARY_VOLUME_MIN}
          canUp={volume < PRIMARY_VOLUME_MAX}
          downLabel={t('primaryVolume.stepDown', { step: '5%' })}
          upLabel={t('primaryVolume.stepUp', { step: '5%' })}
        />
        <span className="text-[10.5px] text-text-muted">{t('stage.stripPrimaryNote')}</span>
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
            <span className="block text-[12.5px] font-bold">{device?.name ?? deviceId}</span>
            <span className="text-[9.5px] text-text-muted">{t('stage.copy')}</span>
          </span>
        </div>
        <StripRow
          label={t('stage.stripDelay')}
          title={
            latency !== undefined
              ? t('deviceLatency.reading', { ms: latency })
              : t('deviceDelay.valueLabel', { device: device?.name ?? deviceId })
          }
          value={`${formatDelaySigned(delay)} ms`}
          onDown={() => void setDeviceDelayValue(deviceId, clampDelay(delay - delayStepMs))}
          onUp={() => void setDeviceDelayValue(deviceId, clampDelay(delay + delayStepMs))}
          canDown={delay > -DELAY_MAX_MS}
          canUp={delay < DELAY_MAX_MS}
          downLabel={t('deviceDelay.stepDown', { step: formatStep(delayStepMs) })}
          upLabel={t('deviceDelay.stepUp', { step: formatStep(delayStepMs) })}
        />
        <StripRow
          label={t('stage.stripShare')}
          title={t('deviceVolume.valueLabel', { device: device?.name ?? deviceId })}
          value={`${share}%`}
          onDown={() => void setDeviceVolume(deviceId, Math.max(0, share - 5))}
          onUp={() => void setDeviceVolume(deviceId, Math.min(100, share + 5))}
          canDown={share > 0}
          canUp={share < 100}
          downLabel={t('deviceVolume.stepDown', { step: '5%' })}
          upLabel={t('deviceVolume.stepUp', { step: '5%' })}
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
        className="pressable flex h-5 w-5 flex-none items-center justify-center rounded-full text-[10.5px] text-text-muted hover:bg-surface-hover hover:text-text-primary"
        title={t('stage.inspectClear')}
        aria-label={t('stage.inspectClear')}
      >
        ✕
      </button>
      {body}
      {/* A primary delay reading would describe a stream that does not exist:
          the system plays this device itself. The strip says so in words. */}
      {isPrimary && (
        <span className="text-[10.5px] text-text-muted">{t('stage.stripPrimaryLatency')}</span>
      )}
    </div>
  );
}
