/**
 * The levels and the compensation: a device's delay and share, a program's
 * source level and its primary (session) volume, and the align that walks the
 * routed programs. Mirrors `src-tauri/src/commands/tuning.rs`.
 *
 * Two axes, never one: a share is a copy's attenuation, a primary volume is the
 * session's own, and the neutral point of both is the same number the config
 * calls neutral.
 *
 * Runs **inside the page**, after the core, and closes over nothing from this
 * module.
 */
export function registerTuningCommands(): void {
  const { state, handlers } = window.__AAR_BRIDGE__;

  /** `config::DELAY_MAX_MS`: a magnitude beyond it is refused, not clamped. */
  const { DELAY_MAX_MS } = window.__AAR_CONSTANTS__;

  handlers.set('get_device_delays', () => state.delays);
  handlers.set('set_device_delay', (payload) => {
    const deviceId = String(payload.deviceId);
    const delayMs = Number(payload.delayMs);
    // `DelayConfig::set`: 0 removes the entry, a magnitude past the hard
    // bound is refused rather than clamped, and anything else is persisted
    // so a later boot reads the same number back.
    if (!Number.isFinite(delayMs)) return null;
    if (Math.abs(delayMs) > DELAY_MAX_MS) {
      throw new Error(`delay ${delayMs} ms is outside the supported ±${DELAY_MAX_MS} ms bound`);
    }
    const rest = state.delays.filter(([id]: [string, number]) => id !== deviceId);
    state.delays = delayMs === 0 ? rest : [...rest, [deviceId, delayMs]];
    return null;
  });
  handlers.set('get_device_volumes', () => state.volumes);
  handlers.set('set_device_volume', () => null);
  handlers.set('get_primary_volumes', () => state.primaryVolumes);
  handlers.set('set_primary_volume', (payload) => {
    const exeName = String(payload.exeName);
    const percent = Number(payload.percent);
    // 100 is the neutral volume and is stored as "no entry", the same rule
    // the real backend follows.
    const rest = state.primaryVolumes.filter(([name]) => name !== exeName);
    state.primaryVolumes = percent === 100 ? rest : [...rest, [exeName, percent]];
    return null;
  });
  handlers.set('get_source_volumes', () => state.sourceVolumes);
  handlers.set('set_source_volume', (payload) => {
    const exeName = String(payload.exeName);
    const percent = Number(payload.percent);
    // 100 is the neutral level and is stored as "no entry", the same rule
    // the real backend follows.
    const rest = state.sourceVolumes.filter(([name]) => name !== exeName);
    state.sourceVolumes = percent === 100 ? rest : [...rest, [exeName, percent]];
    return null;
  });
  handlers.set('align_source_levels', () => {
    // The real command answers with what it set, what it walked past and how
    // many routed programs had a reading at all; the store destructures all
    // three, so answering `null` here made every align in e2e take the catch
    // branch and log a failure for an action the fake never performed.
    return { aligned: [], leftAlone: [], playing: 0 };
  });
}
