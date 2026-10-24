import { useTranslation } from 'react-i18next';

/**
 * One device row of the selection screen: the name, and a picked word while
 * the row is selected. One flat question — which devices take part — with no
 * roles to decide up front; the measurement sorts that out by itself.
 */
export function PickRow({
  label,
  picked,
  onToggle,
}: {
  label: string;
  picked: boolean;
  onToggle: () => void;
}) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={picked}
      className={`pressable flex w-full items-center justify-between gap-3 rounded-ctl border px-2.5 py-1.5 text-left text-[12px] outline-none focus-visible:ring-2 focus-visible:ring-accent/60 ${
        picked
          ? 'border-accent bg-accent-muted text-accent'
          : 'border-line text-text-secondary hover:border-accent/50'
      }`}
    >
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {picked && <span className="flex-none text-xs text-accent">{t('calibration.picked')}</span>}
    </button>
  );
}
