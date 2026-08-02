/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      fontFamily: {
        // Render Chinese cleanly alongside a Latin sans stack.
        sans: [
          'Inter', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto',
          '"PingFang SC"', '"Microsoft YaHei"', '"Hiragino Sans GB"',
          '"Noto Sans CJK SC"', 'sans-serif',
        ],
      },
    },
  },
  plugins: [],
}
