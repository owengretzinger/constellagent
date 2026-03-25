import { defineConfig } from 'electron-vite'
import { resolve } from 'path'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  main: {
    resolve: {
      alias: {
        '@shared': resolve(__dirname, 'src/shared')
      }
    }
  },
  preload: {
    resolve: {
      alias: {
        '@shared': resolve(__dirname, 'src/shared')
      }
    }
  },
  renderer: {
    plugins: [tailwindcss()],
    resolve: {
      alias: {
        '@shared': resolve(__dirname, 'src/shared')
      }
    },
    server: {
      strictPort: false,
      ...(process.env.CONSTELLAGENT_VITE_PORT
        ? { port: Number.parseInt(process.env.CONSTELLAGENT_VITE_PORT, 10) || 5173 }
        : {}),
    },
  }
})
