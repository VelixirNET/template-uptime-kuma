// Installs the Uptime Kuma release pinned in package.json ("uptimeKuma": { ... }) into
// ./uptime-kuma.
//
// Nothing of Uptime Kuma's is committed to this repository. The build does what upstream's own
// non-Docker install (`npm run setup`) does: the tagged source from GitHub, its production
// dependencies from its lockfile, and the prebuilt web interface (dist.tar.gz) from the same
// GitHub release, checked against the SHA-256 pinned in package.json. Upgrading is a version
// bump plus that checksum.
//
// Nixpacks runs this as `npm run build`. It needs internet access (GitHub and the npm registry)
// and no app environment.

'use strict';

const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const pin = require('./package.json').uptimeKuma || {};
const version = pin.version;
const distSha256 = (pin.distSha256 || '').toLowerCase();

const root = __dirname;
const runtime = path.join(root, 'uptime-kuma');
const work = path.join(os.tmpdir(), 'velixir-uptime-kuma-build');
const home = path.join(work, 'home');

// npm keeps its cache under HOME; pointing it at the scratch folder keeps the cache out of the
// image when the folder is deleted at the end.
const env = {
  ...process.env,
  HOME: home,
  npm_config_cache: path.join(home, '.npm'),
  npm_config_update_notifier: 'false',
  npm_config_fund: 'false',
  npm_config_audit: 'false',
};
// Nixpacks sets NPM_CONFIG_PRODUCTION=false for its own install step; each install below says
// what it wants instead.
delete env.NPM_CONFIG_PRODUCTION;
delete env.npm_config_production;

const started = Date.now();

main().catch((err) => fail(err.stack || err.message));

async function main() {
  if (!/^\d+\.\d+\.\d+$/.test(version || '')) {
    fail('package.json needs "uptimeKuma": { "version": "x.y.z", "distSha256": "..." }, naming a release such as "2.5.6".');
  }
  if (!/^[0-9a-f]{64}$/.test(distSha256)) {
    fail('package.json needs "uptimeKuma.distSha256": the SHA-256 of that release\'s dist.tar.gz (GitHub shows it next to the asset).');
  }

  fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(home, { recursive: true });
  fs.rmSync(runtime, { recursive: true, force: true });
  fs.mkdirSync(runtime);

  // ─── Source ─────────────────────────────────────────────────────────────────

  step(`fetching Uptime Kuma ${version} from GitHub`);
  const source = path.join(work, 'source.tar.gz');
  await download(`https://github.com/louislam/uptime-kuma/archive/refs/tags/${version}.tar.gz`, source);
  // Printed so a build can be matched to an exact upstream archive later.
  log(`uptime-kuma-${version}.tar.gz sha256 ${sha256(source)}`);
  run('tar', ['-xzf', source, '-C', runtime, '--strip-components=1']);

  const upstream = readJson(path.join(runtime, 'package.json'));
  if (upstream.version !== version) {
    fail(`the ${version} archive says it is Uptime Kuma ${upstream.version}. Check the version in package.json.`);
  }

  // Only what the server runs: server/, db/, extra/, src/util (the server imports it), and the
  // web interface below. Tests and container files go.
  for (const item of ['test', 'docker', 'public', '.devcontainer', '.github', 'compose.yaml', 'ecosystem.config.js']) {
    fs.rmSync(path.join(runtime, item), { recursive: true, force: true });
  }

  // ─── Dependencies ───────────────────────────────────────────────────────────

  step("installing Uptime Kuma's production dependencies from its lockfile");
  npm(['ci', '--omit', 'dev', '--no-audit', '--no-fund'], runtime);

  // The SQLite driver is a native module. Fail here rather than on the first start.
  const sqliteCheck = spawnSync(process.execPath, ['-e', "require('@louislam/sqlite3')"], { cwd: runtime, env, encoding: 'utf8' });
  if (sqliteCheck.status !== 0) {
    fail(`the SQLite driver did not install correctly:\n${sqliteCheck.stderr}`);
  }

  // ─── Web interface ──────────────────────────────────────────────────────────

  step('fetching the prebuilt web interface (dist.tar.gz)');
  const dist = path.join(work, 'dist.tar.gz');
  await download(`https://github.com/louislam/uptime-kuma/releases/download/${version}/dist.tar.gz`, dist);
  const actual = sha256(dist);
  if (actual !== distSha256) {
    fail(`dist.tar.gz has SHA-256 ${actual}, but package.json pins ${distSha256}. Refusing to install it.`);
  }
  log(`dist.tar.gz sha256 ${actual} (matches the pin)`);
  run('tar', ['-xzf', dist, '-C', runtime]);
  if (!fs.existsSync(path.join(runtime, 'dist', 'index.html'))) {
    fail('dist.tar.gz did not contain dist/index.html.');
  }

  fs.rmSync(work, { recursive: true, force: true });
  step(`done: Uptime Kuma ${version} in ./uptime-kuma (${megabytes(runtime)} MB), ${Math.round((Date.now() - started) / 1000)}s in total`);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function step(message) {
  const s = Math.round((Date.now() - started) / 1000);
  console.log(`\n==> uptime-kuma build [${s}s]: ${message}`);
}

function log(message) {
  console.log(`    ${message}`);
}

function fail(message) {
  console.error(`\nuptime-kuma build failed: ${message}`);
  process.exit(1);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function run(cmd, args, cwd = work) {
  const result = spawnSync(cmd, args, { cwd, env, stdio: 'inherit' });
  if (result.error) fail(`${cmd} could not start: ${result.error.message}`);
  if (result.status !== 0) fail(`${path.basename(cmd)} ${args.join(' ')} exited with ${result.status ?? result.signal}`);
}

// npm sets npm_execpath when it runs a script, so `npm run build` reuses the very npm that is
// running it. Run by hand, fall back to whatever npm is on the PATH.
function npm(args, cwd) {
  const cli = process.env.npm_execpath;
  if (cli && /npm-cli\.js$/.test(cli)) return run(process.execPath, [cli, ...args], cwd);
  return run('npm', args, cwd);
}

async function download(url, file) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url);
      if (res.status === 404) fail(`${url} does not exist. Check the version in package.json.`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
      return;
    } catch (err) {
      if (attempt === 3) fail(`could not download ${url}: ${err.message}`);
      log(`download failed (${err.message}), retrying`);
      await new Promise((resolve) => setTimeout(resolve, 5000 * attempt));
    }
  }
}

function megabytes(dir) {
  let bytes = 0;
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else bytes += fs.lstatSync(p).size;
    }
  };
  walk(dir);
  return Math.round(bytes / 1048576);
}
