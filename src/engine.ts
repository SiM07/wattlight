/**
 * Core of the app: measurement (power or heart rate) -> zone -> light color.
 *
 * `Session` knows nothing about the UI or the terminal: it publishes its full state
 * (`state` event) with status codes that the web UI and the CLI turn into sentences.
 */
import { EventEmitter } from 'node:events';
import type { Measurement, SensorEvent, SensorOptions } from './ble.ts';
import { isComplete } from './config.ts';
import { type Bridge, HUE_RESOURCE_MISSING, HUE_UNAUTHORIZED, HueBridge, HueError } from './hue.ts';
import type { Config, DeviceRef, HueStatus, PublicZone, SessionState, Source, Status } from './shared/types.ts';
import { RollingAverage, toHex, type Zone, ZoneTracker, zonesFromConfig, HR_ZONES, POWER_ZONES } from './zones.ts';

export const NO_DATA_TIMEOUT_MS = 8000; // connected but no measurement for…
export const HUE_RETRY_MS = 15000; // new check while the bridge does not answer
const GROUP_MIN_INTERVAL_MS = 1000; // the bridge limits group commands to ~1/s
const LIGHT_MIN_INTERVAL_MS = 200;
const ERROR_BACKOFF_MS = 5000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** What differs between power and heart rate. */
export interface Metric {
  kind: Source;
  unit: 'W' | 'bpm';
  reference: number;
  hysteresis: number;
  zones: readonly Zone[];
  device: DeviceRef | null;
  smooth: (value: number) => number | null;
  demoRange: readonly [number, number];
}

export type SensorFn = (metric: Metric, options: SensorOptions) => Promise<void>;
export type BridgeFactory = (ip: string, username: string) => Bridge;

export function metricFor(cfg: Config): Metric {
  if (cfg.source === 'hr') {
    return {
      kind: 'hr',
      unit: 'bpm',
      reference: Number(cfg.maxHr),
      hysteresis: Number(cfg.hysteresisBpm),
      zones: zonesFromConfig(cfg.hrZones, HR_ZONES),
      device: cfg.hrm,
      smooth: (bpm) => (bpm > 0 ? bpm : null),
      demoRange: [0.5, 1.0],
    };
  }
  const avg = new RollingAverage(Number(cfg.powerSmoothingS) * 1000);
  return {
    kind: 'power',
    unit: 'W',
    reference: Number(cfg.ftp),
    hysteresis: Number(cfg.hysteresisW),
    zones: zonesFromConfig(cfg.powerZones, POWER_ZONES),
    device: cfg.powerMeter,
    smooth: (w) => (w >= 0 ? avg.push(w) : null),
    demoRange: [0.4, 1.3],
  };
}

export function publicZone(zone: Zone, reference: number): PublicZone {
  return { number: zone.number, name: zone.name, color: toHex(zone.color), from: Math.round(zone.fromPct * reference) };
}

/**
 * Sends the last requested zone to the bridge, within its rate limits.
 * Captures the lights right before the first change so they can be restored at the end.
 */
export class LightDriver {
  private readonly bridge: Bridge;
  private readonly getCfg: () => Config;
  private readonly onResult: (err: Error | null) => void;
  private readonly interval: number;
  private wanted: Zone | null = null;
  private applied: Zone | null = null;
  private snapshot: Awaited<ReturnType<Bridge['snapshot']>> | null = null;
  private pumping: Promise<void> | null = null;
  private closed = false;
  readonly target;

  constructor(bridge: Bridge, getCfg: () => Config, onResult: (err: Error | null) => void = () => {}) {
    this.bridge = bridge;
    this.getCfg = getCfg;
    this.onResult = onResult;
    this.target = getCfg().target!;
    this.interval = this.target.type === 'group' ? GROUP_MIN_INTERVAL_MS : LIGHT_MIN_INTERVAL_MS;
  }

  request(zone: Zone): void {
    if (this.closed) return;
    this.wanted = zone;
    this.pumping ??= this.pump().finally(() => (this.pumping = null));
  }

  /** Applies the current zone again (after a brightness change, for instance). */
  refresh(): void {
    this.applied = null;
    if (this.wanted) this.request(this.wanted);
  }

  private async pump(): Promise<void> {
    while (!this.closed && this.wanted && this.wanted !== this.applied) {
      const zone = this.wanted;
      const cfg = this.getCfg();
      let pause = this.interval;
      try {
        if (cfg.restoreOnExit && !this.snapshot) this.snapshot = await this.bridge.snapshot(await this.bridge.lightIdsFor(this.target));
        await this.bridge.setColor(this.target, zone.color, cfg.brightness, cfg.transitionDs);
        this.applied = zone;
        this.onResult(null);
      } catch (err) {
        this.onResult(err as Error);
        pause = ERROR_BACKOFF_MS;
      }
      await sleep(pause);
    }
  }

