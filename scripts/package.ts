/**
 * Builds portable bundles that embed a Node.js runtime: users have nothing else to install.
 *
 *   npm run package                              # current platform
 *   npm run package -- --target linux-x64,win32-x64
 *
 * Targets: darwin-arm64, darwin-x64, win32-x64, linux-x64, linux-arm64.
 * macOS bundles must be built on macOS (ad-hoc code signing). Output goes to release/.
 * Run `npm run build` first (the npm script does it).
 */
import { spawnSync, type SpawnSyncOptions } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const RELEASE = join(ROOT, 'release');
const CACHE = join(RELEASE, '.cache');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

const TARGETS = ['darwin-arm64', 'darwin-x64', 'win32-x64', 'linux-x64', 'linux-arm64'] as const;
type Target = (typeof TARGETS)[number];

const { values } = parseArgs({
  options: {
    target: { type: 'string', default: `${process.platform}-${process.arch}` },
    node: { type: 'string', default: '24' }, // major version of the embedded runtime
  },
});

function run(command: string, args: string[], options: SpawnSyncOptions = {}): void {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed (${result.error?.message ?? `exit ${result.status}`})`);
}

/** Latest release of the requested Node.js major version. */
async function resolveNodeVersion(major: string): Promise<string> {
  const index = (await (await fetch('https://nodejs.org/dist/index.json')).json()) as { version: string }[];
  const match = index.find((r) => r.version.startsWith(`v${major}.`));
  if (!match) throw new Error(`no Node.js ${major} release found`);
  return match.version;
}

/** Downloads (once) and verifies the official Node.js archive, then extracts the binary. */
async function nodeBinary(version: string, target: Target): Promise<string> {
  const [os, arch] = target.split('-') as [string, string];
  const platform = os === 'win32' ? 'win' : os;
  const name = `node-${version}-${platform}-${arch}`;
  const archive = `${name}.${os === 'win32' ? 'zip' : 'tar.gz'}`;
  const dir = join(CACHE, version);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, archive);

  if (!existsSync(file)) {
    console.log(`downloading ${archive}`);
    const res = await fetch(`https://nodejs.org/dist/${version}/${archive}`);
    if (!res.ok) throw new Error(`download failed: ${res.status} ${archive}`);
    writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  }
  const sums = await (await fetch(`https://nodejs.org/dist/${version}/SHASUMS256.txt`)).text();
  const expected = sums.split('\n').find((line) => line.endsWith(`  ${archive}`))?.split(' ')[0];
  const actual = createHash('sha256').update(readFileSync(file)).digest('hex');
  if (!expected || expected !== actual) {
    rmSync(file);
    throw new Error(`checksum mismatch for ${archive}`);
  }

  const inner = os === 'win32' ? `${name}/node.exe` : `${name}/bin/node`;
  run('tar', ['-xf', file, '-C', dir, inner]);
  return join(dir, inner);
}

/** Application files plus production dependencies for the target platform. */
function stageApp(appDir: string, target: Target): void {
  const [os, cpu] = target.split('-') as [string, string];
  mkdirSync(appDir, { recursive: true });
  for (const part of ['dist/src', 'dist/ui']) {
    cpSync(join(ROOT, part), join(appDir, part), { recursive: true, filter: (src) => !src.endsWith('.map') });
  }
  for (const file of ['package.json', 'package-lock.json', 'LICENSE']) cpSync(join(ROOT, file), join(appDir, file));
  // Native modules ship prebuilt binaries: no compiler, no install scripts. --os/--cpu pick the
  // optional platform packages (webview) of the target instead of the build machine.
  const npmCli = process.env.npm_execpath;
  const npmArgs = ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', `--os=${os}`, `--cpu=${cpu}`];
  if (os === 'linux') npmArgs.push('--libc=glibc'); // the webview package targets glibc distributions
  if (npmCli) run(process.execPath, [npmCli, ...npmArgs], { cwd: appDir });
  else run('npm', npmArgs, { cwd: appDir, shell: process.platform === 'win32' });
  // Prebuilt binaries of other platforms are dead weight.
  for (const mod of ['@stoprocent/noble', '@stoprocent/bluetooth-hci-socket', 'usb', '@serialport/bindings-cpp']) {
    const dir = join(appDir, 'node_modules', mod, 'prebuilds');
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir)) {
      if (!entry.startsWith(`${os}-`)) rmSync(join(dir, entry), { recursive: true, force: true });
    }
  }
}

const MAC_LAUNCHER = `#!/bin/sh
# WattLight.app launcher: runs the embedded Node.js runtime.
# Started from Finder, the output goes to ~/Library/Logs; from a terminal, it stays there.
RESOURCES="$(cd "$(dirname "$0")/../Resources" && pwd)"
if [ -t 1 ]; then
  exec "$RESOURCES/node" "$RESOURCES/app/dist/src/main.js" "$@"
fi
mkdir -p "$HOME/Library/Logs"
exec "$RESOURCES/node" "$RESOURCES/app/dist/src/main.js" "$@" >>"$HOME/Library/Logs/wattlight.log" 2>&1
`;

