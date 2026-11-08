import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Config, DeviceRef, Language, Source, Target } from './shared/types.ts';

/** Config directory: %APPDATA% on Windows, $XDG_CONFIG_HOME or ~/.config elsewhere. */
export function configDir(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32' && env.APPDATA) return join(env.APPDATA, 'wattlight');
  return join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'wattlight');
}

export const CONFIG_PATH = process.env.WATTLIGHT_CONFIG ?? join(configDir(), 'config.json');

export const SOURCES: readonly Source[] = ['power', 'hr'];
export const LANGUAGES: readonly Language[] = ['en', 'fr'];

export const DEFAULTS: Config = {
  bridgeIp: null,
  username: null,
  target: null,
  source: 'power',
  brightness: 254, // 1-254
  transitionDs: 4, // fade duration, in tenths of a second
  restoreOnExit: true,
  language: null, // null = follow the system language

  powerMeter: null, // null = first power sensor found
  ftp: 250,
  powerSmoothingS: 3, // rolling average, the usual 3 s power
  hysteresisW: 5,
  powerZones: null, // null = default zones (zones.ts)

  hrm: null, // null = first heart rate strap found
  maxHr: 190,
  hysteresisBpm: 3,
  hrZones: null,
};

/** Bounds of the numeric settings editable from the UI. */
const RANGES = {
  ftp: [50, 2000],
  maxHr: [100, 240],
  brightness: [1, 254],
  transitionDs: [0, 50],
  powerSmoothingS: [1, 30],
  hysteresisW: [0, 100],
  hysteresisBpm: [0, 20],
} as const satisfies Partial<Record<keyof Config, readonly [number, number]>>;

export interface ConfigStore {
  readonly path: string;
  load(): Config;
  save(cfg: Config): void;
}

export function load(path = CONFIG_PATH): Config {
  let saved: Record<string, unknown> = {};
  if (existsSync(path)) {
    try {
      saved = JSON.parse(readFileSync(path, 'utf8'));
    } catch (err) {
      throw new Error(`unreadable config file (${path}): ${(err as Error).message}`, { cause: err });
    }
  }
  if ('zones' in saved) {
    saved.hrZones ??= saved.zones; // legacy key name
    delete saved.zones;
  }
  return { ...DEFAULTS, ...saved } as Config;
}

/** Atomic write: a crash while saving never leaves a truncated file behind. */
export function save(cfg: Config, path = CONFIG_PATH): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, path);
}

export function fileStore(path = CONFIG_PATH): ConfigStore {
  return { path, load: () => load(path), save: (cfg) => save(cfg, path) };
}

/** Bridge, pairing and target are set: the lights can be driven. */
export function isComplete(cfg: Config): boolean {
  return Boolean(cfg.bridgeIp && cfg.username && cfg.target?.id && cfg.target?.type);
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function device(value: unknown, key: string): DeviceRef | null {
  if (value === null) return null;
  if (!isObject(value) || typeof value.id !== 'string') throw new Error(`invalid ${key}`);
  return { id: value.id, name: typeof value.name === 'string' ? value.name : null };
}

function target(value: unknown): Target | null {
  if (value === null) return null;
  if (!isObject(value) || (value.type !== 'group' && value.type !== 'light') || typeof value.id !== 'string') {
    throw new Error('invalid target');
  }
  return { type: value.type, id: value.id, name: String(value.name ?? value.id) };
}

/**
 * Validates a partial update coming from the UI.
 * Returns the cleaned patch (numbers coerced) or throws a readable error.
 */
export function validatePatch(patch: unknown): Partial<Config> {
  if (!isObject(patch)) throw new Error('invalid settings');
  const clean: Partial<Config> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (key in RANGES) {
      const [min, max] = RANGES[key as keyof typeof RANGES];
      const n = Number(value);
      if (value === null || value === '' || !Number.isFinite(n) || n < min || n > max) {
        throw new Error(`${key} must be between ${min} and ${max}`);
      }
      clean[key as keyof typeof RANGES] = Math.round(n);
    } else if (key === 'source') {
      if (!SOURCES.includes(value as Source)) throw new Error('source must be "power" or "hr"');
      clean.source = value as Source;
    } else if (key === 'language') {
      if (value !== null && !LANGUAGES.includes(value as Language)) throw new Error(`language must be one of ${LANGUAGES.join(', ')}`);
      clean.language = value as Language | null;
    } else if (key === 'restoreOnExit') {
      clean.restoreOnExit = Boolean(value);
    } else if (key === 'target') {
      clean.target = target(value);
    } else if (key === 'powerMeter' || key === 'hrm') {
      clean[key] = device(value, key);
    } else {
      throw new Error(`unknown setting: ${key}`);
    }
  }
  return clean;
}