  async close({ restore = true } = {}): Promise<void> {
    this.closed = true;
    await this.pumping;
    if (restore && this.snapshot) await this.bridge.restore(this.snapshot);
    this.snapshot = null;
  }
}

/** Simulated sensor: ramps up and down forever, to try the app without hardware. */
export async function demoSensor(metric: Metric, { signal, onValue, onEvent }: SensorOptions, stepMs = 250): Promise<void> {
  const wait = (ms: number) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      signal.addEventListener('abort', () => (clearTimeout(timer), resolve()), { once: true });
    });
  const device = { id: 'demo', name: metric.kind === 'power' ? 'Demo trainer' : 'Demo HR strap' };
  onEvent({ type: 'searching', attempt: 1 });
  await wait(800);
  if (signal.aborted) return;
  onEvent({ type: 'connecting', device });
  await wait(600);
  if (signal.aborted) return;
  onEvent({ type: 'connected', device });
  const [low, high] = metric.demoRange.map((f) => Math.round(f * metric.reference)) as [number, number];
  const step = Math.max(1, Math.round((high - low) / 80));
  while (!signal.aborted) {
    for (let v = low; v < high && !signal.aborted; v += step) {
      onValue({ value: v, contact: null });
      await wait(stepMs);
    }
    for (let v = high; v > low && !signal.aborted; v -= step) {
      onValue({ value: v, contact: null });
      await wait(stepMs);
    }
  }
}

const status = (code: Status['code'], level: Status['level'], params: Status['params'] = {}): Status => ({ code, level, params });

const deviceName = (device: DeviceRef | null | undefined) => device?.name ?? device?.id ?? '';

/** Status matching a sensor event; null when the current one should stay. */
export function statusForSensorEvent(event: SensorEvent): Status | null {
  switch (event.type) {
    case 'adapter':
      switch (event.state) {
        case 'poweredOn':
          return status('searching', 'info');
        case 'poweredOff':
          return status('bluetoothOff', 'error');
        case 'unauthorized':
          return status('bluetoothUnauthorized', 'error');
        case 'unsupported':
          return status('bluetoothUnsupported', 'error');
        default:
          return status('bluetoothStarting', 'info');
      }
    case 'searching':
      return event.attempt > 1 ? null : status('searching', 'info');
    case 'notFound':
      return status('notFound', 'warn', { retrySeconds: Math.round(event.retryInMs / 1000) });
    case 'connecting':
      return status('connecting', 'info', { name: deviceName(event.device) });
    case 'connected':
      return status('waiting', 'ok', { name: deviceName(event.device) });
    case 'disconnected':
      return status('disconnected', 'warn', { name: deviceName(event.device) });
    case 'error':
      return status('connectError', 'warn', { name: deviceName(event.device), error: event.message });
  }
}

export function hueStatusFor(err: Error | null): HueStatus {
  if (!err) return { ok: true, problem: null };
  const type = err instanceof HueError ? err.type : null;
  if (type === HUE_UNAUTHORIZED) return { ok: false, problem: 'unauthorized' };
  if (type === HUE_RESOURCE_MISSING) return { ok: false, problem: 'missingTarget' };
  return { ok: false, problem: 'unreachable' };
}

const SENSOR_KEYS = ['source', 'ftp', 'maxHr', 'powerMeter', 'hrm', 'hysteresisW', 'hysteresisBpm', 'powerSmoothingS', 'powerZones', 'hrZones'] as const;

export interface SessionOptions {
  sensor: SensorFn;
  createBridge?: BridgeFactory;
  now?: () => number;
  noDataMs?: number;
  /** How often the no-data watchdog runs. */
  watchdogMs?: number;
  demo?: boolean;
}

export interface SessionEvents {
  state: [SessionState];
  test: [PublicZone];
}

export class Session extends EventEmitter<SessionEvents> {
  cfg: Config;
  private readonly sensor: SensorFn;
  private readonly createBridge: BridgeFactory;
  private readonly now: () => number;
  private readonly noDataMs: number;
  private readonly watchdogMs: number;
  private readonly demo: boolean;

  running = false;
  testing = false;
  private suspended = false;
  private driver: LightDriver | null = null;
  private bridge: { key: string; instance: Bridge } | null = null;
  private hue: HueStatus = { ok: null, problem: null };
  private status: Status;

