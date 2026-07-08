import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3007,
    open: false,
    hmr: false,
    proxy: {
      '/ews/api': { target: 'http://localhost:8548', changeOrigin: true },
    },
  },
})
