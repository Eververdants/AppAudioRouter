import { useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { useFitScale } from '@/hooks/useFitScale';
import { useRouterStore } from '@/stores/routerStore';

/** Fixed design size of the router stage; the whole stage is scaled to fit. */
const STAGE_SIZE = 460;
const RING_SIZE = 380;
const DEVICE_RADIUS = 160;

/**
 * Concentric circle router visualization.
 * - Center: route button (selected process; clicking routes to the chosen device)
 * - Middle ring: ripple effect on route
 * - Outer ring: selectable devices
 */
export function ConcentricRouter() {
  const { t } = useTranslation();
  const { devices, sessions, selectedPid, selectedDeviceId, selectDevice, applyRoute } =
    useRouterStore();
  const { ref, scale } = useFitScale(STAGE_SIZE);
  const [rippleKey, setRippleKey] = useState(0);
  const [showRipple, setShowRipple] = useState(false);
  const latestRippleKey = useRef(0);

  const selectedSession = sessions.find((s) => s.pid === selectedPid);
  const canRoute = Boolean(selectedPid && selectedDeviceId);

  const handleRoute = async () => {
    if (!canRoute) return;
    const nextKey = rippleKey + 1;
    latestRippleKey.current = nextKey;
    setRippleKey(nextKey);
    setShowRipple(true);
    await applyRoute();
  };

  return (
    <div ref={ref} className="relative flex h-full w-full items-center justify-center">
      <div
        className="relative flex items-center justify-center"
        style={{ width: STAGE_SIZE, height: STAGE_SIZE, transform: `scale(${scale})` }}
      >
        {/* Middle ring — decorative */}
        <motion.div
          className="pointer-events-none absolute h-[280px] w-[280px] rounded-full border border-border"
          animate={{ rotate: 360 }}
          transition={{ duration: 60, repeat: Infinity, ease: 'linear' }}
        />
        <motion.div
          className="border-border/60 pointer-events-none absolute h-[200px] w-[200px] rounded-full border"
          animate={{ rotate: -360 }}
          transition={{ duration: 45, repeat: Infinity, ease: 'linear' }}
        />

        {/* Route ripple */}
        <AnimatePresence>
          {showRipple && (
            <motion.div
              key={rippleKey}
              className="pointer-events-none absolute h-32 w-32 rounded-full border-2 border-accent"
              initial={{ scale: 1, opacity: 0.7 }}
              animate={{ scale: 2.8, opacity: 0 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.7, ease: 'easeOut' }}
              onAnimationComplete={() => {
                // A newer ripple (rapid re-click) must not be hidden by this one.
                if (rippleKey === latestRippleKey.current) setShowRipple(false);
              }}
            />
          )}
        </AnimatePresence>

        {/* Outer ring — devices */}
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="relative" style={{ width: RING_SIZE, height: RING_SIZE }}>
            <AnimatePresence>
              {devices.map((device, i) => {
                const angle = (i / devices.length) * Math.PI * 2 - Math.PI / 2;
                const x = Math.cos(angle) * DEVICE_RADIUS;
                const y = Math.sin(angle) * DEVICE_RADIUS;
                const isActive = device.id === selectedDeviceId;

                return (
                  // Outer div carries the position animation: framer-motion
                  // writes x/y into an inline transform, which would override
                  // the button's own -translate-1/2 centering classes.
                  <motion.div
                    key={device.id}
                    initial={{ opacity: 0, scale: 0 }}
                    animate={{ opacity: 1, scale: 1, x, y }}
                    exit={{ opacity: 0, scale: 0 }}
                    transition={{
                      type: 'spring',
                      stiffness: 260,
                      damping: 20,
                      delay: i * 0.04,
                    }}
                    className="absolute left-1/2 top-1/2"
                  >
                    {/* max-w keeps the pill inside the stage:
                        DEVICE_RADIUS + 62 (half pill) <= STAGE_SIZE / 2 */}
                    <button
                      onClick={() => selectDevice(device.id)}
                      className={`max-w-[124px] -translate-x-1/2 -translate-y-1/2 truncate whitespace-nowrap rounded-full border px-3 py-2 text-xs font-medium transition-colors ${
                        isActive
                          ? 'border-accent bg-accent text-white shadow-glow'
                          : 'border-border bg-bg-secondary text-text-secondary hover:border-accent hover:text-accent'
                      }`}
                      title={device.name}
                    >
                      {device.name}
                    </button>
                  </motion.div>
                );
              })}
            </AnimatePresence>
          </div>
        </div>

        {/* Center — route button */}
        <div className="absolute left-1/2 top-1/2 z-10 -translate-x-1/2 -translate-y-1/2">
          <motion.button
            type="button"
            onClick={handleRoute}
            disabled={!canRoute}
            title={canRoute ? t('router.clickToRoute') : undefined}
            whileHover={canRoute ? { scale: 1.05 } : undefined}
            whileTap={canRoute ? { scale: 0.97 } : undefined}
            className={`flex h-32 w-32 flex-col items-center justify-center rounded-full bg-gradient-to-br from-accent to-accent-hover text-white shadow-glow-lg transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70 ${
              canRoute
                ? 'cursor-pointer hover:brightness-110'
                : 'cursor-not-allowed opacity-80 saturate-50'
            }`}
          >
            <AnimatePresence mode="wait">
              {selectedSession ? (
                <motion.div
                  key={selectedSession.pid}
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -10 }}
                  className="flex flex-col items-center gap-1.5 px-4 text-center"
                >
                  <svg
                    width="20"
                    height="20"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                  >
                    <polygon points="5 3 19 12 5 21 5 3" />
                  </svg>
                  <span className="max-w-full truncate text-xs font-semibold leading-tight">
                    {selectedSession.exe_name}
                  </span>
                  <span
                    className={`text-[10px] leading-none ${
                      canRoute ? 'text-white/90' : 'text-white/60'
                    }`}
                  >
                    {selectedDeviceId ? t('router.clickToRoute') : t('router.selectDevice')}
                  </span>
                </motion.div>
              ) : (
                <motion.div
                  key="empty"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  className="flex flex-col items-center gap-1 px-4 text-center text-white/80"
                >
                  <svg
                    width="20"
                    height="20"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                  >
                    <circle cx="12" cy="12" r="10" />
                    <path d="M12 16v-4M12 8h.01" />
                  </svg>
                  <span className="text-[10px] leading-tight">{t('router.selectProcess')}</span>
                </motion.div>
              )}
            </AnimatePresence>
          </motion.button>
        </div>
      </div>
    </div>
  );
}
