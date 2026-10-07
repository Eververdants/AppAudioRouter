import { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { SourceLevelDial } from '@/components/SourceLevelDial';
import { ProcessIcon } from '@/components/ui/ProcessIcon';
import { Ring } from '@/components/ui/Ring';
import { Spinner } from '@/components/ui/Spinner';
import { useLiveness } from '@/hooks/useLiveness';
import { clampDelay, formatDelaySigned, formatStep, orderByDelay } from '@/lib/delay';
import { FADE, MAIN_THREAD_TRANSFORM, SPRING_GLIDE, SPRING_TAP } from '@/lib/motion';
import {
  BOARD_W,
  FEEDER_X,
  HUB_H,
  HUB_W,
  HUB_X,
  MINI_H,
  MINI_W,
  TARGET_H,
  TARGET_W,
  TARGET_X,
  alreadyApplied,
  boardCentre,
  boardHeight,
  feederOutPort,
  feederY,
  hubInPort,
  hubOutPort,
  nodePath,
  orderLabel,
  targetInPort,
  targetY,
} from '@/lib/stage';
import { feedLiveness, useRouterStore } from '@/stores/routerStore';

/**
 * Which card the bottom strip is tuning right now. The hub shows the program
 * itself; a device card shows the levers that exist for its role.
 */
type InspectorKey = 'hub' | `dev:${string}`;

/**
 * A wire drawn on the board, in the shape the SVG layer needs.
 *
 * `litKey` is what a hovered card lights: every wire of the hub lights together
 * when the hub is under the pointer, one wire when its own card is. The key
 * doubles as the e2e hook (`data-wire`), which the old stage's spokes already
 * answered to.
 */
interface WireSpec {
  key: string;
  d: string;
  /** The wire moves only when sound is actually flowing through it. */
  live: boolean;
}

/** Where a card sits on the board, in the coordinates `lib/stage.ts` answers. */
interface Placement {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Card chrome shared by hub, targets, feeders and the ghost: the continuous-
 *  curvature corner, the plane, and the strong hairline that separates a card
 *  from the sunken well — flat blocks with nothing cast and nothing lifted. */
const CARD_CLASS =
  'cc absolute rounded-panel bg-surface border border-line-strong';
/** The role word colour, by role. Literal classes: Tailwind scans source text. */
const ROLE_TEXT_CLASS = {
  primary: 'text-type-primary',
  mirror: 'text-type-mirror',
  feed: 'text-type-feed',
} as const;

/** The card whose wire(s) light up under the pointer. */
const NO_PIDS: number[] = [];

/**
 * The node board: the one place a route is drawn.
 *
 * One programme per board. The hub card sits mid-left; a column of destination
 * cards stands at the right — output devices first in delay order, then the
 * programmes the sound is being sent into, each numbered in route order (01 is
 * the one Windows plays itself). A wire from the hub's out-pin to a card's
 * in-pin is the route; the wires are one grey line, and the colour lives on the
 * number badges and role words, the way a colourist's graph stays quiet.
 *
 * The board is a proposal, exactly as the ring stage was: destination cards
 * toggle membership in the plan, and the hub — which wears a "click to apply"
 * capsule whenever the plan is not yet the truth — lands it. Feeds are the
 * exception, because their endpoint pair is theirs alone: they connect and
 * disconnect immediately, with the toast carrying the way back.
 *
 * Nothing here measures anything: every position comes from `lib/stage.ts`,
 * so a card and the wire meeting it cannot disagree by a frame. The one
 * standing animation — dashes on wires that carry sound — is gated on
 * visibility, focus and the system's motion preference (`useLiveness`), and a
 * resting board paints nothing.
 */
export function NodeStage() {
  const { t } = useTranslation();
  const liveness = useLiveness();
  const devices = useRouterStore((s) => s.devices);
  const sessions = useRouterStore((s) => s.sessions);
  const selectedPids = useRouterStore((s) => s.selectedPids);
  const selectedDeviceIds = useRouterStore((s) => s.selectedDeviceIds);
  const routedPids = useRouterStore((s) => s.routedPids);
  const soundingPids = useRouterStore((s) => s.soundingPids);
  const deviceDelays = useRouterStore((s) => s.deviceDelays);
  const deviceLatencyMs = useRouterStore((s) => s.deviceLatencyMs);
  const feeds = useRouterStore((s) => s.feeds);
  const feedCarrier = useRouterStore((s) => s.feedCarrier);
  const applying = useRouterStore((s) => s.applying);
  const toggleDeviceSelection = useRouterStore((s) => s.toggleDeviceSelection);
  const promoteDevice = useRouterStore((s) => s.promoteDevice);
  const applyRoute = useRouterStore((s) => s.applyRoute);
  const addFeed = useRouterStore((s) => s.addFeed);
  const removeFeed = useRouterStore((s) => s.removeFeed);
  const selectProcess = useRouterStore((s) => s.selectProcess);

  /** The card whose wire(s) light up under the pointer. */
  const [hoverKey, setHoverKey] = useState<string | null>(null);
  /** The card the bottom strip is tuning. */
  const [inspectorKey, setInspectorKey] = useState<InspectorKey | null>(null);
  /** The add-destination picker, anchored to the ghost card. */
  const [pickerOpen, setPickerOpen] = useState(false);
  const boardRef = useRef<HTMLDivElement | null>(null);

  const pid = selectedPids[0];
  const session = sessions.find((s) => s.pid === pid);
  const name = session?.display_name ?? session?.exe_name;
  const drawn = orderByDelay(selectedDeviceIds, deviceDelays);
  const answered = alreadyApplied(drawn, selectedPids, routedPids);
  const canApply = pid !== undefined && drawn.length > 0 && !answered && !applying;
  const sounding = pid !== undefined && soundingPids[pid] === true;
  const hasPlan = drawn.length > 0;

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
    return (feeds[pid] ?? [])
      .map((targetPid) => sessions.find((s) => s.pid === targetPid))
      .filter((s) => s !== undefined);
  }, [feeds, sessions, pid]);

  // The destination column: devices in delay order, then feeds — the number
  // badges read 01, 02, … straight down the column, and 01 is always the one
  // Windows plays itself.
  const targetCount = drawn.length + feedTargets.length + 1; // + the ghost card
  // Either column may outgrow the default board: a plan with a dozen
  // destinations makes the board taller and the well scrolls, rather than the
  // cards closing in on each other — and the programmes feeding *in* are a
  // column too, which is the half that used to be left out of the budget.
  const height = boardHeight(targetCount, feeders.length);
  const hubY = Math.round(boardCentre(height) - HUB_H / 2);
  const feedTargetStates = feedTargets.map((targetSession) => ({
    session: targetSession,
    state: feedLiveness(pid ?? -1, feedCarrier, routedPids, sessions),
  }));

  // Escape closes the picker; registered only while it is open, so a standing
  // listener never swallows the search box's Escape (the same rule the
  // briefing bubble follows).
  useEffect(() => {
    if (!pickerOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        setPickerOpen(false);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [pickerOpen]);

  useEffect(() => {
    if (!pickerOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (boardRef.current !== null && !boardRef.current.contains(event.target as Node)) {
        setPickerOpen(false);
      }
    };
    // The picker lives inside the board, so the outside-close only has to watch
    // for clicks that land outside the whole board; clicks inside land on the
    // picker's own rows or the ghost that toggles it.
    window.addEventListener('pointerdown', onPointerDown, true);
    return () => window.removeEventListener('pointerdown', onPointerDown, true);
  }, [pickerOpen]);

  // Selecting a different programme resets the inspector to the card that is
  // actually on screen — a key naming last programme's device must not survive.
  useEffect(() => {
    setInspectorKey(null);
    setPickerOpen(false);
    setHoverKey(null);
  }, [pid]);

  const wires: WireSpec[] = [];
  // Hub → destinations. The hub's own wires light together when it is hovered.
  drawn.forEach((deviceId, index) => {
    const from = hubOutPort(height);
    const to = targetInPort(index, targetCount, height);
    wires.push({
      key: `dev:${deviceId}`,
      d: nodePath(from.x, from.y, to.x, to.y),
      live: flowing,
    });
  });
  feedTargetStates.forEach(({ session: targetSession, state }, index) => {
    const from = hubOutPort(height);
    const to = targetInPort(drawn.length + index, targetCount, height);
    wires.push({
      key: `feed:${targetSession.pid}`,
      d: nodePath(from.x, from.y, to.x, to.y),
      live: flowing && state === 'live',
    });
  });
  // Feeders → hub.
  feeders.forEach((feeder, index) => {
    const from = feederOutPort(index, feeders.length, height);
    const to = hubInPort(height);
    wires.push({
      key: `feeder:${feeder.pid}`,
      d: nodePath(from.x, from.y, to.x, to.y),
      live: (soundingPids[feeder.pid] === true) && liveness,
    });
  });

  const lit = (key: string): boolean =>
    hoverKey === 'hub' && !key.startsWith('feeder:')
      ? true
      : hoverKey === key;

  const primaryDelay = drawn.length > 0 ? (deviceDelays[drawn[0] ?? ''] ?? 0) : 0;

  /**
   * Add or remove one device card.
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
  const targets = drawn
    .map((id) => devices.find((d) => d.id === id)?.name ?? id)
    .join(' + ');
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
          the rail; the cards sit on it as solid blocks, separated by the
          strength of their own borders — nothing casts anything. */}
      <div className="bg-surface-sunken min-h-0 flex-1 overflow-auto">
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
              wire, and it scrolls with the board rather than hovering over
              it. */}
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

          {/* The wires. One grey line each — the role colour lives on the cards
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
                className={`nwire${wire.live ? ' stage-flow' : ''}${lit(wire.key) ? ' lit' : ''}`}
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
                className={`${CARD_CLASS} hover:border-line-strong focus-visible:border-accent focus-visible:outline-none flex flex-col items-start justify-center gap-1 px-3 text-left`}
                style={{
                  left: FEEDER_X,
                  top: feederY(index, feeders.length, height),
                  width: MINI_W,
                  height: MINI_H,
                }}
              >
                <span className="pin pin-out" aria-hidden="true" />
                <span className="flex w-full items-center gap-2">
                  <Ring tone="idle" size={12} live={soundingPids[feeder.pid] === true && liveness} />
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
              } focus-visible:outline-none flex flex-col items-center justify-center gap-1 px-4 text-center`}
              style={{ left: HUB_X, top: hubY, width: HUB_W, height: HUB_H }}
            >
              {canApply && (
                <span className="bg-accent text-accent-ink absolute -top-3 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full px-2.5 py-0.5 text-[10px] font-semibold">
                  {t('stage.applyHint')}
                </span>
              )}
              <span className="flex items-center gap-2">
                <Ring
                  tone={hasPlan || feedTargetStates.length > 0 ? 'main' : 'idle'}
                  size={16}
                  live={sounding && liveness}
                />
                <ProcessIcon
                  exeName={session.exe_name}
                  name={name ?? session.exe_name}
                  size={18}
                />
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
                {applying && <Spinner size={10} className="mr-1 inline-block align-[-1px] text-accent" />}
                {sounding ? t('stage.sounding') : t('stage.quiet')}
                {feedTargetStates.length > 0 && (
                  <span className="text-type-feed"> · {t('stage.feedCount', { n: feedTargetStates.length })}</span>
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
              <SourceLevelDial exeName={session.exe_name} displayName={session.display_name ?? undefined} />
            </div>
          )}

          {/* Destinations, numbered in route order; then the ghost. */}
          {drawn.map((deviceId, index) => {
            const device = devices.find((d) => d.id === deviceId);
            const deviceName = device?.name ?? deviceId;
            const role = index === 0 ? 'primary' : 'mirror';
            const roleWord = role === 'primary' ? t('stage.main') : t('stage.copy');
            const isPrimary = role === 'primary';
            const delay = deviceDelays[deviceId] ?? 0;
            const canPromote =
              !isPrimary && drawn.length > 1 && delay <= primaryDelay;
            const placement: Placement = {
              left: TARGET_X,
              top: targetY(index, targetCount, height),
              width: TARGET_W,
              height: TARGET_H,
            };
            const wireKey = `dev:${deviceId}`;
            return (
              <motion.div
                key={deviceId}
                data-device-row={deviceId}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={FADE}
                transformTemplate={MAIN_THREAD_TRANSFORM}
                onMouseEnter={() => setHoverKey(wireKey)}
                onMouseLeave={() => setHoverKey(null)}
                className={`${CARD_CLASS} group group/copy ${inspectorKey === `dev:${deviceId}` ? 'border-accent' : ''}`}
                style={placement}
              >
                <span className="pin pin-in" aria-hidden="true" />
                {/* Removal is a plan edit like any other: it toggles the card
                    out of the selection, and the hub asks the same question it
                    always does. The last device cannot leave — a route to zero
                    devices is not a state this app offers. */}
                {/* Only ever offered where it can do something: the guard that
                    keeps a route from being clicked empty lives in `toggleTarget`,
                    so with one device staged the ✕ was drawn, clickable, and
                    answered nothing. */}
                {drawn.length > 1 && (
                  <button
                    type="button"
                    title={t('stage.removeTarget', { name: deviceName })}
                    onClick={() => toggleTarget(deviceId)}
                    className="pressable absolute -right-2 -top-2 z-10 hidden h-4 w-4 place-items-center rounded-full border border-line-strong bg-surface text-[9px] leading-none text-text-muted group-hover:grid group-focus-within:grid hover:border-error hover:text-error"
                  >
                    ✕
                  </button>
                )}
                {/* The number badge opens the strip — but only once there is
                    something to tune: a single-device route starts no engine,
                    so neither a delay nor a share exists for it, and the
                    primary volume alone is not a control this route offers.
                    Same rule the disc stage always carried. */}
                {badgeIsButton ? (
                  <button
                    type="button"
                    className="no cursor-pointer hover:border-accent hover:text-accent"
                    onClick={() => setInspectorKey(`dev:${deviceId}`)}
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
                <div className="flex h-full flex-col justify-center gap-0.5 pl-3 pr-2">
                  <button
                    type="button"
                    aria-pressed={selectedDeviceIds.includes(deviceId)}
                    aria-label={deviceName}
                    onClick={() => toggleTarget(deviceId)}
                    className="truncate text-left text-[12px] font-bold text-text-primary outline-none focus-visible:text-accent"
                  >
                    {deviceName}
                  </button>
                  <div className="flex items-center gap-1.5">
                    {isPrimary ? (
                      <span
                        title={t('stage.primaryTitle')}
                        className={`text-[10px] font-semibold ${ROLE_TEXT_CLASS.primary}`}
                      >
                        {roleWord}
                      </span>
                    ) : canPromote ? (
                      // The role word itself is the switch: it reads "Copy"
                      // until the pointer or the keyboard arrives, then it
                      // offers the move. The accessible name is the action, so
                      // a screen reader hears the control and not the state.
                      <button
                        type="button"
                        aria-label={t('stage.promote')}
                        title={t('stage.promoteTitle')}
                        onClick={(event) => {
                          event.stopPropagation();
                          promoteDevice(deviceId);
                        }}
                        className="text-[10px] font-semibold text-type-mirror underline decoration-dotted underline-offset-2 outline-none hover:text-accent focus-visible:text-accent"
                      >
                        <span className="group-hover/copy:hidden">{roleWord}</span>
                        <span className="hidden group-hover/copy:inline">
                          {t('stage.promote')}
                        </span>
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
                  </div>
                </div>
              </motion.div>
            );
          })}

          {/* Feed targets: amber, immediate, and honest about what is missing.
              The ✕ disconnects at once — the toast carries the way back. */}
          {feedTargetStates.map(({ session: targetSession, state }, index) => {
            const targetName = targetSession.display_name ?? targetSession.exe_name;
            const no = orderLabel(drawn.length + index);
            const title =
              state === 'live'
                ? t('stage.feedTitleLive', { name: targetName })
                : state === 'suspended'
                  ? t('stage.feedTitleSuspended', { source: name ?? '', name: targetName })
                  : t('stage.feedTitleNoCarrier', { name: targetName });
            const stateWord =
              state === 'live'
                ? t('stage.feedRole')
                : state === 'suspended'
                  ? t('stage.feedHeld')
                  : t('stage.feedNoCarrier');
            return (
              <motion.div
                key={targetSession.pid}
                data-feed-row={targetSession.pid}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={FADE}
                transformTemplate={MAIN_THREAD_TRANSFORM}
                onMouseEnter={() => setHoverKey(`feed:${targetSession.pid}`)}
                onMouseLeave={() => setHoverKey(null)}
                title={title}
                className={`${CARD_CLASS} ${state !== 'live' ? 'opacity-90' : ''}`}
                style={{
                  left: TARGET_X,
                  top: targetY(drawn.length + index, targetCount, height),
                  width: TARGET_W,
                  height: TARGET_H,
                }}
              >
                <span className="pin pin-in pin-amber" aria-hidden="true" />
                <button
                  type="button"
                  title={t('stage.removeFeed', { name: targetName })}
                  onClick={() => void removeFeed(pid ?? -1, targetSession.pid)}
                  className="pressable absolute -right-2 -top-2 z-10 grid h-4 w-4 place-items-center rounded-full border border-line-strong bg-surface text-[9px] leading-none text-text-muted hover:border-error hover:text-error"
                >
                  ✕
                </button>
                <span className="no" aria-hidden="true">
                  {no}
                </span>
                <div className="flex h-full flex-col justify-center gap-0.5 pl-3 pr-2">
                  <div className="flex items-center gap-1.5">
                    <ProcessIcon
                      exeName={targetSession.exe_name}
                      name={targetSession.display_name ?? targetSession.exe_name}
                      size={15}
                    />
                    <span className="truncate text-[12px] font-bold text-text-primary">
                      {targetName}
                    </span>
                  </div>
                  <div className="flex items-center gap-1">
                    <span className={`text-[10px] font-semibold ${ROLE_TEXT_CLASS.feed} ${state !== 'live' ? 'opacity-60' : ''}`}>
                      {stateWord}
                    </span>
                    <span className="truncate text-[9.5px] text-text-muted">
                      {t('stage.feedInputSuffix')}
                    </span>
                  </div>
                </div>
              </motion.div>
            );
          })}

          {/* The ghost: how a destination is added. Devices join the plan (the
              hub still asks), feeds connect at once. */}
          <motion.button
            type="button"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={FADE}
            transformTemplate={MAIN_THREAD_TRANSFORM}
            aria-label={t('stage.addTarget')}
            title={t('stage.addTargetTitle')}
            onClick={() => setPickerOpen((value) => !value)}
            className={`${CARD_CLASS} hover:border-accent/60 text-text-muted hover:text-accent focus-visible:border-accent focus-visible:outline-none grid place-items-center border-dashed`}
            style={{
              left: TARGET_X,
              top: targetY(targetCount - 1, targetCount, height),
              width: TARGET_W,
              height: TARGET_H,
            }}
          >
            <span className="flex items-center gap-2 text-[12px] font-semibold">
              <span aria-hidden="true" className="text-[15px] leading-none">
                ＋
              </span>
              {t('stage.addTarget')}
            </span>
          </motion.button>

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
                className="bg-surface border-line-strong cc absolute z-30 w-[230px] rounded-card border p-1.5"
                style={{
                  left: Math.min(TARGET_X - 20, BOARD_W - 250),
                  top: Math.min(
                    targetY(targetCount - 1, targetCount, height) + TARGET_H + 8,
                    height - 190,
                  ),
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
                          toggleDeviceSelection(d.id);
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
        </div>
      </div>

      {/* The strip: what a clicked card tunes. Nothing here is drawn for
          decoration — when nothing is selected it says how to get here. */}
      <Inspector
        inspectorKey={inspectorKey}
        onClear={() => setInspectorKey(null)}
        drawn={drawn}
        hubName={name}
        hubSounding={sounding}
        deviceLatencyMs={deviceLatencyMs}
      />
    </div>
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

/** The bottom strip of the board: the levers that exist for the selected card,
 *  and the honest sentence about the ones that do not. */
function Inspector({
  inspectorKey,
  onClear,
  drawn,
  hubName,
  hubSounding,
  deviceLatencyMs,
}: {
  inspectorKey: InspectorKey | null;
  onClear: () => void;
  drawn: string[];
  hubName: string | undefined;
  hubSounding: boolean;
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
  // A stable empty array, not a fresh `[]`: a store selector that returns a new
  // reference on every call re-renders forever ("getSnapshot should be cached").
  const feedTargets = useRouterStore((s) =>
    selectedPids[0] === undefined ? NO_PIDS : (s.feeds[selectedPids[0]] ?? NO_PIDS),
  );
  const setPrimaryVolume = useRouterStore((s) => s.setPrimaryVolume);
  const setDeviceVolume = useRouterStore((s) => s.setDeviceVolume);
  const setDeviceDelayValue = useRouterStore((s) => s.setDeviceDelayValue);

  const session = sessions.find((s) => s.pid === selectedPids[0]);
  const exeName = session?.exe_name;

  let body: React.ReactNode;
  // A device panel only exists while a route has copies: a single-device route
  // is played by the system directly, and neither a delay nor a share has
  // anywhere to act. A key left over from a longer plan falls back to the
  // programme's own summary rather than describing levers that just went away.
  const devicePanelOpen =
    inspectorKey !== null &&
    inspectorKey.startsWith('dev:') &&
    drawn.length > 1 &&
    // ...and the key still names a device that is in the route. Without this
    // half of the guard, removing the copy being inspected leaves the strip
    // open on it: `indexOf` answers -1, so it is read as a mirror and keeps
    // offering delay and share for a device the route no longer has — tuning a
    // lever that is attached to nothing.
    drawn.includes(inspectorKey.slice(4));
  if (
    inspectorKey === null ||
    inspectorKey === 'hub' ||
    session === undefined ||
    !devicePanelOpen
  ) {
    // Nothing picked, or the programme itself: the strip is the programme's own
    // summary — where it plays, how many devices, how many feeds. The board's
    // hub card carries the name; this is the sentence under it.
    body =
      session !== undefined ? (
        <>
          <div className="who flex items-center gap-2.5">
            <span className="nm text-[12.5px] font-bold">{hubName}</span>
            <span className="text-[10px] text-text-muted">
              {hubSounding ? t('stage.sounding') : t('stage.quiet')}
            </span>
          </div>
          <span className="text-[11.5px] text-text-muted">
            {drawn.length === 0
              ? t('stage.inspectorHubNoRoute')
              : drawn.length === 1
                ? t('stage.inspectorHubOne', { device: devices.find((d) => d.id === drawn[0])?.name ?? '' })
                : t('stage.inspectorHubMulti', {
                    device: devices.find((d) => d.id === drawn[0])?.name ?? '',
                    m: drawn.length - 1,
                  })}
            {feedTargets.length > 0 && ` · ${t('stage.inspectorHubFeeds', { n: feedTargets.length })}`}
          </span>
        </>
      ) : (
        <span className="text-[11.5px] text-text-muted">{t('stage.inspectorHint')}</span>
      );
  } else {
    const deviceId = inspectorKey.slice(4);
    const device = devices.find((d) => d.id === deviceId);
    const role = drawn.indexOf(deviceId) === 0 ? 'primary' : 'mirror';
    if (role === 'primary') {
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
  }

  return (
    <div
      data-tuner-strip
      className="flex flex-none items-center gap-4 overflow-x-auto border-t border-line px-4 py-2.5"
    >
      {inspectorKey !== null && (
        <button
          type="button"
          onClick={onClear}
          className="text-[10.5px] text-text-muted hover:text-text-primary"
          title={t('stage.inspectClear')}
        >
          ✕
        </button>
      )}
      {body}
      {/* A primary delay reading would describe a stream that does not exist:
          the system plays this device itself. The strip says so in words. */}
      {devicePanelOpen && drawn[0] === inspectorKey.slice(4) && (
        <span className="text-[10.5px] text-text-muted">{t('stage.stripPrimaryLatency')}</span>
      )}
    </div>
  );
}
