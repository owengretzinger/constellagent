const readline = require('node:readline');
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

const proc = pty.spawn(config.file, config.args, {
  name: 'xterm-256color',
  cols: config.cols ?? 80,
  rows: config.rows ?? 24,
  cwd: config.cwd,
  env: config.env,
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
