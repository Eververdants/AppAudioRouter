import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { motion } from 'framer-motion';
import { Section } from '@/components/Section';

const FAQ_KEYS = ['free', 'driver', 'running', 'bluetooth', 'platform'] as const;

interface FaqEntry {
  question: string;
  answer: string;
}

/** Native details/summary accordion: the answers stay in the DOM (and in view
 *  of crawlers and answer engines) whether or not an entry is expanded. */
function FaqItem({ entry }: { entry: FaqEntry }) {
  return (
    <details className="group rounded-2xl border border-glass bg-glass shadow-glass backdrop-blur-xl">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-4 p-5 text-left text-base font-semibold text-text-primary [&::-webkit-details-marker]:hidden">
        {entry.question}
        <span
          aria-hidden="true"
          className="flex h-6 w-6 flex-none items-center justify-center rounded-full bg-accent-muted text-accent transition-transform group-open:rotate-45"
        >
          +
        </span>
      </summary>
      <p className="px-5 pb-5 text-sm leading-relaxed text-text-secondary">{entry.answer}</p>
    </details>
  );
}

/** FAQ section. The FAQPage JSON-LD is generated from the same i18n strings
 *  the section renders, so search and answer engines always see structured
 *  data matching the visible content, in the language it is displayed in. */
export function Faq() {
  const { t, i18n } = useTranslation();
  const language = i18n.language.startsWith('zh') ? 'zh-CN' : 'en';

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
            <FaqItem entry={entry} />
          </motion.div>
        ))}
      </div>
    </Section>
  );
}
