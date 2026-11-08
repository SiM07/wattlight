import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { after, before, test } from 'node:test';
import type { Config } from '../src/shared/types.ts';
import { DEFAULTS } from '../src/config.ts';
import { Session } from '../src/engine.ts';
import { FakeBridge, fakeHueApi } from '../src/fakes.ts';
import { type AppServer, createServer } from '../src/server.ts';
import { manualSensor } from './helpers.ts';

let server: AppServer;
let base: string;
let saved: Config[] = [];
let session: Session;
const scans: string[] = [];

function memoryStore(initial: Config) {
  let cfg = initial;
  return {
    path: '/tmp/wattlight-test.json',
    load: () => cfg,
    save: (next: Config) => {
      cfg = next;
      saved.push(next);
    },
  };
}

before(async () => {
  const bridge = new FakeBridge();
  const hue = fakeHueApi(bridge, 50);
  session = new Session(DEFAULTS, { sensor: manualSensor().fn, createBridge: hue.createBridge });
  server = createServer({
    session,
    store: memoryStore({ ...DEFAULTS }),
    hue,
    scan: async (kind) => {
      scans.push(`${kind}:${session.state.status.code}`);
      return [{ id: 'neo', name: 'Neo', rssi: -50 }];
    },
    info: { version: 'test', mode: 'browser', demo: false, platform: 'test' },
    token: 'secret-token-for-tests',
  });
  ({ url: base } = await server.listen());
  base = base.split('#')[0]!.replace(/\/$/, '');
});

after(async () => {
  await session.stop();
  await server.close();
});

/** Response body as loosely typed JSON. */
const json = async (res: Response): Promise<any> => res.json();

const call = (path: string, init: RequestInit = {}, token = 'secret-token-for-tests') =>
  fetch(`${base}${path}`, { ...init, headers: { 'X-Wattlight-Token': token, 'Content-Type': 'application/json', ...init.headers } });
const post = (path: string, body: unknown) => call(path, { method: 'POST', body: JSON.stringify(body) });

test('API calls need the token', async () => {
  assert.equal((await call('/api/state', {}, 'wrong')).status, 401);
  assert.equal((await fetch(`${base}/api/state`)).status, 401);
  assert.equal((await call('/api/state')).status, 200);
});

test('foreign Host headers are refused (DNS rebinding)', async () => {
  const status = await new Promise<number>((resolve, reject) => {
    const req = httpRequest(`${base}/api/state`, { headers: { Host: 'evil.example:80', 'X-Wattlight-Token': 'secret-token-for-tests' } }, (res) => {
      res.resume();
      resolve(res.statusCode!);
    });
    req.on('error', reject);
    req.end();
  });
  assert.equal(status, 403);
});

test('the state hides the bridge credentials', async () => {
  const body = await json(await call('/api/state'));
  assert.equal(body.config.paired, false);
  assert.equal('username' in body.config, false);
  assert.equal(body.app.configPath, '/tmp/wattlight-test.json');
  assert.equal(body.session.status.code, 'unconfigured');
});

test('static files are served, other paths are not', async () => {
  const page = await fetch(`${base}/`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy') ?? '', /default-src 'self'/);
  assert.match(await page.text(), /<title>WattLight<\/title>/);
  assert.equal((await fetch(`${base}/ui/style.css`)).status, 200);
  for (const path of ['/package.json', '/src/server.ts', '/ui/../package.json', '/ui/%2e%2e/package.json', '/src/shared/../config.ts']) {
    assert.equal((await fetch(`${base}${path}`)).status, 404, path);
  }
});

test('config updates are validated and saved', async () => {
  saved = [];
  const ok = await post('/api/config', { ftp: '280', source: 'hr' });
  assert.equal(ok.status, 200);
  assert.equal((await json(ok)).config.ftp, 280);
  assert.equal(saved.at(-1)!.source, 'hr');
  const bad = await post('/api/config', { ftp: 5 });
  assert.equal(bad.status, 400);
  assert.match((await json(bad)).error, /ftp/);
  assert.equal((await post('/api/config', { username: 'x' })).status, 400);
});

test('Hue routes need a paired bridge', async () => {
  const res = await call('/api/hue/targets');
  assert.equal(res.status, 409);
  assert.equal((await json(res)).code, 'notPaired');
});

test('pairing saves the bridge and unlocks the Hue routes', async () => {
  assert.equal((await post('/api/hue/pair', { ip: 'not an ip!' })).status, 400);
  const res = await post('/api/hue/pair', { ip: '192.168.1.42' });
  assert.equal(res.status, 200);
  const { config } = await json(res);
  assert.equal(config.paired, true);
  assert.equal(config.bridgeIp, '192.168.1.42');
  assert.equal(saved.at(-1)!.username, 'sandbox-user');
  const { targets } = await json(await call('/api/hue/targets'));
  assert.ok(targets.some((t: { name: string }) => t.name === 'Pain cave'));
  assert.equal((await post('/api/hue/identify', { target: targets[0] })).status, 200);
});

test('picking a target starts the session; a scan suspends it', async () => {
  await post('/api/config', { target: { type: 'light', id: '1', name: 'Lamp' } });
  await post('/api/session/start', {});
  assert.equal(session.running, true);
  const res = await post('/api/sensors/scan', { kind: 'power' });
  assert.deepEqual((await json(res)).devices, [{ id: 'neo', name: 'Neo', rssi: -50 }]);
  assert.deepEqual(scans, ['power:suspended']);
  assert.equal(session.running, true); // resumed
  assert.equal((await post('/api/sensors/scan', { kind: 'cadence' })).status, 400);
});

test('the event stream sends the current state first', async () => {
  const controller = new AbortController();
  const res = await fetch(`${base}/api/events?token=secret-token-for-tests`, { signal: controller.signal });
  assert.equal(res.headers.get('content-type'), 'text/event-stream');
  const reader = res.body!.getReader();
  const { value } = await reader.read();
  assert.match(new TextDecoder().decode(value), /^event: state\ndata: \{/);
  controller.abort();
  assert.equal((await fetch(`${base}/api/events?token=nope`)).status, 401);
});
