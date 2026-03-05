import type { ElectrobunConfig } from 'electrobun'

export default {
  app: {
    name: 'Constellagent',
    identifier: 'dev.constellagent.app',
    version: '1.0.0',
    description: 'Desktop app for running multiple AI agents in parallel',
  },
  build: {
    bun: {
      entrypoint: 'src/main/index.ts',
    },
    copy: {
      'dist/index.html': 'views/mainview/index.html',
      'dist/assets': 'views/mainview/assets',
      'node_modules/node-pty': 'bun/node_modules/node-pty',
      'node_modules/node-pty/build/Release': 'bun/build/Release',
      'src/main/pty-worker.cjs': 'bun/pty-worker.cjs',
    },
    watchIgnore: ['dist/**'],
    mac: {
      bundleCEF: false,
    },
    linux: {
      bundleCEF: false,
    },
    win: {
      bundleCEF: false,
    },
  },
} satisfies ElectrobunConfig
