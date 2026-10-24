import { useMemo, useState } from 'react';
import { AnimatePresence } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { Block } from '@/components/settings/Block';
import { ROW_BUTTON_CLASS, Row } from '@/components/settings/Row';
import { RememberedChip } from '@/components/settings/RememberedChip';
import { ConfirmButton } from '@/components/ui/ConfirmButton';
import { Select } from '@/components/ui/Select';
import { Switch } from '@/components/ui/Switch';
import { detectCarrierPair, matchesCarrier } from '@/lib/carrierDetect';
import { openCarrierDownload } from '@/lib/invoke';
import type { AudioDevice, ResetOutcome } from '@/lib/types';
import { useRouterStore } from '@/stores/routerStore';

/**
 * What the app remembers and what it lets go of, as the page's second section:
 * the auto-restore switch and the routes it has already written down, the two
 * destructive actions (release every per-app endpoint / stop every route), and
 * the loopback pair the feeds run through.
 *
 * `devices` arrives as a prop rather than being read here because the page reads
 * it too, for the delay wizard — and because this list is the store's *own*
 * devices: the board's carrier filter lives on the board, and narrowing it here
 * would leave a configured carrier with no way back to change or clear it.
 */
export function RoutingSection({ devices }: { devices: AudioDevice[] }) {
  const { t } = useTranslation();
  const autoRemember = useRouterStore((s) => s.autoRemember);
  const toggleAutoRemember = useRouterStore((s) => s.toggleAutoRemember);
  const rememberedRoutes = useRouterStore((s) => s.rememberedRoutes);
  const forgetRememberedRoute = useRouterStore((s) => s.forgetRememberedRoute);
  const resetPinnedEndpoints = useRouterStore((s) => s.resetPinnedEndpoints);
  const stopAllRoutes = useRouterStore((s) => s.stopAllRoutes);
  const routedCount = useRouterStore((s) => Object.keys(s.routedPids).length);
  const feedCarrier = useRouterStore((s) => s.feedCarrier);
  const setFeedCarrier = useRouterStore((s) => s.setFeedCarrier);
  const captureDevices = useRouterStore((s) => s.captureDevices);
  const raiseError = useRouterStore((s) => s.raiseError);

  // What the last "reset per-app output" press cleared, so the press has an
  // answer of its own instead of only a line in another tab.
  const [resetOutcome, setResetOutcome] = useState<ResetOutcome | null>(null);
  // Whether that press is still being answered.
  const [resetBusy, setResetBusy] = useState(false);

  // Which known loopback driver, if any, is on the two lists right now. Both
  // lists follow the audio-changed event, so a driver installed while the app
  // is open pairs without a restart.
  const carrierMatch = useMemo(
    () => detectCarrierPair(devices, captureDevices),
    [devices, captureDevices],
  );

  const carrierOptions = [
    { value: '', label: t('settings.feedCarrierNone') },
    ...devices.map((device) => ({ value: device.id, label: device.name })),
  ];
  const captureOptions = [
    { value: '', label: t('settings.feedCarrierNone') },
    ...captureDevices.map((device) => ({ value: device.id, label: device.name })),
  ];

  return (
    <>
      <Row title={t('settings.autoRemember')} desc={t('settings.autoRememberDesc')}>
        <Switch
          checked={autoRemember}
          onChange={toggleAutoRemember}
          label={t('settings.autoRemember')}
        />
      </Row>
      {rememberedRoutes.length > 0 && (
        <Block title={t('settings.rememberedRoutes')}>
          <div className="flex flex-wrap gap-1.5">
            <AnimatePresence initial={false}>
              {rememberedRoutes.map((entry) => (
                <RememberedChip
                  key={entry.exeName}
                  entry={entry}
                  devices={devices}
                  onForget={forgetRememberedRoute}
                />
              ))}
            </AnimatePresence>
          </div>
        </Block>
      )}
      <Row title={t('settings.resetEndpoints')} desc={t('settings.resetEndpointsDesc')}>
        {/* Every per-app assignment on the machine, both data flows,
                        in one press — and it reaches programs that are not on the
                        board. The same action asks first in the process list's
                        header for the same reason, so it asks here too. */}
        <div className="flex flex-col items-end gap-1.5">
          <ConfirmButton
            label={t('settings.resetEndpointsAction')}
            confirmLabel={t('settings.resetEndpointsConfirm')}
            // One wipe at a time: the walk releases every assignment on
            // the machine, and a second press while the first is still
            // answering would race it for the same processes — and pay
            // for a second set of failures. The tour guards its own copy
            // of this action the same way.
            disabled={resetBusy}
            onConfirm={() => {
              setResetBusy(true);
              void resetPinnedEndpoints()
                .then((outcome) => {
                  // A refusal is the toast's; what belongs here is the
                  // count, so the press is not mistaken for a no-op.
                  if (outcome !== null) setResetOutcome(outcome);
                })
                .finally(() => setResetBusy(false));
            }}
          />
          {resetOutcome !== null && (
            <span className="max-w-[34ch] text-right text-[11px] leading-relaxed text-text-muted">
              {t('startup.resetDone', { n: resetOutcome.released })}
              {resetOutcome.still_pinned.length > 0 &&
                ` ${t('startup.resetRemaining', {
                  processes: resetOutcome.still_pinned.join(', '),
                })}`}
            </span>
          )}
        </div>
      </Row>
      <Row title={t('settings.stopAllRoutes')} desc={t('settings.stopAllRoutesDesc')}>
        <ConfirmButton
          label={t('settings.stopAllRoutesAction')}
          confirmLabel={t('settings.stopAllRoutesConfirm')}
          onConfirm={() => void stopAllRoutes()}
          disabled={routedCount === 0}
        />
      </Row>
      {/* Sending one program's audio into another's input runs through
                      a loopback pair: the source plays to the pair's playback
                      side, the target records from its recording side. The app
                      ships no driver, so the pair is picked here; without one,
                      feeds are remembered and shown on the board, but silent. */}
      <Block title={t('settings.feedCarrier')} desc={t('settings.feedCarrierDesc')}>
        <div className="flex flex-col gap-2">
          <label className="flex items-center gap-3">
            <span className="w-[130px] flex-none text-[11px] text-text-muted">
              {t('settings.feedCarrierRender')}
            </span>
            <Select
              ariaLabel={t('settings.feedCarrierRender')}
              title={t('settings.feedCarrierRenderHint')}
              value={feedCarrier.render ?? ''}
              options={carrierOptions}
              missingLabel={t('settings.deviceGone')}
              onChange={(next) =>
                void setFeedCarrier(next === '' ? null : next, feedCarrier.capture)
              }
            />
          </label>
          <label className="flex items-center gap-3">
            <span className="w-[130px] flex-none text-[11px] text-text-muted">
              {t('settings.feedCarrierCapture')}
            </span>
            <Select
              ariaLabel={t('settings.feedCarrierCapture')}
              title={t('settings.feedCarrierCaptureHint')}
              value={feedCarrier.capture ?? ''}
              options={captureOptions}
              onChange={(next) =>
                void setFeedCarrier(feedCarrier.render, next === '' ? null : next)
              }
            />
          </label>
        </div>
        {/* The known loopback drivers announce themselves: pairing is
                        one click when one is here, and the free one is one click
                        away when none is. The button below hands a driver key to
                        the backend — the URL itself never crosses from the
                        frontend. */}
        {carrierMatch && !matchesCarrier(carrierMatch, feedCarrier) && (
          <div className="mt-3 flex items-center justify-between gap-3">
            <span className="text-[11px] text-text-secondary">
              {t('settings.feedCarrierDetected', {
                driver: carrierMatch.driver.display,
              })}
            </span>
            <button
              type="button"
              onClick={() => void setFeedCarrier(carrierMatch.renderId, carrierMatch.captureId)}
              className="pressable shrink-0 rounded-ctl bg-accent px-2.5 py-1 text-[11px] font-medium text-accent-ink outline-none hover:bg-accent-hover focus-visible:ring-2 focus-visible:ring-accent/60"
            >
              {t('settings.feedCarrierApply')}
            </button>
          </div>
        )}
        {carrierMatch && matchesCarrier(carrierMatch, feedCarrier) && (
          <div className="mt-3 text-[11px] text-text-muted">
            {t('settings.feedCarrierPaired', { driver: carrierMatch.driver.display })}
          </div>
        )}
        {/* The offer belongs to "no known driver here and nothing
                      usable picked", not to "nothing picked at all": a pair with
                      one side still empty carries nothing (the restore skips
                      it), so it needs the driver as much as an empty one does.
                      Keying it on both sides being blank left a half-picked pair
                      with no branch at all — no note, no way to the download —
                      and since the half-state is persisted, a reload did not
                      bring it back. */}
        {!carrierMatch && (feedCarrier.render === null || feedCarrier.capture === null) && (
          <div className="mt-3 flex items-center justify-between gap-3">
            <span className="max-w-[52ch] text-[11px] leading-relaxed text-text-muted">
              {t('settings.feedCarrierMissing')}
            </span>
            <button
              type="button"
              onClick={() =>
                void openCarrierDownload('vb-cable').catch(() => {
                  // The page is the only way to the driver, and a
                  // press that opens nothing looks like a press
                  // that worked.
                  raiseError(t('settings.feedCarrierDownloadFailed'));
                })
              }
              className={ROW_BUTTON_CLASS}
            >
              {t('settings.feedCarrierDownload')}
            </button>
          </div>
        )}
      </Block>
    </>
  );
}
