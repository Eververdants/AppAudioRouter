import { motion } from 'framer-motion';
import { useRouterStore } from '@/stores/routerStore';

const container = {
  hidden: { opacity: 0 },
  show: {
    opacity: 1,
    transition: { staggerChildren: 0.05 },
  },
};

const item = {
  hidden: { opacity: 0, x: -10 },
  show: { opacity: 1, x: 0 },
};

export function ProcessList() {
  const { sessions, selectedPid, selectProcess, refreshSessions } = useRouterStore();

  return (
    <div className="flex h-full flex-col rounded-xl border border-border bg-bg-secondary p-4">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-text-primary">进程列表</h2>
        <button
          onClick={refreshSessions}
          className="rounded-md px-2 py-1 text-xs text-text-muted transition-colors hover:bg-bg-tertiary hover:text-accent"
        >
          刷新
        </button>
      </div>

      <motion.div
        variants={container}
        initial="hidden"
        animate="show"
        className="flex-1 space-y-1.5 overflow-y-auto"
      >
        {sessions.length === 0 ? (
          <p className="py-8 text-center text-xs text-text-muted">
            未检测到有音频会话的进程<br />
            <span className="text-[10px]">让目标程序发出声音后刷新</span>
          </p>
        ) : (
          sessions.map((session) => (
            <motion.button
              key={session.pid}
              variants={item}
              onClick={() => selectProcess(session.pid)}
              className={`w-full rounded-lg px-3 py-2 text-left text-xs transition-all ${
                session.pid === selectedPid
                  ? 'bg-accent/10 text-accent ring-1 ring-accent'
                  : 'text-text-secondary hover:bg-bg-tertiary'
              }`}
            >
              <div className="font-medium">{session.exe_name}</div>
              <div className="text-[10px] text-text-muted">PID {session.pid}</div>
            </motion.button>
          ))
        )}
      </motion.div>
    </div>
  );
}
