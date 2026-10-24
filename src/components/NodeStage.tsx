import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { BoardFooter } from '@/components/nodeStage/BoardFooter';
import { Halo, WireLayer } from '@/components/nodeStage/BoardBackdrop';
import { DestinationPanels } from '@/components/nodeStage/DestinationPanels';
import { FeederColumn } from '@/components/nodeStage/FeederColumn';
import { HubCard } from '@/components/nodeStage/HubCard';
import { AddDestinationPicker, ChangePrimaryPicker } from '@/components/nodeStage/PickerMenu';
import { useBoardGeometry } from '@/components/nodeStage/hooks/useBoardGeometry';
import { useBoardTransients } from '@/components/nodeStage/hooks/useBoardTransients';
import { useBoardWires } from '@/components/nodeStage/hooks/useBoardWires';
import { useFeedCandidates } from '@/components/nodeStage/hooks/useFeedCandidates';
import { useFeedPlan } from '@/components/nodeStage/hooks/useFeedPlan';
import { useFeeders } from '@/components/nodeStage/hooks/useFeeders';
import { useHubIdentity } from '@/components/nodeStage/hooks/useHubIdentity';
import { usePickers } from '@/components/nodeStage/hooks/usePickers';
import { useElementHeight } from '@/hooks/useElementHeight';
import { useLiveness } from '@/hooks/useLiveness';
import { useProgramRoutes } from '@/hooks/useProgramRoutes';
import { BOARD_W, alreadyApplied, effectiveFallback } from '@/lib/stage';
import { useRouterStore } from '@/stores/routerStore';

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
 *
 * What stays in this file is the plan's arithmetic and the board's choreography:
 * the store reads, what the pickers may offer (the carrier's filter lives here
 * and nowhere else), the last-device guard, the hub's accessible sentence, and
 * the order the pieces are asked for. `nodeStage/*` holds the pieces — the three
 * kinds of card, the two panels, the two pickers, the wires, the strip — and
 * `nodeStage/hooks/*` holds the states that describe one programme's board: the
 * hub's identity and its swaps, the feed plan, the feeders, the pickers' focus
 * contract, the geometry, the wires, and the one-shot states a programme switch
 * drops. A piece takes what it draws as props; none of them reads the plan out
 * of the store for itself, and none of them measures a card.
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
  const windowApps = useRouterStore((s) => s.windowApps);
  const loadWindowApps = useRouterStore((s) => s.loadWindowApps);
  const selectProcess = useRouterStore((s) => s.selectProcess);

  /** The row whose wire(s) light up under the pointer. */
  const [hoverKey, setHoverKey] = useState<string | null>(null);

  const wellRef = useRef<HTMLDivElement | null>(null);
  /** The hub card: what the level dial belongs to, and the place its focus goes
   *  back to when the dial unmounts with the caret still inside it. */
  const hubRef = useRef<HTMLButtonElement | null>(null);
  const measured = useElementHeight(wellRef);

  // The programme under the cursor, and the two swaps that report it changing.
  const { pid, session, name, exe, hubName, sounding, nameSwap, iconSwap } = useHubIdentity(
    selectedPids,
    sessions,
  );
  // The feed half of the plan, and the landed half beside it.
  const { planFeedSessions, landedFeedPids, landedFeedSet, planFeedStates } = useFeedPlan({
    pid,
    exe,
    sessions,
    windowApps,
    feeds,
    selectedFeedPids,
    feedCarrier,
    feedTapFailures,
  });
  // The programmes sending sound into the hub, and which of them are sounding.
  const { feeders, soundingFeeders } = useFeeders({ pid, sessions, feeds });
  // The two pickers, their search, and the focus they both have to give back.
  const {
    pickerOpen,
    setPickerOpen,
    primaryPickerOpen,
    setPrimaryPickerOpen,
    feedQuery,
    setFeedQuery,
    feedSearchRef,
    pickerReturnRef,
    addMenuRef,
    primaryMenuRef,
    closePicker,
  } = usePickers();
  // The picker's programme-input rows.
  const feedCandidates = useFeedCandidates({
    sessions,
    windowApps,
    pid,
    session,
    planFeedSessions,
    feedQuery,
  });

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

  /** Every row in the copies panel: the copies first, then the feeds. */
  const copiesRows = copyDeviceIds.length + planFeedStates.length;

  // The board's arithmetic: the panels' seats, the hub's, and the pickers' room.
  const { height, column, hubY, addPickerTop, addPickerCap, primaryPickerTop, primaryPickerCap } =
    useBoardGeometry({ measured, copiesRows });
  // Which row the strip is tuning, which row has just arrived, whether a
  // proposal has just landed — and the reset that starts a new programme quiet.
  const {
    inspectorKey,
    setInspectorKey,
    inspectorReturnRef,
    clearInspector,
    copyScroll,
    setCopyScroll,
    revealIndex,
    clearReveal,
    landPulse,
  } = useBoardTransients({
    pid,
    drawn,
    planFeedStates,
    answered,
    setHoverKey,
    setPickerOpen,
    setPrimaryPickerOpen,
    setFeedQuery,
  });
  // The wires, and the feeder column's seat window they are cut with.
  const { wires, lit, feederSeats, feederHasSeat } = useBoardWires({
    height,
    column,
    copyScroll,
    primaryDeviceId,
    copyDeviceIds,
    planFeedStates,
    feeders,
    soundingFeeders,
    sounding,
    liveness,
    flowing,
    feedCarrier,
    feedTapFailures,
    hoverKey,
  });

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
          <Halo height={height} />
          <WireLayer
            wires={wires}
            height={height}
            pid={pid}
            devicesAnswered={devicesAnswered}
            lit={lit}
          />
          <FeederColumn
            feeders={feeders}
            feederSeats={feederSeats}
            feederHasSeat={feederHasSeat}
            height={height}
            name={name}
            soundingFeeders={soundingFeeders}
            liveness={liveness}
            setHoverKey={setHoverKey}
            selectProcess={selectProcess}
          />
          <HubCard
            session={session}
            name={name}
            hubName={hubName}
            hubY={hubY}
            hubRef={hubRef}
            canApply={canApply}
            applying={applying}
            sounding={sounding}
            hasPlan={hasPlan}
            drawn={drawn}
            planFeedStates={planFeedStates}
            feeders={feeders}
            landPulse={landPulse}
            hubAria={hubAria}
            liveness={liveness}
            setHoverKey={setHoverKey}
            applyRoute={applyRoute}
            nameSwap={nameSwap}
            iconSwap={iconSwap}
          />
          <DestinationPanels
            column={column}
            primaryDeviceId={primaryDeviceId}
            copyDeviceIds={copyDeviceIds}
            planFeedStates={planFeedStates}
            copiesRows={copiesRows}
            inspectorKey={inspectorKey}
            badgeIsButton={badgeIsButton}
            deviceDelays={deviceDelays}
            name={name}
            deviceNameOf={deviceNameOf}
            toggleTarget={toggleTarget}
            promoteDevice={promoteDevice}
            dropFeedTarget={dropFeedTarget}
            setHoverKey={setHoverKey}
            setInspectorKey={setInspectorKey}
            inspectorReturnRef={inspectorReturnRef}
            pickerOpen={pickerOpen}
            setPickerOpen={setPickerOpen}
            setPrimaryPickerOpen={setPrimaryPickerOpen}
            pickerReturnRef={pickerReturnRef}
            loadWindowApps={loadWindowApps}
            setCopyScroll={setCopyScroll}
            revealIndex={revealIndex}
            clearReveal={clearReveal}
            pid={pid}
          />
          <AddDestinationPicker
            pickerOpen={pickerOpen}
            addMenuRef={addMenuRef}
            closePicker={closePicker}
            switchableDevices={switchableDevices}
            addableDevices={addableDevices}
            devicePickerEmpty={devicePickerEmpty}
            feedCandidates={feedCandidates}
            feedQuery={feedQuery}
            setFeedQuery={setFeedQuery}
            feedSearchRef={feedSearchRef}
            pid={pid}
            setPrimaryDevice={setPrimaryDevice}
            appendDeviceTarget={appendDeviceTarget}
            appendFeedTarget={appendFeedTarget}
            addPickerTop={addPickerTop}
            addPickerCap={addPickerCap}
          />
          <ChangePrimaryPicker
            primaryPickerOpen={primaryPickerOpen}
            primaryMenuRef={primaryMenuRef}
            closePicker={closePicker}
            pickableDevices={pickableDevices}
            primaryDeviceId={primaryDeviceId}
            devicePickerEmpty={devicePickerEmpty}
            setPrimaryDevice={setPrimaryDevice}
            primaryPickerTop={primaryPickerTop}
            primaryPickerCap={primaryPickerCap}
          />
        </div>
      </div>

      <BoardFooter
        inspectorKey={inspectorKey}
        clearInspector={clearInspector}
        drawn={drawn}
        deviceLatencyMs={deviceLatencyMs}
        answered={answered}
        session={session}
        targets={targets}
      />
    </div>
  );
}
