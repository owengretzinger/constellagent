import type { ElectrobunConfig } from 'electrobun'

export default {
  app: {
    name: 'Constellagent',
    identifier: 'sh.constellagent.app',
    version: '1.0.0',
  },
  build: {
    copy: {
      'dist/index.html': 'views/mainview/index.html',
      'dist/assets': 'views/mainview/assets',
      'node_modules/node-pty/build/Release/pty.node': 'bun/build/Release/pty.node',
      'claude-hooks': 'claude-hooks',
      'codex-hooks': 'codex-hooks',
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
