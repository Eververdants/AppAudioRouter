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
        /* The three roles a device can be in, as spoke colours. One colour
           paints three things on the stage; nothing else may use these. */
        type: {
          primary: 'rgb(var(--type-primary-rgb) / <alpha-value>)',
          mirror: 'rgb(var(--type-mirror-rgb) / <alpha-value>)',
          idle: 'rgb(var(--type-idle-rgb) / <alpha-value>)',
        },
      },
      /* Corner radii, in steps of "how far from the window edge is this".
         Nested surfaces take the next step down. The ladder runs tight — flat
         panels read as planes, not as bubbles — while anything that floats is
         a capsule (`rounded-full`) or a true circle, so the rectangular steps
         below are only for planes that sit still. */
      borderRadius: {
        window: '16px',
        panel: '14px',
        card: '12px',
        ctl: '10px',
        seg: '8px',
      },
      boxShadow: {
        float: 'var(--shadow-float)',
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
    },
  },
  plugins: [],
};

export default config;
