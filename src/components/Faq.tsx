import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { motion } from 'framer-motion';
import { Section } from '@/components/Section';

const FAQ_KEYS = ['free', 'driver', 'running', 'bluetooth', 'platform'] as const;

interface FaqEntry {
  question: string;
  answer: string;
}

/** One FAQ entry. The expand/collapse animates `grid-template-rows`
 *  (0fr → 1fr) instead of mounting/unmounting the panel, so the answers stay
 *  in the DOM — and in view of crawlers and answer engines — at all times. */
function FaqItem({
  entry,
  index,
  open,
  onToggle,
}: {
  entry: FaqEntry;
  index: number;
  open: boolean;
  onToggle: () => void;
}) {
  const buttonId = `faq-button-${index}`;
  const panelId = `faq-panel-${index}`;

  return (
    <div
      className={`rounded-2xl border bg-glass shadow-glass backdrop-blur-xl transition-colors duration-300 ${
        open ? 'border-accent/40' : 'border-glass hover:border-accent/30'
      }`}
    >
      <button
        type="button"
        id={buttonId}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={onToggle}
        className="flex w-full items-center justify-between gap-4 p-5 text-left text-base font-semibold text-text-primary"
      >
        {entry.question}
        <motion.span
          animate={{ rotate: open ? 45 : 0 }}
          transition={{ duration: 0.2, ease: 'easeOut' }}
          className="flex h-6 w-6 flex-none items-center justify-center rounded-full bg-accent-muted text-accent"
          aria-hidden="true"
        >
          +
        </motion.span>
      </button>
      <div
        id={panelId}
        role="region"
        aria-labelledby={buttonId}
        className="grid transition-[grid-template-rows] duration-300 ease-out"
        style={{ gridTemplateRows: open ? '1fr' : '0fr' }}
      >
        <div className="overflow-hidden">
          <p className="px-5 pb-5 text-sm leading-relaxed text-text-secondary">{entry.answer}</p>
        </div>
      </div>
    </div>
  );
}

/** FAQ section. The FAQPage JSON-LD is generated from the same i18n strings
 *  the section renders, so search and answer engines always see structured
 *  data matching the visible content, in the language it is displayed in. */
export function Faq() {
  const { t, i18n } = useTranslation();
  const language = i18n.language.startsWith('zh') ? 'zh-CN' : 'en';
  const [openKey, setOpenKey] = useState<string | null>('free');

  const entries: FaqEntry[] = FAQ_KEYS.map((key) => ({
    question: t(`faq.items.${key}.question`),
    answer: t(`faq.items.${key}.answer`),
  }));

  useEffect(() => {
    const script = document.createElement('script');
    script.type = 'application/ld+json';
    script.id = 'faq-jsonld';
    script.textContent = JSON.stringify({
      '@context': 'https://schema.org',
      '@type': 'FAQPage',
      inLanguage: language,
      mainEntity: entries.map((entry) => ({
        '@type': 'Question',
        name: entry.question,
        acceptedAnswer: { '@type': 'Answer', text: entry.answer },
      })),
    });
    document.head.appendChild(script);
    return () => {
      script.remove();
    };
    // `entries` is derived from t(); the strings it yields only change with
    // the language, so `language` is the effect's real input.
  }, [language, i18n]);

  return (
    <Section
      id="faq"
      eyebrow={t('faq.eyebrow')}
      title={t('faq.title')}
      description={t('faq.description')}
    >
      <div className="mx-auto grid max-w-3xl gap-3">
        {entries.map((entry, index) => (
          <motion.div
            key={entry.question}
            initial={{ opacity: 0, y: 16 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: '-60px' }}
            transition={{ duration: 0.4, delay: index * 0.05, ease: 'easeOut' }}
          >
            <FaqItem
              entry={entry}
              index={index}
              open={openKey === String(index)}
              onToggle={() =>
                setOpenKey((current) => (current === String(index) ? null : String(index)))
              }
            />
          </motion.div>
        ))}
      </div>
    </Section>
  );
}
