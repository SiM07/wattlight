/**
 * In-memory stand-ins for the Hue bridge and the Bluetooth scan.
 * Used by the tests and by `--sandbox`, which runs the whole app without any hardware.
 */
import { type Bridge, HueError, type LightState, type Snapshot } from './hue.ts';
import type { HueApi, ScanFn } from './server.ts';
import type { BridgeInfo, SensorDevice, Target, TargetOption } from './shared/types.ts';
import type { Rgb } from './zones.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class FakeBridge implements Bridge {
  lights: Record<string, LightState> = {
    '1': { on: true, bri: 200, colormode: 'ct', ct: 366 },
    '2': { on: false, bri: 120, colormode: 'xy', xy: [0.4, 0.4] },
    '3': { on: true, bri: 254, colormode: 'xy', xy: [0.3, 0.3] },
  };
  groups: Record<string, { name: string; type: 'Room' | 'Zone'; lights: string[] }> = {
    '1': { name: 'Pain cave', type: 'Room', lights: ['1', '2'] },
    '2': { name: 'Living room', type: 'Room', lights: ['3'] },
  };
  /** Every color command, for assertions. */
  readonly commands: { target: Target; rgb: Rgb; bri: number }[] = [];
  reachable = true;

  private guard(): void {
    if (!this.reachable) throw new HueError('bridge unreachable', { network: true });
  }

  async check(): Promise<void> {
    this.guard();
  }

  async targets(): Promise<TargetOption[]> {
    this.guard();
    return [
      ...Object.entries(this.groups).map(([id, g]): TargetOption => ({ type: 'group', id, name: g.name, kind: g.type === 'Room' ? 'room' : 'zone', lights: g.lights.length })),
      ...Object.keys(this.lights).map((id): TargetOption => ({ type: 'light', id, name: `Hue color lamp ${id}`, kind: 'light', lights: 1 })),
    ];
  }

  async identify(): Promise<void> {
    this.guard();
  }

  async lightIdsFor(target: Target): Promise<string[]> {
    this.guard();
    return target.type === 'group' ? (this.groups[target.id]?.lights ?? []) : [target.id];
  }

  async setColor(target: Target, rgb: Rgb, bri: number): Promise<void> {
    this.guard();
    this.commands.push({ target, rgb, bri });
    for (const id of await this.lightIdsFor(target)) this.lights[id] = { on: true, bri, colormode: 'rgb', rgb };
  }

  async snapshot(ids: string[]): Promise<Snapshot> {
    this.guard();
    return Object.fromEntries(ids.map((id) => [id, structuredClone(this.lights[id])]));
  }

  async restore(snapshot: Snapshot): Promise<void> {
    this.guard();
    Object.assign(this.lights, structuredClone(snapshot));
  }
}

/** Fake Hue API: one bridge, paired after a short wait as if the button had been pressed. */
export function fakeHueApi(bridge = new FakeBridge(), pairDelayMs = 2500): HueApi {
  const info: BridgeInfo = { ip: '192.168.1.42', name: 'Sandbox bridge', id: '001788fffe000000' };
  return {
    discover: async () => (await sleep(800), [info]),
    pair: async (_ip, { signal }) => {
      await sleep(pairDelayMs);
      signal.throwIfAborted();
      return 'sandbox-user';
    },
    createBridge: () => bridge,
  };
}

export const fakeScan: ScanFn = async (kind) => {
  await sleep(1500);
  const devices: SensorDevice[] =
    kind === 'power'
      ? [
          { id: 'sandbox-neo', name: 'Tacx Neo 2T 12345', rssi: -48 },
          { id: 'sandbox-pm', name: 'Assioma 0042', rssi: -71 },
        ]
      : [{ id: 'sandbox-hrm', name: 'HRM-Pro+:123456', rssi: -55 }];
  return devices;
};
