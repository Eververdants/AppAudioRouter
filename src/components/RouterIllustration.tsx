import { useEffect, useState } from 'react';
import { motion, useAnimation } from 'framer-motion';
import { useTranslation } from 'react-i18next';

/** Interactive re-draw of the app's concentric router, used as the hero
 *  visual. Same composition as `ConcentricRouter.tsx` in the app — the routed
 *  process in the centre, playback devices as capsules on an orbit ring,
 *  curved route lines with a perpendicular bow — and the same core gesture:
 *  click devices to pick targets, click the centre to apply or stop the route.
 *  Route lines draw in with a pathLength tween when applied; live devices
 *  carry the ripple pulse. Drawn once at a fixed design size; the SVG scales
 *  to its container, so no fit-scale logic is needed here. */

const STAGE_SIZE = 460;
const CENTER = STAGE_SIZE / 2;
const ORBIT_RADIUS = 150;
const CURVE_BOW = 30;

interface DeviceSpec {
  nameKey: string;
  /** Signed delay in ms and volume in percent, mirroring the values under a
   *  device node in the app. The Bluetooth figure is the README's own example
   *  for headset/speaker alignment. */
  delay: string;
  volume: string;
  /** Stable id; selection order (not this field) decides the route order. */
  id: number;
  angle: number;
}

const DEVICES: DeviceSpec[] = [
  {
    nameKey: 'hero.illustration.devices.hdmi',
    delay: '0 ms',
    volume: '100 %',
    id: 1,
    angle: -90,
  },
  {
    nameKey: 'hero.illustration.devices.usb',
    delay: '+60 ms',
    volume: '85 %',
    id: 2,
    angle: 30,
  },
  {
    nameKey: 'hero.illustration.devices.bluetooth',
    delay: '+180 ms',
    volume: '70 %',
    id: 3,
    angle: 150,
  },
];

function devicePoint(angle: number): { x: number; y: number } {
  const rad = (angle * Math.PI) / 180;
  return { x: CENTER + Math.cos(rad) * ORBIT_RADIUS, y: CENTER + Math.sin(rad) * ORBIT_RADIUS };
}

/** Quadratic curve from the centre to a device point, bowed the same way for
 *  every route so the group reads as one flow around the hub. */
function routePath(target: { x: number; y: number }): string {
  const dx = target.x - CENTER;
  const dy = target.y - CENTER;
  const cx = CENTER + dx / 2 - (dy / ORBIT_RADIUS) * CURVE_BOW;
  const cy = CENTER + dy / 2 + (dx / ORBIT_RADIUS) * CURVE_BOW;
  return `M ${CENTER} ${CENTER} Q ${cx} ${cy} ${target.x} ${target.y}`;
}

const spring = { type: 'spring', stiffness: 200, damping: 20 } as const;

const fillBox = { transformBox: 'fill-box', transformOrigin: 'center' } as const;

function activationKey(event: React.KeyboardEvent, action: () => void) {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    action();
  }
}