  private metric!: Metric;
  private tracker!: ZoneTracker;
  private value: number | null = null;
  private zone: Zone | null = null;
  private device: DeviceRef | null = null;
  private connected = false;
  private started = false; // first useful measurement received
  private lastValueAt = 0;

  private abort: AbortController | null = null;
  private sensorTask: Promise<void> = Promise.resolve();
  private hueTimer: NodeJS.Timeout | undefined;
  private watchdog: NodeJS.Timeout | undefined;

  constructor(
    cfg: Config,
    { sensor, createBridge = (ip, user) => new HueBridge(ip, user), now = Date.now, noDataMs = NO_DATA_TIMEOUT_MS, watchdogMs = 1000, demo = false }: SessionOptions,
  ) {
    super();
    this.cfg = cfg;
    this.sensor = sensor;
    this.createBridge = createBridge;
    this.now = now;
    this.noDataMs = noDataMs;
    this.watchdogMs = watchdogMs;
    this.demo = demo;
    this.reset();
    this.status = this.idleStatus();
  }

  private reset(): void {
    this.metric = metricFor(this.cfg);
    this.tracker = new ZoneTracker(this.metric.zones, this.metric.reference, this.metric.hysteresis);
    this.value = null;
    this.zone = null;
    this.device = null;
    this.connected = false;
    this.started = false;
    this.lastValueAt = 0;
  }

  private idleStatus(): Status {
    return isComplete(this.cfg) ? status('stopped', 'info') : status('unconfigured', 'info');
  }

  get state(): SessionState {
    const { metric } = this;
    return {
      running: this.running,
      demo: this.demo,
      testing: this.testing,
      configured: isComplete(this.cfg),
      source: metric.kind,
      unit: metric.unit,
      reference: metric.reference,
      zones: metric.zones.map((z) => publicZone(z, metric.reference)),
      status: this.status,
      device: this.device,
      value: this.value === null ? null : Math.round(this.value),
      pct: this.value === null ? null : Math.round((this.value / metric.reference) * 100),
      zone: this.zone && publicZone(this.zone, metric.reference),
      hue: this.hue,
      target: this.cfg.target,
    };
  }

  private publish(): void {
    this.emit('state', this.state);
  }

  private setStatus(next: Status): void {
    this.status = next;
  }

  private bridgeInstance(): Bridge {
    const { bridgeIp, username } = this.cfg;
    const key = `${bridgeIp}|${username}`;
    if (this.bridge?.key !== key) this.bridge = { key, instance: this.createBridge(bridgeIp!, username!) };
    return this.bridge.instance;
  }

  private ensureDriver(): LightDriver {
    this.driver ??= new LightDriver(this.bridgeInstance(), () => this.cfg, (err) => this.onHueResult(err));
    return this.driver;
  }

  private onHueResult(err: Error | null): void {
    const next = hueStatusFor(err);
    if (next.ok !== this.hue.ok || next.problem !== this.hue.problem) {
      this.hue = next;
      this.publish();
    }
  }

  private async checkHue(): Promise<void> {
    try {
      await this.bridgeInstance().check();
      this.onHueResult(null);
    } catch (err) {
      this.onHueResult(err as Error);
    }
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.suspended = false;
    if (!isComplete(this.cfg)) {
      this.setStatus(status('unconfigured', 'info'));
      return this.publish();
    }
    this.reset();
    this.running = true;
    this.setStatus(status('starting', 'info'));
    const abort = (this.abort = new AbortController());
    void this.checkHue();
    this.hueTimer = setInterval(() => this.hue.ok === false && void this.checkHue(), HUE_RETRY_MS);
    this.watchdog = setInterval(() => this.watch(), this.watchdogMs);
    this.sensorTask = Promise.resolve()
      .then(() =>
        this.sensor(this.metric, {
          signal: abort.signal,
          onValue: (m) => !abort.signal.aborted && this.onValue(m),
          onEvent: (e) => !abort.signal.aborted && this.onSensorEvent(e),
        }),
      )
      .catch((err: Error) => {
        if (abort.signal.aborted) return;
        this.setStatus(status('bluetoothFailed', 'error', { error: err.message }));
        this.publish();
      });
    this.publish();
  }

  /** Stops reading; puts the lights back in their original state when `restoreOnExit` is set. */
  async stop({ restore = true } = {}): Promise<void> {
    const active = this.running || this.suspended;
    this.suspended = false;
    if (!active) return;
    if (this.running) await this.halt();
    await this.closeDriver(restore);
    this.setStatus(this.idleStatus());
    this.publish();
  }

