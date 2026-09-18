import { useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { DeviceAnnotation } from '@/components/DeviceAnnotation';
import { useFitScale } from '@/hooks/useFitScale';
import { useRouterStore } from '@/stores/routerStore';

/** Fixed design size of the router stage; the whole stage is scaled to fit. */
const STAGE_SIZE = 460;
const ORBIT_RADIUS = 164;
const CENTER = STAGE_SIZE / 2;
/** Widest a device capsule may get, derived rather than picked: a node at the
 *  horizontal extreme of the orbit is `ORBIT_RADIUS` from the centre, so
 *  anything wider than the room left on either side would spill out of the
 *  stage. Capsules size to their content up to this, so a short name makes a
 *  short chip; a name longer than this truncates, and the full one stays in the
 *  tooltip and in the settings list. The delay is annotated *under* the
 *  capsule, not inside it, so this budget belongs to the name alone — and no
 *  hover or edit ever changes a width here. */
const MAX_NODE_WIDTH = 2 * (CENTER - ORBIT_RADIUS);
/** Perpendicular bow of the route curves: everything bends the same way,
 * which reads as one flow around the hub instead of rigid spokes. */
const CURVE_BOW = 30;

function deviceOffset(index: number, total: number): { x: number; y: number } {
  const angle = (index / total) * Math.PI * 2 - Math.PI / 2;
  return { x: Math.cos(angle) * ORBIT_RADIUS, y: Math.sin(angle) * ORBIT_RADIUS };
}

/** Quadratic curve from the centre to a device at offset (x, y). */
function routePath(x: number, y: number): string {
  const cx = CENTER + x / 2 - (y / ORBIT_RADIUS) * CURVE_BOW;
  const cy = CENTER + y / 2 + (x / ORBIT_RADIUS) * CURVE_BOW;
  return `M ${CENTER} ${CENTER} Q ${cx} ${cy} ${CENTER + x} ${CENTER + y}`;
}

/**
 * Concentric circle router visualization.
 *
 * One quiet composition: a frosted-glass hub, a hairline orbit, and the
 * selected devices sitting on it, linked to the hub by faint flowing curves
 * that diffuse under the frosted glass. Restraint over decoration — motion is
 * reserved for state: selecting, routing, living routes. Devices of the current
 * route also carry their delay bubble, so latency is adjusted where the device
 * is rather than in a panel of its own.
 */
export function ConcentricRouter() {
  const { t } = useTranslation();
  const devices = useRouterStore((s) => s.devices);
  const sessions = useRouterStore((s) => s.sessions);
  const selectedPids = useRouterStore((s) => s.selectedPids);
  const selectedDeviceIds = useRouterStore((s) => s.selectedDeviceIds);
  const routedPids = useRouterStore((s) => s.routedPids);
  const defaultDeviceId = useRouterStore((s) => s.defaultDeviceId);
  const delayRangeMs = useRouterStore((s) => s.delayRangeMs);
  const toggleDeviceSelection = useRouterStore((s) => s.toggleDeviceSelection);
  const applyRoute = useRouterStore((s) => s.applyRoute);
  const { ref, scale } = useFitScale(STAGE_SIZE);
  const [rippleKey, setRippleKey] = useState(0);
  const [showRipple, setShowRipple] = useState(false);
  const latestRippleKey = useRef(0);

  const selectedCount = selectedPids.length;
  const isMulti = selectedCount > 1;
  const primarySession = sessions.find((s) => s.pid === selectedPids[0]);
  // Union of devices the selected processes are currently routed to.
  const activeIds =
    selectedCount === 0 ? [] : [...new Set(selectedPids.flatMap((pid) => routedPids[pid] ?? []))];
  const canRoute = selectedCount > 0 && selectedDeviceIds.length > 0;

  const handleRoute = async () => {
    if (!canRoute) return;
    const nextKey = rippleKey + 1;
    latestRippleKey.current = nextKey;
    setRippleKey(nextKey);
    setShowRipple(true);
    await applyRoute();
  };

  const orbitBox = {
    left: CENTER - ORBIT_RADIUS,
    top: CENTER - ORBIT_RADIUS,
    width: ORBIT_RADIUS * 2,
    height: ORBIT_RADIUS * 2,
  };

  return (
    <div ref={ref} className="relative flex h-full w-full items-center justify-center">
      <div
        className="relative flex items-center justify-center"
        style={{ width: STAGE_SIZE, height: STAGE_SIZE, transform: `scale(${scale})` }}
      >
        {/* Soft glow giving the hub depth, without a hard shape */}
        <div
          className="pointer-events-none absolute h-60 w-60 -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent/10 blur-3xl"
          style={{ left: CENTER, top: CENTER }}
        />

        {/* Hairline orbits + a lone dot circling the outer one (the only idle motion) */}
        <div
          className="pointer-events-none absolute rounded-full border border-border/50"
          style={orbitBox}
        />
        <div
          className="pointer-events-none absolute rounded-full border border-border/30"
          style={{ left: CENTER - 118, top: CENTER - 118, width: 236, height: 236 }}
        />
        <motion.div
          className="pointer-events-none absolute"
          style={orbitBox}
          animate={{ rotate: 360 }}
          transition={{ duration: 80, repeat: Infinity, ease: 'linear' }}
        >
          <span className="absolute left-1/2 top-0 h-1 w-1 -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent/50" />
        </motion.div>

        {/* Route ripple — one soft wave */}
        <AnimatePresence>
          {showRipple && (
            <motion.div
              key={rippleKey}
              className="pointer-events-none absolute rounded-full border border-accent/50"
              style={{ left: CENTER - 76, top: CENTER - 76, width: 152, height: 152 }}
              initial={{ scale: 1, opacity: 0.5 }}
              animate={{ scale: 2.3, opacity: 0 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.9, ease: 'easeOut' }}
              onAnimationComplete={() => {
                // A newer ripple (rapid re-click) must not be hidden by this one.
                if (rippleKey === latestRippleKey.current) setShowRipple(false);
              }}
            />
          )}
        </AnimatePresence>

        {/* Flowing links: centre → each selected device; the segment passing
            under the frosted hub diffuses into it like light through glass */}
        <svg
          className="pointer-events-none absolute inset-0"
          width={STAGE_SIZE}
          height={STAGE_SIZE}
          viewBox={`0 0 ${STAGE_SIZE} ${STAGE_SIZE}`}
          fill="none"
          aria-hidden="true"
        >
          <AnimatePresence>
            {selectedDeviceIds.map((id, routeIndex) => {
              const deviceIndex = devices.findIndex((d) => d.id === id);
              if (deviceIndex < 0) return null;
              const { x, y } = deviceOffset(deviceIndex, devices.length);
              const isLive = activeIds.includes(id);
              return (
                <motion.path
                  key={id}
                  d={routePath(x, y)}
                  stroke="var(--accent)"
                  strokeOpacity={isLive ? 0.75 : 0.3}
                  strokeWidth={isLive ? 2 : 1.5}
                  strokeLinecap="round"
                  strokeDasharray="2 7"
                  style={isLive ? { filter: 'drop-shadow(0 0 5px var(--accent-glow))' } : undefined}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1, strokeDashoffset: [0, -18] }}
                  exit={{ opacity: 0, transition: { duration: 0.25 } }}
                  transition={{
                    opacity: { duration: 0.4, delay: routeIndex * 0.05 },
                    strokeDashoffset: { duration: 1.8, repeat: Infinity, ease: 'linear' },
                  }}
                />
              );
            })}
          </AnimatePresence>
        </svg>

        {/* Orbit — devices (multi-select) */}
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="relative" style={{ width: ORBIT_RADIUS * 2, height: ORBIT_RADIUS * 2 }}>
            <AnimatePresence>
              {devices.map((device, i) => {
                const { x, y } = deviceOffset(i, devices.length);
                const selectionIndex = selectedDeviceIds.indexOf(device.id);
                const isSelected = selectionIndex >= 0;
                const isPrimary = selectionIndex === 0;
                const isLive = activeIds.includes(device.id);

                return (
                  // Outer div carries the position animation: framer-motion
                  // writes x/y into an inline transform, which would override
                  // centering translate classes on the elements inside it.
                  <motion.div
                    key={device.id}
                    initial={{ opacity: 0, scale: 0 }}
                    animate={{ opacity: 1, scale: 1, x, y }}
                    exit={{ opacity: 0, scale: 0 }}
                    transition={{
                      type: 'spring',
                      stiffness: 260,
                      damping: 22,
                      delay: i * 0.04,
                    }}
                    className="absolute left-1/2 top-1/2 hover:z-10 focus-within:z-10"
                  >
                    {/* `group/device` is the node as a whole: the capsule plus
                        the delay annotated under it. Absolute positioning is
                        what keeps them independent — the number never changes
                        the capsule's width, and the capsule never changes the
                        number's place on the stage. */}
                    <div className="group/device relative -translate-x-1/2 -translate-y-1/2">
                      {/* System default endpoint: the device every unrouted
                          process already plays through. */}
                      {device.id === defaultDeviceId && (
                        <span
                          title={t('router.defaultDevice')}
                          className="absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full bg-text-muted/80 ring-2 ring-bg-secondary"
                        />
                      )}
                      {/* Live halo: an expanding ring behind routed devices. */}
                      {isLive && (
                        <motion.span
                          aria-hidden="true"
                          className="absolute inset-0 rounded-full border border-accent/40"
                          animate={{ scale: [1, 1.35], opacity: [0.5, 0] }}
                          transition={{ duration: 2.4, repeat: Infinity, ease: 'easeOut' }}
                        />
                      )}
                      {/* The capsule is the device name and nothing else; the
                          delay hangs under it as an annotation. */}
                      <div
                        style={{ maxWidth: MAX_NODE_WIDTH }}
                        className={`relative flex items-center rounded-full border px-2.5 py-1 text-[11px] font-medium transition-[color,background-color,border-color,box-shadow] ${
                          isPrimary
                            ? 'border-accent/70 bg-accent-muted text-accent shadow-glow'
                            : isSelected
                              ? 'bg-accent-muted/70 border-accent/50 text-accent'
                              : 'border-glass bg-glass-strong text-text-secondary shadow-glass hover:border-accent/40 hover:text-accent'
                        }`}
                      >
                        {/* The name takes the room it needs; the capsule's own
                            cap is the only thing that truncates it. */}
                        <motion.button
                          type="button"
                          onClick={(e) => {
                            toggleDeviceSelection(device.id);
                            // A mouse click would otherwise leave the button
                            // focused, and the next Space would silently undo
                            // the selection just made. Keyboard activation
                            // (detail 0) keeps the focus it needs.
                            if (e.detail > 0) e.currentTarget.blur();
                          }}
                          whileTap={{ scale: 0.94 }}
                          transition={{ type: 'spring', stiffness: 420, damping: 26 }}
                          title={device.name}
                          className="flex min-w-0 items-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
                        >
                          <span className="truncate">{device.name}</span>
                        </motion.button>
                        {isSelected && (
                          <motion.span
                            key={selectionIndex}
                            initial={{ scale: 0 }}
                            animate={{ scale: 1 }}
                            transition={{ type: 'spring', stiffness: 500, damping: 24 }}
                            className={`absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full text-[9px] font-semibold leading-none ${
                              isPrimary ? 'bg-accent text-white' : 'bg-accent/80 text-white'
                            }`}
                          >
                            {selectionIndex + 1}
                          </motion.span>
                        )}
                        {isLive && !isSelected && (
                          <span className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-success ring-2 ring-bg-secondary" />
                        )}
                      </div>
                      {/* A device you are working with shows its delay and
                          volume; so does any device that carries an offset or a
                          level change, selected or not. */}
                      <DeviceAnnotation
                        deviceId={device.id}
                        name={device.name}
                        rangeMs={delayRangeMs}
                        isSelected={isSelected}
                      />
                    </div>
                  </motion.div>
                );
              })}
            </AnimatePresence>
          </div>
        </div>

        {/* Centre — frosted-glass hub */}
        <div
          className="absolute z-10"
          style={{ left: CENTER, top: CENTER, transform: 'translate(-50%, -50%)' }}
        >
          {canRoute && (
            <motion.div
              aria-hidden="true"
              className="absolute -inset-2 rounded-full border border-accent/30"
              animate={{ opacity: [0.15, 0.4, 0.15], scale: [1, 1.03, 1] }}
              transition={{ duration: 3.6, repeat: Infinity, ease: 'easeInOut' }}
            />
          )}
          <motion.button
            type="button"
            onClick={handleRoute}
            disabled={!canRoute}
            title={
              canRoute
                ? selectedPids
                    .map((pid) => sessions.find((s) => s.pid === pid)?.exe_name ?? `PID ${pid}`)
                    .join(' · ')
                : undefined
            }
            whileHover={canRoute ? { scale: 1.04 } : undefined}
            whileTap={canRoute ? { scale: 0.97 } : undefined}
            transition={{ type: 'spring', stiffness: 380, damping: 24 }}
            className={`relative flex h-36 w-36 flex-col items-center justify-center rounded-full border outline-none backdrop-blur-2xl transition-[color,background-color,border-color,box-shadow] focus-visible:ring-2 focus-visible:ring-accent/60 ${
              canRoute
                ? 'cursor-pointer border-accent/40 bg-white/50 shadow-glow dark:bg-white/[0.07]'
                : 'cursor-default border-white/60 bg-white/40 shadow-glass dark:border-white/10 dark:bg-white/[0.05]'
            }`}
          >
            {/* inner rim keeps the disc reading as curved glass */}
            <span
              aria-hidden="true"
              className="pointer-events-none absolute inset-[6px] rounded-full border border-white/50 dark:border-white/[0.05]"
            />
            <AnimatePresence mode="wait">
              {primarySession ? (
                <motion.div
                  key={selectedPids.join(',')}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -8 }}
                  transition={{ type: 'spring', stiffness: 400, damping: 30 }}
                  className="flex flex-col items-center gap-2 px-5 text-center"
                >
                  <span className="flex h-9 w-9 flex-none items-center justify-center rounded-full bg-accent text-white shadow-glow">
                    <svg
                      width="13"
                      height="13"
                      viewBox="0 0 24 24"
                      fill="currentColor"
                      aria-hidden="true"
                    >
                      <polygon points="6 3 21 12 6 21 6 3" />
                    </svg>
                  </span>
                  <span className="max-w-[104px] truncate text-[13px] font-semibold leading-tight text-text-primary">
                    {isMulti
                      ? t('router.processCount', { n: selectedCount })
                      : primarySession.exe_name}
                  </span>
                  <span
                    className={`text-[10px] leading-none ${
                      canRoute
                        ? 'font-medium text-accent'
                        : activeIds.length > 0
                          ? 'font-medium text-success'
                          : 'text-text-muted'
                    }`}
                  >
                    {canRoute
                      ? selectedDeviceIds.length > 1
                        ? t('router.clickToRouteMulti', { n: selectedDeviceIds.length })
                        : t('router.clickToRoute')
                      : activeIds.length > 0
                        ? t('router.routedActive', { n: activeIds.length })
                        : t('router.selectDevice')}
                  </span>
                </motion.div>
              ) : (
                <motion.div
                  key="empty"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  className="flex flex-col items-center gap-2.5 px-5 text-center"
                >
                  <span className="flex h-9 w-9 flex-none items-center justify-center rounded-full bg-bg-tertiary text-text-muted">
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      aria-hidden="true"
                    >
                      <circle cx="12" cy="12" r="10" />
                      <path d="M12 16v-4M12 8h.01" />
                    </svg>
                  </span>
                  <span className="text-[10px] leading-tight text-text-muted">
                    {t('router.selectProcess')}
                  </span>
                </motion.div>
              )}
            </AnimatePresence>
          </motion.button>
        </div>
      </div>
    </div>
  );
}
