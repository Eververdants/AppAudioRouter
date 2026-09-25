import { motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';

/** Vector re-draw of the app's concentric router, used as the hero visual.
 *  Same composition as `ConcentricRouter.tsx` in the app: the routed process
 *  in the centre, playback devices as capsules on an orbit ring, curved route
 *  lines with a perpendicular bow, order badges on the nodes and a ripple
 *  pulse while the route is live. Drawn once at a fixed design size; the SVG
 *  scales to its container, so no fit-scale logic is needed here. */

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
  /** Route order; the first device is the primary endpoint. */
  order: number;
  angle: number;
}

const DEVICES: DeviceSpec[] = [
  {
    nameKey: 'hero.illustration.devices.hdmi',
    delay: '0 ms',
    volume: '100 %',
    order: 1,
    angle: -90,
  },
  {
    nameKey: 'hero.illustration.devices.usb',
    delay: '+60 ms',
    volume: '85 %',
    order: 2,
    angle: 30,
  },
  {
    nameKey: 'hero.illustration.devices.bluetooth',
    delay: '+180 ms',
    volume: '70 %',
    order: 3,
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

export function RouterIllustration() {
  const { t } = useTranslation();

  return (
    <div className="relative mx-auto w-full max-w-[460px]">
      <svg
        viewBox={`0 0 ${STAGE_SIZE} ${STAGE_SIZE}`}
        role="img"
        aria-label={t('hero.illustration.label')}
        className="h-auto w-full"
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

        {/* Route lines: a faint base stroke plus an animated dash on top. */}
        {DEVICES.map((device) => {
          const point = devicePoint(device.angle);
          return (
            <g key={device.order}>
              <path
                d={routePath(point)}
                fill="none"
                className="stroke-accent/15"
                strokeWidth="3"
                strokeLinecap="round"
              />
              <path
                d={routePath(point)}
                fill="none"
                className="route-flow stroke-accent"
                strokeWidth="2"
                strokeLinecap="round"
                strokeDasharray="6 22"
              />
            </g>
          );
        })}

        {/* Centre: the routed process. */}
        <motion.g
          initial={{ opacity: 0, scale: 0.6 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={spring}
          style={{ transformBox: 'fill-box', transformOrigin: 'center' }}
        >
          <circle
            cx={CENTER}
            cy={CENTER}
            r={46}
            className="fill-glass-strong stroke-accent/50"
            strokeWidth="1.5"
          />
          <circle
            cx={CENTER}
            cy={CENTER}
            r={46}
            fill="none"
            className="node-ripple stroke-accent/40"
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

        {/* Devices on the outer ring. */}
        {DEVICES.map((device, index) => {
          const point = devicePoint(device.angle);
          return (
            <motion.g
              key={device.order}
              initial={{ opacity: 0, scale: 0.6 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ ...spring, delay: 0.15 + index * 0.12 }}
              style={{ transformBox: 'fill-box', transformOrigin: 'center' }}
            >
              <circle
                cx={point.x}
                cy={point.y}
                r={34}
                fill="none"
                className="node-ripple stroke-accent/40"
                strokeWidth="1.5"
                style={{ animationDelay: `${index * 0.5}s` }}
              />
              <rect
                x={point.x - 55}
                y={point.y - 26}
                width={110}
                height={52}
                rx={26}
                className="fill-glass-strong stroke-glass"
                strokeWidth="1"
              />
              <text
                x={point.x}
                y={point.y - 5}
                textAnchor="middle"
                className="fill-text-primary text-[13px] font-semibold"
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
              {/* Order badge: 1 marks the primary endpoint. */}
              <g>
                <circle
                  cx={point.x + 48}
                  cy={point.y - 20}
                  r={9}
                  className="fill-bg-primary stroke-border"
                  strokeWidth="1"
                />
                <text
                  x={point.x + 48}
                  y={point.y - 16.5}
                  textAnchor="middle"
                  className="fill-text-secondary text-[9.5px] font-semibold"
                >
                  {device.order}
                </text>
              </g>
            </motion.g>
          );
        })}
      </svg>

      {/* Status pill floating under the stage, like the app's live-route state. */}
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.7, duration: 0.4 }}
        className="absolute bottom-1 left-1/2 -translate-x-1/2"
      >
        <span className="flex items-center gap-2 whitespace-nowrap rounded-full border border-glass bg-glass-strong px-4 py-1.5 text-xs font-medium text-text-secondary shadow-glass backdrop-blur-xl">
          <span className="h-1.5 w-1.5 rounded-full bg-success" />
          {t('hero.illustration.status')}
        </span>
      </motion.div>
    </div>
  );
}