  /** Pauses the sensor (to run a Bluetooth scan) while keeping the lights as they are. */
  async suspend(): Promise<void> {
    if (!this.running) return;
    await this.halt();
    this.suspended = true;
    this.setStatus(status('suspended', 'info'));
    this.publish();
  }

  async resume(): Promise<void> {
    if (this.suspended) await this.start();
  }

  private async halt(): Promise<void> {
    this.running = false;
    this.abort?.abort();
    clearInterval(this.hueTimer);
    clearInterval(this.watchdog);
    await this.sensorTask;
    this.reset();
  }

  private async closeDriver(restore: boolean): Promise<void> {
    const driver = this.driver;
    this.driver = null;
    await driver?.close({ restore: restore && this.cfg.restoreOnExit });
  }

  /** Applies a new config; restarts reading if it was running. */
  async configure(cfg: Config): Promise<void> {
    const prev = this.cfg;
    const wasRunning = this.running || this.suspended;
    const lightsChanged =
      prev.bridgeIp !== cfg.bridgeIp || prev.username !== cfg.username || prev.target?.type !== cfg.target?.type || prev.target?.id !== cfg.target?.id;
    const sensorChanged = SENSOR_KEYS.some((k) => JSON.stringify(prev[k]) !== JSON.stringify(cfg[k]));

    if (lightsChanged) {
      if (this.running) await this.halt();
      await this.closeDriver(true);
      this.cfg = cfg;
      this.hue = { ok: null, problem: null };
      if (wasRunning) return this.start();
    } else if (sensorChanged && this.running) {
      // The driver (and its snapshot of the lights) is kept: no flash back to the original state.
      await this.halt();
      this.cfg = cfg;
      return this.start();
    } else {
      this.cfg = cfg;
      if (!this.running) this.reset();
      if (prev.brightness !== cfg.brightness || prev.transitionDs !== cfg.transitionDs) this.driver?.refresh();
    }
    if (!this.running && !this.suspended) this.setStatus(this.idleStatus());
    this.publish();
  }

  /** Cycles the lights through the zone colors, then goes back to the previous state. */
  async testColors(stepMs = 1500): Promise<void> {
    if (this.testing) return;
    if (!isComplete(this.cfg)) throw new Error('set up the Hue bridge and the lights first');
    this.testing = true;
    this.publish();
    const driver = this.ensureDriver();
    const metric = metricFor(this.cfg);
    try {
      for (const zone of metric.zones) {
        driver.request(zone);
        this.emit('test', publicZone(zone, metric.reference));
        await sleep(stepMs);
      }
    } finally {
      this.testing = false;
      if (this.running && this.zone) driver.request(this.zone);
      else if (driver === this.driver) await this.closeDriver(true);
      this.publish();
    }
  }

  private onSensorEvent(event: SensorEvent): void {
    if (event.type === 'connected') {
      this.connected = true;
      this.device = event.device;
      this.lastValueAt = this.now();
    } else if (event.type !== 'adapter' && event.type !== 'connecting') {
      this.connected = false;
    }
    if (event.type === 'disconnected' || event.type === 'error') {
      this.value = null;
      this.started = false;
    }
    const next = statusForSensorEvent(event);
    if (next) {
      this.setStatus(next);
      this.publish();
    }
  }

  private onValue({ value, contact }: Measurement): void {
    this.lastValueAt = this.now();
    const name = deviceName(this.device);
    if (contact === false) {
      this.value = null;
      if (this.status.code !== 'noContact') {
        this.setStatus(status('noContact', 'warn', { name }));
        this.publish();
      }
      return;
    }
    const smoothed = this.metric.smooth(value);
    if (smoothed === null) return;
    if (!this.started && smoothed <= 0) {
      // Trainer on but not pedaling yet: leave the lights alone.
      if (this.status.code !== 'waiting') {
        this.setStatus(status('waiting', 'ok', { name }));
        this.publish();
      }
      return;
    }
    this.started = true;
    this.value = smoothed;
    this.zone = this.tracker.update(smoothed);
    if (this.status.code !== 'live') this.setStatus(status('live', 'ok', { name }));
    if (!this.testing) this.ensureDriver().request(this.zone);
    this.publish();
  }

  private watch(): void {
    if (!this.running || !this.connected || this.status.code === 'noData') return;
    if (this.now() - this.lastValueAt < this.noDataMs) return;
    this.value = null;
    this.setStatus(status('noData', 'warn', { name: deviceName(this.device) }));
    this.publish();
  }
}
