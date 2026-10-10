import { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { SourceLevelDial } from '@/components/SourceLevelDial';
import { ProcessIcon } from '@/components/ui/ProcessIcon';
import { Ring } from '@/components/ui/Ring';
import { Spinner } from '@/components/ui/Spinner';
import { useElementHeight } from '@/hooks/useElementHeight';
import { useLiveness } from '@/hooks/useLiveness';
import { useProgramRoutes } from '@/hooks/useProgramRoutes';
import { clampDelay, formatDelaySigned, formatStep, orderByDelay } from '@/lib/delay';
import { FADE, MAIN_THREAD_TRANSFORM, SPRING_GLIDE, SPRING_TAP } from '@/lib/motion';
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
  const soundingPids = useRouterStore((s) => s.soundingPids);
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
  const boardRef = useRef<HTMLDivElement | null>(null);
  const wellRef = useRef<HTMLDivElement | null>(null);
  const measured = useElementHeight(wellRef);

  const pid = selectedPids[0];
  const session = sessions.find((s) => s.pid === pid);
  const name = session?.display_name ?? session?.exe_name;
  const drawn = orderByDelay(selectedDeviceIds, deviceDelays);
  const answered = alreadyApplied(drawn, selectedPids, routesByPid);
  const canApply = pid !== undefined && drawn.length > 0 && !answered && !applying;
  const sounding = pid !== undefined && soundingPids[pid] === true;
  const hasPlan = drawn.length > 0;

  const primaryDeviceId = drawn[0];
  const copyDeviceIds = drawn.slice(1);

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

  // Escape closes a picker; registered only while one is open, so a standing
  // listener never swallows the search box's Escape (the same rule the
  // briefing bubble follows).
  useEffect(() => {
    if (!pickerOpen && !primaryPickerOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        setPickerOpen(false);
        setPrimaryPickerOpen(false);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [pickerOpen, primaryPickerOpen]);

  useEffect(() => {
    if (!pickerOpen && !primaryPickerOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (boardRef.current !== null && !boardRef.current.contains(event.target as Node)) {
        setPickerOpen(false);
        setPrimaryPickerOpen(false);
      }
    };
    // The picker lives inside the board, so the outside-close only has to watch
    // for clicks that land outside the whole board; clicks inside land on the
    // picker's own rows or the title-row button that toggles it.
    window.addEventListener('pointerdown', onPointerDown, true);
    return () => window.removeEventListener('pointerdown', onPointerDown, true);
  }, [pickerOpen, primaryPickerOpen]);

  // Selecting a different programme resets the inspector to the card that is
  // actually on screen — a key naming last programme's device must not survive —
  // and puts the copies panel back at the top, where it always starts.
  useEffect(() => {
    setInspectorKey(null);
    setPickerOpen(false);
    setPrimaryPickerOpen(false);
    setHoverKey(null);
    setCopyScroll(0);
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
        soundingPids[feeder.pid] === true &&
        liveness &&
        feedLiveness(feeder.pid, feedCarrier, routedPids, sessions) === 'live',
    });
  });

  const lit = (key: string): boolean =>
    hoverKey === 'hub' && !key.startsWith('feeder:') ? true : hoverKey === key;

  const primaryDelay = primaryDeviceId !== undefined ? (deviceDelays[primaryDeviceId] ?? 0) : 0;

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
      <div ref={wellRef} className="min-h-0 flex-1 overflow-x-auto overflow-y-hidden bg-surface-sunken">
        <div
          ref={boardRef}
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
                // `live` is the route carrying sound right now, and that alone
                // is what the moving dash reports. `lit` is the cursor, and only
                // brightens the line: gating the flow on it made the animation
                // unreachable in the steady state it describes, because a wire
                // you are not hovering over was a still line even while playing.
                className={`nwire${wire.live ? ' stage-flow' : ''}${lit(wire.key) ? 'lit' : ''}`}
              />
            ))}
          </svg>

          {/* Feeders: the programmes sending sound into the hub. A click walks
              to that programme's own board — the graph answers one programme at
              a time, and this is the door between them. */}
          {feeders.map((feeder, index) => {
            const feederName = feeder.display_name ?? feeder.exe_name;
            return (
              <motion.button
                key={feeder.pid}
                type="button"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={FADE}
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
                }}
              >
                <span className="pin pin-out" aria-hidden="true" />
                <span className="flex w-full items-center gap-2">
                  <Ring
                    tone="idle"
                    size={12}
                    live={soundingPids[feeder.pid] === true && liveness}
                  />
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
              whileTap={canApply ? { scaleX: 1.02, scaleY: 0.98 } : undefined}
              transformTemplate={MAIN_THREAD_TRANSFORM}
              transition={SPRING_TAP}
              className={`${CARD_CLASS} ${
                canApply
                  ? 'cursor-pointer border-accent/60 hover:border-accent focus-visible:border-accent'
                  : 'cursor-default'
              } flex flex-col items-center justify-center gap-1 px-4 text-center focus-visible:outline-none`}
              style={{ left: HUB_X, top: hubY, width: HUB_W, height: HUB_H }}
            >
              {canApply && (
                <span className="absolute -top-3 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full bg-accent px-2.5 py-0.5 text-[10px] font-semibold text-accent-ink">
                  {t('stage.applyHint')}
                </span>
              )}
              <span className="flex items-center gap-2">
                <Ring
                  tone={hasPlan || feedTargetStates.length > 0 ? 'main' : 'idle'}
                  size={16}
                  live={sounding && liveness}
                />
                <ProcessIcon exeName={session.exe_name} name={name ?? session.exe_name} size={18} />
                <AnimatePresence mode="wait" initial={false}>
                  <motion.span
                    key={name ?? ''}
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={FADE}
                    transformTemplate={MAIN_THREAD_TRANSFORM}
                    className="max-w-[110px] truncate text-[12.5px] font-bold text-text-primary"
                  >
                    {name}
                  </motion.span>
                </AnimatePresence>
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
              kept it: multi-device routes only, program-scoped. */}
          {session !== undefined && drawn.length > 1 && (
            <div
              className="absolute flex justify-center"
              style={{ left: HUB_X - 40, top: hubY + HUB_H + 12, width: HUB_W + 80 }}
            >
              <SourceLevelDial
                exeName={session.exe_name}
                displayName={session.display_name ?? undefined}
              />
            </div>
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
                canPromote={false}
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
            headerAction={
              <button
                type="button"
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
              const canPromote = drawn.length > 1 && delay <= primaryDelay;
              return (
                <DeviceRow
                  key={deviceId}
                  deviceId={deviceId}
                  deviceName={devices.find((d) => d.id === deviceId)?.name ?? deviceId}
                  index={offset + 1}
                  top={rowContentY(offset) - ROW_H / 2}
                  isPrimary={false}
                  canPromote={canPromote}
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
                aria-label={t('stage.addTarget')}
                initial={{ opacity: 0, y: 6, scale: 0.98 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: 4 }}
                transition={SPRING_GLIDE}
                transformTemplate={MAIN_THREAD_TRANSFORM}
                className="cc absolute z-30 w-[230px] rounded-card border border-line-strong bg-surface p-1.5"
                style={{
                  left: Math.min(GROUP_X - 40, BOARD_W - 250),
                  top: Math.min(column.copiesY + GROUP_HEADER_H + 8, height - 190),
                }}
              >
                <PickerSection label={t('stage.pickDevice')}>
                  {devices.filter((d) => !drawn.includes(d.id)).length === 0 && (
                    <PickerEmpty text={t('stage.pickNone')} />
                  )}
                  {devices
                    .filter((d) => !drawn.includes(d.id))
                    .map((d) => (
                      <button
                        key={d.id}
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          // Append, never toggle: reaching for "add" must put a
                          // copy on the plan's tail, not take the primary seat.
                          appendDeviceTarget(d.id);
                          setPickerOpen(false);
                        }}
                        className="pressable w-full rounded-seg px-2.5 py-1.5 text-left text-[12px] text-text-secondary hover:bg-surface-hover hover:text-text-primary"
                      >
                        {d.name}
                      </button>
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
                      <button
                        key={s.pid}
                        type="button"
                        role="menuitem"
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
                      </button>
                    ))}
                </PickerSection>
              </motion.div>
            )}
          </AnimatePresence>

          {/* The change-primary picker: the way to hand the primary seat to
              another device without touching the copies. A device whose delay
              compensation is larger than the rest is offered disabled — the
              system plays the main device directly, and software delay can only
              hold sound back, so it could never take that seat. */}
          <AnimatePresence>
            {primaryPickerOpen && (
              <motion.div
                key="primary-picker"
                role="menu"
                aria-label={t('stage.changePrimary')}
                initial={{ opacity: 0, y: 6, scale: 0.98 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: 4 }}
                transition={SPRING_GLIDE}
                transformTemplate={MAIN_THREAD_TRANSFORM}
                className="cc absolute z-30 w-[230px] rounded-card border border-line-strong bg-surface p-1.5"
                style={{
                  left: Math.min(GROUP_X - 40, BOARD_W - 250),
                  top: Math.min(column.primaryY + column.primaryHeight + 6, height - 190),
                }}
              >
                <PickerSection label={t('stage.pickPrimary')}>
                  {devices.length === 0 && <PickerEmpty text={t('stage.pickNone')} />}
                  {devices.map((d) => {
                    const picked = d.id === primaryDeviceId;
                    const others = drawn.filter((id) => id !== d.id);
                    const minOther =
                      others.length > 0
                        ? Math.min(...others.map((id) => deviceDelays[id] ?? 0))
                        : Number.POSITIVE_INFINITY;
                    const blocked = !picked && (deviceDelays[d.id] ?? 0) > minOther;
                    return (
                      <button
                        key={d.id}
                        type="button"
                        role="menuitem"
                        aria-current={picked ? 'true' : undefined}
                        disabled={blocked}
                        title={blocked ? t('stage.promoteBlockedTitle') : undefined}
                        onClick={() => {
                          setPrimaryDevice(d.id);
                          setPrimaryPickerOpen(false);
                        }}
                        className={`pressable flex w-full items-center gap-2 rounded-seg px-2.5 py-1.5 text-left text-[12px] ${
                          blocked
                            ? 'cursor-not-allowed text-text-muted opacity-60'
                            : 'text-text-secondary hover:bg-surface-hover hover:text-text-primary'
                        }`}
                      >
                        <span
                          className={`flex h-3 w-3 flex-none items-center justify-center text-[10px] ${
                            picked ? 'text-accent' : 'text-transparent'
                          }`}
                          aria-hidden="true"
                        >
                          ✓
                        </span>
                        <span className="truncate">{d.name}</span>
                      </button>
                    );
                  })}
                </PickerSection>
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
  children,
}: {
  label: string;
  top: number;
  height: number;
  rows: number;
  empty: string;
  headerAction?: React.ReactNode;
  onScroll?: (scrollTop: number) => void;
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
            <div className="px-3 py-2.5 text-[10.5px] leading-relaxed text-text-muted">{empty}</div>
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
  canPromote,
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
  canPromote: boolean;
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
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={FADE}
      transformTemplate={MAIN_THREAD_TRANSFORM}
      onMouseEnter={() => onHover(wireKey)}
      onMouseLeave={() => onHover(null)}
      className={`group/copy group absolute flex items-center gap-2 rounded-ctl bg-surface pl-3 pr-2 ${
        inspected ? 'ring-1 ring-accent' : 'hover:bg-surface-hover'
      }`}
      style={{ left: GROUP_PAD, top, width: ROW_W, height: ROW_H }}
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
          aria-pressed={onPrimaryPick === undefined ? selectedDeviceIds.includes(deviceId) : undefined}
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
                aria-label={t('stage.changePrimary')}
                title={t('stage.changePrimaryTitle')}
                onClick={(event) => {
                  event.stopPropagation();
                  onPrimaryPick();
                }}
                className="pressable text-[10px] font-semibold text-type-primary underline decoration-dotted underline-offset-2 outline-none hover:text-accent focus-visible:text-accent"
              >
                <span className="group-hover/copy:hidden">{roleWord}</span>
                <span className="hidden group-hover/copy:inline">{t('stage.changePrimary')}</span>
              </button>
            )
          ) : canPromote ? (
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
              className="pressable text-[10px] font-semibold text-type-mirror underline decoration-dotted underline-offset-2 outline-none hover:text-accent focus-visible:text-accent"
            >
              <span className="group-hover/copy:hidden">{roleWord}</span>
              <span className="hidden group-hover/copy:inline">{t('stage.promote')}</span>
            </button>
          ) : (
            <span
              title={t('stage.promoteBlockedTitle')}
              className={`text-[10px] font-semibold ${ROLE_TEXT_CLASS.mirror}`}
            >
              {roleWord}
            </span>
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
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={FADE}
      transformTemplate={MAIN_THREAD_TRANSFORM}
      onMouseEnter={() => onHover(`feed:${session.pid}`)}
      onMouseLeave={() => onHover(null)}
      title={title}
      className={`absolute flex items-center gap-2 rounded-ctl bg-surface pl-3 pr-2 ${state !== 'live' ? 'opacity-90' : ''}`}
      style={{ left: GROUP_PAD, top, width: ROW_W, height: ROW_H }}
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
    <div className="item rounded-seg" title={title}>
      <span className="text-[10.5px] text-text-secondary">{label}</span>
      <span className="stp flex items-center gap-1 rounded-seg border border-line-strong px-1 py-0.5">
        <button
          type="button"
          aria-label={downLabel}
          onClick={onDown}
          disabled={!canDown}
          className="pressable flex h-4 w-4 items-center justify-center rounded-full text-[11px] leading-none text-text-muted hover:bg-accent-muted hover:text-accent disabled:opacity-30 disabled:hover:bg-transparent"
        >
          −
        </button>
        <span className="min-w-[44px] text-center font-mono text-[10.5px] tabular-nums text-text-secondary">
          {value}
        </span>
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
  const delayRangeMs = useRouterStore((s) => s.delayRangeMs);
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
    body = (
      <>
        <div className="who flex items-center gap-2.5">
          <Ring tone="main" size={14} />
          <span>
            <span className="nm block text-[12.5px] font-bold">{device?.name ?? deviceId}</span>
            <span className="text-[9.5px] text-text-muted">{t('stage.main')}</span>
          </span>
        </div>
        <StripRow
          label={t('stage.stripPrimaryVolume')}
          title={t('primaryVolume.hint')}
          value={`${volume}%`}
          onDown={() => void setPrimaryVolume(exeName ?? '', Math.max(5, volume - 5))}
          onUp={() => void setPrimaryVolume(exeName ?? '', Math.min(100, volume + 5))}
          canDown={volume > 5}
          canUp={volume < 100}
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
        <div className="who flex items-center gap-2.5">
          <Ring tone="copy" size={14} />
          <span>
            <span className="nm block text-[12.5px] font-bold">{device?.name ?? deviceId}</span>
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
          onDown={() =>
            void setDeviceDelayValue(deviceId, clampDelay(delay - delayStepMs, delayRangeMs))
          }
          onUp={() =>
            void setDeviceDelayValue(deviceId, clampDelay(delay + delayStepMs, delayRangeMs))
          }
          canDown={delay > -delayRangeMs}
          canUp={delay < delayRangeMs}
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
