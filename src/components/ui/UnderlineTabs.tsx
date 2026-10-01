import { motion } from 'framer-motion';
import { SPRING_GLIDE } from '@/lib/motion';

/** One entry of an `UnderlineTabs` row. */
export interface TabItem {
  id: string;
  label: string;
}

/**
 * Underline tabs — the app's one piece of view navigation.
 *
 * A tab is a word with a rule under it, and the rule under the current one is
 * the accent. That is the whole visual: no capsule, no filled pill, no pill
 * sliding around inside a track. A pill has to carry the label *and* the
 * selection in one shape, which means the inactive tabs look like buttons
 * waiting to be pressed; a rule under a word leaves the words to be words.
 *
 * The accent rule travels between labels on the shared-layout spring, so
 * switching reads as the same mark moving rather than as two marks blinking.
 */
export function UnderlineTabs({
  tabs,
  active,
  onChange,
  layoutId,
  ariaLabel,
}: {
  tabs: TabItem[];
  active: string;
  onChange: (id: string) => void;
  /** Shared-layout id of the moving rule; must be unique per tab row. */
  layoutId: string;
  ariaLabel: string;
}) {
  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className="flex h-11 flex-none items-stretch gap-6 border-b border-line pl-5"
    >
      {tabs.map((tab) => {
        const selected = tab.id === active;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={selected}
            onClick={() => onChange(tab.id)}
            className="relative flex flex-col justify-end outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/60"
          >
            <span
              className={`px-0.5 pb-2 text-[12px] transition-colors ${
                selected
                  ? 'font-medium text-text-primary'
                  : 'text-text-muted hover:text-text-secondary'
              }`}
            >
              {tab.label}
            </span>
            {selected ? (
              <motion.span
                layoutId={layoutId}
                transition={SPRING_GLIDE}
                className="absolute inset-x-0 bottom-0 h-0.5 bg-accent"
              />
            ) : (
              // A transparent twin keeps every tab the same height, so the row
              // does not resize as the rule moves through it.
              <span aria-hidden="true" className="absolute inset-x-0 bottom-0 h-0.5" />
            )}
          </button>
        );
      })}
    </div>
  );
}
