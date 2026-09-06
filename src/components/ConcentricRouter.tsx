import { motion, AnimatePresence } from 'framer-motion';
import { useRouterStore } from '@/stores/routerStore';

/**
 * Concentric circle router visualization.
 * - Center: selected process
 * - Middle ring: ripple effect on route
 * - Outer ring: selectable devices
 */
export function ConcentricRouter() {
  const { devices, sessions, selectedPid, selectedDeviceId, selectDevice, applyRoute } =
    useRouterStore();

  const selectedSession = sessions.find((s) => s.pid === selectedPid);

  const handleRoute = async () => {
    await applyRoute();
  };

  return (
    <div className="relative flex h-[420px] w-full items-center justify-center">
      {/* Outer ring — devices */}
      <div className="absolute inset-0 flex items-center justify-center">
        <div className="relative h-[380px] w-[380px]">
          <AnimatePresence>
            {devices.map((device, i) => {
              const angle = (i / devices.length) * Math.PI * 2 - Math.PI / 2;
              const radius = 160;
              const x = Math.cos(angle) * radius;
              const y = Math.sin(angle) * radius;
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
                  <button
                    onClick={() => selectDevice(device.id)}
                    className={`-translate-x-1/2 -translate-y-1/2 whitespace-nowrap rounded-full border px-3 py-2 text-xs font-medium transition-colors ${
                      isActive
                        ? 'border-accent bg-accent text-white shadow-glow'
                        : 'border-border bg-bg-secondary text-text-secondary hover:border-accent hover:text-accent'
                    }`}
                    title={device.name}
                  >
                    {device.name.length > 12 ? device.name.slice(0, 12) + '...' : device.name}
                  </button>
                </motion.div>
              );
            })}
          </AnimatePresence>
        </div>
      </div>

      {/* Middle ring — decorative */}
      <motion.div
        className="pointer-events-none absolute h-[280px] w-[280px] rounded-full border border-border"
        animate={{ rotate: 360 }}
        transition={{ duration: 60, repeat: Infinity, ease: 'linear' }}
      />
      <motion.div
        className="pointer-events-none absolute h-[200px] w-[200px] rounded-full border border-border/60"
        animate={{ rotate: -360 }}
        transition={{ duration: 45, repeat: Infinity, ease: 'linear' }}
      />

      {/* Center — selected process */}
      <motion.div
        className="relative z-10 flex h-32 w-32 flex-col items-center justify-center rounded-full bg-gradient-to-br from-accent to-accent-hover text-white shadow-glow-lg"
        layout
        whileHover={{ scale: 1.05 }}
        whileTap={{ scale: 0.97 }}
      >
        <AnimatePresence mode="wait">
          {selectedSession ? (
            <motion.div
              key={selectedSession.pid}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              className="flex flex-col items-center gap-1 px-3 text-center"
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polygon points="5 3 19 12 5 21 5 3" />
              </svg>
              <span className="text-xs font-semibold leading-tight">
                {selectedSession.exe_name.length > 14
                  ? selectedSession.exe_name.slice(0, 14) + '...'
                  : selectedSession.exe_name}
              </span>
            </motion.div>
          ) : (
            <motion.div
              key="empty"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="flex flex-col items-center gap-1 text-center text-white/80"
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="10" />
                <path d="M12 16v-4M12 8h.01" />
              </svg>
              <span className="text-[10px]">选择进程</span>
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>

      {/* Route button */}
      <motion.button
        onClick={handleRoute}
        disabled={!selectedPid || !selectedDeviceId}
        className="absolute bottom-2 left-1/2 -translate-x-1/2 rounded-full bg-accent px-6 py-2 text-sm font-semibold text-white shadow-glow transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none"
        whileHover={{ scale: 1.05 }}
        whileTap={{ scale: 0.95 }}
      >
        路由到此设备
      </motion.button>
    </div>
  );
}
