import { useRef, type PointerEvent, type ReactNode } from 'react';
import { motion } from 'framer-motion';

interface SpotlightCardProps {
  children: ReactNode;
  className?: string;
  /** Reveal delay for the staggered whileInView entrance. */
  delay?: number;
  /** Hover lift; switch off for cards that expand in place (FAQ). */
  lift?: boolean;
}

/** Liquid-glass card with a cursor-following radial highlight. The highlight
 *  position travels through --mx / --my custom properties written straight to
 *  the element on pointer move, so following the cursor never re-renders. */
export function SpotlightCard({
  children,
  className = '',
  delay = 0,
  lift = true,
}: SpotlightCardProps) {
  const ref = useRef<HTMLDivElement>(null);

  const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    el.style.setProperty('--mx', `${event.clientX - rect.left}px`);
    el.style.setProperty('--my', `${event.clientY - rect.top}px`);
  };

  return (
    <motion.div
      ref={ref}
      onPointerMove={handlePointerMove}
      initial={{ opacity: 0, y: 20 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '-60px' }}
      transition={{ duration: 0.45, delay, ease: 'easeOut' }}
      whileHover={lift ? { y: -3 } : undefined}
      className={`group relative overflow-hidden rounded-2xl border border-glass bg-glass shadow-glass backdrop-blur-xl transition-colors duration-300 hover:border-accent/40 ${className}`}
    >
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 opacity-0 transition-opacity duration-300 group-hover:opacity-100"
        style={{
          background:
            'radial-gradient(340px circle at var(--mx, 50%) var(--my, 50%), var(--accent-muted), transparent 65%)',
        }}
      />
      <div className="relative">{children}</div>
    </motion.div>
  );
}
