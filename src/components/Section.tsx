import type { ReactNode } from 'react';
import { motion } from 'framer-motion';

/** Shared section shell: consistent width, rhythm and heading composition for
 *  every block of the page, so the sections read as one visual system. */
interface SectionProps {
  id: string;
  eyebrow: string;
  title: string;
  description?: string;
  children: ReactNode;
}

export function Section({ id, eyebrow, title, description, children }: SectionProps) {
  return (
    <section id={id} className="mx-auto w-full max-w-6xl px-4 py-20 sm:px-6 sm:py-24 lg:px-8">
      <motion.div
        initial={{ opacity: 0, y: 24 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true, margin: '-80px' }}
        transition={{ duration: 0.5, ease: 'easeOut' }}
        className="mx-auto max-w-2xl text-center"
      >
        <p className="text-sm font-semibold uppercase tracking-widest text-accent">{eyebrow}</p>
        <h2 className="mt-3 text-3xl font-bold tracking-tight text-text-primary sm:text-4xl">
          {title}
        </h2>
        {description && (
          <p className="mt-4 text-base leading-relaxed text-text-secondary">{description}</p>
        )}
      </motion.div>
      <div className="mt-12 sm:mt-14">{children}</div>
    </section>
  );
}
