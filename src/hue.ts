/** Minimal client for the local Philips Hue bridge API (v1, HTTPS). */
import https from 'node:https';
import { hostname } from 'node:os';
import { browse } from './mdns.ts';
import type { BridgeInfo, Target, TargetOption } from './shared/types.ts';
import type { Rgb } from './zones.ts';

/** Hue error types we react to. */
export const HUE_UNAUTHORIZED = 1;
export const HUE_RESOURCE_MISSING = 3;
export const HUE_LINK_BUTTON = 101;

export class HueError extends Error {
  /** Hue error type, or null for network errors. */
  readonly type: number | null;
  /** True when the bridge could not be reached at all. */
  readonly network: boolean;

  constructor(message: string, { type = null, network = false }: { type?: number | null; network?: boolean } = {}) {
    super(message);
    this.name = 'HueError';
    this.type = type;
    this.network = network;
  }
}

// The bridge uses a self-signed certificate: we do not verify it (local network only).
const bridgeAgent = new https.Agent({ rejectUnauthorized: false, keepAlive: true });

function request(method: string, url: string, body?: unknown, timeoutMs = 5000): Promise<any> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = https.request(
      url,
      { method, agent: bridgeAgent, timeout: timeoutMs, headers: payload ? { 'Content-Type': 'application/json' } : {} },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            resolve(data ? JSON.parse(data) : null);
          } catch {
            reject(new HueError(`${method} ${url}: invalid response`));
          }
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (err) => reject(new HueError(`${method} ${url}: ${err.message}`, { network: true })));
    req.end(payload);
  });
}

interface HueApiError {
  type: number;
  address: string;
  description: string;
}

