import { motion } from 'framer-motion';
import { MAIN_THREAD_TRANSFORM, SPRING_TAP } from '@/lib/motion';

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
      transformTemplate={MAIN_THREAD_TRANSFORM}
      transition={SPRING_TAP}
      className={`relative flex h-5 w-9 flex-none items-center rounded-full p-0.5 outline-none transition-colors duration-200 focus-visible:ring-2 focus-visible:ring-accent/60 ${
        checked ? 'justify-end bg-accent' : 'justify-start bg-bg-tertiary'
      } ${disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'}`}
    >
      <motion.span
        aria-hidden="true"
        layout
        transition={SPRING_TAP}
        className="h-4 w-4 rounded-full border border-line-strong bg-white"
      />
    </motion.button>
  );
}
