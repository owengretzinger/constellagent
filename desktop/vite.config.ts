import { resolve } from 'path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  root: 'src/renderer',
  plugins: [react()],
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
    },
  },
  build: {
    outDir: '../../dist',
    emptyOutDir: true,
    // Monaco + editor ecosystem is large; split vendors to avoid one giant bundle.
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined
          if (id.includes('monaco-editor')) return 'vendor-monaco'
          if (id.includes('@xterm')) return 'vendor-xterm'
          if (id.includes('react') || id.includes('scheduler')) return 'vendor-react'
          if (id.includes('allotment') || id.includes('react-arborist')) return 'vendor-ui'
          return undefined
        },
      },
    },
  },
  server: {
    port: 5173,
    strictPort: true,
  },
})
