import { AnimatePresence, motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { Ring } from '@/components/ui/Ring';
import { MAIN_THREAD_TRANSFORM, SPRING_GLIDE } from '@/lib/motion';
import type { AudioSession } from '@/lib/types';
import { Inspector } from './Inspector';
import type { InspectorKey } from './shared';

/**
 * What a clicked card tunes, and — when there is nothing to tune — the one
 * sentence that says where the volume of that route lives instead.
 *
 * Both bands make room for themselves as they arrive and give the room back as
 * they leave, and only one of them is ever mounted: the strip while a row is
 * picked, the note while a landed single-destination route has no strip to open.
 */
export function BoardFooter({
  inspectorKey,
  clearInspector,
  drawn,
  deviceLatencyMs,
  answered,
  session,
  targets,
}: {
  inspectorKey: InspectorKey | null;
  /** Closes the strip from its own ✕, focus back on the badge that opened it. */
  clearInspector: () => void;
  drawn: string[];
  deviceLatencyMs: Record<string, number>;
  answered: boolean;
  session: AudioSession | undefined;
  /** The device names the plan reaches, for the note that names them. */
  targets: string;
}) {
  const { t } = useTranslation();
  return (
    <>
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
              onClear={clearInspector}
              drawn={drawn}
              deviceLatencyMs={deviceLatencyMs}
            />
          </motion.div>
        )}
      </AnimatePresence>

      {/* A route with one destination starts no engine, so the strip has no
          lever to offer — and the question "how do I turn this program down"
          had no answer anywhere in the app. It is not a lever this board can
          pull: the volume of a program Windows plays itself belongs to the
          system mixer. So the band says where it lives, and only while a route
          is actually single-destination — a note about a plan nobody landed
          would be a bar talking to itself. */}
      <AnimatePresence initial={false}>
        {inspectorKey === null && answered && drawn.length === 1 && session !== undefined && (
          <motion.div
            key="single-note"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={SPRING_GLIDE}
            transformTemplate={MAIN_THREAD_TRANSFORM}
            className="flex-none overflow-hidden"
          >
            <div
              data-single-note
              className="flex items-center gap-2 border-t border-line px-4 py-2.5 text-xs text-text-muted"
            >
              <Ring tone="main" size={12} />
              <span className="truncate" title={t('stage.singleNoteTitle')}>
                {t('stage.singleNote', { device: targets })}
              </span>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
