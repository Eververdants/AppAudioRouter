import i18next from 'i18next';
import { DELAY_STEP_STORAGE_KEY, clampDelay, clampStep } from '@/lib/delay';
import * as api from '@/lib/invoke';
import { deviceName } from '../pure/targets';
import type { GetRouterState, SetRouterState, TuningActions } from '../types';

/** The tuning surface, kept on its three separate axes:
 *
 *  - **device share** (`setDeviceVolume`) attenuates a copy, 100 = as produced;
 *  - **primary volume** (`setPrimaryVolume`) is the program's own session volume
 *    and reaches only its primary device — the backend refuses it for a program
 *    this store does not hold a route for, and no path here writes it directly;
 *  - **source level** (`setSourceVolume`) is what the engines apply to the
 *    program's audio on its way out.
 *
 *  Delays are the copies' compensation and nothing else: the reading in
 *  `deviceLatencyMs` is made of them, so every write ends with a reconciliation
 *  rather than a guess. The bounds are the paired literals in `@/lib/types`,
 *  reached through `lib/delay` — never re-declared here. */
export function createTuningSlice(set: SetRouterState, get: GetRouterState): TuningActions {
  return {
    loadDelaySettings: async () => {
      try {
        const delays = await api.getDeviceDelays();
        const deviceDelays: Record<string, number> = {};
        for (const [deviceId, delayMs] of delays) {
          // A stored 0 is the absence written by an older build: read it as no
          // entry, the same way every reader of `deviceDelays` treats one, so a
          // reload cannot smuggle the stored-zero shape back onto the board.
          if (delayMs === 0) continue;
          deviceDelays[deviceId] = delayMs;
        }
        set({ deviceDelays });
      } catch (e) {
        get().addLog(i18next.t('log.delaySettingsFailed', { error: String(e) }), 'error');
      }
    },

    loadDeviceVolumes: async () => {
      try {
        const pairs = await api.getDeviceVolumes();
        const deviceVolumes: Record<string, number> = {};
        for (const [deviceId, percent] of pairs) {
          deviceVolumes[deviceId] = percent;
        }
        set({ deviceVolumes });
      } catch (e) {
        get().addLog(i18next.t('log.deviceVolumesFailed', { error: String(e) }), 'error');
      }
    },

    setDeviceVolume: async (deviceId, percent) => {
      const current = get().deviceVolumes[deviceId] ?? 100;
      if (current === percent) return;
      set((s) => {
        const deviceVolumes = { ...s.deviceVolumes };
        if (percent >= 100) {
          delete deviceVolumes[deviceId];
        } else {
          deviceVolumes[deviceId] = percent;
        }
        return { deviceVolumes };
      });
      try {
        await api.setDeviceVolume(deviceId, percent);
        get().addLog(
          i18next.t('log.deviceVolumeSet', {
            device: deviceName(deviceId, get().devices),
            n: percent,
          }),
          'info',
        );
      } catch (e) {
        // The backend rejected the value; undo the optimistic update so the UI
        // keeps matching what the engine actually applies and persists. Only
        // while this is still the number on screen: the step buttons fire without
        // waiting, so a later click can have restated this device's share while
        // this write was in flight, and that one stands.
        set((s) => {
          if ((s.deviceVolumes[deviceId] ?? 100) !== percent) return {};
          const deviceVolumes = { ...s.deviceVolumes };
          if (current >= 100) {
            delete deviceVolumes[deviceId];
          } else {
            deviceVolumes[deviceId] = current;
          }
          return { deviceVolumes };
        });
        get().raiseError(i18next.t('log.deviceVolumeFailed', { error: String(e) }), {
          detail: String(e),
        });
      }
    },

    loadPrimaryVolumes: async () => {
      try {
        const pairs = await api.getPrimaryVolumes();
        const primaryVolumes: Record<string, number> = {};
        for (const [exeName, percent] of pairs) {
          primaryVolumes[exeName] = percent;
        }
        set({ primaryVolumes });
      } catch (e) {
        get().addLog(i18next.t('log.primaryVolumesFailed', { error: String(e) }), 'error');
      }
    },

    setPrimaryVolume: async (exeName, percent) => {
      const current = get().primaryVolumes[exeName] ?? 100;
      if (current === percent) return;
      set((s) => {
        const primaryVolumes = { ...s.primaryVolumes };
        // Only an exact 100 is dropped: it is the neutral point ("the program's
        // own loudness") rather than a boundary, and 5–99 are values of their
        // own the backend keeps.
        if (percent === 100) {
          delete primaryVolumes[exeName];
        } else {
          primaryVolumes[exeName] = percent;
        }
        return { primaryVolumes };
      });
      try {
        await api.setPrimaryVolume(exeName, percent);
        get().addLog(i18next.t('log.primaryVolumeSet', { process: exeName, n: percent }), 'info');
      } catch (e) {
        // The backend rejected the value; undo the optimistic update so the UI
        // keeps matching the session volume the engines actually apply. Only while
        // this is still the number on screen: the step buttons fire without
        // waiting, so a later click can have restated this program's value while
        // this write was in flight, and that one stands.
        set((s) => {
          if ((s.primaryVolumes[exeName] ?? 100) !== percent) return {};
          const primaryVolumes = { ...s.primaryVolumes };
          if (current === 100) {
            delete primaryVolumes[exeName];
          } else {
            primaryVolumes[exeName] = current;
          }
          return { primaryVolumes };
        });
        get().raiseError(i18next.t('log.primaryVolumeFailed', { error: String(e) }), {
          detail: String(e),
        });
      }
    },

    loadSourceVolumes: async () => {
      try {
        const pairs = await api.getSourceVolumes();
        const sourceVolumes: Record<string, number> = {};
        for (const [exeName, percent] of pairs) {
          sourceVolumes[exeName] = percent;
        }
        set({ sourceVolumes });
      } catch (e) {
        get().addLog(i18next.t('log.sourceVolumesFailed', { error: String(e) }), 'error');
      }
    },

    setSourceVolume: async (exeName, percent) => {
      const current = get().sourceVolumes[exeName] ?? 100;
      if (current === percent) return;
      set((s) => {
        const sourceVolumes = { ...s.sourceVolumes };
        // Only an exact 100 is dropped: it is this range's neutral point rather
        // than its top, so 101 and up are levels in their own right and have to
        // survive as entries. The backend stores by the same rule.
        if (percent === 100) {
          delete sourceVolumes[exeName];
        } else {
          sourceVolumes[exeName] = percent;
        }
        return { sourceVolumes };
      });
      try {
        await api.setSourceVolume(exeName, percent);
        get().addLog(i18next.t('log.sourceVolumeSet', { process: exeName, n: percent }), 'info');
      } catch (e) {
        // The backend rejected the value; undo the optimistic update so the UI
        // keeps matching what the engine actually applies and persists. Only
        // while this is still the number on screen: the dial commits without
        // waiting, so a later one can have restated this program's level while
        // this write was in flight, and that one stands.
        set((s) => {
          if ((s.sourceVolumes[exeName] ?? 100) !== percent) return {};
          const sourceVolumes = { ...s.sourceVolumes };
          if (current === 100) {
            delete sourceVolumes[exeName];
          } else {
            sourceVolumes[exeName] = current;
          }
          return { sourceVolumes };
        });
        get().raiseError(i18next.t('log.sourceVolumeFailed', { error: String(e) }), {
          detail: String(e),
        });
      }
    },

    alignSourceLevels: async () => {
      try {
        const { aligned, leftAlone, playing } = await api.alignSourceLevels();
        // One line for the whole action, and it says both halves: what it changed
        // and what it walked past. A program that was not making a sound is not a
        // failure, but it is the reason the numbers on screen moved unevenly —
        // and when nothing changed, the count alone would read as a no-op that
        // explains nothing. There are two ways for nothing to change and they need
        // different words: nothing was playing at all, or exactly one program was,
        // and one program cannot be aligned against itself. The likeliest first
        // move a user makes is clicking Align while listening to a single program.
        get().addLog(
          i18next.t(
            aligned.length === 0
              ? playing === 1
                ? 'log.sourceLevelsAlignedOne'
                : 'log.sourceLevelsAlignedNone'
              : leftAlone.length === 0
                ? 'log.sourceLevelsAligned'
                : 'log.sourceLevelsAlignedSome',
            { n: aligned.length, processes: leftAlone.join(', ') },
          ),
          'info',
        );
      } catch (e) {
        get().raiseError(i18next.t('log.sourceLevelsAlignFailed', { error: String(e) }), {
          detail: String(e),
        });
      }
      // Read the levels back rather than trusting the ones this side could have
      // predicted: the backend rounds each gain and bounds it by that program's
      // own measured peak, and a run that failed halfway has still written some.
      await get().loadSourceVolumes();
    },

    setDeviceDelayValue: async (deviceId, delayMs) => {
      const current = get().deviceDelays[deviceId] ?? 0;
      const next = clampDelay(delayMs);
      // Nothing to change is a success, not a refusal: the calibration's apply
      // walks every measured device and treats a falsy answer as a failure.
      if (current === next) return true;
      set((s) => {
        // A delay of 0 is an absence, not a value: like the neutral source level
        // and the neutral share, the entry is pruned, so "no compensation" has
        // exactly one representation — the missing key every reader treats as 0.
        const deviceDelays = { ...s.deviceDelays };
        if (next === 0) delete deviceDelays[deviceId];
        else deviceDelays[deviceId] = next;
        return { deviceDelays };
      });
      try {
        await api.setDeviceDelay(deviceId, next);
        get().addLog(
          i18next.t('log.delaySet', { device: deviceName(deviceId, get().devices), n: next }),
          'info',
        );
        // The reading is made of this number, so it has to be re-asked: it is
        // taken from the running engines, and nothing else would tell them the
        // value moved. Without this the figure would sit at what the device was
        // playing at before the change, which is the one thing it exists to show.
        await get().reconcileActiveDuplications();
        return true;
      } catch (e) {
        // The backend rejected the value; undo the optimistic update so the UI
        // keeps matching what the engine actually applies and persists. Only while
        // this is still the number on screen: −/+ fires without waiting, so a later
        // click can have restated this device's delay while this write was in
        // flight, and that one stands.
        set((s) => {
          if ((s.deviceDelays[deviceId] ?? 0) !== next) return {};
          const deviceDelays = { ...s.deviceDelays };
          if (current === 0) {
            delete deviceDelays[deviceId];
          } else {
            deviceDelays[deviceId] = current;
          }
          return { deviceDelays };
        });
        get().raiseError(i18next.t('log.delaySetFailed', { error: String(e) }), {
          detail: String(e),
        });
        return false;
      }
    },

    setDelayStep: (stepMs) => {
      const step = clampStep(stepMs);
      if (get().delayStepMs === step) return;
      set({ delayStepMs: step });
      try {
        localStorage.setItem(DELAY_STEP_STORAGE_KEY, String(step));
      } catch {
        /* storage may be unavailable; the preference just does not persist */
      }
    },
  };
}