export function RouterIllustration() {
  const { t } = useTranslation();
  // Start fully routed so the first paint shows the live three-device route
  // from the README screenshot; everything is clickable from there.
  const [selected, setSelected] = useState<number[]>([1, 2, 3]);
  const [routing, setRouting] = useState(true);
  const centerControls = useAnimation();

  // Stopping is implicit: dropping the last selected device ends the route.
  useEffect(() => {
    if (routing && selected.length === 0) setRouting(false);
  }, [routing, selected.length]);

  const toggleDevice = (id: number) =>
    setSelected((prev) => (prev.includes(id) ? prev.filter((d) => d !== id) : [...prev, id]));

  const applyRoute = () => {
    if (selected.length === 0) {
      // Nothing to route: nudge the disc sideways instead of failing silently.
      void centerControls.start({
        x: [0, -7, 7, -4, 0],
        transition: { duration: 0.4, ease: 'easeInOut' },
      });
      return;
    }
    setRouting((r) => !r);
  };

  const statusText = routing
    ? t('hero.illustration.status.routing', { count: selected.length })
    : selected.length > 0
      ? t('hero.illustration.status.selecting', { count: selected.length })
      : t('hero.illustration.status.idle');
  const statusDot = routing
    ? 'bg-success animate-pulse'
    : selected.length > 0
      ? 'bg-accent'
      : 'bg-text-muted/50';

  return (
    <div className="relative mx-auto w-full max-w-[460px]">
      <svg
        viewBox={`0 0 ${STAGE_SIZE} ${STAGE_SIZE}`}
        role="img"
        aria-label={t('hero.illustration.label')}
        className="h-auto w-full select-none"
      >
        {/* Orbit ring */}
        <motion.circle
          cx={CENTER}
          cy={CENTER}
          r={ORBIT_RADIUS}
          fill="none"
          className="stroke-border"
          strokeWidth="1.5"
          strokeDasharray="3 7"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.8 }}
        />

        {/* Route lines, one per device in three visual states: a faint base
            always, a dashed preview once selected, and a drawn + flowing line
            while the route is live. */}
        {DEVICES.map((device) => {
          const point = devicePoint(device.angle);
          const isSelected = selected.includes(device.id);
          const isRouted = routing && isSelected;
          return (
            <g key={device.id}>
              <path
                d={routePath(point)}
                fill="none"
                className="stroke-accent/10"
                strokeWidth="3"
                strokeLinecap="round"
              />
              {isSelected && !isRouted && (
                <path
                  d={routePath(point)}
                  fill="none"
                  className="stroke-accent/40"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeDasharray="4 10"
                />
              )}
              <motion.path
                d={routePath(point)}
                fill="none"
                className="stroke-accent/45"
                strokeWidth="3"
                strokeLinecap="round"
                initial={false}
                animate={{ pathLength: isRouted ? 1 : 0, opacity: isRouted ? 1 : 0 }}
                transition={{ duration: 0.5, ease: 'easeOut' }}
              />
              {isRouted && (
                <path
                  d={routePath(point)}
                  fill="none"
                  className="route-flow stroke-accent"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeDasharray="6 22"
                />
              )}
            </g>
          );
        })}

        {/* Centre: the routed process. Clicking applies or stops the route.
            The ripple lives OUTSIDE the interactive group: its CSS scale
            animation would otherwise keep the group's bounding box moving
            (and the group's own geometry stable for hit-testing). */}
        <motion.g
          initial={{ opacity: 0, scale: 0.6 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={spring}
          style={fillBox}
        >
          {routing && (
            <circle
              cx={CENTER}
              cy={CENTER}
              r={46}
              fill="none"
              className="node-ripple stroke-accent/40"
              strokeWidth="1.5"
            />
          )}
          <motion.g
            onClick={applyRoute}
            onKeyDown={(event) => activationKey(event, applyRoute)}
            role="button"
            tabIndex={0}
            aria-label={t('hero.illustration.apply')}
            animate={centerControls}
            whileHover={{ scale: 1.04 }}
            whileTap={{ scale: 0.95 }}
            className="cursor-pointer focus:outline-none"
            style={fillBox}
          >
            <circle
              cx={CENTER}
              cy={CENTER}
              r={46}
              className="fill-glass-strong stroke-accent/50"
              strokeWidth="1.5"
            />
            {/* Waveform mark inside the process disc. */}
            <g className="stroke-accent" strokeWidth="2.4" strokeLinecap="round">
              <path d={`M ${CENTER - 14} ${CENTER - 8} v 16`} />
              <path d={`M ${CENTER - 7} ${CENTER - 14} v 28`} />
              <path d={`M ${CENTER} ${CENTER - 9} v 18`} />
              <path d={`M ${CENTER + 7} ${CENTER - 15} v 30`} />
              <path d={`M ${CENTER + 14} ${CENTER - 7} v 14`} />
            </g>
            <text
              x={CENTER}
              y={CENTER + 32}
              textAnchor="middle"
              className="fill-text-primary font-mono text-[13px] font-semibold"
            >
              {t('hero.illustration.process')}
            </text>
          </motion.g>
        </motion.g>

        {/* Devices on the outer ring. Clicking toggles the target. */}
        {DEVICES.map((device, index) => {
          const point = devicePoint(device.angle);
          const isSelected = selected.includes(device.id);
          const isRouted = routing && isSelected;
          const rank = isSelected ? selected.indexOf(device.id) : -1;
          return (
            <motion.g
              key={device.id}
              initial={{ opacity: 0, scale: 0.6 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ ...spring, delay: 0.15 + index * 0.12 }}
              style={fillBox}
            >
              {/* Ripple outside the interactive group, same reason as the
                  centre's: hit-testing geometry must not breathe. */}
              {isRouted && (
                <circle
                  cx={point.x}
                  cy={point.y}
                  r={34}
                  fill="none"
                  className="node-ripple stroke-accent/40"
                  strokeWidth="1.5"
                  style={{ animationDelay: `${index * 0.5}s` }}
                />
              )}
              <motion.g
                onClick={() => toggleDevice(device.id)}
                onKeyDown={(event) => activationKey(event, () => toggleDevice(device.id))}
                role="button"
                tabIndex={0}
                aria-pressed={isSelected}
                aria-label={`${t(device.nameKey)} — ${device.delay} · ${device.volume}`}
                whileHover={{ scale: 1.05 }}
                whileTap={{ scale: 0.97 }}
                animate={{ opacity: isSelected ? 1 : 0.72 }}
                className="cursor-pointer focus:outline-none"
                style={fillBox}
              >
                <rect
                  x={point.x - 55}
                  y={point.y - 26}
                  width={110}
                  height={52}
                  rx={26}
                  strokeWidth="1.5"
                  className={
                    isSelected
                      ? 'fill-glass-strong stroke-accent/70'
                      : 'fill-glass-strong stroke-glass'
                  }
                />
                <text
                  x={point.x}
                  y={point.y - 5}
                  textAnchor="middle"
                  className={`text-[13px] font-semibold ${
                    isSelected ? 'fill-text-primary' : 'fill-text-secondary'
                  }`}
                >
                  {t(device.nameKey)}
                </text>
                <text
                  x={point.x}
                  y={point.y + 15}
                  textAnchor="middle"
                  className="fill-text-muted font-mono text-[10.5px]"
                >
                  {device.delay} · {device.volume}
                </text>
              </motion.g>
              {/* Order badge: shown while selected, filled for the primary.
                  Sits outside the interactive group — its hidden state is a
                  scale(0) group, and degenerate geometry inside the
                  hit-tested group would break pointer targeting. */}
              <motion.g
                initial={false}
                animate={{ scale: isSelected ? 1 : 0 }}
                transition={spring}
                style={fillBox}
              >
                <circle
                  cx={point.x + 48}
                  cy={point.y - 20}
                  r={9}
                  strokeWidth="1"
                  className={
                    rank === 0 ? 'fill-accent stroke-accent' : 'fill-bg-primary stroke-border'
                  }
                />
                <text
                  x={point.x + 48}
                  y={point.y - 16.5}
                  textAnchor="middle"
                  className={`text-[9.5px] font-semibold ${
                    rank === 0 ? 'fill-white dark:fill-bg-primary' : 'fill-text-secondary'
                  }`}
                >
                  {rank + 1}
                </text>
              </motion.g>
            </motion.g>
          );
        })}
      </svg>

      {/* Status pill floating under the stage, mirroring the app's live-route
          state; content swaps with a small pop when the state changes. */}
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.7, duration: 0.4 }}
        className="absolute bottom-1 left-1/2 -translate-x-1/2"
      >
        <motion.span
          key={statusText}
          initial={{ scale: 0.92, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ duration: 0.25 }}
          className="flex items-center gap-2 whitespace-nowrap rounded-full border border-glass bg-glass-strong px-4 py-1.5 text-xs font-medium text-text-secondary shadow-glass backdrop-blur-xl"
        >
          <span className={`h-1.5 w-1.5 rounded-full ${statusDot}`} />
          {statusText}
        </motion.span>
      </motion.div>
    </div>
  );
}
