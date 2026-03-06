const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

function ensureSpawnHelpersExecutable() {
  try {
    const pkgPath = require.resolve('node-pty/package.json');
    const baseDir = path.dirname(pkgPath);
    const candidates = [
      path.join(baseDir, 'build', 'Release', 'spawn-helper'),
      path.join(baseDir, 'build', 'Debug', 'spawn-helper'),
      path.join(baseDir, 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper'),
    ];
    for (const helperPath of candidates) {
      if (!fs.existsSync(helperPath)) continue;
      try {
        fs.chmodSync(helperPath, 0o755);
      } catch {
        // Best-effort: if chmod fails, node-pty may still work depending on platform.
      }
    }
  } catch {
    // Ignore if node-pty is unavailable; require will fail below with a clear error.
  }
}

function sanitizeEnv(inputEnv) {
  const env = {};
  for (const [key, value] of Object.entries(inputEnv || {})) {
    if (value === undefined || value === null) continue;
    env[key] = String(value);
  }
  if (!env.PATH || !env.PATH.trim()) {
    env.PATH = '/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin';
  }
  return env;
}

function resolveShell(configFile, env) {
  const candidates = [
    typeof configFile === 'string' ? configFile.trim() : '',
    typeof env.SHELL === 'string' ? env.SHELL.trim() : '',
    '/bin/zsh',
    '/bin/bash',
    '/bin/sh',
    'sh',
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (candidate.startsWith('/')) {
      if (fs.existsSync(candidate)) return candidate;
      continue;
    }
    return candidate;
  }
  return '/bin/sh';
}

function resolveCwd(configCwd) {
  if (typeof configCwd === 'string' && configCwd && fs.existsSync(configCwd)) {
    return configCwd;
  }
  return process.cwd();
}

ensureSpawnHelpersExecutable();
const pty = require('node-pty');

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

const rawConfig = process.argv[2];
if (!rawConfig) {
  send({ type: 'exit', exitCode: 1 });
  process.exit(1);
}

let config;
try {
  config = JSON.parse(rawConfig);
} catch {
  send({ type: 'exit', exitCode: 1 });
  process.exit(1);
}

const env = sanitizeEnv(config.env);
const file = resolveShell(config.file, env);
const args = Array.isArray(config.args) ? config.args.filter((v) => typeof v === 'string') : [];
const cwd = resolveCwd(config.cwd);

const proc = pty.spawn(file, args, {
  name: 'xterm-256color',
  cols: config.cols ?? 80,
  rows: config.rows ?? 24,
  cwd,
  env,
});

send({ type: 'ready', pid: proc.pid });

proc.onData((data) => {
  send({ type: 'data', data });
});

proc.onExit(({ exitCode }) => {
  send({ type: 'exit', exitCode });
  process.exit(0);
});

const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

rl.on('line', (line) => {
  if (!line) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }

  if (message.type === 'write' && typeof message.data === 'string') {
    proc.write(message.data);
    return;
  }

  if (message.type === 'resize' && typeof message.cols === 'number' && typeof message.rows === 'number') {
    proc.resize(message.cols, message.rows);
    return;
  }

  if (message.type === 'terminate') {
    proc.kill();
  }
});