function raiseOnError(result: unknown): void {
  if (!Array.isArray(result)) return;
  const errors: HueApiError[] = result.filter((item) => item?.error).map((item) => item.error);
  if (errors.length) throw new HueError(errors.map((e) => `${e.address}: ${e.description}`).join('; '), { type: errors[0]!.type });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Philips discovery service (needs Internet, rate limited to a few calls per quarter hour). */
async function discoverViaCloud(): Promise<string[]> {
  try {
    const res = await fetch('https://discovery.meethue.com/', { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return [];
    const list = (await res.json()) as { internalipaddress?: string }[];
    return list.map((b) => b.internalipaddress).filter((ip): ip is string => Boolean(ip));
  } catch {
    return [];
  }
}

/** Public bridge configuration (no pairing needed): name and identifier. */
export async function bridgeInfo(ip: string): Promise<BridgeInfo | null> {
  try {
    const config = await request('GET', `https://${ip}/api/0/config`, undefined, 3000);
    return config?.bridgeid ? { ip, name: config.name ?? 'Hue Bridge', id: config.bridgeid } : null;
  } catch {
    return null;
  }
}

/**
 * Looks for bridges on the local network (mDNS) and through the Philips service, in parallel.
 * Only returns addresses that actually answer like a Hue bridge.
 */
export async function discoverBridges({
  mdns = browse,
  cloud = discoverViaCloud,
  info = bridgeInfo,
}: {
  mdns?: (service: string) => Promise<string[]>;
  cloud?: () => Promise<string[]>;
  info?: (ip: string) => Promise<BridgeInfo | null>;
} = {}): Promise<BridgeInfo[]> {
  const [local, remote] = await Promise.all([mdns('_hue._tcp.local').catch(() => []), cloud()]);
  const ips = [...new Set([...local, ...remote])];
  const bridges = await Promise.all(ips.map(info));
  return bridges.filter((b): b is BridgeInfo => b !== null);
}

/** Device name shown in the Hue app: "wattlight#<computer>" (at most 19 characters after the #). */
export function deviceType(host = hostname()): string {
  const device = host.replace(/\.local$/i, '').replace(/[^\w.-]/g, '').slice(0, 19) || 'computer';
  return `wattlight#${device}`;
}

/** One pairing attempt: returns the username, or null while the link button has not been pressed. */
export async function tryPair(ip: string, devicetype = deviceType()): Promise<string | null> {
  const [item = {}] = (await request('POST', `https://${ip}/api`, { devicetype })) ?? [];
  if (item.success) return item.success.username;
  if (item.error?.type === HUE_LINK_BUTTON) return null;
  throw new HueError(item.error?.description ?? 'unexpected answer from the bridge', { type: item.error?.type ?? null });
}

export class PairTimeoutError extends HueError {
  constructor() {
    super('the link button of the bridge was not pressed in time', { type: HUE_LINK_BUTTON });
  }
}

/** Creates a user on the bridge. The link button must be pressed while this runs. */
export async function pair(ip: string, { timeoutMs = 30000, signal, devicetype }: { timeoutMs?: number; signal?: AbortSignal; devicetype?: string } = {}): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    const username = await tryPair(ip, devicetype);
    if (username) return username;
    await sleep(1000);
  }
  throw new PairTimeoutError();
}

/** Conversion sRGB -> CIE xy (Philips formula). The bridge clamps it into the lamp's gamut itself. */
export function rgbToXy([r8, g8, b8]: Rgb): [number, number] {
  const lin = (c: number) => {
    c /= 255;
    return c > 0.04045 ? ((c + 0.055) / 1.055) ** 2.4 : c / 12.92;
  };
  const [r, g, b] = [lin(r8), lin(g8), lin(b8)];
  const X = r * 0.664511 + g * 0.154324 + b * 0.162028;
  const Y = r * 0.283881 + g * 0.668433 + b * 0.047685;
  const Z = r * 0.000088 + g * 0.07231 + b * 0.986039;
  const sum = X + Y + Z;
  if (sum === 0) return [0.3227, 0.329];
  return [+(X / sum).toFixed(4), +(Y / sum).toFixed(4)];
}

export type LightState = Record<string, any>;
export type Snapshot = Record<string, LightState>;

/** What the engine needs from a bridge; implemented by HueBridge and by test fakes. */
export interface Bridge {
  check(): Promise<void>;
  targets(): Promise<TargetOption[]>;
  identify(target: Target): Promise<unknown>;
  lightIdsFor(target: Target): Promise<string[]>;
  setColor(target: Target, rgb: Rgb, bri: number, transitionDs: number): Promise<unknown>;
  snapshot(lightIds: string[]): Promise<Snapshot>;
  restore(snapshot: Snapshot): Promise<void>;
}

export class HueBridge implements Bridge {
  private readonly base: string;

  constructor(ip: string, username: string) {
    this.base = `https://${ip}/api/${username}`;
  }

  async get(path: string): Promise<any> {
    const result = await request('GET', `${this.base}/${path}`);
    raiseOnError(result);
    return result;
  }

  async put(path: string, body: unknown): Promise<any> {
    const result = await request('PUT', `${this.base}/${path}`, body);
    raiseOnError(result);
    return result;
  }

  /** Checks that the bridge answers and that the pairing is still valid. */
  async check(): Promise<void> {
    await this.get('lights');
  }

  /** What can be colored: rooms, zones, then color lights. */
  async targets(): Promise<TargetOption[]> {
    const [groups, lights] = await Promise.all([this.get('groups'), this.get('lights')]);
    const list: TargetOption[] = [];
    for (const [id, g] of Object.entries<any>(groups)) {
      if (g.type === 'Room' || g.type === 'Zone') {
        list.push({ type: 'group', id, name: g.name, kind: g.type === 'Room' ? 'room' : 'zone', lights: g.lights.length });
      }
    }
    for (const [id, l] of Object.entries<any>(lights)) {
      if (/color/i.test(l.type ?? '')) list.push({ type: 'light', id, name: l.name, kind: 'light', lights: 1 });
    }
    return list;
  }

  /** Blinks the target once so it can be spotted. */
  identify(target: Target): Promise<unknown> {
    return this.command(target, { alert: 'select' });
  }

  async lightIdsFor(target: Target): Promise<string[]> {
    if (target.type === 'group') return (await this.get(`groups/${target.id}`)).lights;
    return [target.id];
  }

  setColor(target: Target, rgb: Rgb, bri: number, transitionDs: number): Promise<unknown> {
    return this.command(target, { on: true, xy: rgbToXy(rgb), bri, transitiontime: transitionDs });
  }

  private command(target: Target, body: Record<string, unknown>): Promise<unknown> {
    return target.type === 'group' ? this.put(`groups/${target.id}/action`, body) : this.put(`lights/${target.id}/state`, body);
  }

  async snapshot(lightIds: string[]): Promise<Snapshot> {
    const snap: Snapshot = {};
    for (const id of lightIds) snap[id] = (await this.get(`lights/${id}`)).state;
    return snap;
  }

  async restore(snapshot: Snapshot): Promise<void> {
    for (const [id, state] of Object.entries(snapshot)) {
      await this.put(`lights/${id}/state`, restoreBody(state)).catch(() => {}); // unreachable light: do not block the exit
    }
  }
}

/** Command that puts a light back in a previously captured state. */
export function restoreBody(state: LightState): Record<string, unknown> {
  const body: Record<string, unknown> = { on: !!state.on, transitiontime: 10 };
  if (!body.on) return body;
  if (state.bri !== undefined) body.bri = state.bri;
  if (state.colormode === 'xy' && state.xy) body.xy = state.xy;
  else if (state.colormode === 'ct' && state.ct) body.ct = state.ct;
  else if (state.colormode === 'hs' && state.hue !== undefined) Object.assign(body, { hue: state.hue, sat: state.sat ?? 254 });
  return body;
}
