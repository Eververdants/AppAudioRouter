import { motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { ProcessIcon } from '@/components/ui/ProcessIcon';
import { MAIN_THREAD_TRANSFORM, SPRING_TAP } from '@/lib/motion';
import { GROUP_PAD, ROW_H, ROW_W, orderLabel } from '@/lib/stage';
import type { AudioSession } from '@/lib/types';
import { ROLE_TEXT_CLASS } from './shared';

/**
 * One programme the hub's sound is fed into. Amber, immediate to read, and
 * honest about what is missing. The row is the plan: staged with the picker,
 * connected by the hub, and taken back out by the hub after its ✕ stages the
 * removal — the same two beats a device row plays, and no undo card beside
 * them.
 */
export function FeedRow({
  session,
  landed,
  state,
  index,
  top,
  sourceName,
  onRemove,
  onHover,
}: {
  session: AudioSession;
  /** Whether this planned feed is already connected. A staged one reads as
   *  the proposal it is; its three honest states only mean something once the
   *  hub has landed it. */
  landed: boolean;
  state: 'live' | 'suspended' | 'no-carrier';
  index: number;
  top: number;
  sourceName: string;
  onRemove: () => void;
  onHover: (key: string | null) => void;
}) {
  const { t } = useTranslation();
  const targetName = session.display_name ?? session.exe_name;
  const title = !landed
    ? t('stage.feedTitlePlanned', { name: targetName })
    : state === 'live'
      ? t('stage.feedTitleLive', { name: targetName })
      : state === 'suspended'
        ? t('stage.feedTitleSuspended', { source: sourceName, name: targetName })
        : t('stage.feedTitleNoCarrier', { name: targetName });
  const stateWord =
    !landed || state === 'live'
      ? t('stage.feedRole')
      : state === 'suspended'
        ? t('stage.feedHeld')
        : t('stage.feedNoCarrier');

  return (
    <motion.div
      data-feed-row={session.pid}
      // Same seat-taking entrance the device rows carry: it grows out of the
      // edge the amber wire meets, pin first, line never chasing.
      initial={{ opacity: 0, scaleX: 0.94 }}
      animate={{ opacity: 1, scaleX: 1 }}
      transition={SPRING_TAP}
      transformTemplate={MAIN_THREAD_TRANSFORM}
      onMouseEnter={() => onHover(`feed:${session.pid}`)}
      onMouseLeave={() => onHover(null)}
      title={title}
      className={`absolute flex items-center gap-2 rounded-ctl bg-surface pl-3 pr-2 ${landed && state !== 'live' ? 'opacity-90' : ''}`}
      style={{ left: GROUP_PAD, top, width: ROW_W, height: ROW_H, transformOrigin: 'left center' }}
    >
      <span className="pin pin-in pin-amber" aria-hidden="true" />
      <span className="no" aria-hidden="true">
        {orderLabel(index)}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-center gap-1.5">
          <ProcessIcon
            exeName={session.exe_name}
            name={session.display_name ?? session.exe_name}
            size={15}
          />
          <span className="truncate text-[12px] font-bold text-text-primary">{targetName}</span>
        </span>
        <span className="flex items-center gap-1">
          <span
            className={`text-xs font-semibold ${ROLE_TEXT_CLASS.feed} ${state !== 'live' ? 'opacity-60' : ''}`}
          >
            {stateWord}
          </span>
          <span className="truncate text-xs text-text-muted">{t('stage.feedInputSuffix')}</span>
        </span>
      </span>
      <button
        type="button"
        title={t('stage.removeFeed', { name: targetName })}
        aria-label={t('stage.removeFeed', { name: targetName })}
        onClick={onRemove}
        className="pressable hit flex h-4 w-4 flex-none items-center justify-center rounded-full border border-line-strong text-[9px] leading-none text-text-muted hover:border-error hover:text-error focus-visible:border-error focus-visible:text-error"
      >
        ✕
      </button>
    </motion.div>
  );
}
