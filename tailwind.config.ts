import type { Config } from 'tailwindcss';

const config: Config = {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: {
          primary: 'var(--bg-primary)',
          tertiary: 'rgb(var(--bg-tertiary-rgb) / <alpha-value>)',
        },
        text: {
          primary: 'var(--text-primary)',
          secondary: 'var(--text-secondary)',
          muted: 'rgb(var(--text-muted-rgb) / <alpha-value>)',
        },
        accent: {
          DEFAULT: 'rgb(var(--accent-rgb) / <alpha-value>)',
          hover: 'var(--accent-hover)',
          muted: 'var(--accent-muted)',
          /* Text and glyphs sitting on top of an accent fill. Nested here so
             the pair reads as one decision (`bg-accent text-accent-ink`)
             instead of two independent colours. */
          ink: 'var(--accent-ink)',
        },
        success: 'var(--success)',
        error: 'rgb(var(--error-rgb) / <alpha-value>)',
        /* Flat planes of the editor layout: the sidebar and work-area
           background, the raised plane used only by things that float, and the
           1px rules between rows and sections. */
        surface: {
          DEFAULT: 'rgb(var(--surface-rgb) / <alpha-value>)',
          sunken: 'var(--surface-sunken)',
          raised: 'var(--surface-raised)',
          hover: 'var(--surface-hover)',
        },
        line: {
          DEFAULT: 'rgb(var(--hairline-rgb) / <alpha-value>)',
          strong: 'var(--hairline-strong)',
        },
        /* The four roles a route target can be in, as node accents. One colour
           paints three things on the stage: the node's role word, its number
           badge and the reading that belongs to it; nothing else may use these.
           `feed` marks a program's *input* rather than an output device — amber
           so it reads at a glance as a different kind of wire. */
        type: {
          primary: 'rgb(var(--type-primary-rgb) / <alpha-value>)',
          mirror: 'rgb(var(--type-mirror-rgb) / <alpha-value>)',
          idle: 'rgb(var(--type-idle-rgb) / <alpha-value>)',
          feed: 'rgb(var(--type-feed-rgb) / <alpha-value>)',
        },
      },
      /* Corner radii, in steps of "how far from the window edge is this".
         Nested surfaces take the next step down. The ladder is generous — the
         interface is built on large, continuous-curvature corners — while
         anything that floats is a capsule (`rounded-full`) or a true circle,
         so the rectangular steps below are only for planes that sit still.
         The ladder is the whole radius story: window 28 / panel 24 / card 20 /
         ctl 12 / seg 10, then full. No component invents its own step, and no
         bare `rounded` (4 px) survives — a control is either on the ladder or
         round. */
      borderRadius: {
        window: '28px',
        panel: '24px',
        card: '20px',
        ctl: '12px',
        seg: '10px',
      },
      fontFamily: {
        sans: [
          'Inter',
          'system-ui',
          '-apple-system',
          'Segoe UI',
          'Microsoft YaHei UI',
          'Roboto',
          'sans-serif',
        ],
        mono: ['JetBrains Mono', 'Fira Code', 'Consolas', 'monospace'],
      },
      /* One scale, four steps, and nothing readable below it. The interface
         used to run on thirteen arbitrary sizes from 8 to 19px — 9.5px for a
         delay reading, 10.5px for a share, 11px for body copy — which is not a
         type system, it is a pile. Anything a person has to read is `xs` or
         larger; the only smaller marks left are glyphs inside 16px controls
         (✕, ⌄) and the letter tile of a program with no icon yet. */
      fontSize: {
        xs: ['11px', { lineHeight: '16px' }],
        sm: ['12px', { lineHeight: '18px' }],
        base: ['13px', { lineHeight: '20px' }],
        lg: ['17px', { lineHeight: '24px' }],
      },
    },
  },
  plugins: [],
};

export default config;
