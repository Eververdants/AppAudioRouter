import { AnimatePresence, motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { BOARD_W, GROUP_X } from '@/lib/stage';
import { MAIN_THREAD_TRANSFORM } from '@/lib/motion';
import type { AudioDevice, AudioSession } from '@/lib/types';
import { PICKER_ITEM_VARIANTS, PICKER_VARIANTS } from './shared';
import { walkFeedResults, walkPickerMenu } from './pickerKeys';
import type { Dispatch, RefObject, SetStateAction } from 'react';

/** One section of the add-destination picker. `section` is the stable hook the
 *  end-to-end specs scope a row to: the same device can appear in more than one
 *  section, and "which one did you mean" is the question the sections answer. */
function PickerSection({
  label,
  section,
  children,
}: {
  label: string;
  section: string;
  children: React.ReactNode;
}) {
  return (
    <div data-picker-section={section} className="mb-0.5 last:mb-0">
      <div className="px-2 pb-1 pt-1.5 text-xs font-semibold uppercase tracking-[0.08em] text-text-muted">
        {label}
      </div>
      <div className="flex flex-col">{children}</div>
    </div>
  );
}

function PickerEmpty({ text }: { text: string }) {
  return <div className="px-2.5 py-1.5 text-[11px] text-text-muted">{text}</div>;
}

/**
 * The add-destination picker: play here instead, also play here, and feed this
 * programme's input — three questions the board asks one menu at a time.
 *
 * It scrolls instead of growing past the board (`addPickerTop` / `addPickerCap`
 * come from the board's own geometry), and the carrier's playback side is
 * already out of the two device lists: a pipe is not an output, and the filter
 * belongs to these menus, not to the store. Focus is contractual — the board
 * puts it in the first row when this opens and back on the button that opened it
 * when it closes.
 */
export function AddDestinationPicker({
  pickerOpen,
  addMenuRef,
  closePicker,
  switchableDevices,
  addableDevices,
  devicePickerEmpty,
  feedCandidates,
  feedQuery,
  setFeedQuery,
  feedSearchRef,
  pid,
  setPrimaryDevice,
  appendDeviceTarget,
  appendFeedTarget,
  addPickerTop,
  addPickerCap,
}: {
  pickerOpen: boolean;
  addMenuRef: RefObject<HTMLDivElement | null>;
  /** Closes both pickers; `true` puts the keyboard back on the button they
   *  came out of. */
  closePicker: (toTrigger: boolean) => void;
  switchableDevices: AudioDevice[];
  addableDevices: AudioDevice[];
  devicePickerEmpty: string;
  feedCandidates: AudioSession[];
  feedQuery: string;
  setFeedQuery: Dispatch<SetStateAction<string>>;
  feedSearchRef: RefObject<HTMLInputElement | null>;
  pid: number | undefined;
  setPrimaryDevice: (deviceId: string) => void;
  appendDeviceTarget: (deviceId: string) => void;
  appendFeedTarget: (targetPid: number) => void;
  addPickerTop: number;
  addPickerCap: number;
}) {
  const { t } = useTranslation();
  return (
    <AnimatePresence>
      {pickerOpen && (
        <motion.div
          key="picker"
          ref={addMenuRef}
          role="menu"
          data-owns-picker
          aria-label={t('stage.addTarget')}
          initial="closed"
          animate="open"
          exit="closed"
          variants={PICKER_VARIANTS}
          transformTemplate={MAIN_THREAD_TRANSFORM}
          onKeyDown={walkPickerMenu}
          className="cc absolute z-30 w-[230px] overflow-hidden rounded-card border border-line-strong bg-surface p-1.5"
          style={{
            left: Math.min(GROUP_X - 40, BOARD_W - 250),
            top: addPickerTop,
            maxHeight: addPickerCap,
          }}
        >
          <div className="overflow-y-auto" style={{ maxHeight: addPickerCap - 14 }}>
            <PickerSection label={t('stage.pickSwitch')} section="switch">
              {switchableDevices.length === 0 && <PickerEmpty text={devicePickerEmpty} />}
              {switchableDevices.map((d) => (
                <motion.button
                  key={d.id}
                  type="button"
                  role="menuitem"
                  variants={PICKER_ITEM_VARIANTS}
                  transformTemplate={MAIN_THREAD_TRANSFORM}
                  onClick={() => {
                    // The seat, not a second output: the device that held
                    // it leaves the plan, because "play here instead" was
                    // never "play here as well".
                    setPrimaryDevice(d.id);
                    closePicker(true);
                  }}
                  className="pressable w-full rounded-seg px-2.5 py-1.5 text-left text-[12px] text-text-secondary hover:bg-surface-hover hover:text-text-primary"
                >
                  {d.name}
                </motion.button>
              ))}
            </PickerSection>
            <PickerSection label={t('stage.pickCopy')} section="copy">
              {addableDevices.length === 0 && <PickerEmpty text={t('stage.pickNone')} />}
              {addableDevices.map((d) => (
                <motion.button
                  key={d.id}
                  type="button"
                  role="menuitem"
                  variants={PICKER_ITEM_VARIANTS}
                  transformTemplate={MAIN_THREAD_TRANSFORM}
                  onClick={() => {
                    // Append, never toggle: "also" has to leave the plan's
                    // membership alone and put the new device on the tail.
                    // The seat it ends up in is the delay order's call,
                    // exactly as for any other row.
                    appendDeviceTarget(d.id);
                    closePicker(true);
                  }}
                  className="pressable w-full rounded-seg px-2.5 py-1.5 text-left text-[12px] text-text-secondary hover:bg-surface-hover hover:text-text-primary"
                >
                  {d.name}
                </motion.button>
              ))}
            </PickerSection>
            <PickerSection label={t('stage.pickFeed')} section="feed">
              {/* The way to any running app, not only the ones already
                        making sound: typing narrows both tiers at once, and an
                        empty query is the list the menu always opened with.
                        Escape clears the query first — the menu's own handler
                        stands aside for that one key. */}
              <input
                ref={feedSearchRef}
                type="text"
                value={feedQuery}
                onChange={(event) => setFeedQuery(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') {
                    if (event.currentTarget.value !== '') {
                      setFeedQuery('');
                      event.stopPropagation();
                    }
                    return;
                  }
                  if (event.key === 'Enter') {
                    // The first match is the answer a typist means.
                    const first = event.currentTarget
                      .closest('[data-picker-section="feed"]')
                      ?.querySelector<HTMLButtonElement>('[role="menuitem"]');
                    first?.click();
                    return;
                  }
                  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                    walkFeedResults(event);
                  }
                }}
                placeholder={t('stage.pickFeedSearch')}
                aria-label={t('stage.pickFeedSearch')}
                className="mb-1 block w-full rounded-seg border border-line bg-surface-sunken px-2 py-1 text-[12px] text-text-primary outline-none placeholder:text-text-muted focus-visible:border-accent"
              />
              {feedCandidates.length === 0 && (
                <PickerEmpty
                  text={feedQuery.trim() === '' ? t('stage.pickNone') : t('stage.pickFeedNoMatch')}
                />
              )}
              {feedCandidates.map((s) => (
                <motion.button
                  key={s.pid}
                  type="button"
                  role="menuitem"
                  variants={PICKER_ITEM_VARIANTS}
                  transformTemplate={MAIN_THREAD_TRANSFORM}
                  onClick={() => {
                    if (pid !== undefined) appendFeedTarget(s.pid);
                    closePicker(true);
                  }}
                  className="pressable flex w-full items-center gap-2 rounded-seg px-2.5 py-1.5 text-left text-[12px] text-text-secondary hover:bg-surface-hover hover:text-text-primary"
                >
                  <span className="text-type-feed" aria-hidden="true">
                    ◧
                  </span>
                  <span className="truncate">
                    {t('stage.pickFeedItem', {
                      process: s.display_name ?? s.exe_name,
                    })}
                  </span>
                </motion.button>
              ))}
            </PickerSection>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/**
 * The change-primary picker, anchored to the primary panel's title row: the
 * same two-beat focus contract as the add picker, answering the other question.
 */
export function ChangePrimaryPicker({
  primaryPickerOpen,
  primaryMenuRef,
  closePicker,
  pickableDevices,
  primaryDeviceId,
  devicePickerEmpty,
  setPrimaryDevice,
  primaryPickerTop,
  primaryPickerCap,
}: {
  primaryPickerOpen: boolean;
  primaryMenuRef: RefObject<HTMLDivElement | null>;
  closePicker: (toTrigger: boolean) => void;
  pickableDevices: AudioDevice[];
  primaryDeviceId: string | undefined;
  devicePickerEmpty: string;
  setPrimaryDevice: (deviceId: string) => void;
  primaryPickerTop: number;
  primaryPickerCap: number;
}) {
  const { t } = useTranslation();
  return (
    <>
      {/* The change-primary picker: the way to hand the primary seat to
              another device without touching the copies. Every row is
              selectable — a device already carrying a delay compensation may
              take the seat too (the values are the copies' alignment figures,
              not a gate on who sits first); recalibrating after the move is
              the wizard's job. */}
      <AnimatePresence>
        {primaryPickerOpen && (
          <motion.div
            key="primary-picker"
            ref={primaryMenuRef}
            role="menu"
            data-owns-picker
            aria-label={t('stage.changePrimary')}
            initial="closed"
            animate="open"
            exit="closed"
            variants={PICKER_VARIANTS}
            transformTemplate={MAIN_THREAD_TRANSFORM}
            onKeyDown={walkPickerMenu}
            className="cc absolute z-30 w-[230px] overflow-hidden rounded-card border border-line-strong bg-surface p-1.5"
            style={{
              left: Math.min(GROUP_X - 40, BOARD_W - 250),
              top: primaryPickerTop,
              maxHeight: primaryPickerCap,
            }}
          >
            <div className="overflow-y-auto" style={{ maxHeight: primaryPickerCap - 14 }}>
              <PickerSection label={t('stage.pickPrimary')} section="primary">
                {pickableDevices.length === 0 && <PickerEmpty text={devicePickerEmpty} />}
                {pickableDevices.map((d) => {
                  const picked = d.id === primaryDeviceId;
                  return (
                    <motion.button
                      key={d.id}
                      type="button"
                      role="menuitem"
                      variants={PICKER_ITEM_VARIANTS}
                      transformTemplate={MAIN_THREAD_TRANSFORM}
                      aria-current={picked ? 'true' : undefined}
                      onClick={() => {
                        setPrimaryDevice(d.id);
                        closePicker(true);
                      }}
                      className="pressable flex w-full items-center gap-2 rounded-seg px-2.5 py-1.5 text-left text-[12px] text-text-secondary outline-none hover:bg-surface-hover hover:text-text-primary focus-visible:bg-surface-hover focus-visible:text-text-primary"
                    >
                      <span
                        className={`flex h-3 w-3 flex-none items-center justify-center text-xs ${
                          picked ? 'text-accent' : 'text-transparent'
                        }`}
                        aria-hidden="true"
                      >
                        ✓
                      </span>
                      <span className="min-w-0 flex-1 truncate">{d.name}</span>
                    </motion.button>
                  );
                })}
              </PickerSection>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
