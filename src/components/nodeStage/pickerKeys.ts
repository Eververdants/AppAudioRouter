/**
 * The arrows a `role=menu` promises.
 *
 * The rows are real buttons, so `Tab` already reaches every one of them — but a
 * device list walked one Tab press per device is not walked, and the board's own
 * `Select` (settings) answers the arrows. Focus moves rather than a highlight,
 * so the browser scrolls the row into view by itself.
 */
export function walkPickerMenu(event: React.KeyboardEvent<HTMLDivElement>): void {
  const rows = Array.from(
    event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
  );
  if (rows.length === 0) return;
  const current = rows.findIndex((row) => row === document.activeElement);
  let next: number | null = null;
  if (event.key === 'ArrowDown') next = current < 0 ? 0 : (current + 1) % rows.length;
  else if (event.key === 'ArrowUp')
    next = current < 0 ? rows.length - 1 : (current - 1 + rows.length) % rows.length;
  else if (event.key === 'Home') next = 0;
  else if (event.key === 'End') next = rows.length - 1;
  if (next === null) return;
  event.preventDefault();
  rows[next]?.focus();
}

/**
 * Arrows out of the feed search walk *this section's* results, not the whole
 * menu: the search sits in the menu's last section, and the menu's own walker —
 * which always starts from its first row — would answer ArrowDown with a jump
 * across two unrelated sections. Focus moves rather than a highlight, so the
 * browser scrolls the row into view by itself, exactly like the menu above.
 */
export function walkFeedResults(event: React.KeyboardEvent<HTMLInputElement>): void {
  const section = event.currentTarget.closest('[data-picker-section="feed"]');
  const rows = Array.from(section?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []);
  if (rows.length === 0) return;
  const current = rows.findIndex((row) => row === document.activeElement);
  const next =
    event.key === 'ArrowDown'
      ? current < 0
        ? 0
        : (current + 1) % rows.length
      : current < 0
        ? rows.length - 1
        : (current - 1 + rows.length) % rows.length;
  event.preventDefault();
  event.stopPropagation();
  rows[next]?.focus();
}
