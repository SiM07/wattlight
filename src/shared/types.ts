/**
 * Types shared by the Node process and the web UI: the contract of the local HTTP API.
 * This file must not import any Node API, it is also compiled for the browser.
 */

export type Source = 'power' | 'hr';
export type Language = 'en' | 'fr';
export type Level = 'info' | 'ok' | 'warn' | 'error';

export interface DeviceRef {
  id: string;
  name: string | null;
}

export interface Target {
  type: 'group' | 'light';
  id: string;
  name: string;
}

export interface ZoneSetting {
  name?: string;
  fromPct: number;
  color: string;
}

export interface Config {
  bridgeIp: string | null;
  username: string | null;
  target: Target | null;
  source: Source;
  brightness: number;
  transitionDs: number;
  restoreOnExit: boolean;
  language: Language | null;
  powerMeter: DeviceRef | null;
  ftp: number;
  powerSmoothingS: number;
  hysteresisW: number;
  powerZones: ZoneSetting[] | null;
  hrm: DeviceRef | null;
  maxHr: number;
  hysteresisBpm: number;
  hrZones: ZoneSetting[] | null;
}

/** Config as exposed to the UI: the bridge credentials stay in the Node process. */
export type PublicConfig = Omit<Config, 'username'> & { paired: boolean };

/** What the engine is doing; the UI turns it into a sentence with the translation tables. */
export type StatusCode =
  | 'unconfigured'
  | 'stopped'
  | 'starting'
  | 'suspended'
  | 'bluetoothStarting'
  | 'bluetoothOff'
  | 'bluetoothUnauthorized'
  | 'bluetoothUnsupported'
  | 'bluetoothFailed'
  | 'searching'
  | 'notFound'
  | 'connecting'
  | 'waiting'
  | 'live'
  | 'disconnected'
  | 'connectError'
  | 'noData'
  | 'noContact';

export interface Status {
  code: StatusCode;
  level: Level;
  /** Values inserted in the message: device name, error text… */
  params: Record<string, string | number>;
}

export type HueProblem = 'unauthorized' | 'missingTarget' | 'unreachable';

export interface HueStatus {
  /** null until the first check. */
  ok: boolean | null;
  problem: HueProblem | null;
}

export interface PublicZone {
  number: number;
  name: string;
  color: string;
  /** Lower bound in watts or bpm. */
  from: number;
}

export interface SessionState {
  running: boolean;
  demo: boolean;
  testing: boolean;
  configured: boolean;
  source: Source;
  unit: 'W' | 'bpm';
  reference: number;
  zones: PublicZone[];
  status: Status;
  device: DeviceRef | null;
  value: number | null;
  pct: number | null;
  zone: PublicZone | null;
  hue: HueStatus;
  target: Target | null;
}

export interface BridgeInfo {
  ip: string;
  name: string;
  id: string;
}

export interface TargetOption extends Target {
  kind: 'room' | 'zone' | 'light';
  lights: number;
}

export interface SensorDevice extends DeviceRef {
  rssi: number | null;
}

export interface AppInfo {
  version: string;
  mode: 'window' | 'browser';
  demo: boolean;
  platform: string;
  configPath: string;
}

export interface StateResponse {
  app: AppInfo;
  config: PublicConfig;
  session: SessionState;
}

/** Error codes the UI knows how to explain; other errors are shown as is. */
export type ErrorCode = 'pairTimeout' | 'bridgeUnreachable' | 'notPaired' | 'invalidSettings' | 'bluetooth';

export interface ApiError {
  error: string;
  code?: ErrorCode;
}

/** Server-sent events on /api/events. */
export interface EventMap {
  state: SessionState;
  config: PublicConfig;
  test: PublicZone;
}
