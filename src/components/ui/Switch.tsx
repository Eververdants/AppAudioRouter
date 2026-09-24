import { motion } from 'framer-motion';

interface SwitchProps {
  checked: boolean;
  onChange: () => void;
  /** Accessible name; the switch itself renders no text. */
  label: string;
  disabled?: boolean;
}

/**
 * Animated toggle switch.
 *
 * The thumb is laid out by flex `justify-start/end` on the track and animated
 * there with a layout spring, so the slide stays smooth even if the track
 * width ever changes.
 */
export function Switch({ checked, onChange, label, disabled = false }: SwitchProps) {
  return (
    <motion.button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={onChange}
      whileTap={disabled ? undefined : { scale: 0.94 }}
      className={`relative flex h-6 w-11 flex-none items-center rounded-full p-0.5 outline-none transition-colors duration-200 focus-visible:ring-2 focus-visible:ring-accent/60 ${
        checked ? 'justify-end bg-accent shadow-glow' : 'justify-start bg-bg-tertiary'
      } ${disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'}`}
    >
      <motion.span
        aria-hidden="true"
        layout
        transition={{ type: 'spring', stiffness: 550, damping: 32 }}
        className="h-5 w-5 rounded-full bg-white shadow-[0_1px_3px_rgba(0,0,0,0.25)]"
      />
    </motion.button>
  );
}
