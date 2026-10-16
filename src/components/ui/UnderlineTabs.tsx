import { motion } from 'framer-motion';
import { SPRING_GLIDE } from '@/lib/motion';

/** One entry of an `UnderlineTabs` row. */
export interface TabItem {
  id: string;
  label: string;
}

/** The id of one tab's button. The panel it shows points back at it, so the two
 *  sides of the association are spelled the same way in both files. */
export function tabButtonId(layoutId: string, tabId: string): string {
  return `tab-${layoutId}-${tabId}`;
}

/** The id of the panel one tab shows, named by the tab that owns it. */
export function tabPanelId(layoutId: string, tabId: string): string {
  return `tab-panel-${layoutId}-${tabId}`;
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
  const step = (event: React.KeyboardEvent<HTMLDivElement>, delta: number): void => {
    const index = tabs.findIndex((tab) => tab.id === active);
    const next = tabs[(index + delta + tabs.length) % tabs.length];
    if (next === undefined) return;
    event.preventDefault();
    onChange(next.id);
    // The tab row is one tab stop, so the keyboard has to be carried to the tab
    // that now answers: `aria-selected` alone would leave the focus ring on the
    // word the arrows just moved away from.
    document.getElementById(tabButtonId(layoutId, next.id))?.focus();
  };

  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      onKeyDown={(event) => {
        // `role=tablist` promises the arrows: a tab row is walked left and
        // right, not with Tab, which belongs to the controls inside the view.
        if (event.key === 'ArrowRight') step(event, 1);
        else if (event.key === 'ArrowLeft') step(event, -1);
        else if (event.key === 'Home' || event.key === 'End') {
          const edge = event.key === 'Home' ? tabs[0] : tabs[tabs.length - 1];
          if (edge === undefined) return;
          event.preventDefault();
          onChange(edge.id);
          document.getElementById(tabButtonId(layoutId, edge.id))?.focus();
        }
      }}
      className="flex h-11 flex-none items-stretch gap-6 border-b border-line pl-5"
    >
      {tabs.map((tab) => {
        const selected = tab.id === active;
        return (
          <button
            key={tab.id}
            id={tabButtonId(layoutId, tab.id)}
            type="button"
            role="tab"
            aria-selected={selected}
            aria-controls={tabPanelId(layoutId, tab.id)}
            // One tab stop for the row: the arrows move between the tabs, so Tab
            // can leave for the view the selected tab is showing.
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(tab.id)}
            className="group/tab relative flex flex-col justify-end outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/60"
          >
            <span
              className={`px-0.5 pb-2 text-[12px] transition-[color,transform] duration-100 group-active/tab:scale-95 ${
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
