import { useTranslation } from 'react-i18next';
import { ROW_H, rowContentY } from '@/lib/stage';
import { DeviceRow } from './DeviceRow';
import { FeedRow } from './FeedRow';
import { Panel } from './Panel';
import type { PlannedFeed } from './hooks/useFeedPlan';
import type { InspectorKey } from './shared';
import type { Dispatch, RefObject, SetStateAction } from 'react';
import type { PanelColumn } from '@/lib/stage';

/**
 * The destination column: the primary device alone in the first panel, and
 * every copy and every programme input below it in the second.
 *
 * The two panels are one column laid out by `panelColumn`, so the hub's wires
 * and these rows answer to the same four numbers; the rows are placed by
 * `rowContentY`, which is the same arithmetic the wire endpoints use.
 */
export function DestinationPanels({
  column,
  primaryDeviceId,
  copyDeviceIds,
  planFeedStates,
  copiesRows,
  inspectorKey,
  badgeIsButton,
  deviceDelays,
  name,
  deviceNameOf,
  toggleTarget,
  promoteDevice,
  dropFeedTarget,
  setHoverKey,
  setInspectorKey,
  inspectorReturnRef,
  pickerOpen,
  setPickerOpen,
  setPrimaryPickerOpen,
  pickerReturnRef,
  loadWindowApps,
  setCopyScroll,
  revealIndex,
  clearReveal,
  pid,
}: {
  column: PanelColumn;
  primaryDeviceId: string | undefined;
  copyDeviceIds: string[];
  planFeedStates: PlannedFeed[];
  copiesRows: number;
  inspectorKey: InspectorKey | null;
  badgeIsButton: boolean;
  deviceDelays: Record<string, number>;
  name: string | undefined;
  deviceNameOf: (id: string) => string;
  /** The last device cannot leave the plan: the guard is this screen's fact. */
  toggleTarget: (deviceId: string) => void;
  promoteDevice: (deviceId: string) => void;
  dropFeedTarget: (targetPid: number) => void;
  setHoverKey: (key: string | null) => void;
  setInspectorKey: Dispatch<SetStateAction<InspectorKey | null>>;
  /** The number badge the strip was opened from, kept by the board. */
  inspectorReturnRef: RefObject<HTMLElement | null>;
  pickerOpen: boolean;
  setPickerOpen: Dispatch<SetStateAction<boolean>>;
  setPrimaryPickerOpen: Dispatch<SetStateAction<boolean>>;
  /** The button a picker came from, so closing hands the keyboard back to it. */
  pickerReturnRef: RefObject<HTMLElement | null>;
  loadWindowApps: () => Promise<void>;
  setCopyScroll: (scrollTop: number) => void;
  revealIndex: number | null;
  clearReveal: () => void;
  pid: number | undefined;
}) {
  const { t } = useTranslation();
  return (
    <>
      {/* The primary device, alone in the first panel: 01 is the endpoint
              Windows plays itself, and it sits above the copies because that is
              the order the numbering teaches. */}
      <Panel
        label={t('stage.groupPrimary')}
        top={column.primaryY}
        height={column.primaryHeight}
        rows={primaryDeviceId !== undefined ? 1 : 0}
        empty={t('stage.groupPrimaryEmpty')}
      >
        {primaryDeviceId !== undefined && (
          <DeviceRow
            deviceId={primaryDeviceId}
            deviceName={deviceNameOf(primaryDeviceId)}
            index={0}
            top={rowContentY(0) - ROW_H / 2}
            isPrimary
            delay={0}
            badgeIsButton={badgeIsButton}
            removable={false}
            inspected={inspectorKey === `dev:${primaryDeviceId}`}
            onRemove={() => undefined}
            onPromote={() => undefined}
            onPrimaryPick={() => {
              pickerReturnRef.current = document.activeElement as HTMLElement | null;
              // The two pickers are never open at once: opening this one
              // shuts the add picker, so a key or press always belongs to the
              // menu that is on screen.
              setPickerOpen(false);
              setPrimaryPickerOpen((value) => !value);
            }}
            onInspect={(source) => {
              inspectorReturnRef.current = source;
              setInspectorKey(`dev:${primaryDeviceId}`);
            }}
            onHover={setHoverKey}
          />
        )}
      </Panel>

      {/* Everything else: the copies, then the programmes this sound is fed
              into. It is as tall as its rows — one too many to fit and it
              scrolls here, rather than the stage scrolling around it. */}
      <Panel
        label={t('stage.groupCopies')}
        top={column.copiesY}
        height={column.copiesHeight}
        rows={copiesRows}
        empty={t('stage.groupCopiesEmpty')}
        onScroll={setCopyScroll}
        resetKey={pid}
        revealIndex={revealIndex}
        onRevealed={clearReveal}
        headerAction={
          <button
            type="button"
            data-owns-picker
            aria-label={t('stage.addTarget')}
            title={t('stage.addTargetTitle')}
            onClick={(event) => {
              pickerReturnRef.current = event.currentTarget;
              // As above: one picker at a time.
              setPrimaryPickerOpen(false);
              // The windowed pool is read when it can be looked at: this
              // menu is the one place its rows show, and the read is cheap
              // and idempotent. Opening only — closing needs no list.
              if (!pickerOpen) void loadWindowApps();
              setPickerOpen((value) => !value);
            }}
            className="pressable hit flex h-[18px] w-[18px] flex-none items-center justify-center rounded-full border border-dashed border-line-strong text-[11px] leading-none text-text-muted hover:border-accent/60 hover:text-accent focus-visible:border-accent focus-visible:outline-none"
          >
            ＋
          </button>
        }
      >
        {copyDeviceIds.map((deviceId, offset) => {
          const delay = deviceDelays[deviceId] ?? 0;
          return (
            <DeviceRow
              key={deviceId}
              deviceId={deviceId}
              deviceName={deviceNameOf(deviceId)}
              index={offset + 1}
              top={rowContentY(offset) - ROW_H / 2}
              isPrimary={false}
              delay={delay}
              badgeIsButton={badgeIsButton}
              removable
              inspected={inspectorKey === `dev:${deviceId}`}
              onRemove={() => toggleTarget(deviceId)}
              onPromote={() => promoteDevice(deviceId)}
              onInspect={(source) => {
                inspectorReturnRef.current = source;
                setInspectorKey(`dev:${deviceId}`);
              }}
              onHover={setHoverKey}
            />
          );
        })}
        {planFeedStates.map(({ session: targetSession, landed, state }, offset) => (
          <FeedRow
            key={targetSession.pid}
            session={targetSession}
            landed={landed}
            state={state}
            index={copyDeviceIds.length + offset + 1}
            top={rowContentY(copyDeviceIds.length + offset) - ROW_H / 2}
            sourceName={name ?? ''}
            onRemove={() => dropFeedTarget(targetSession.pid)}
            onHover={setHoverKey}
          />
        ))}
      </Panel>
    </>
  );
}
