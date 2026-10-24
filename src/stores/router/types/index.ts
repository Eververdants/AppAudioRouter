import type { StoreApi } from 'zustand';
import type { AudioActions, AudioState } from './audio';
import type { EngineActions } from './engine';
import type { FeedsActions, FeedsState } from './feeds';
import type { IconsActions, IconsState } from './icons';
import type { JournalActions, JournalState } from './journal';
import type { MemoryActions, MemoryState } from './memory';
import type { RoutingActions, RoutingState } from './routing';
import type { SelectionActions, SelectionState } from './selection';
import type { ShellActions, ShellState } from './shell';
import type { TuningActions, TuningState } from './tuning';

/** The store's whole state: every domain's slice, composed here and nowhere
 *  else. The field and action signatures live with the domain that owns them —
 *  a `types/<domain>.ts` file declares both halves, so a field and the actions
 *  that write it cannot drift apart across two files.
 *
 *  Keys are by executable, never by display name, and `exe_path` never reaches
 *  the frontend; the per-domain comments carry that rule where it applies. */
export interface RouterState
  extends
    AudioState,
    SelectionState,
    RoutingState,
    FeedsState,
    MemoryState,
    TuningState,
    IconsState,
    ShellState,
    JournalState,
    AudioActions,
    SelectionActions,
    RoutingActions,
    FeedsActions,
    MemoryActions,
    TuningActions,
    IconsActions,
    ShellActions,
    EngineActions,
    JournalActions {}

/** The state fields alone — what the initial state has to cover exactly. */
export interface RouterData
  extends
    AudioState,
    SelectionState,
    RoutingState,
    FeedsState,
    MemoryState,
    TuningState,
    IconsState,
    ShellState,
    JournalState {}

/** The `set` every slice factory is handed: zustand's own setter for this
 *  store, so a slice writes exactly the fields it is allowed to. */
export type SetRouterState = StoreApi<RouterState>['setState'];

/** The `get` every slice factory is handed — the whole state, not one slice: a
 *  domain action reads across domains (an apply needs the session list and the
 *  memory), and this is the one seam that says so. */
export type GetRouterState = () => RouterState;

// The per-domain halves, re-exported so a slice file imports its own contract
// from `../types` and never reaches past it into a sibling type file.
export type { AudioActions, AudioState } from './audio';
export type { EngineActions } from './engine';
export type { FeedsActions, FeedsState } from './feeds';
export type { IconsActions, IconsState } from './icons';
export type { JournalActions, JournalState } from './journal';
export type { MemoryActions, MemoryState } from './memory';
export type {
  RoutingActions,
  RoutingState,
  RouteApplyActions,
  RouteResetActions,
  RouteStopActions,
} from './routing';
export type { SelectionActions, SelectionState } from './selection';
export type { ShellActions, ShellState } from './shell';
export type { TuningActions, TuningState } from './tuning';
