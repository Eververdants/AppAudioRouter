import { AnimatePresence, motion } from 'framer-motion';
import { useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { SourceLevelDial } from '@/components/SourceLevelDial';
import { ProcessIcon } from '@/components/ui/ProcessIcon';
import { Ring } from '@/components/ui/Ring';
import { useLiveness } from '@/hooks/useLiveness';
import { formatStep, orderByDelay } from '@/lib/delay';
import { FADE, RIPPLE, SPRING_ARRIVE, SPRING_GLIDE, SPRING_TAP } from '@/lib/motion';
import {
  DISC_D,
  HUB_D,
  HUB_HALO_R,
  ORBIT_R,
  STAGE_H,
  STAGE_W,
  TONE,
  alreadyApplied,
  approach,
  bloom,
  roleOf,
  satellite,
  spoke,
  stageCentre,
  type StageRole,
} from '@/lib/stage';
import { useRouterStore } from '@/stores/routerStore';

/**
 * The concentric stage: one programme at the centre, every output device on a
 * ring around it, and a spoke from the hub to each lit disc.
 *
 * The spoke *is* the route, in the same sense a wire between two nodes was, and
 * the ring is why it can be read without being explained: the lit discs are the
 * answer to "where is this programme's sound going", and there is no heading to
 * read first. Every device is always on the ring — including the ones the route
 * does not touch — because a device you have to go find is a device you forgot
 * existed, and too many audio problems are one unplugged thing away.
 *
 * What is drawn is the *pending selection*, which the store prefills from the
 * programme's live route (or from the system default it plays through), so what
 * appears when you select a programme is reality, and what appears after a pick
 * is the plan. The hub is the press that lands the plan; while the drawn plan is
 * already what is playing, the hub goes back to being a label, because a stage
 * never asks anyone to confirm what they can hear.
 *
 * The sizes, the angles and therefore the spokes are all arithmetic
 * (`lib/stage.ts`), which is why nothing here measures anything: a disc and the
 * spoke that meets it cannot disagree, and no ResizeObserver has to run.
 *
 * Everything that moves here moves because something happened. A disc arrives
 * out of the hub; a spoke grows from the hub rim to the disc it now reaches; a
 * role word is replaced rather than rewritten; a number rolls to its new value.
 * Nothing animates for atmosphere, and the one standing loop — the dash on
 * spokes carrying sound — is gated on visibility, focus and the system's own
 * motion preference (see `useLiveness`).
 */
export function ConcentricStage() {
  const { t } = useTranslation();
  const devices = useRouterStore((s) => s.devices);
  const sessions = useRouterStore((s) => s.sessions);
  const selectedPids = useRouterStore((s) => s.selectedPids);
  const selectedDeviceIds = useRouterStore((s) => s.selectedDeviceIds);
  const routedPids = useRouterStore((s) => s.routedPids);
  const soundingPids = useRouterStore((s) => s.soundingPids);
  const defaultDeviceId = useRouterStore((s) => s.defaultDeviceId);
  const deviceDelays = useRouterStore((s) => s.deviceDelays);
  const toggleDeviceSelection = useRouterStore((s) => s.toggleDeviceSelection);
  const promoteDevice = useRouterStore((s) => s.promoteDevice);
  const applying = useRouterStore((s) => s.applying);
  const applyRoute = useRouterStore((s) => s.applyRoute);

  const liveness = useLiveness();

  // A concentric ripple is how this stage says "that one just changed": one ring
  // expanding out of the disc that was pressed and fading as it leaves. One-shot
  // per press, never a standing loop — it reports an event, then it is gone.
  const [ripples, setRipples] = useState<{ id: number; x: number; y: number }[]>([]);
  const rippleId = useRef(0);
  const pushRipple = (x: number, y: number) => {
    const id = rippleId.current++;
    setRipples((current) => [...current, { id, x, y }]);
  };
  const dismissRipple = (id: number) => {
    setRipples((current) => current.filter((ripple) => ripple.id !== id));
  };

  const pid = selectedPids[0];
  const session = pid === undefined ? undefined : sessions.find((s) => s.pid === pid);
  const live = pid === undefined ? undefined : routedPids[pid];
  /**
   * What the ring shows: the plan, drawn in the order the apply will realize
   * it — delay order, the order the route itself goes out in (`orderByDelay`)
   * — so the disc wearing `Main` is always the one Apply actually hands to the
   * system. With no delays set every value ties and the plan's own order
   * stands, which is the freedom the copy's promotion control spends; a copy
   * whose delay is strictly larger is drawn where the apply would leave it,
   * never where a click wished it were.
   */
  const drawn = pid === undefined ? [] : orderByDelay(selectedDeviceIds, deviceDelays);
  // The plan's first device is its primary, and a copy can take that seat only
  // when its own delay ties with it: the system plays the primary directly,
  // and software delay cannot pull a later device earlier.
  const [primaryId] = drawn;
  const primaryDelayMs = primaryId === undefined ? 0 : (deviceDelays[primaryId] ?? 0);

  // The hub is the apply button: pressing it lands the plan that is drawn. When
  // every selected programme already plays exactly that plan there is nothing
  // to press — the hub goes back to being a label (see `alreadyApplied`).
  const answered = alreadyApplied(drawn, selectedPids, routedPids);
  const canApply = pid !== undefined && drawn.length > 0 && !answered && !applying;
  const targets = drawn.map((id) => devices.find((d) => d.id === id)?.name ?? id).join(' + ');
  const applyAria =
    selectedPids.length > 1
      ? t('stage.applyAriaMany', { n: selectedPids.length, device: targets })
      : t('stage.applyAriaOne', {
          process: session?.display_name ?? session?.exe_name ?? '',
          device: targets,
        });

  const sounding = pid !== undefined && soundingPids[pid] === true && liveness;
  /**
   * A spoke only flows when what it draws is actually playing. A plan is not
   * playing anything yet, and a window nobody is looking at owes nobody a
   * repaint — see `useLiveness`, which is also what keeps this honest when the
   * system asks for less motion.
   */
  const flows =
    sounding &&
    live !== undefined &&
    drawn.length > 0 &&
    drawn.length === live.length &&
    drawn.every((id, index) => id === live[index]);

  const { cx, cy } = stageCentre();
  const count = Math.max(1, devices.length);
  const hasPlan = drawn.length > 0;

  return (
    <section className="relative min-h-0 flex-1 overflow-auto">
      <div className="relative mx-auto my-auto flex min-h-full items-center justify-center">
        <div className="relative" style={{ width: STAGE_W, height: STAGE_H }}>
          {/* Something for the glass to bend. Nothing here ever moves. */}
          <div
            aria-hidden="true"
            className="aurora pointer-events-none absolute inset-0 opacity-90"
          />
          {/* Grain over those pools so they read as light on a surface rather
              than as a vector gradient. Static, blended, beneath the discs. */}
          <div aria-hidden="true" className="grain pointer-events-none absolute inset-0" />

          <svg
            width={STAGE_W}
            height={STAGE_H}
            viewBox={`0 0 ${STAGE_W} ${STAGE_H}`}
            className="absolute inset-0"
            aria-hidden="true"
          >
            {/* The orbit itself: a faint circle the discs sit on, so the ring
                reads as one object rather than as scattered coins. */}
            <circle
              cx={cx}
              cy={cy}
              r={ORBIT_R}
              fill="none"
              stroke="var(--hairline)"
              strokeWidth={1}
            />

            {/* The halo. Two stacked circles rather than one animated between
                colours: it has to be able to change with the theme, and a
                colour interpolated in JavaScript is a colour that disagrees
                with the palette. Cross-fading is also the honest reading — the
                stage is furniture until it is wired. */}
            <circle
              cx={cx}
              cy={cy}
              r={HUB_HALO_R}
              fill="none"
              stroke="var(--hairline-strong)"
              strokeWidth={1}
              strokeDasharray="2 7"
              className="transition-opacity duration-500"
              opacity={hasPlan ? 0 : 0.7}
            />
            <circle
              cx={cx}
              cy={cy}
              r={HUB_HALO_R}
              fill="none"
              stroke="var(--type-primary)"
              strokeWidth={1}
              strokeDasharray="2 7"
              className="transition-opacity duration-500"
              opacity={hasPlan ? 0.7 : 0}
            />

            {/* The spokes. One mounts by growing out of the hub rim toward the
                disc it now reaches, which is the whole of what "connected"
                means here — and it unmounts by retracting, because a route that
                disappears without a trace leaves you unsure you cancelled it.
                `initial={false}` keeps the stage from performing itself on
                arrival: only spokes that appear *later* have something to say. */}
            <AnimatePresence initial={false}>
              {devices.map((device, index) => {
                const role = roleOf(device.id, drawn);
                if (role === 'idle') return null;
                const { x0, y0, x1, y1 } = spoke(satellite(index, count).angle);
                return (
                  <motion.line
                    key={device.id}
                    data-wire={`${pid}:${device.id}`}
                    data-live={flows ? 'true' : undefined}
                    x1={x0}
                    y1={y0}
                    initial={{ x2: x0, y2: y0, opacity: 0 }}
                    animate={{ x2: x1, y2: y1, opacity: flows ? 1 : 0.6 }}
                    exit={{ x2: x0, y2: y0, opacity: 0 }}
                    transition={SPRING_GLIDE}
                    strokeWidth={3}
                    strokeLinecap="round"
                    className={`${TONE[role].wire} ${flows ? 'stage-flow' : ''}`}
                  />
                );
              })}
            </AnimatePresence>
          </svg>

          {/* The programme whose output this is. The hub shows the display
              name (the window's title when the program has one), while the
              level dial below keeps working on the exe — the name a person
              reads and the key the storage writes are deliberately different
              strings. */}
          <Hub
            cx={cx}
            cy={cy}
            exeName={session?.exe_name}
            name={session?.display_name ?? session?.exe_name}
            sounding={flows}
            hasPlan={hasPlan}
            showLevel={drawn.length > 1}
            canApply={canApply}
            applyAria={applyAria}
            onApply={() => void applyRoute()}
          />

          {devices.length === 0 && (
            <p className="absolute inset-x-0 top-1/2 -translate-y-1/2 text-center text-[11px] text-text-muted">
              {t('settings.noDevices')}
            </p>
          )}

          {devices.map((device, index) => (
            <Satellite
              key={device.id}
              deviceId={device.id}
              name={device.name}
              role={roleOf(device.id, drawn)}
              isDefaultDevice={device.id === defaultDeviceId}
              showTuner={drawn.length > 1}
              canPromote={drawn.length > 1 && (deviceDelays[device.id] ?? 0) === primaryDelayMs}
              canPick={pid !== undefined}
              index={index}
              count={count}
              position={satellite(index, count)}
              onToggle={() => {
                // Picking devices is a toggle, not a mode: the first one chosen
                // is what the system plays directly, the ones after it are
                // copies. The route may never be empty, so the last one out
                // stays in — a programme with nowhere to play is not a state
                // this app offers. A press that changes nothing sends no ripple.
                const onlyOneLeft = drawn.length === 1 && drawn[0] === device.id;
                if (onlyOneLeft) return;
                pushRipple(satellite(index, count).x, satellite(index, count).y);
                toggleDeviceSelection(device.id);
              }}
              onPromote={() => promoteDevice(device.id)}
            />
          ))}

          {/* Ripples ride above the discs: a concentric wave leaving the thing
              that was just pressed, then gone. */}
          <AnimatePresence>
            {ripples.map((ripple) => (
              <Ripple
                key={ripple.id}
                x={ripple.x}
                y={ripple.y}
                onDone={() => dismissRipple(ripple.id)}
              />
            ))}
          </AnimatePresence>
        </div>
      </div>
    </section>
  );
}

/**
 * One concentric ripple: a ring the size of a disc, expanding out of the point
 * that changed and fading as it leaves. It is the stage's way of saying "that
 * one just changed" without a word, and it is concentric by construction — the
 * same circle as the disc it leaves, growing.
 */
function Ripple({ x, y, onDone }: { x: number; y: number; onDone: () => void }) {
  return (
    <motion.span
      aria-hidden="true"
      className="pointer-events-none absolute rounded-full border-2 border-accent/50"
      style={{ left: x, top: y, width: DISC_D, height: DISC_D, x: '-50%', y: '-50%' }}
      initial={{ scale: 0.7, opacity: 0.6 }}
      animate={{ scale: 2.2, opacity: 0 }}
      exit={{ opacity: 0 }}
      transition={RIPPLE}
      onAnimationComplete={onDone}
    />
  );
}

/** The programme at the centre of the ring — and, when a plan is waiting, the button that lands it. */
function Hub({
  cx,
  cy,
  exeName,
  name,
  sounding,
  hasPlan,
  showLevel,
  canApply,
  applyAria,
  onApply,
}: {
  cx: number;
  cy: number;
  /** The executable name, which the level storage is keyed by. */
  exeName: string | undefined;
  /** What the hub says: the display name when the backend found one. */
  name: string | undefined;
  sounding: boolean;
  hasPlan: boolean;
  showLevel: boolean;
  /** Whether pressing the hub right now would change anything. */
  canApply: boolean;
  /** What the press would do, as a sentence for screen readers. */
  applyAria: string;
  onApply: () => void;
}) {
  const { t } = useTranslation();

  // The hub leans in by a hair once there is a plan: it is the thing the
  // spokes come from, and a centre that acknowledges that reads as the
  // cause of the ring rather than as a label floating in it. With nothing
  // attached it is a thinner, clearer piece of the same glass; the thick
  // glossy lens is reserved for a centre that is actually wired.
  // A true circle, not a squircle: the hub is the innermost member of a
  // concentric family (halo, orbit, discs, rings), and a superellipse here
  // would make the whole ring read as squares standing on a circle.
  const discClass = `group/hub relative flex flex-col items-center justify-center gap-1 rounded-full px-2 outline-none ${
    hasPlan ? 'glass-strong' : 'glass-thin'
  }`;
  const content = (
    <>
      <Ring size={22} tone={hasPlan ? 'main' : 'idle'} live={sounding} />
      {/* The icon belongs to the file, so it swaps only when the programme
          changes — a window that retitles itself swaps the name below and
          leaves the icon standing. The swap is small and stays in the slot:
          the old icon lets go (fades, shrinking a little), the new one
          springs into place — a pop, not the name's slide, and no travel
          across the hub. The wrapper is exactly the icon's slot, so nothing
          shifts while one identity replaces the other. */}
      <AnimatePresence mode="wait" initial={false}>
        {exeName !== undefined && (
          <motion.span
            key={exeName}
            initial={{ opacity: 0, scale: 0.7 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.6 }}
            transition={SPRING_TAP}
            className="flex flex-none"
          >
            <ProcessIcon exeName={exeName} name={name ?? exeName} size={24} />
          </motion.span>
        )}
      </AnimatePresence>
      {/* The name is not overwritten when another programme is picked — or
          when this one's window retitles itself: it is swapped. Two names
          cross-fading would read as one programme being renamed, which is not
          a thing that happens here. */}
      <AnimatePresence mode="wait" initial={false}>
        <motion.span
          key={name ?? '__none__'}
          initial={{ opacity: 0, y: 5 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -5 }}
          transition={FADE}
          className="flex max-w-full flex-col items-center gap-1"
        >
          {name === undefined ? (
            <span className="px-1 text-[11px] leading-tight text-text-muted">
              {t('stage.guide')}
            </span>
          ) : (
            <>
              <span className="max-w-full truncate text-[12.5px] font-medium leading-tight text-text-primary">
                {name}
              </span>
              <span className="text-[9.5px] leading-none text-text-muted">
                {sounding ? t('stage.sounding') : t('stage.quiet')}
              </span>
            </>
          )}
        </motion.span>
      </AnimatePresence>
    </>
  );

  return (
    <motion.div
      initial={{ scale: 0.88, opacity: 0 }}
      animate={{ scale: 1, opacity: 1 }}
      transition={SPRING_ARRIVE}
      className="absolute flex flex-col items-center justify-center gap-1 text-center"
      style={{ left: cx - HUB_D / 2, top: cy - HUB_D / 2, width: HUB_D, height: HUB_D }}
    >
      {/* The disc and its badge share one wrapper so the badge tracks the rim
          even when the level dial below pulls the flex column taller than the
          hub box itself. */}
      <div className="relative flex-none">
        {name === undefined ? (
          <motion.div className={discClass} style={{ width: HUB_D, height: HUB_D }}>
            {content}
          </motion.div>
        ) : (
          <motion.button
            type="button"
            data-source-node="subject"
            disabled={!canApply}
            aria-label={canApply ? applyAria : undefined}
            onClick={onApply}
            animate={{ scale: hasPlan ? 1.03 : 1 }}
            whileHover={canApply ? { scale: 1.05 } : undefined}
            // The press is the confirmation now: this button changes what
            // everybody hears, so it squashes rather than shrinking, the way a
            // soft body deforms under a finger.
            whileTap={canApply ? { scaleX: 1.06, scaleY: 0.9 } : undefined}
            transition={SPRING_TAP}
            className={`${discClass} ${canApply ? 'cursor-pointer' : 'cursor-default'} focus-visible:ring-2 focus-visible:ring-accent/60`}
            style={{ width: HUB_D, height: HUB_D }}
          >
            {content}
            {/* Approaching an actionable hub draws a second circle around it —
                the same cue the discs use, so the pressable thing on this stage
                all speak one language. */}
            {canApply && (
              <span
                aria-hidden="true"
                className="pointer-events-none absolute -inset-2 rounded-full border border-accent/45 opacity-0 transition-opacity duration-200 group-hover/hub:opacity-100"
              />
            )}
          </motion.button>
        )}
        {/* The press-me badge: when what is drawn is not what is playing, the
            hub is the button that makes them the same. It straddles the rim so
            it reads as attached to the disc rather than as a sixth satellite,
            and it is gone the moment the answer is on screen. A press that
            would change nothing leaves no badge and no cursor. */}
        <AnimatePresence>
          {canApply && (
            <motion.span
              key="hub-apply"
              aria-hidden="true"
              initial={{ opacity: 0, x: '-50%', y: 6, scale: 0.8 }}
              animate={{ opacity: 1, x: '-50%', y: 0, scale: 1 }}
              exit={{ opacity: 0, x: '-50%', y: 6, scale: 0.8 }}
              transition={SPRING_TAP}
              className="pointer-events-none absolute left-1/2 z-10"
              style={{ top: HUB_D - 9 }}
            >
              <span className="squircle block rounded-full bg-accent px-2 py-[3px] text-[10px] font-medium leading-none text-accent-ink shadow-md shadow-accent/25">
                {t('stage.applyHint')}
              </span>
            </motion.span>
          )}
        </AnimatePresence>
      </div>
      {/* A level only has anywhere to act while an engine is carrying this
          programme's audio to more than one device, which is the same gate the
          copies' own sliders live behind. */}
      {showLevel && exeName !== undefined && (
        <SourceLevelDial exeName={exeName} displayName={name} />
      )}
    </motion.div>
  );
}

/**
 * One output device, drawn as a glass disc orbiting the hub.
 *
 * The name rides under the disc rather than inside it, and the tuners under
 * that: a control inside the control you press is a control nobody reaches,
 * least of all by keyboard. The label line is always reserved — one device
 * being the system default would otherwise push its own name half a line up,
 * and six names that do not share a baseline read as a mistake.
 *
 * In a plan with more than one device, the copy's role word is also the way to
 * change the job: pointing at it turns "Copy" into the promotion, because
 * which device plays directly is a position to move, not a fact to read. A
 * copy whose delay compensation is larger than the primary's keeps the plain
 * word and a title that says why — the system plays the primary directly, and
 * software delay cannot pull a later device earlier.
 */
function Satellite({
  deviceId,
  name,
  role,
  isDefaultDevice,
  showTuner,
  canPromote,
  canPick,
  index,
  count,
  position,
  onToggle,
  onPromote,
}: {
  deviceId: string;
  name: string;
  role: StageRole;
  isDefaultDevice: boolean;
  showTuner: boolean;
  /** Whether promoting this device would survive the apply's delay order. */
  canPromote: boolean;
  canPick: boolean;
  index: number;
  count: number;
  position: { x: number; y: number };
  onToggle: () => void;
  onPromote: () => void;
}) {
  const { t } = useTranslation();
  const tone = TONE[role];
  const lit = role !== 'idle';
  const from = approach(index, count);

  return (
    <div
      data-device-row={deviceId}
      className="absolute"
      style={{ left: position.x, top: position.y, transform: 'translate(-50%, -50%)' }}
    >
      <motion.div
        // Arrival: out of the hub, along this disc's own bearing, staggered so
        // the ring assembles clockwise. A device that is part of no route holds
        // back — the ring's silhouette is made of the devices that are doing
        // something, and the rest are there to be picked.
        initial={{ x: from.x, y: from.y, scale: 0.55, opacity: 0 }}
        animate={{ x: 0, y: 0, scale: 1, opacity: lit ? 1 : 0.72 }}
        whileHover={{ scale: 1.05, opacity: 1 }}
        transition={{ ...SPRING_ARRIVE, delay: Math.min(index * 0.045, 0.24) }}
        className="group/disc flex flex-col items-center"
      >
        <div className="relative">
          {/* Approaching a disc draws a second circle around it, one the disc
              does not have to re-paint to show: opacity, not shadow, so the
              hover costs nothing and cannot fight the bloom beneath it. */}
          <span
            aria-hidden="true"
            className="pointer-events-none absolute -inset-2 rounded-full border border-accent/45 opacity-0 transition-opacity duration-200 group-focus-within/disc:opacity-100 group-hover/disc:opacity-100"
          />
          <motion.button
            type="button"
            onClick={onToggle}
            aria-pressed={lit}
            aria-label={name}
            title={name}
            // A press flattens the droplet rather than shrinking it: wider and
            // shorter, the way a bead of liquid deforms under a finger, then
            // springs back round. Uniform scale would read as a sticker peeling.
            whileTap={{ scaleX: 1.08, scaleY: 0.88 }}
            transition={SPRING_TAP}
            className={`relative flex items-center justify-center rounded-full ${tone.outline} ${tone.wash} ${
              lit ? 'glass-strong' : 'glass-thin'
            } outline-none transition-colors hover:border-accent/60 focus-visible:ring-2 focus-visible:ring-accent/60`}
            style={{ width: DISC_D, height: DISC_D, ...bloom(role) }}
          >
            {/* The core of the ring is what lights up, and it arrives rather
                than appearing: a disc that is suddenly on is a disc you want to
                have watched turn on. */}
            <motion.span animate={{ scale: lit ? 1 : 0.8 }} transition={SPRING_TAP}>
              <Ring
                size={24}
                tone={role === 'primary' ? 'main' : role === 'mirror' ? 'copy' : 'idle'}
              />
            </motion.span>
          </motion.button>
        </div>

        <span
          className={`mt-2 max-w-[104px] truncate text-center text-[11px] leading-tight transition-colors ${
            lit
              ? 'font-medium text-text-primary'
              : 'text-text-secondary group-hover/disc:text-text-primary'
          }`}
        >
          {name}
        </span>

        {/* The role word is replaced, not rewritten: `Copy` slides out as
            `Main` slides in, so a device changing job is something you see
            happen rather than something you have to notice afterwards. In a
            multi-device plan the copy's word wears a dotted underline and
            offers the promotion on approach — the word that says what a device
            is doing is the word that changes what it is doing. */}
        <span
          className={`mt-0.5 flex justify-center text-center text-[9.5px] leading-none ${tone.label}`}
          style={{ minHeight: 12 }}
        >
          <AnimatePresence mode="wait" initial={false}>
            {role === 'primary' || role === 'mirror' ? (
              <motion.span
                key={role}
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                transition={FADE}
              >
                {role === 'primary' ? (
                  t('stage.main')
                ) : canPromote ? (
                  <button
                    type="button"
                    onClick={onPromote}
                    title={t('stage.promoteTitle')}
                    aria-label={t('stage.promote')}
                    className="group/promote cursor-pointer rounded-[5px] outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
                  >
                    <span className="underline decoration-type-mirror/50 decoration-dotted underline-offset-2 group-focus-within/promote:hidden group-hover/promote:hidden">
                      {t('stage.copy')}
                    </span>
                    <span className="hidden group-focus-within/promote:inline group-hover/promote:inline">
                      {t('stage.promote')}
                    </span>
                  </button>
                ) : (
                  <span title={t('stage.promoteBlockedTitle')}>{t('stage.copy')}</span>
                )}
              </motion.span>
            ) : isDefaultDevice ? (
              <motion.span
                key="default"
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                transition={FADE}
              >
                {t('stage.defaultLabel')}
              </motion.span>
            ) : null}
          </AnimatePresence>
        </span>

        {/* Delay and level belong to a copy for one reason: the system plays the
            route's first device itself, so there is no stream of ours on it for a
            delay to hold back or a gain to attenuate. Shown only when there is a
            copy to tune, which is also the only time they can do anything. */}
        <AnimatePresence initial={false}>
          {canPick && role === 'mirror' && showTuner && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              transition={SPRING_GLIDE}
              className="overflow-hidden"
            >
              <Tuner deviceId={deviceId} />
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>
    </div>
  );
}

/** How much one press moves a device's level, in percent. */
const VOLUME_STEP = 5;

/**
 * One copy's two controls: how far behind the others it plays, and how loud.
 *
 * Buttons and nothing else — no dragging, no wheel. Twenty devices' worth of
 * scrolling in a list of numbers is not a mistake anyone should be able to make
 * by resting a finger, and these two change what you hear.
 */
function Tuner({ deviceId }: { deviceId: string }) {
  const { t } = useTranslation();
  const delayRangeMs = useRouterStore((s) => s.delayRangeMs);
  const stepMs = useRouterStore((s) => s.delayStepMs);
  const delayMs = useRouterStore((s) => s.deviceDelays[deviceId] ?? 0);
  const volume = useRouterStore((s) => s.deviceVolumes[deviceId] ?? 100);
  const latencyMs = useRouterStore((s) => s.deviceLatencyMs[deviceId]);
  const setDeviceDelayValue = useRouterStore((s) => s.setDeviceDelayValue);
  const setDeviceVolume = useRouterStore((s) => s.setDeviceVolume);

  return (
    <div className="mt-1 flex flex-col items-center gap-1">
      <Row
        title={latencyMs === undefined ? undefined : t('deviceLatency.reading', { ms: latencyMs })}
        downLabel={t('deviceDelay.stepDown', { step: formatStep(stepMs) })}
        upLabel={t('deviceDelay.stepUp', { step: formatStep(stepMs) })}
        value={`${delayMs} ms`}
        atMin={delayMs <= -delayRangeMs}
        atMax={delayMs >= delayRangeMs}
        onChange={(direction) => {
          const next = Math.max(
            -delayRangeMs,
            Math.min(delayRangeMs, delayMs + direction * stepMs),
          );
          void setDeviceDelayValue(deviceId, next);
        }}
      />
      <Row
        title={undefined}
        downLabel={t('deviceVolume.stepDown', { step: VOLUME_STEP })}
        upLabel={t('deviceVolume.stepUp', { step: VOLUME_STEP })}
        value={`${volume}%`}
        atMin={volume <= 0}
        atMax={volume >= 100}
        onChange={(direction) => {
          const next = Math.max(0, Math.min(100, volume + direction * VOLUME_STEP));
          void setDeviceVolume(deviceId, next);
        }}
      />
    </div>
  );
}

/** A −/value/+ triple, small enough to sit under a disc. */
function Row({
  title,
  downLabel,
  upLabel,
  value,
  atMin,
  atMax,
  onChange,
}: {
  title: string | undefined;
  downLabel: string;
  upLabel: string;
  value: string;
  atMin: boolean;
  atMax: boolean;
  onChange: (direction: 1 | -1) => void;
}) {
  return (
    <div className="flex items-center gap-1" title={title}>
      <MiniStep label={downLabel} disabled={atMin} onClick={() => onChange(-1)}>
        <line x1="1" y1="5" x2="9" y2="5" />
      </MiniStep>
      {/* The value rolls to its new number instead of being replaced in place:
          a figure that changes under your finger without moving is easy to miss,
          and "did that press do anything" is not a question worth asking twice. */}
      <span className="relative inline-flex h-4 w-[44px] items-center justify-center overflow-hidden">
        <AnimatePresence initial={false} mode="popLayout">
          <motion.span
            key={value}
            initial={{ y: 10, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: -10, opacity: 0 }}
            transition={SPRING_TAP}
            className="font-mono text-[10px] tabular-nums text-text-secondary"
          >
            {value}
          </motion.span>
        </AnimatePresence>
      </span>
      <MiniStep label={upLabel} disabled={atMax} onClick={() => onChange(1)}>
        <line x1="1" y1="5" x2="9" y2="5" />
        <line x1="5" y1="1" x2="5" y2="9" />
      </MiniStep>
    </div>
  );
}

/**
 * The ± of a tuner row. A sixteenth the size of the settings stepper, because
 * this one has to fit under a disc — and the press is the feedback, since a
 * control this small has no room to show a state of its own.
 */
function MiniStep({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <motion.button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      whileHover={disabled ? undefined : { scale: 1.18 }}
      whileTap={disabled ? undefined : { scale: 0.82 }}
      transition={SPRING_TAP}
      className="squircle flex h-4 w-4 flex-none items-center justify-center rounded-[5px] border border-glass-border bg-glass text-text-secondary outline-none transition-colors hover:border-accent/50 hover:text-accent focus-visible:ring-2 focus-visible:ring-accent/60 disabled:cursor-default disabled:opacity-40"
    >
      <svg
        width="8"
        height="8"
        viewBox="0 0 10 10"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        aria-hidden="true"
      >
        {children}
      </svg>
    </motion.button>
  );
}
