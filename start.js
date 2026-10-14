// Starts Uptime Kuma the way velixir runs apps.
//
// Uptime Kuma runs as it is, from ./uptime-kuma (installed by build-kuma.js). This file adds
// the four things a public deploy needs:
//
//   1. Data on the volume. velixir sets VELIXIR_VOLUME_PATH when the app has one, and Kuma's
//      data folder (its SQLite database, uploaded images, screenshots) goes there, so monitors
//      and their history survive restarts and redeploys. Without one it uses the container disk
//      and starts empty on every restart, and the log says so.
//   2. No open setup page. On a fresh Uptime Kuma, whoever opens the URL first creates the
//      admin account. Here the first start runs Kuma on loopback only, creates the admin itself
//      through Kuma's own setup call, prints the password once to the deploy log, and only then
//      starts Kuma on the public port. KUMA_ADMIN_PASSWORD resets the password on any start.
//   3. SQLite chosen up front, so Kuma's "which database?" page never appears.
//   4. Settings it cannot guess: the edge is trusted for the visitor's address, and the app's
//      public URL is filled in for the links in notifications. Both only while unset, so a
//      change you make in Kuma's settings is never overwritten.
//
// While Kuma starts, $PORT serves a short "starting" page and /healthz answers 200.

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { createRequire } = require('node:module');
const { spawn } = require('node:child_process');

const PORT = Number(process.env.PORT || 8080);
const kumaDir = path.join(__dirname, 'uptime-kuma');
const kumaRequire = createRequire(path.join(kumaDir, 'package.json'));

const volume = (process.env.VELIXIR_VOLUME_PATH || '').trim();
const dataDir = volume ? path.join(volume, 'uptime-kuma') : path.join(__dirname, '.kuma-data');
const dbFile = path.join(dataDir, 'kuma.db');

const adminUser = (process.env.KUMA_ADMIN_USERNAME || 'admin').trim();
const adminPassword = process.env.KUMA_ADMIN_PASSWORD || '';

const publicUrl = (process.env.PUBLIC_URL
  || (process.env.VELIXIR_APP_SLUG ? `https://${process.env.VELIXIR_APP_SLUG}.velixir.run` : `http://localhost:${PORT}`))
  .replace(/\/+$/, '');

let child = null;
let stopping = false;

// ─── The page shown while Kuma starts ──────────────────────────────────────────

const STARTING_PAGE = `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="5">
<title>Starting Uptime Kuma</title>
<style>
  :root { color-scheme: dark; }
  body { margin:0; min-height:100vh; display:grid; place-items:center; background:#0b0b10; color:#e8e8ef;
         font:15px/1.6 ui-sans-serif,system-ui,-apple-system,Segoe UI,sans-serif; }
  p { color:#7a7a8c; font-size:.875rem; }
</style>
<div><h1>Uptime Kuma is starting</h1><p>This takes a few seconds. The page reloads by itself.</p></div>
</html>`;

function startingServer() {
  const server = http.createServer((req, res) => {
    if (req.url === '/healthz') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      return res.end('ok');
    }
    res.writeHead(503, { 'content-type': 'text/html; charset=utf-8', 'retry-after': '5', 'cache-control': 'no-store' });
    res.end(STARTING_PAGE);
  });
  server.listen(PORT, '0.0.0.0');
  return server;
}

// ─── Kuma ────────────────────────────────────────────────────────────────────

function kumaEnv(host, port) {
  return {
    ...process.env,
    NODE_ENV: 'production',
    DATA_DIR: dataDir + path.sep,
    UPTIME_KUMA_HOST: host,
    UPTIME_KUMA_PORT: String(port),
    // SQLite in the data folder. Without this, a fresh Kuma asks in the browser which database
    // to use, and that page would be open to anyone.
    UPTIME_KUMA_DB_TYPE: 'sqlite',
    // PORT would otherwise be read as Kuma's port too.
    PORT: String(port),
  };
}

function spawnKuma(host, port) {
  return spawn(process.execPath, ['server/server.js'], { cwd: kumaDir, env: kumaEnv(host, port), stdio: 'inherit' });
}

function waitForExit(proc) {
  return new Promise((resolve) => {
    if (proc.exitCode !== null || proc.signalCode !== null) return resolve();
    proc.once('exit', () => resolve());
  });
}

// ─── SQLite, through Kuma's own driver ───────────────────────────────────────

function openDb() {
  const sqlite3 = kumaRequire('@louislam/sqlite3');
  const db = new sqlite3.Database(dbFile);
  const call = (method) => (sql, params = []) => new Promise((resolve, reject) =>
    db[method](sql, params, function (err, result) { err ? reject(err) : resolve(method === 'run' ? this : result); }));
  return {
    get: call('get'),
    run: call('run'),
    close: () => new Promise((resolve) => db.close(() => resolve())),
  };
}

async function userCount() {
  if (!fs.existsSync(dbFile)) return 0;
  const db = openDb();
  try {
    const row = await db.get('SELECT COUNT(*) AS n FROM user');
    return row ? row.n : 0;
  } catch {
    return 0; // No user table yet: Kuma has not migrated this database.
  } finally {
    await db.close();
  }
}

