import i18next from 'i18next';
import { deviceName, feedTargetsOf, selectionTargets } from '../pure/targets';
import { feedTargetPool, findInPool } from '../pure/processes';
import type { GetRouterState, SelectionActions, SetRouterState } from '../types';

/** The two plans the board stages — processes, devices, programme inputs — and
 *  the ordering of the device plan's seat. Nothing here talks to the backend:
 *  these are edits of a proposal, and `applyRoute` is what lands it. The
 *  `*SelectionPrefilled` flags are the whole difference between a guess the
 *  subscriptions keep re-derived and a plan the user built. */
export function createSelectionSlice(set: SetRouterState, get: GetRouterState): SelectionActions {
  return {
    selectProcess: (pid) =>
      set((s) => ({
        selectedPids: [pid],
        selectedDeviceIds: selectionTargets(s, pid),
        // Whatever came out of that is a guess about where the process plays,
        // not something the user asked for yet — and it stays derived: the
        // subscription below keeps it tracking the route and the default.
        deviceSelectionPrefilled: true,
        // The feed plan is the same kind of guess: the program's live feeds until
        // the user stages one of their own, tracked by the same subscription.
        selectedFeedPids: feedTargetsOf(s, pid),
        feedSelectionPrefilled: true,
      })),

    toggleProcessSelection: (pid) =>
      set((s) => {
        const selectedPids = s.selectedPids.includes(pid)
          ? s.selectedPids.filter((p) => p !== pid)
          : [...s.selectedPids, pid];
        // Device targets stay shared across a multi-selection; clear them only
        // when the last process was deselected. Either way the target list is no
        // longer one process's prefilled guess.
        const selectedDeviceIds = selectedPids.length === 0 ? [] : s.selectedDeviceIds;
        // The feed plan is not shared — it belongs to the programme the board
        // draws — so it survives a multi-selection and only leaves with the last
        // one. The prefill flag is left as it stands: the board keeps showing the
        // first process's plan either way.
        const selectedFeedPids = selectedPids.length === 0 ? [] : s.selectedFeedPids;
        return {
          selectedPids,
          selectedDeviceIds,
          deviceSelectionPrefilled: false,
          selectedFeedPids,
        };
      }),

    toggleDeviceSelection: (deviceId) => {
      const { selectedDeviceIds, deviceSelectionPrefilled, devices, selectedPids, sessions } =
        get();
      // The first click on a device while the target list is still the app's own
      // single-device guess *replaces* it: "play through that one instead". Adding
      // to the guess is what used to turn a device switch into a second copy of
      // the audio on a device the user did not mean to use.
      const replacesGuess =
        deviceSelectionPrefilled &&
        selectedDeviceIds.length === 1 &&
        !selectedDeviceIds.includes(deviceId);
      const next = replacesGuess
        ? [deviceId]
        : selectedDeviceIds.includes(deviceId)
          ? selectedDeviceIds.filter((id) => id !== deviceId)
          : [...selectedDeviceIds, deviceId];
      set({ selectedDeviceIds: next, deviceSelectionPrefilled: false });
      if (replacesGuess) {
        const device = deviceName(deviceId, devices);
        const process = sessions.find((s) => s.pid === selectedPids[0])?.exe_name;
        get().addLog(
          process === undefined
            ? i18next.t('log.deviceSwitched', { device })
            : i18next.t('log.deviceSwitchedProcess', { process, device }),
          'info',
        );
      }
    },

    appendDeviceTarget: (deviceId) => {
      const { selectedDeviceIds } = get();
      // Already in the plan: the row's own toggle owns membership, and appending
      // a second time would put one device on two rows.
      if (selectedDeviceIds.includes(deviceId)) return;
      set({
        deviceSelectionPrefilled: false,
        selectedDeviceIds: [...selectedDeviceIds, deviceId],
      });
    },

    appendFeedTarget: (targetPid) => {
      const { sessions, windowApps, selectedPids, selectedFeedPids } = get();
      const pid = selectedPids[0];
      const source = sessions.find((s) => s.pid === pid);
      const target = findInPool(sessions, windowApps, targetPid);
      // A feed into the program itself is not a state this app offers, and a
      // target that has left both lists (sessions and windowed apps) has nothing
      // to arrive at.
      if (source === undefined || target === undefined) return;
      if (source.exe_name.toLowerCase() === target.exe_name.toLowerCase()) return;
      // The plan speaks the address the live map speaks — the program's lowest
      // pid. Storing the sibling the picker happened to offer would make the same
      // rule read as two, and the hub would never stop asking to apply it.
      const canonical =
        feedTargetPool(sessions, windowApps).get(target.exe_name.toLowerCase()) ?? targetPid;
      if (selectedFeedPids.includes(canonical)) return;
      set({
        selectedFeedPids: [...selectedFeedPids, canonical],
        feedSelectionPrefilled: false,
      });
    },

    dropFeedTarget: (targetPid) => {
      const { selectedFeedPids } = get();
      if (!selectedFeedPids.includes(targetPid)) return;
      set({
        selectedFeedPids: selectedFeedPids.filter((pid) => pid !== targetPid),
        feedSelectionPrefilled: false,
      });
    },

    setPrimaryDevice: (deviceId) => {
      const { selectedDeviceIds, devices } = get();
      if (!selectedDeviceIds.includes(deviceId) && !devices.some((d) => d.id === deviceId)) return;
      // The seat is the plan's first entry: the board draws the plan in its own
      // order and the apply lands exactly that order, so promoting a device that
      // already holds it is not a change.
      if (selectedDeviceIds[0] === deviceId) return;
      // Who stays when the picked device takes the seat:
      // - already on the plan: everyone but itself (roles swap, membership kept);
      // - from outside: everyone but the device currently holding the seat — the
      //   same membership the board's picker offers, so a row the picker lets you
      //   press is never a row this refuses. A device already carrying a delay
      //   compensation may take the seat: the values are the copies' business,
      //   and recalibrating after the move is the wizard's job.
      const kept = selectedDeviceIds.includes(deviceId)
        ? selectedDeviceIds.filter((id) => id !== deviceId)
        : selectedDeviceIds.slice(1);
      set({ selectedDeviceIds: [deviceId, ...kept], deviceSelectionPrefilled: false });
    },

    promoteDevice: (deviceId) => {
      const { selectedDeviceIds } = get();
      // Not staged, or already the primary: nothing to move. A no-op must not
      // churn the array the stage's role words are keyed against.
      const index = selectedDeviceIds.indexOf(deviceId);
      if (index <= 0) return;
      // Moving the seat is the user's own staging, exactly like `setPrimaryDevice`
      // and `appendDeviceTarget`: the plan stops being the app's derived guess, so
      // a refresh must not re-derive the seat back from the live route under it.
      set({
        selectedDeviceIds: [deviceId, ...selectedDeviceIds.filter((id) => id !== deviceId)],
        deviceSelectionPrefilled: false,
      });
    },
  };
}
