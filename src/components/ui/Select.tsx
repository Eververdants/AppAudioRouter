import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { MAIN_THREAD_TRANSFORM, SPRING_GLIDE, SPRING_TAP } from '@/lib/motion';

/** One row of a `Select`. `value` is what `onChange` is handed. */
export interface SelectOption {
  value: string;
  label: string;
  /** Rendered muted after the label; a hint about what the row is. */
  hint?: string;
}

interface SelectProps {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  /** Accessible name of the control. */
  ariaLabel: string;
  /** Tooltip for the trigger. */
  title?: string;
  /** Shown on the trigger while `value` names no option. */
  placeholder?: string;
  /**
   * Shown on the trigger while `value` names an option that is *gone* — a
   * configured device that has left the machine. Without it the raw id is put on
   * screen, and an endpoint guid is not something a person can read; the two
   * states still have to look different (`placeholder` means "nothing picked",
   * this means "something is picked and it is not here"), which is why they are
   * two props rather than one.
   */
  missingLabel?: string;
  disabled?: boolean;
}

/**
 * A dropdown that belongs to the interface.
 *
 * The native `<select>` renders an OS menu that cannot be styled, cannot be
 * animated and cannot say what the rest of this app says with motion. This is
 * the same control built out of the app's own vocabulary: a trigger row, a
 * gliding menu, a check on the chosen row, and a chevron that turns over as it
 * opens — every part on one of the shared springs.
 *
 * Keyboard-complete: `Enter`/`Space`/`ArrowDown` open it, the arrows and
 * `Home`/`End` move, `Enter` chooses, `Escape` closes without spending the key
 * on the page underneath (`data-owns-escape` is what tells the settings page's
 * own Escape handler to stand down). Focus never leaves the trigger — the menu
 * is a listbox the trigger points at, so the tab order stays one control wide.
 */
