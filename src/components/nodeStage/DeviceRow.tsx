import { motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { formatDelaySigned } from '@/lib/delay';
import { MAIN_THREAD_TRANSFORM, SPRING_TAP } from '@/lib/motion';
import { GROUP_PAD, ROW_H, ROW_W, orderLabel } from '@/lib/stage';
import { ROLE_TEXT_CLASS } from './shared';

/**
 * One output device, as a row inside a panel.
 *
 * The row is placed by `lib/stage.ts` rather than by flow, so the wire that
 * meets its in-pin cannot be a frame out of step with it; the panel's own
 * scrolling moves the row and its wire together.
 */
export function DeviceRow({
  deviceId,
  deviceName,
  index,
  top,
  isPrimary,
  delay,
  badgeIsButton,
  removable,
  inspected,
  onRemove,
  onPromote,
  onPrimaryPick,
  onInspect,
  onHover,
}: {
  deviceId: string;
  deviceName: string;
  index: number;
  top: number;
  isPrimary: boolean;
  delay: number;
  badgeIsButton: boolean;
  removable: boolean;
  inspected: boolean;
  onRemove: () => void;
  onPromote: () => void;
  /** Present on the primary row only: clicking the row opens the picker that
   *  hands the primary seat to another device. */
  onPrimaryPick?: () => void;
  /** Opens the strip, with the control that was pressed: closing the strip
   *  later puts the keyboard back there. */
  onInspect: (source: HTMLElement) => void;
  onHover: (key: string | null) => void;
}) {
  const { t } = useTranslation();
  const roleWord = isPrimary ? t('stage.main') : t('stage.copy');
  const wireKey = `dev:${deviceId}`;

  return (
    <motion.div
      data-device-row={deviceId}
      // A destination taking its seat: it grows out of the edge its wire meets,
      // so the pin stays put and the line never chases it into place.
      initial={{ opacity: 0, scaleX: 0.94 }}
      animate={{ opacity: 1, scaleX: 1 }}
      transition={SPRING_TAP}
      transformTemplate={MAIN_THREAD_TRANSFORM}
      onMouseEnter={() => onHover(wireKey)}
      onMouseLeave={() => onHover(null)}
      className={`group/copy group absolute flex items-center gap-2 rounded-ctl bg-surface pl-3 pr-2 ${
        inspected ? 'ring-1 ring-accent' : 'hover:bg-surface-hover'
      }`}
      style={{ left: GROUP_PAD, top, width: ROW_W, height: ROW_H, transformOrigin: 'left center' }}
    >
      <span className="pin pin-in" aria-hidden="true" />
      {/* The number badge opens the strip — but only once there is something to
          tune: a single-device route starts no engine, so neither a delay nor a
          share exists for it, and the primary volume alone is not a control this
          route offers. Same rule the disc stage always carried. */}
      {badgeIsButton ? (
        <button
          type="button"
          className="no pressable hit cursor-pointer hover:border-accent hover:text-accent focus-visible:ring-2 focus-visible:ring-accent/60"
          onClick={(event) => onInspect(event.currentTarget)}
          aria-label={t('stage.inspectAria', { name: deviceName })}
          title={t('stage.inspectTitle', { name: deviceName })}
        >
          {orderLabel(index)}
        </button>
      ) : (
        <span className="no" aria-hidden="true">
          {orderLabel(index)}
        </span>
      )}
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        {/* One control per row, and it opens the row: the primary's name opens
            the picker that hands the seat over, a copy's name opens the strip
            that tunes it. Neither removes anything — a press that takes a
            destination out of the plan is the ✕, and it says so. */}
        <button
          type="button"
          // The primary row's name opens the change-primary picker: the press
          // that opens it must not be the press that closes it, so the button
          // is exempt from the outside-close like the pickers themselves.
          data-owns-picker={onPrimaryPick !== undefined ? 'true' : undefined}
          aria-label={
            onPrimaryPick === undefined
              ? t('stage.rowAria', { name: deviceName })
              : t('stage.changePrimaryAria', { name: deviceName })
          }
          title={
            onPrimaryPick === undefined
              ? t('stage.inspectTitle', { name: deviceName })
              : t('stage.changePrimaryTitle')
          }
          onClick={onPrimaryPick ?? ((event) => onInspect(event.currentTarget))}
          className="pressable flex items-center gap-1 truncate rounded-seg text-left text-[12px] font-bold text-text-primary outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
        >
          <span className="truncate">{deviceName}</span>
          {/* The chevron is the one mark that says this name opens something:
              without it the row reads as a label that happens to be bold. */}
          {onPrimaryPick !== undefined && (
            <span aria-hidden="true" className="flex-none text-[9px] leading-none text-text-muted">
              ⌄
            </span>
          )}
        </button>
        <span className="flex items-center gap-1.5">
          {/* The role word is a label and nothing else. It used to be the
              button that handed the seat over — a state word that changed under
              the pointer and, with no hover to reveal it, changed nothing at
              all before acting. The action now has a control of its own. */}
          <span
            title={isPrimary ? t('stage.primaryTitle') : t('stage.promoteTitle')}
            className={`text-xs font-semibold ${
              isPrimary ? ROLE_TEXT_CLASS.primary : ROLE_TEXT_CLASS.mirror
            }`}
          >
            {roleWord}
          </span>
          {!isPrimary && (
            <button
              type="button"
              aria-label={t('stage.promote')}
              title={t('stage.promoteTitle')}
              onClick={onPromote}
              className="pressable hit relative flex h-[18px] w-[18px] flex-none items-center justify-center rounded-full text-text-muted opacity-60 outline-none hover:bg-accent-muted hover:text-accent hover:opacity-100 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-accent/60"
            >
              <span aria-hidden="true" className="text-[11px] leading-none">
                ⇄
              </span>
            </button>
          )}
          {!isPrimary && delay !== 0 && (
            <span className="font-mono text-xs tabular-nums text-text-muted">
              {formatDelaySigned(delay)}
            </span>
          )}
        </span>
      </span>
      {/* Removal is a plan edit like any other: it toggles the row out of the
          selection, and the hub asks the same question it always does. The last
          device cannot leave — a route to zero devices is not a state this app
          offers — so the primary row carries no ✕ at all. */}
      {removable && (
        <button
          type="button"
          title={t('stage.removeTarget', { name: deviceName })}
          // The glyph is the picture, not the name: read as text it is a
          // multiplication sign, so the action has to be said.
          aria-label={t('stage.removeTarget', { name: deviceName })}
          onClick={onRemove}
          className="pressable hit flex h-4 w-4 flex-none items-center justify-center rounded-full border border-line-strong text-[9px] leading-none text-text-muted hover:border-error hover:text-error focus-visible:border-error focus-visible:text-error"
        >
          ✕
        </button>
      )}
    </motion.div>
  );
}
