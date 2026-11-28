import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react()],
  // SHOP_PORT and PORT (the API's) let a second copy run next to the first.
  server: { port: Number(process.env.SHOP_PORT ?? 5174), strictPort: true, proxy: { '/api': `http://localhost:${process.env.PORT ?? 8788}` } },
})