export function Select({
  value,
  options,
  onChange,
  ariaLabel,
  title,
  placeholder,
  missingLabel,
  disabled = false,
}: SelectProps) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const listId = useId();

  const selectedIndex = useMemo(
    () => options.findIndex((option) => option.value === value),
    [options, value],
  );
  const selected = selectedIndex >= 0 ? options[selectedIndex] : undefined;

  // Opening puts the highlight on whatever is chosen, so the menu opens around
  // the answer rather than at its top.
  const openMenu = () => {
    setActiveIndex(selectedIndex >= 0 ? selectedIndex : 0);
    setOpen(true);
  };

  const move = (delta: number) => {
    if (options.length === 0) return;
    setActiveIndex((index) => {
      const next = (index + delta + options.length) % options.length;
      return next;
    });
  };

  const choose = (index: number) => {
    const option = options[index];
    if (option === undefined) return;
    onChange(option.value);
    setOpen(false);
    // The trigger keeps the focus: it is the control, and a click on a row must
    // not leave the keyboard pointing at nothing.
    triggerRef.current?.focus();
  };

  // The highlight travels while the focus stays on the trigger, so nothing
  // scrolls after it: past a handful of devices the row a keyboard user is
  // aiming at sits below the fold and never becomes reachable.
  useEffect(() => {
    if (!open) return;
    const row = menuRef.current?.querySelector(`[data-row-index="${activeIndex}"]`);
    row?.scrollIntoView({ block: 'nearest' });
  }, [open, activeIndex]);

  // Options come and go with the device list while the menu can be open. A
  // highlight past the end would point `aria-activedescendant` at a row that is
  // not there and leave `Enter` choosing nothing, so it follows the list down.
  useEffect(() => {
    setActiveIndex((index) => (index < options.length ? index : Math.max(0, options.length - 1)));
  }, [options.length]);

  // Escape and outside-pointerdown follow the menu's visibility, exactly as the
  // stage's pickers do it — a standing listener would swallow the key for the
  // whole session.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey, true);
    const onPointerDown = (event: PointerEvent) => {
      if (rootRef.current !== null && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    window.addEventListener('pointerdown', onPointerDown, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('pointerdown', onPointerDown, true);
    };
  }, [open]);

  const onTriggerKeyDown = (event: React.KeyboardEvent) => {
    if (disabled) return;
    switch (event.key) {
      case 'ArrowDown':
      case 'ArrowUp':
        event.preventDefault();
        if (!open) openMenu();
        else move(event.key === 'ArrowDown' ? 1 : -1);
        break;
      case 'Home':
        if (open) {
          event.preventDefault();
          setActiveIndex(0);
        }
        break;
      case 'End':
        if (open) {
          event.preventDefault();
          setActiveIndex(options.length - 1);
        }
        break;
      case 'Enter':
      case ' ':
        event.preventDefault();
        if (!open) openMenu();
        else choose(activeIndex);
        break;
      case 'Tab':
        setOpen(false);
        break;
      default:
        break;
    }
  };

  const activeId =
    open && options[activeIndex] !== undefined ? `${listId}-option-${activeIndex}` : undefined;

  return (
    <div
      ref={rootRef}
      // The marker is mounted only while the menu is up: a closed dropdown does
      // not own the Escape key, and leaving it on would leave the settings page
      // unable to be closed by the keyboard for as long as focus sat here.
      {...(open ? { 'data-owns-escape': '' } : {})}
      className="relative min-w-0 flex-1"
    >
      <button
        ref={triggerRef}
        type="button"
        role="combobox"
        aria-expanded={open}
        aria-haspopup="listbox"
        // Only while the listbox is actually in the document: `aria-controls`
        // naming an element that is not there is a broken reference, and the
        // menu is mounted only when it is open.
        aria-controls={open ? listId : undefined}
        aria-activedescendant={activeId}
        aria-label={ariaLabel}
        title={title}
        disabled={disabled}
        onClick={() => (open ? setOpen(false) : openMenu())}
        onKeyDown={onTriggerKeyDown}
        className={`flex h-8 w-full min-w-0 items-center gap-2 rounded-ctl border bg-surface px-2.5 text-left text-[12px] outline-none transition-[background-color,border-color,color,transform] duration-150 focus-visible:border-accent active:scale-[0.99] ${
          open
            ? 'border-accent/60'
            : 'border-line-strong hover:border-line-strong hover:bg-surface-hover'
        } ${disabled ? 'cursor-not-allowed opacity-45' : ''}`}
      >
        <span
          className={`min-w-0 flex-1 truncate ${selected === undefined ? 'text-text-muted' : 'text-text-secondary'}`}
        >
          {/* A value that names no option is not silence: a device that was
              unplugged after it was chosen still has its id stored, and a blank
              trigger would read as "nothing is configured". But the id is not
              something a person can read either — the caller says what a missing
              option *means* (`missingLabel`), and the raw id only shows when a
              caller had nothing to say. */}
          {selected?.label ?? (value === '' ? (placeholder ?? '') : (missingLabel ?? value))}
        </span>
        {/* The chevron turns over as the menu arrives: the one mark that says
            the control is open, in place of a native menu's popup. */}
        <motion.span
          aria-hidden="true"
          animate={{ rotate: open ? 180 : 0 }}
          transition={SPRING_TAP}
          transformTemplate={MAIN_THREAD_TRANSFORM}
          className="flex-none text-text-muted"
        >
          <svg
            width="9"
            height="9"
            viewBox="0 0 10 10"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polyline points="2 3.5 5 6.5 8 3.5" />
          </svg>
        </motion.span>
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            key="select-menu"
            ref={menuRef}
            id={listId}
            role="listbox"
            aria-label={ariaLabel}
            initial={{ opacity: 0, y: -4, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -3, scale: 0.99 }}
            transition={SPRING_GLIDE}
            transformTemplate={MAIN_THREAD_TRANSFORM}
            className="cc absolute left-0 right-0 top-full z-30 mt-1 max-h-[220px] overflow-y-auto rounded-card border border-line-strong bg-surface p-1"
          >
            {options.length === 0 && (
              <div className="px-2.5 py-1.5 text-[11px] text-text-muted">{placeholder ?? ''}</div>
            )}
            {options.map((option, index) => {
              const picked = option.value === value;
              const active = index === activeIndex;
              return (
                <button
                  key={option.value}
                  id={`${listId}-option-${index}`}
                  data-row-index={index}
                  type="button"
                  role="option"
                  aria-selected={picked}
                  tabIndex={-1}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => choose(index)}
                  className={`flex w-full items-center gap-2 rounded-seg px-2 py-1.5 text-left text-[12px] transition-colors ${
                    active ? 'bg-surface-hover text-text-primary' : 'text-text-secondary'
                  }`}
                >
                  <span className="flex h-3 w-3 flex-none items-center justify-center">
                    <AnimatePresence initial={false}>
                      {picked && (
                        <motion.svg
                          key="check"
                          initial={{ scale: 0.4, opacity: 0 }}
                          animate={{ scale: 1, opacity: 1 }}
                          exit={{ scale: 0.4, opacity: 0 }}
                          transition={SPRING_TAP}
                          transformTemplate={MAIN_THREAD_TRANSFORM}
                          width="10"
                          height="10"
                          viewBox="0 0 10 10"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.6"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          className="text-accent"
                          aria-hidden="true"
                        >
                          <polyline points="1.5 5.5 4 8 8.5 2.5" />
                        </motion.svg>
                      )}
                    </AnimatePresence>
                  </span>
                  <span className="min-w-0 flex-1 truncate">{option.label}</span>
                  {option.hint !== undefined && (
                    <span className="flex-none text-xs text-text-muted">{option.hint}</span>
                  )}
                </button>
              );
            })}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
