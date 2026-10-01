/**
 * Whether (and how) a device's delay/volume values are currently applied.
 *
 * - `mirror`: the duplication engine drives this device, so its values take
 *   effect directly.
 * - `primary`: the system plays this device natively — software can neither
 *   delay nor attenuate that path, so its values only anchor the group.
 * - `inactive`: no engine path involves this device (unrouted, or the sole
 *   target of a single-device route), so its values do nothing right now.
 *
 * The role also decides whether a latency reading can exist at all: only a
 * mirror has a stream of ours to measure, so `primary` and `inactive` mean
 * "nothing to measure" rather than "0 ms".
 */
export type EngineRole = 'mirror' | 'primary' | 'inactive';

/**
 * Every device's engine role across all live routes.
 *
 * A route's first device is played by the OS and the rest are mirrored by the
 * engine, so only routes with two or more targets produce engine roles at all.
 * A device that is a mirror of any route counts as a mirror: there its values
 * are applied, which is the only thing this map is asked.
 */
export function engineRolesFor(
  routedPids: Record<number, string[] | undefined>,
): Map<string, EngineRole> {
  const roles = new Map<string, EngineRole>();
  for (const ids of Object.values(routedPids)) {
    if (ids === undefined || ids.length < 2) continue;
    ids.forEach((id, index) => {
      if (index > 0) roles.set(id, 'mirror');
      else if (!roles.has(id)) roles.set(id, 'primary');
    });
  }
  return roles;
}

/**
 * Which devices the selected processes are routed to right now.
 *
 * The union across the selection, in the order the routes were applied: the
 * first entry is the device the OS plays, and therefore the one the group's
 * delay/volume anchor to.
 */
export function activeDeviceIds(
  selectedPids: number[],
  routedPids: Record<number, string[] | undefined>,
): string[] {
  if (selectedPids.length === 0) return [];
  return [...new Set(selectedPids.flatMap((pid) => routedPids[pid] ?? []))];
}
