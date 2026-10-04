import { useRouterStore } from '@/stores/routerStore';

/**
 * One program's executable icon.
 *
 * Sourced per executable — the icon belongs to the file, not the process — and
 * carried in the store as a data URL, fetched once and cached. Until it
 * arrives (or for good, when the file has none) the tile holds the display
 * name's first letter: a fixed slot either way, so a row never shifts when the
 * real icon lands.
 */
export function ProcessIcon({
  exeName,
  name,
  size,
}: {
  exeName: string;
  /** What the letter tile reads before the icon arrives. */
  name: string;
  size: number;
}) {
  const icon = useRouterStore((s) => s.iconByExe[exeName]);
  const letter = Array.from(name.trim())[0] ?? '?';
  return (
    <span
      aria-hidden="true"
      className="relative flex flex-none items-center justify-center overflow-hidden rounded bg-surface-hover text-text-muted"
      style={{ width: size, height: size }}
    >
      {icon ? (
        <img
          src={icon}
          width={size}
          height={size}
          alt=""
          draggable={false}
          className="h-full w-full"
        />
      ) : (
        <span className="text-[8px] font-semibold uppercase leading-none">{letter}</span>
      )}
    </span>
  );
}
