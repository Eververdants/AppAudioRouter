import { create } from 'zustand';
import { initialState } from './router/initial';
import { feedTargetsOf, selectionTargets } from './router/pure/targets';
import { createApplySlice } from './router/slices/apply';
import { createAudioSlice } from './router/slices/audio';
import { createEngineSlice } from './router/slices/engine';
import { createFeedsSlice } from './router/slices/feeds';
import { createIconsSlice } from './router/slices/icons';
import { createJournalSlice } from './router/slices/journal';
import { createMemorySlice } from './router/slices/memory';
import { createResetSlice } from './router/slices/reset';
import { createSelectionSlice } from './router/slices/selection';
import { createShellSlice } from './router/slices/shell';
import { createStopSlice } from './router/slices/stop';
import { createTuningSlice } from './router/slices/tuning';
import type { RouterState } from './router/types';

export { feedLiveness, type FeedLiveness, type RememberedFeedEntry } from './router/liveness';
export { findInPool } from './router/pure/processes';

/**
 * The store root: the composition point and nothing else.
 *
 * Every state field and action signature lives in `router/types/*`, every
 * action body in `router/slices/*`, the stateless helpers in `router/pure/*`,
 * and the module-level mutable guards — the restore claims, the icon asks, the
 * refresh gates, the reconciliation flight, the one assignment queue — in
 * `router/gates.ts`, where each of them is declared exactly once for the run.
 * What stays here is the single `create` call and the two subscriptions below:
 * they are the only state in the app that has to react to *any* write, and no
 * list of call sites at the refreshes can ever be as complete as one.
 */
export const useRouterStore = create<RouterState>((set, get) => ({
  ...initialState,
  ...createAudioSlice(set, get),
  ...createSelectionSlice(set, get),
  ...createApplySlice(set, get),
  ...createStopSlice(set, get),
  ...createResetSlice(set, get),
  ...createFeedsSlice(set, get),
  ...createMemorySlice(set, get),
  ...createTuningSlice(set, get),
  ...createIconsSlice(set, get),
  ...createShellSlice(set, get),
  ...createEngineSlice(set, get),
  ...createJournalSlice(set, get),
}));

/**
 * The staged targets are derived state while the user is staging nothing of
 * their own, so they have to be re-derived whenever what they were derived
 * *from* moves: the system default switching under an unrouted program, a
 * routed device leaving and coming back with the Bluetooth headset it belongs
 * to, the backend reporting a route the engine list did not. Without this the
 * plan held the moment of the last selection or apply, and the board needed a
 * program switch to catch up with what the audio engine had already been doing.
 *
 * One subscription rather than a call inside every refresh: the sources move
 * from more places than any one list of call sites keeps up with, and a stale
 * board is exactly what a missed call site looks like. The user's own staging
 * (`deviceSelectionPrefilled` false) freezes the plan on purpose — a proposal
 * being built must not be rewritten under the cursor — so this does nothing for
 * it, and the equality check keeps a refresh that changed nothing from
 * repainting the plan with a fresh array.
 */
useRouterStore.subscribe((state, previous) => {
  if (!state.deviceSelectionPrefilled || state.selectedPids.length !== 1) return;
  if (
    state.routedPids === previous.routedPids &&
    state.defaultDeviceId === previous.defaultDeviceId &&
    state.devices === previous.devices &&
    state.sessions === previous.sessions &&
    state.selectedPids === previous.selectedPids
  ) {
    return;
  }
  const pid = state.selectedPids[0];
  if (pid === undefined) return;
  const desired = selectionTargets(state, pid);
  const current = state.selectedDeviceIds;
  if (desired.length === current.length && desired.every((id, index) => id === current[index])) {
    return;
  }
  useRouterStore.setState({ selectedDeviceIds: desired });
});

/**
 * The staged feeds are derived state while the user stages nothing of their
 * own, for the same reason the device plan is: a restore landing at boot, a
 * process leaving the list, a rule the backend took down — the plan has to read
 * what the live map holds, or a wire that is already up reads as a proposal
 * waiting for the hub, and pressing that hub would take down a feed the user
 * never touched. Unlike the device plan, the feed plan belongs to the one
 * programme the board draws even in a multi-selection, so there is no
 * single-selection guard here. The user's own staging
 * (`feedSelectionPrefilled` false) freezes it, and a landing that refused a
 * pair keeps it frozen — the hub stays honest about what has not landed.
 */
useRouterStore.subscribe((state, previous) => {
  if (!state.feedSelectionPrefilled) return;
  const pid = state.selectedPids[0];
  if (pid === undefined) return;
  if (
    state.feeds === previous.feeds &&
    state.sessions === previous.sessions &&
    state.selectedPids === previous.selectedPids
  ) {
    return;
  }
  const desired = feedTargetsOf(state, pid);
  const current = state.selectedFeedPids;
  if (
    desired.length === current.length &&
    desired.every((target, index) => target === current[index])
  ) {
    return;
  }
  useRouterStore.setState({ selectedFeedPids: desired });
});
