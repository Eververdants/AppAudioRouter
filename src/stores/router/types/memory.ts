import type { RememberedRouteEntry } from '@/lib/types';

/** The route memory, and the switch that decides whether an apply writes it. */
export interface MemoryState {
  /** Whether a route is written to the memory as it is applied, and restored
   * from it when the program plays again. */
  autoRemember: boolean;
  /** Routes the backend remembers, one entry per executable name. */
  rememberedRoutes: RememberedRouteEntry[];
}

/** Reading the memory, putting it back, and taking one row out of it. */
export interface MemoryActions {
  /** Read the remembered routes the backend persisted for earlier sessions. */
  loadRememberedRoutes: () => Promise<void>;
  /** Put the remembered route of every process that has no route back on.
   * A no-op until the device list, the process list and the memory have all
   * arrived, which is why every one of them calls it. */
  restoreRememberedRoutes: () => Promise<void>;
  /** Forget one executable's remembered route. */
  forgetRememberedRoute: (exeName: string) => Promise<void>;
  toggleAutoRemember: () => void;
}
