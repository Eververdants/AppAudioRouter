import i18next from 'i18next';
import * as api from '@/lib/invoke';
import { feedRestoreDecided, queueAssignmentWork } from '../gates';
import { feedLiveness } from '../liveness';
import { rememberFeedTargets } from '../pure/memory';
import { deriveFeeds, feedTargetPool, findInPool, lowestPidByExe } from '../pure/processes';
import type { FeedsActions, GetRouterState, SetRouterState } from '../types';

/** "Send this program's output into that program": the memory, the carrier pair
 *  that can carry it, and the two verbs that land and take down one rule.
 *
 *  A feed is an *additional* destination — the source's own device output is
 *  untouched — and both ends are keyed by executable. Landing goes through
 *  `addFeed` / `removeFeed`, which is also the only way the hub's apply writes a
 *  feed; the picker edits the plan, never this. */
export function createFeedsSlice(set: SetRouterState, get: GetRouterState): FeedsActions {
  return {
    loadFeeds: async () => {
      try {
        const pairs = await api.listFeeds();
        const grouped = new Map<string, { sourceExe: string; targetExe: string[] }>();
        for (const [sourceExe, targetExe] of pairs) {
          const key = sourceExe.toLowerCase();
          const entry = grouped.get(key);
          if (entry === undefined) grouped.set(key, { sourceExe, targetExe: [targetExe] });
          else entry.targetExe.push(targetExe);
        }
        const rememberedFeeds = [...grouped.values()];
        set({
          rememberedFeeds,
          feeds: deriveFeeds(rememberedFeeds, get().sessions, get().windowApps),
        });
      } catch (e) {
        get().addLog(i18next.t('log.feedsLoadFailed', { error: String(e) }), 'error');
        return;
      }
      queueAssignmentWork(() => get().restoreRememberedFeeds());
    },

    loadFeedCarrier: async () => {
      try {
        set({ feedCarrier: await api.getFeedCarrier() });
      } catch (e) {
        get().addLog(i18next.t('log.feedCarrierLoadFailed', { error: String(e) }), 'error');
      }
      // The carrier arriving is the moment every recorded-but-undeliverable feed
      // becomes deliverable; whichever of the three inputs landed last calls it.
      queueAssignmentWork(() => get().restoreRememberedFeeds());
    },

    setFeedCarrier: async (render, capture) => {
      const previous = get().feedCarrier;
      set({ feedCarrier: { render, capture } });
      try {
        await api.setFeedCarrier(render, capture);
        get().addLog(i18next.t('log.feedCarrierSet'), 'success');
        // A carrier moving means a new pair for every feed's tap and for every
        // target's capture pin — the whole rule has to be laid down again, not
        // only the ones that were waiting. The claim is what would otherwise skip
        // every pair that has already delivered once.
        feedRestoreDecided.clear();
        queueAssignmentWork(() => get().restoreRememberedFeeds());
      } catch (e) {
        set((s) => {
          // Roll this pair back only while it is still the pair on screen: the two
          // picker rows fire without waiting, so a second pairing can have restated
          // the carrier while this write was in flight, and the pair that write
          // accepted stands — the file holds it, and the liveness of every feed is
          // read from it.
          if (s.feedCarrier.render !== render || s.feedCarrier.capture !== capture) return {};
          return { feedCarrier: previous };
        });
        get().raiseError(i18next.t('log.feedCarrierSetFailed', { error: String(e) }), {
          detail: String(e),
        });
      }
    },

    addFeed: async (sourcePid, targetPid) => {
      const { sessions, windowApps, feeds } = get();
      if (sourcePid === targetPid) return;
      const source = sessions.find((s) => s.pid === sourcePid);
      const target = findInPool(sessions, windowApps, targetPid);
      if (source === undefined || target === undefined) return;
      // A feed belongs to the program, and the live map is rebuilt from the memory
      // on each program's lowest pid (`deriveFeeds`). The board can be looking at
      // a sibling process, so an add kept under that pid would give one rule two
      // addresses in one run: the ✕ addressed by the sibling finds nothing in the
      // map and does nothing, and the next refresh moves the wire to the lowest
      // pid anyway. Pin, remember and restore all use the address the refresh
      // uses — the source out of the session list, the target out of the pool
      // that also holds the running-but-silent apps a feed may be aimed at.
      const canonicalSource =
        lowestPidByExe(sessions).get(source.exe_name.toLowerCase()) ?? sourcePid;
      const canonicalTarget =
        feedTargetPool(sessions, windowApps).get(target.exe_name.toLowerCase()) ?? targetPid;
      if (canonicalSource === canonicalTarget) return;
      if ((feeds[canonicalSource] ?? []).includes(canonicalTarget)) return;
      // The board has shown this pair since the user staged it; landing records
      // the rule in the memory and puts the wire into the live map, where the
      // three-state word and the moving dashes read it.
      set((s) => ({
        feeds: {
          ...s.feeds,
          [canonicalSource]: [...(s.feeds[canonicalSource] ?? []), canonicalTarget],
        },
        rememberedFeeds: rememberFeedTargets(
          s.rememberedFeeds,
          source.exe_name,
          target.exe_name,
          true,
        ),
      }));
      // Claimed *before* the ask, like the restore's own attempts: the pinning
      // itself is a Core Audio change, and the refresh it provokes runs the feed
      // restore over the rule this add has already written — unclaimed, it
      // delivers the same pair a second time and logs a feed the user just added
      // as restored. Only when the backend can actually deliver, or a rule that
      // came back suspended would never be tried again once its reason clears.
      const decidedKey = `${canonicalSource}|${target.exe_name.toLowerCase()}`;
      const deliverable =
        feedLiveness(source.exe_name, get().feedCarrier, get().feedTapFailures) === 'live';
      if (deliverable) feedRestoreDecided.add(decidedKey);
      try {
        const outcome = await api.setFeedTarget(
          canonicalSource,
          source.exe_name,
          canonicalTarget,
          target.exe_name,
        );
        // Not delivered after all: hand the pair back to the restore pass, which
        // runs the moment the reason stops holding (the carrier gets configured).
        // Only a claim this add made.
        if (deliverable && !outcome.delivered) feedRestoreDecided.delete(decidedKey);
        if (outcome.delivered) {
          // The tap was rebuilt, so whatever killed the last one no longer stands.
          set((s) => {
            if (s.feedTapFailures[source.exe_name.toLowerCase()] === undefined) return {};
            const feedTapFailures = { ...s.feedTapFailures };
            delete feedTapFailures[source.exe_name.toLowerCase()];
            return { feedTapFailures };
          });
          get().addLog(
            i18next.t('log.feedSet', { source: source.exe_name, target: target.exe_name }),
            'success',
          );
        } else {
          get().addLog(
            i18next.t('log.feedNoCarrier', { source: source.exe_name, target: target.exe_name }),
            'error',
          );
        }
      } catch (e) {
        // The backend refused the rule: roll the whole optimistic write back, so
        // the UI never shows a wire the audio service does not know about.
        if (deliverable) feedRestoreDecided.delete(decidedKey);
        set((s) => {
          const nextFeeds = { ...s.feeds };
          const remaining = (nextFeeds[canonicalSource] ?? []).filter(
            (pid) => pid !== canonicalTarget,
          );
          if (remaining.length === 0) delete nextFeeds[canonicalSource];
          else nextFeeds[canonicalSource] = remaining;
          return {
            feeds: nextFeeds,
            rememberedFeeds: rememberFeedTargets(
              s.rememberedFeeds,
              source.exe_name,
              target.exe_name,
              false,
            ),
          };
        });
        get().raiseError(i18next.t('log.feedSetFailed', { error: String(e) }), {
          detail: String(e),
        });
      }
    },

    removeFeed: async (sourcePid, targetPid) => {
      const { sessions, windowApps, feeds, rememberedFeeds } = get();
      const source = sessions.find((s) => s.pid === sourcePid);
      const target = findInPool(sessions, windowApps, targetPid);
      // The same address `addFeed` and `deriveFeeds` use: the row can be reached
      // from a sibling process's board, and the wire it shows lives under the
      // program's lowest pid. A session that has just left the list keeps the pid
      // it was called with — that is still the wire's address. The source is
      // canonical out of the session list, the target out of the pool that also
      // holds the running-but-silent apps.
      const sourceByExe = lowestPidByExe(sessions);
      const targetByExe = feedTargetPool(sessions, windowApps);
      const sourceExe = source?.exe_name.toLowerCase();
      const targetExe = target?.exe_name.toLowerCase();
      const canonicalSource =
        (sourceExe === undefined ? undefined : sourceByExe.get(sourceExe)) ?? sourcePid;
      const canonicalTarget =
        (targetExe === undefined ? undefined : targetByExe.get(targetExe)) ?? targetPid;
      if (!(feeds[canonicalSource] ?? []).includes(canonicalTarget)) return;
      // Where this wire sat among its source's other wires, in the board and in
      // the memory the board is rebuilt from: a rollback that appended would
      // renumber every feed the user still has standing.
      const wireIndex = (feeds[canonicalSource] ?? []).indexOf(canonicalTarget);
      const memoryIndex =
        source === undefined || target === undefined
          ? undefined
          : rememberedFeeds
              .find((entry) => entry.sourceExe.toLowerCase() === source.exe_name.toLowerCase())
              ?.targetExe.findIndex((name) => name.toLowerCase() === target.exe_name.toLowerCase());
      set((s) => {
        const nextFeeds = { ...s.feeds };
        const remaining = (nextFeeds[canonicalSource] ?? []).filter(
          (pid) => pid !== canonicalTarget,
        );
        if (remaining.length === 0) delete nextFeeds[canonicalSource];
        else nextFeeds[canonicalSource] = remaining;
        return {
          feeds: nextFeeds,
          rememberedFeeds:
            source !== undefined && target !== undefined
              ? rememberFeedTargets(s.rememberedFeeds, source.exe_name, target.exe_name, false)
              : s.rememberedFeeds,
        };
      });
      try {
        const stuck = await api.removeFeedTarget(canonicalSource, canonicalTarget);
        if (source !== undefined && target !== undefined) {
          get().addLog(
            i18next.t('log.feedRemoved', { source: source.exe_name, target: target.exe_name }),
            'info',
          );
        }
        // The rule is gone and the wire came down, but the endpoint did not: the
        // program stays fixed to the carrier, and nothing on screen says so.
        // Say it here, and name the way out — this is the one case where the
        // settings page's reset is the only thing left that can reach it.
        if (stuck.length > 0) {
          get().raiseError(i18next.t('log.feedRemovedStuck', { processes: stuck.join(', ') }));
        }
      } catch (e) {
        // The backend kept the rule: put this one wire and this one memory entry
        // back rather than showing a board that disagrees with the audio service.
        // Functional, and scoped to this one wire, so a *different* feed the user
        // moved while this removal was in flight keeps its own outcome instead of
        // being reverted by a whole-map snapshot.
        set((s) => {
          const nextFeeds = { ...s.feeds };
          const existing = nextFeeds[canonicalSource] ?? [];
          if (!existing.includes(canonicalTarget)) {
            const restored = [...existing];
            restored.splice(wireIndex, 0, canonicalTarget);
            nextFeeds[canonicalSource] = restored;
          }
          return {
            feeds: nextFeeds,
            rememberedFeeds:
              source !== undefined && target !== undefined
                ? rememberFeedTargets(
                    s.rememberedFeeds,
                    source.exe_name,
                    target.exe_name,
                    true,
                    memoryIndex,
                  )
                : s.rememberedFeeds,
          };
        });
        get().raiseError(i18next.t('log.feedRemoveFailed', { error: String(e) }), {
          detail: String(e),
        });
      }
    },

    restoreRememberedFeeds: async () => {
      const { rememberedFeeds, sessions, windowApps, feedCarrier } = get();
      if (rememberedFeeds.length === 0) return;
      if (feedCarrier.render === null || feedCarrier.capture === null) return;
      const sourceByExe = lowestPidByExe(sessions);
      if (sourceByExe.size === 0) return;
      const targetByExe = feedTargetPool(sessions, windowApps);
      const pairs: {
        sourcePid: number;
        sourceExe: string;
        targetPid: number;
        targetExe: string;
      }[] = [];
      for (const entry of rememberedFeeds) {
        const sourcePid = sourceByExe.get(entry.sourceExe.toLowerCase());
        if (sourcePid === undefined) continue;
        for (const targetExe of entry.targetExe) {
          const targetPid = targetByExe.get(targetExe.toLowerCase());
          if (targetPid === undefined || targetPid === sourcePid) continue;
          // Membership in the live feed map is not delivery: the map is derived
          // from this very memory, so every live pair is in it, and skipping on
          // it would skip everything. What bounds the attempts is the decided
          // set below — once per (pid, target) per run — and the delivered ones
          // were claimed by `addFeed` at the moment the backend pinned them.
          const key = `${sourcePid}|${targetExe.toLowerCase()}`;
          if (feedRestoreDecided.has(key)) continue;
          pairs.push({ sourcePid, sourceExe: entry.sourceExe, targetPid, targetExe });
        }
      }
      if (pairs.length === 0) return;
      // Claimed before the first await, like the device-route restore: a refresh
      // landing mid-flight must not double-pin the same endpoints.
      for (const pair of pairs) {
        feedRestoreDecided.add(`${pair.sourcePid}|${pair.targetExe.toLowerCase()}`);
      }
      const results = await Promise.allSettled(
        pairs.map((pair) =>
          api.setFeedTarget(pair.sourcePid, pair.sourceExe, pair.targetPid, pair.targetExe),
        ),
      );
      const restored: Record<number, number[]> = {};
      const recovered = new Set<string>();
      results.forEach((result, index) => {
        const pair = pairs[index];
        if (pair === undefined) return;
        if (result.status === 'fulfilled' && result.value.delivered) {
          restored[pair.sourcePid] = [...(restored[pair.sourcePid] ?? []), pair.targetPid];
          recovered.add(pair.sourceExe.toLowerCase());
          get().addLog(
            i18next.t('log.feedRestored', { source: pair.sourceExe, target: pair.targetExe }),
            'info',
          );
        }
        // A missing carrier stays silent in a restore pass: the board shows that
        // state, and a boot sweep has no business scolding the user for a
        // configuration it can see.
      });
      if (Object.keys(restored).length === 0) return;
      set((s) => {
        const nextFeeds = { ...s.feeds };
        for (const [sourcePidKey, targetPids] of Object.entries(restored)) {
          const sourcePid = Number(sourcePidKey);
          const existing = nextFeeds[sourcePid] ?? [];
          nextFeeds[sourcePid] = [...existing, ...targetPids.filter((t) => !existing.includes(t))];
        }
        // A tap that just delivered is alive again, so the failure that marked
        // this programme's rows as broken no longer stands.
        let feedTapFailures = s.feedTapFailures;
        for (const exe of recovered) {
          if (feedTapFailures[exe] === undefined) continue;
          if (feedTapFailures === s.feedTapFailures) feedTapFailures = { ...feedTapFailures };
          delete feedTapFailures[exe];
        }
        return { feeds: nextFeeds, feedTapFailures };
      });
    },
  };
}
