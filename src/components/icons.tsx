/** Inline stroke icons (24×24 grid, 1.8 stroke), one per feature and scenario.
 *  Drawn by hand rather than pulled from an icon package, so the set stays
 *  small and the landing page keeps no runtime dependency beyond React. */

import type { SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement>;

function Icon({ children, ...props }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {children}
    </svg>
  );
}

/** One source splitting into several targets. */
export function RouteIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="5" cy="12" r="2.2" />
      <circle cx="19" cy="5.5" r="2.2" />
      <circle cx="19" cy="18.5" r="2.2" />
      <path d="M7.2 12h4.3c1.4 0 2.5-.7 3.4-2.1l1.4-2.2" />
      <path d="M7.2 12h4.3c1.4 0 2.5.7 3.4 2.1l1.4 2.2" />
    </Icon>
  );
}

/** Clock with an offset — signed delay compensation. */
export function DelayIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
      <path d="M17.5 3.5l2.5 1" />
    </Icon>
  );
}

/** Speaker with level waves — per-device volume. */
export function VolumeIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4 9.5h3l4.5-3.8v12.6L7 14.5H4z" />
      <path d="M15.5 9.5a3.6 3.6 0 0 1 0 5" />
      <path d="M18 7a7 7 0 0 1 0 10" />
    </Icon>
  );
}

/** Shield with a check — no driver, nothing installed into the audio stack. */
export function NoDriverIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 3l7 2.6v5.1c0 4.6-3 8.4-7 10.3-4-1.9-7-5.7-7-10.3V5.6z" />
      <path d="M9 12.2l2.1 2.1 4-4.3" />
    </Icon>
  );
}

/** Circular restore arrow over a tray — remembered routes and tray residency. */
export function MemoryIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4 13.5v3A2.5 2.5 0 0 0 6.5 19h11a2.5 2.5 0 0 0 2.5-2.5v-3" />
      <path d="M12 4v9" />
      <path d="M8.5 9.5L12 13l3.5-3.5" />
    </Icon>
  );
}

/** Headphones beside a speaker box — listening together. */
export function ListenTogetherIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4 14v-2a5.5 5.5 0 0 1 11 0v2" />
      <path d="M4 14h2.6v5H5.5A1.5 1.5 0 0 1 4 17.5z" />
      <path d="M15 14h-2.6v5h1.1A1.5 1.5 0 0 0 15 17.5z" />
      <path d="M17.5 8.5h4v9h-2.5a1.5 1.5 0 0 1-1.5-1.5z" />
    </Icon>
  );
}

/** Sliders — balance and fine-tuning. */
export function SlidersIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M5 4v6M5 14v6" />
      <path d="M12 4v3M12 11v9" />
      <path d="M19 4v9M19 17v3" />
      <circle cx="5" cy="12" r="1.8" />
      <circle cx="12" cy="9" r="1.8" />
      <circle cx="19" cy="15" r="1.8" />
    </Icon>
  );
}

/** Refresh arrows — live lists and auto-restore. */
export function RefreshIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M20 12a8 8 0 1 1-2.4-5.7" />
      <path d="M20 3.5V8h-4.5" />
    </Icon>
  );
}

export function GitHubIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...props}>
      <path d="M12 2C6.48 2 2 6.58 2 12.25c0 4.53 2.87 8.37 6.84 9.73.5.09.68-.22.68-.49 0-.24-.01-.88-.01-1.73-2.78.62-3.37-1.37-3.37-1.37-.45-1.18-1.11-1.5-1.11-1.5-.91-.63.07-.62.07-.62 1 .07 1.53 1.06 1.53 1.06.9 1.57 2.36 1.12 2.94.86.09-.67.35-1.12.63-1.38-2.22-.26-4.56-1.14-4.56-5.07 0-1.12.39-2.03 1.03-2.75-.1-.26-.45-1.3.1-2.71 0 0 .84-.28 2.75 1.05a9.36 9.36 0 0 1 5 0c1.91-1.33 2.75-1.05 2.75-1.05.55 1.41.2 2.45.1 2.71.64.72 1.03 1.63 1.03 2.75 0 3.94-2.34 4.8-4.57 5.06.36.32.68.94.68 1.9 0 1.37-.01 2.47-.01 2.81 0 .27.18.59.69.49A10.02 10.02 0 0 0 22 12.25C22 6.58 17.52 2 12 2z" />
    </svg>
  );
}

export function SunIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2.5v2.5M12 19v2.5M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M2.5 12H5M19 12h2.5M4.9 19.1l1.8-1.8M17.3 6.7l1.8-1.8" />
    </Icon>
  );
}

export function MoonIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M20 13.5A8 8 0 0 1 10.5 4 7.5 7.5 0 1 0 20 13.5z" />
    </Icon>
  );
}

export function DownloadIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 4v11" />
      <path d="M7.5 10.5L12 15l4.5-4.5" />
      <path d="M5 19h14" />
    </Icon>
  );
}

export function ExternalLinkIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M14 5h5v5" />
      <path d="M19 5l-8 8" />
      <path d="M18 14v4a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 18V6.5A1.5 1.5 0 0 1 5.5 5H10" />
    </Icon>
  );
}

export function CopyIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15V6.5A1.5 1.5 0 0 1 6.5 5H15" />
    </Icon>
  );
}

export function CheckIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M5 12.5l4.5 4.5L19 7.5" />
    </Icon>
  );
}

export function ArrowUpIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 19V5" />
      <path d="M5.5 11.5L12 5l6.5 6.5" />
    </Icon>
  );
}