const infoPlist = (version: string) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>WattLight</string>
  <key>CFBundleDisplayName</key><string>WattLight</string>
  <key>CFBundleIdentifier</key><string>io.github.sim07.wattlight</string>
  <key>CFBundleVersion</key><string>${version}</string>
  <key>CFBundleShortVersionString</key><string>${version}</string>
  <key>CFBundleExecutable</key><string>wattlight</string>
  <key>CFBundleIconFile</key><string>icon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
  <key>LSApplicationCategoryType</key><string>public.app-category.healthcare-fitness</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSBluetoothAlwaysUsageDescription</key><string>WattLight reads your smart trainer, power meter or heart rate strap over Bluetooth.</string>
  <key>NSLocalNetworkUsageDescription</key><string>WattLight finds and controls your Philips Hue bridge on your local network.</string>
  <key>NSBonjourServices</key><array><string>_hue._tcp</string></array>
</dict>
</plist>
`;

const WINDOWS_LAUNCHER = `@echo off\r
rem Starts WattLight with the embedded Node.js runtime. The minimized console shows the logs.\r
start "WattLight" /min "%~dp0node.exe" "%~dp0app\\dist\\src\\main.js" %*\r
`;

const LINUX_LAUNCHER = `#!/bin/sh
# Starts WattLight with the embedded Node.js runtime.
DIR="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
exec "$DIR/node" "$DIR/app/dist/src/main.js" "$@"
`;

const LINUX_DESKTOP_INSTALLER = `#!/bin/sh
# Adds WattLight to the application menu of the current user.
DIR="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
mkdir -p "$HOME/.local/share/applications"
cat > "$HOME/.local/share/applications/wattlight.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=WattLight
Comment=Your Hue lights follow your training zone
Exec="$DIR/wattlight"
Icon=$DIR/icon.png
Terminal=false
Categories=Utility;Sports;
EOF
echo "WattLight added to your applications menu."
`;

async function packageTarget(target: Target, nodeVersion: string): Promise<string> {
  const [os] = target.split('-');
  if (os === 'darwin' && process.platform !== 'darwin') throw new Error('macOS bundles must be built on macOS');
  const version: string = pkg.version;
  const node = await nodeBinary(nodeVersion, target);
  const work = join(RELEASE, 'stage', target);
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  const base = `wattlight-${version}-${target}`;

  if (os === 'darwin') {
    const contents = join(work, 'WattLight.app', 'Contents');
    mkdirSync(join(contents, 'MacOS'), { recursive: true });
    mkdirSync(join(contents, 'Resources'), { recursive: true });
    writeFileSync(join(contents, 'Info.plist'), infoPlist(version));
    writeFileSync(join(contents, 'MacOS', 'wattlight'), MAC_LAUNCHER, { mode: 0o755 });
    cpSync(join(ROOT, 'assets', 'icon.icns'), join(contents, 'Resources', 'icon.icns'));
    cpSync(node, join(contents, 'Resources', 'node'));
    chmodSync(join(contents, 'Resources', 'node'), 0o755);
    stageApp(join(contents, 'Resources', 'app'), target);
    run('codesign', ['--force', '--deep', '--sign', '-', join(work, 'WattLight.app')]);
    const out = join(RELEASE, `${base}.zip`);
    rmSync(out, { force: true });
    run('ditto', ['-c', '-k', '--keepParent', join(work, 'WattLight.app'), out]);
    return out;
  }

  const folder = join(work, 'wattlight');
  mkdirSync(folder, { recursive: true });
  stageApp(join(folder, 'app'), target);
  if (os === 'win32') {
    cpSync(node, join(folder, 'node.exe'));
    writeFileSync(join(folder, 'wattlight.cmd'), WINDOWS_LAUNCHER);
    const out = join(RELEASE, `${base}.zip`);
    rmSync(out, { force: true });
    if (process.platform === 'win32') run('tar', ['-a', '-c', '-f', out, 'wattlight'], { cwd: work });
    else run('zip', ['-qr', out, 'wattlight'], { cwd: work });
    return out;
  }

  cpSync(node, join(folder, 'node'));
  chmodSync(join(folder, 'node'), 0o755);
  writeFileSync(join(folder, 'wattlight'), LINUX_LAUNCHER, { mode: 0o755 });
  writeFileSync(join(folder, 'install-desktop-entry.sh'), LINUX_DESKTOP_INSTALLER, { mode: 0o755 });
  cpSync(join(ROOT, 'assets', 'icon-256.png'), join(folder, 'icon.png'));
  const out = join(RELEASE, `${base}.tar.gz`);
  run('tar', ['-czf', out, 'wattlight'], { cwd: work });
  return out;
}

async function main(): Promise<void> {
  if (!existsSync(join(ROOT, 'dist', 'src', 'main.js'))) throw new Error('run `npm run build` first');
  const targets = values.target.split(',').map((t) => t.trim()) as Target[];
  for (const target of targets) if (!TARGETS.includes(target)) throw new Error(`unknown target ${target} (expected one of ${TARGETS.join(', ')})`);
  const nodeVersion = await resolveNodeVersion(values.node);
  console.log(`embedding Node.js ${nodeVersion}`);
  const outputs: string[] = [];
  for (const target of targets) outputs.push(await packageTarget(target, nodeVersion));
  console.log(`\n${outputs.join('\n')}`);
}

main().catch((err: Error) => {
  console.error(`package: ${err.message}`);
  process.exit(1);
});