// Settings are rows of (key, JSON value, type). Set only when absent.
async function applySettings() {
  const db = openDb();
  try {
    const defaults = { trustProxy: true, primaryBaseURL: publicUrl };
    for (const [key, value] of Object.entries(defaults)) {
      const row = await db.get('SELECT id FROM setting WHERE `key` = ?', [key]);
      if (!row) await db.run('INSERT INTO setting (`key`, `value`, `type`) VALUES (?, ?, ?)', [key, JSON.stringify(value), 'general']);
    }
    if (adminPassword) {
      const bcrypt = kumaRequire('bcryptjs');
      const hash = await bcrypt.hash(adminPassword, 10);
      const result = await db.run('UPDATE user SET password = ? WHERE username = ?', [hash, adminUser]);
      if (result.changes > 0) {
        console.log(`Uptime Kuma: password for "${adminUser}" set from KUMA_ADMIN_PASSWORD.`);
      } else {
        console.log(`Uptime Kuma: KUMA_ADMIN_PASSWORD is set, but there is no user "${adminUser}". Set KUMA_ADMIN_USERNAME to your username.`);
      }
    }
  } finally {
    await db.close();
  }
}

// ─── First start: create the admin on loopback ───────────────────────────────

async function firstStart() {
  const password = adminPassword || randomPassword(24);
  const port = PORT === 3291 ? 3292 : 3291;
  console.log('Uptime Kuma: first start. Preparing the database and the admin account on loopback before going public.');

  child = spawnKuma('127.0.0.1', port);
  const io = kumaRequire('socket.io-client');

  try {
    const result = await new Promise((resolve, reject) => {
      const deadline = setTimeout(() => { socket.close(); reject(new Error('Uptime Kuma did not start within 5 minutes')); }, 300000);
      const socket = io(`http://127.0.0.1:${port}`, { transports: ['websocket'], reconnectionDelay: 1000, reconnectionDelayMax: 2000 });
      child.once('exit', (code) => { if (done) return; clearTimeout(deadline); socket.close(); reject(new Error(`Uptime Kuma exited during first start (code ${code})`)); });
      // Kuma can answer on this port twice: first a temporary page while it migrates the
      // database, then the real server. The temporary one never answers "setup", so each
      // attempt times out and is retried, on this connection or the next one.
      let done = false;
      const attempt = () => {
        if (done || !socket.connected) return;
        socket.timeout(5000).emit('setup', adminUser, password, (err, res) => {
          if (done) return;
          if (err) return setTimeout(attempt, 1000);
          done = true;
          clearTimeout(deadline);
          socket.close();
          resolve(res || {});
        });
      };
      socket.on('connect', attempt);
    });
    if (!result.ok && !/initialized/i.test(result.msg || '')) {
      throw new Error(`Uptime Kuma refused the admin account: ${result.msg}`);
    }
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await waitForExit(child);
    }
    child = null;
  }

  box([
    'Uptime Kuma is ready. Your admin account:',
    '',
    `  URL:       ${publicUrl}`,
    `  Username:  ${adminUser}`,
    `  Password:  ${adminPassword ? '(the one in KUMA_ADMIN_PASSWORD)' : password}`,
    '',
    'This is shown once. Change it in Settings > Security, or set',
    'KUMA_ADMIN_PASSWORD on the Environment tab to reset it on the next start.',
  ]);
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  fs.mkdirSync(dataDir, { recursive: true });

  if (!volume) {
    box([
      'No volume: Uptime Kuma\'s data is on the container disk.',
      '',
      'Monitors, their history, notifications and the admin account start',
      'empty again on every restart and redeploy. Add a volume on the app\'s',
      'Volume tab (a paid plan) to keep them.',
    ]);
  }

  const placeholder = startingServer();

  if ((await userCount()) === 0) {
    await firstStart();
  }
  if (stopping) return process.exit(0);

  await applySettings();

  await new Promise((resolve) => placeholder.close(() => resolve()));
  if (stopping) return process.exit(0);

  child = spawnKuma('0.0.0.0', PORT);
  child.on('exit', (code, signal) => {
    // A stop we forwarded is a clean exit; anything else is a crash the platform should see.
    process.exit(stopping ? 0 : (code ?? (signal ? 1 : 0)));
  });
}

// As PID 1, node gets no default signal handling: without this a redeploy's SIGTERM would be
// ignored until the platform's grace period ran out. Kuma closes its database on SIGTERM.
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    stopping = true;
    if (child && child.exitCode === null) child.kill(signal);
    else process.exit(0);
  });
}

function randomPassword(n) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  let out = '';
  while (out.length < n) out += alphabet[crypto.randomInt(alphabet.length)];
  // Kuma's strength check wants a mix; the alphabet guarantees letters, add a digit for sure.
  return out.slice(0, n - 1) + String(crypto.randomInt(10));
}

function box(lines) {
  const width = Math.max(...lines.map((l) => l.length));
  const border = `+${'-'.repeat(width + 2)}+`;
  console.log(['', border, ...lines.map((l) => `| ${l.padEnd(width)} |`), border].join('\n'));
}

main().catch((err) => {
  console.error(`Uptime Kuma could not start: ${err.message}`);
  if (child && child.exitCode === null) child.kill('SIGTERM');
  process.exit(1);
});
