import { useEffect, useRef, useState } from 'react';

/**
 * The board's two pickers, their search, and the focus contract they share.
 *
 * One of them is open at a time; `Escape` and a pointerdown outside close both,
 * and only the dismissals that leave the keyboard in the air reach back for the
 * button the menu came out of. Both listeners are registered only while one of
 * the two is open, so a standing listener never swallows the search box's
 * `Escape` (the same rule the routed capsule follows). The menu surfaces and the
 * search box live here because the focus effects below are the only thing that
 * reaches for them; whoever opens a picker records where it came from.
 */
export function usePickers() {
  /** The add-destination picker, anchored to the copies panel's title row. */
  const [pickerOpen, setPickerOpen] = useState(false);
  /** The change-primary picker, anchored to the primary panel's title row. */
  const [primaryPickerOpen, setPrimaryPickerOpen] = useState(false);
  /** The feed section's search. An empty query is the pool the menu opens
   *  with; a query narrows both tiers and is one press (Escape) from gone. */
  const [feedQuery, setFeedQuery] = useState('');
  /** The feed search box, for the two keys that belong to it: Escape clears
   *  the query before the menu hears the key, and the menu's own handler
   *  stands aside by the same address. */
  const feedSearchRef = useRef<HTMLInputElement | null>(null);

  /** The button a picker came from, so closing hands the keyboard back to it. */
  const pickerReturnRef = useRef<HTMLElement | null>(null);

  /** The two menu surfaces, for the focus an open `role=menu` is expected to take. */
  const addMenuRef = useRef<HTMLDivElement | null>(null);
  const primaryMenuRef = useRef<HTMLDivElement | null>(null);

  // Escape closes a picker and a pointerdown anywhere outside one closes it
  // too — blank space on the board included. Both listeners are registered
  // only while one of the two pickers is open, so a standing listener never
  // swallows the search box's Escape (the same rule the routed capsule
  // follows). Both pickers are shut together: they are never open at once, and
  // whichever key or press arrives belongs to the one on screen.
  /** Close the pickers. `toTrigger` puts the keyboard back on the button the
   *  menu came out of: one dismissed with Escape, or answered by choosing a row,
   *  must not leave the caret in the air — the next Tab would start wherever the
   *  unmounted menu last stood. A press somewhere else is its own answer, so
   *  that door does not reach back. */
  const closePicker = (toTrigger: boolean) => {
    setPickerOpen(false);
    setPrimaryPickerOpen(false);
    setFeedQuery('');
    if (toTrigger) pickerReturnRef.current?.focus();
    pickerReturnRef.current = null;
  };

  useEffect(() => {
    if (!pickerOpen && !primaryPickerOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        // The feed search owns Escape while it holds a query: one press clears
        // it, and only an empty box lets the key reach the menu's close.
        const search = feedSearchRef.current;
        if (search !== null && event.target === search && search.value !== '') return;
        event.stopPropagation();
        closePicker(true);
      }
    };
    const onPointerDown = (event: PointerEvent) => {
      // A press that does not land on a picker surface — or on the buttons
      // that toggle one, where the close must not race the button's own click
      // and turn "toggle shut" into "close then reopen" — shuts both. Those
      // surfaces carry `data-owns-picker`; everything else on the board (the
      // well, the halo, the cards, the strip) closes them.
      const target = event.target;
      if (target instanceof Element && target.closest('[data-owns-picker]')) return;
      closePicker(false);
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('pointerdown', onPointerDown, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('pointerdown', onPointerDown, true);
    };
  }, [pickerOpen, primaryPickerOpen]);

  // A menu is walked, not Tabbed through: its rows sit after the whole panel in
  // the document, so Tab would visit every device on the board before reaching
  // one. Opening moves the focus to the first row, which is where the arrows the
  // menus already answer have to start.
  useEffect(() => {
    const menu = pickerOpen
      ? addMenuRef.current
      : primaryPickerOpen
        ? primaryMenuRef.current
        : null;
    menu?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
  }, [pickerOpen, primaryPickerOpen]);

  return {
    pickerOpen,
    setPickerOpen,
    primaryPickerOpen,
    setPrimaryPickerOpen,
    feedQuery,
    setFeedQuery,
    feedSearchRef,
    pickerReturnRef,
    addMenuRef,
    primaryMenuRef,
    closePicker,
  };
}
