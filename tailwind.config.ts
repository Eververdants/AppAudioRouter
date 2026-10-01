import type { Config } from 'tailwindcss';

const config: Config = {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: {
          primary: 'var(--bg-primary)',
          secondary: 'var(--bg-secondary)',
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
        },
        success: 'var(--success)',
        error: 'rgb(var(--error-rgb) / <alpha-value>)',
        border: {
          DEFAULT: 'rgb(var(--border-rgb) / <alpha-value>)',
        },
        /* Flat planes of the editor layout: the sidebar and work-area
           background, the raised plane used only by things that float, and the
           1px rules between rows and sections. */
        surface: {
          DEFAULT: 'var(--surface)',
          sunken: 'var(--surface-sunken)',
          raised: 'var(--surface-raised)',
          hover: 'var(--surface-hover)',
        },
        line: {
          DEFAULT: 'rgb(var(--hairline-rgb) / <alpha-value>)',
          strong: 'var(--hairline-strong)',
        },
        ink: 'var(--accent-ink)',
        glass: {
          DEFAULT: 'var(--glass-bg)',
          strong: 'var(--glass-bg-strong)',
        },
      },
      borderColor: {
        glass: 'var(--glass-border)',
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
      boxShadow: {
        glow: '0 0 20px var(--accent-glow)',
        'glow-lg': '0 0 40px var(--accent-glow)',
        /** Liquid-glass panel: top rim light + hairline edge + ambient drop. */
        glass: 'inset 0 1px 0 var(--glass-highlight), 0 0 0 1px var(--glass-edge)',
        'glass-lg':
          'inset 0 1px 0 var(--glass-highlight), 0 0 0 1px var(--glass-edge), 0 24px 64px var(--glass-shadow)',
      },
    },
  },
  plugins: [],
};

export default config;
