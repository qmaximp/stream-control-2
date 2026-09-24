import type { Config } from 'tailwindcss'

const config: Config = {
  content: [
    './app/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        bg: '#0f0f14',
        panel: '#1a1a24',
        accent: '#7c3aed',
        accent2: '#a78bfa',
        border: '#2a2a38',
      },
    },
  },
  plugins: [],
}
export default config
