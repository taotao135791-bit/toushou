/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: 'class',
  content: [
    './src/renderer/**/*.{js,ts,jsx,tsx}'
  ],
  theme: {
    extend: {
      colors: {
        // Semantic palette backed by CSS variables (see index.css).
        // Light theme by default, flipped under `.dark`.
        ink: {
          950: 'rgb(var(--bg-app) / <alpha-value>)',
          900: 'rgb(var(--bg-sidebar) / <alpha-value>)',
          850: 'rgb(var(--bg-elev) / <alpha-value>)',
          800: 'rgb(var(--bg-sunken) / <alpha-value>)',
          700: 'rgb(var(--bubble) / <alpha-value>)',
          600: 'var(--line-strong)'
        },
        cream: {
          DEFAULT: 'rgb(var(--text) / <alpha-value>)',
          dim: 'rgb(var(--text-dim) / <alpha-value>)',
          faint: 'rgb(var(--text-faint) / <alpha-value>)'
        },
        accent: {
          DEFAULT: 'rgb(var(--accent) / <alpha-value>)',
          bright: 'rgb(var(--accent-bright) / <alpha-value>)',
          deep: 'rgb(var(--accent-deep) / <alpha-value>)',
          soft: 'var(--accent-soft)'
        },
        line: 'var(--line)',
        overlay: {
          DEFAULT: 'var(--overlay)',
          strong: 'var(--overlay-strong)'
        }
      },
      boxShadow: {
        pop: 'var(--shadow-pop)',
        card: 'var(--shadow-card)',
        composer: 'var(--shadow-composer)'
      },
      transitionTimingFunction: {
        standard: 'var(--ease)'
      },
      fontFamily: {
        sans: [
          'Geist', '-apple-system', 'BlinkMacSystemFont', 'SF Pro Text',
          'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'sans-serif'
        ],
        serif: [
          'New York', 'ui-serif', 'Georgia', 'Songti SC', 'STSong', 'serif'
        ],
        mono: [
          'JetBrains Mono', 'SF Mono', 'Menlo', 'Consolas',
          'PingFang SC', 'Microsoft YaHei', 'monospace'
        ]
      }
    }
  },
  plugins: []
}
