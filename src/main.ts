#!/usr/bin/env node
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { scan, shutdownBluetooth, streamSensor } from './ble.ts';
import { configDir, fileStore, isComplete, SOURCES, validatePatch } from './config.ts';
import { launchDesktop } from './desktop.ts';
import { demoSensor, Session } from './engine.ts';
import { describeStatus, pickLanguage, translate } from './shared/i18n.ts';
import type { SessionState, Source } from './shared/types.ts';
import { VERSION } from './version.ts';

const USAGE = `WattLight ${VERSION} - your Philips Hue lights follow your training zone

Usage:
  wattlight [options]        open the app
  wattlight run [options]    drive the lights from the terminal, without the app window
  wattlight scan [--source]  list the Bluetooth sensors in range

Options:
  --demo                 simulated sensor (the Hue lights are real)
  --sandbox              everything simulated, with a separate settings file: no hardware needed
  --browser              open the app in the default browser instead of a window
  --source <power|hr>    power (default) or heart rate          (run, scan)
  --ftp <watts>          FTP                                     (run)
  --max-hr <bpm>         max heart rate                          (run)
  --brightness <1-254>   brightness                              (run)
  -v, --version          print the version
  -h, --help             print this help

Settings are saved in ${fileStore().path}`;

function parse() {
  return parseArgs({
    allowPositionals: true,
    options: {
      demo: { type: 'boolean' },
      sandbox: { type: 'boolean' },
      browser: { type: 'boolean' },
      source: { type: 'string' },
      ftp: { type: 'string' },
      'max-hr': { type: 'string' },
      brightness: { type: 'string' },
      version: { type: 'boolean', short: 'v' },
      help: { type: 'boolean', short: 'h' },
    },
  });
}

/** Headless mode: prints the status changes and the live value on one line. */
async function runHeadless(values: ReturnType<typeof parse>['values']): Promise<void> {
  const store = fileStore();
  const overrides = validatePatch({
    ...(values.source && { source: values.source }),
    ...(values.ftp && { ftp: values.ftp }),
    ...(values['max-hr'] && { maxHr: values['max-hr'] }),
    ...(values.brightness && { brightness: values.brightness }),
  });
  const cfg = { ...store.load(), ...overrides };
  if (!isComplete(cfg)) throw new Error('not set up yet: open the app once (`wattlight`) to pair the Hue bridge and pick the lights');

  const lang = cfg.language ?? pickLanguage(Intl.DateTimeFormat().resolvedOptions().locale);
  const tty = process.stdout.isTTY;
  const session = new Session(cfg, {
    demo: Boolean(values.demo),
    sensor: values.demo ? (metric, o) => demoSensor(metric, o) : (metric, o) => streamSensor(metric.kind, metric.device, o),
  });

  let lastStatus = '';
  let lastHue: boolean | null = null;
  const print = (line: string) => process.stdout.write(tty ? `\r\x1b[K${line}\n` : `${line}\n`);
  session.on('state', (state: SessionState) => {
    const configured = state.source === 'power' ? cfg.powerMeter?.name : cfg.hrm?.name;
    const { title, hint } = describeStatus(lang, state.status, state.source, state.device?.name ?? configured);
    const text = hint ? `${title} - ${hint}` : title;
    if (text !== lastStatus) {
      lastStatus = text;
      print(`[${new Date().toLocaleTimeString()}] ${text}`);
    }
    if (state.hue.ok !== lastHue) {
      lastHue = state.hue.ok;
      if (state.hue.problem) print(`[${new Date().toLocaleTimeString()}] ${translate(lang, `hue.${state.hue.problem}`, { ip: cfg.bridgeIp })}`);
    }
    if (tty && state.value !== null && state.zone) {
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(state.zone!.color.slice(i, i + 2), 16));
      const zoneName = translate(lang, `zone.${state.zone.name}`);
      const badge = `\x1b[48;2;${r};${g};${b}m\x1b[30m Z${state.zone.number} ${zoneName} \x1b[0m`;
      const reference = translate(lang, 'reference', {}, state.source);
      process.stdout.write(`\r\x1b[K  ${String(state.value).padStart(4)} ${state.unit}  ${String(state.pct).padStart(3)} % ${reference}  ${badge}`);
    }
  });

  let stopping = false;
  const stop = async () => {
    if (stopping) process.exit(1);
    stopping = true;
    await session.stop();
    await shutdownBluetooth();
    process.exit(0);
  };
  process.on('SIGINT', () => void stop());
  process.on('SIGTERM', () => void stop());
  await session.start();
}

async function scanCommand(source: Source): Promise<void> {
  console.log(`Searching for ${source === 'power' ? 'power sensors and trainers' : 'heart rate straps'} for 8 s…`);
  const devices = await scan(source, {
    onEvent: (e) => e.type === 'adapter' && !['poweredOn', 'unknown', 'resetting'].includes(e.state) && console.log(`Bluetooth: ${e.state}`),
  });
  if (!devices.length) console.log('Nothing found. Wake the sensor up (pedal, or wear the strap) and try again.');
  for (const d of devices) console.log(`${(d.name ?? 'unnamed').padEnd(28)} ${d.id}  ${d.rssi ?? ''} dBm`);
  await shutdownBluetooth();
  process.exit(0);
}

async function main(): Promise<void> {
  const { positionals, values } = parse();
  if (values.help) return void console.log(USAGE);
  if (values.version) return void console.log(VERSION);
  const source = (values.source ?? 'power') as Source;
  if (!SOURCES.includes(source)) throw new Error('--source must be "power" or "hr"');

  switch (positionals[0]) {
    case undefined:
    case 'app':
      return launchDesktop({
        demo: values.demo,
        sandbox: values.sandbox,
        browser: values.browser,
        store: values.sandbox ? fileStore(join(configDir(), 'sandbox.json')) : undefined,
      });
    case 'run':
      return runHeadless(values);
    case 'scan':
      return scanCommand(source);
    default:
      console.error(USAGE);
      process.exit(1);
  }
}

main().catch((err: Error) => {
  console.error(`\nError: ${err.message}`);
  process.exit(1);
});
