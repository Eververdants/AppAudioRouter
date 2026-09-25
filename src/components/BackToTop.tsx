import { useState } from 'react';
import { AnimatePresence, motion, useMotionValueEvent, useScroll } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { ArrowUpIcon } from '@/components/icons';

/** Floating back-to-top button: appears once the hero is well behind, lifts
 *  on hover and smooth-scrolls home. */
export function BackToTop() {
  const { t } = useTranslation();
  const { scrollY } = useScroll();
  const [visible, setVisible] = useState(false);

  useMotionValueEvent(scrollY, 'change', (value) => setVisible(value > 600));

  return (
    <AnimatePresence>
      {visible && (
        <motion.button
          type="button"
          initial={{ opacity: 0, scale: 0.6, y: 8 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.6, y: 8 }}
          transition={{ type: 'spring', stiffness: 320, damping: 24 }}
          whileHover={{ y: -3 }}
          whileTap={{ scale: 0.9 }}
          onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
          aria-label={t('backToTop.label')}
          title={t('backToTop.label')}
          className="fixed bottom-6 right-6 z-50 flex h-11 w-11 items-center justify-center rounded-full border border-glass bg-glass-strong text-text-secondary shadow-glass-lg backdrop-blur-xl transition-colors hover:border-accent/40 hover:text-accent"
        >
          <ArrowUpIcon className="h-5 w-5" />
        </motion.button>
      )}
    </AnimatePresence>
  );
}
