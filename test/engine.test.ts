import assert from 'node:assert/strict';
import { test } from 'node:test';
import { demoSensor, metricFor, Session } from '../src/engine.ts';
import { FakeBridge } from '../src/fakes.ts';
import type { SessionState } from '../src/shared/types.ts';
import { configured, manualSensor, sleep, until } from './helpers.ts';

function setup(patch = {}, options = {}) {
  const bridge = new FakeBridge();
  const sensor = manualSensor();
  const session = new Session(configured(patch), { sensor: sensor.fn, createBridge: () => bridge, ...options });
  const states: SessionState[] = [];
  session.on('state', (s) => states.push(s));
  return { bridge, sensor, session, states, last: () => states.at(-1)! };
}

test('without a bridge, the session asks for the setup', async () => {
  const sensor = manualSensor();
  const session = new Session(configured({ username: null }), { sensor: sensor.fn });
  await session.start();
  assert.equal(session.state.status.code, 'unconfigured');
  assert.equal(session.running, false);
  assert.equal(sensor.runs.length, 0);
});

test('sensor events become status codes', async () => {
  const { sensor, session, last } = setup();
  await session.start();
  sensor.event({ type: 'adapter', state: 'poweredOff' });
  assert.deepEqual(last().status, { code: 'bluetoothOff', level: 'error', params: {} });
  sensor.event({ type: 'searching', attempt: 1 });
  assert.equal(last().status.code, 'searching');
  sensor.event({ type: 'notFound', attempt: 1, retryInMs: 5000 });
  assert.deepEqual(last().status, { code: 'notFound', level: 'warn', params: { retrySeconds: 5 } });
  sensor.event({ type: 'connecting', device: { id: 'neo', name: 'Neo' } });
  assert.equal(last().status.code, 'connecting');
  sensor.connect();
  assert.deepEqual(last().status, { code: 'waiting', level: 'ok', params: { name: 'Neo' } });
  await session.stop();
});

test('zero watts before the first pedal stroke leaves the lights alone', async () => {
  const { bridge, sensor, session, last } = setup();
  await session.start();
  sensor.connect();
  sensor.value(0);
  sensor.value(0);
  await sleep(50);
  assert.equal(last().status.code, 'waiting');
  assert.equal(bridge.commands.length, 0);
  await session.stop();
});

test('power drives the zone and the light color', async () => {
  const { bridge, sensor, session, last } = setup({ ftp: 200, powerSmoothingS: 1 });
  await session.start();
  sensor.connect();
  sensor.value(190); // 95 % FTP -> Z4
  assert.equal(last().status.code, 'live');
  assert.equal(last().zone?.number, 4);
  assert.equal(last().pct, 95);
  await until(() => bridge.commands.length === 1);
  assert.deepEqual(bridge.commands[0]!.rgb, [0xff, 0xcc, 0x3f]);
  await session.stop();
});

test('stopping restores the lights captured before the first change', async () => {
  const { bridge, sensor, session } = setup();
  const before = structuredClone(bridge.lights['1']);
  await session.start();
  sensor.connect();
  sensor.value(300);
  await until(() => bridge.commands.length > 0);
  assert.notDeepEqual(bridge.lights['1'], before);
  await session.stop();
  assert.deepEqual(bridge.lights['1'], before);
  assert.equal(session.state.status.code, 'stopped');
  assert.ok(sensor.aborted);
});

test('restoreOnExit=false leaves the last color', async () => {
  const { bridge, sensor, session } = setup({ restoreOnExit: false });
  await session.start();
  sensor.connect();
  sensor.value(300);
  await until(() => bridge.commands.length > 0);
  await session.stop();
  assert.equal(bridge.lights['1']!.colormode, 'rgb');
});

test('the watchdog warns when a connected sensor goes silent', async () => {
  const { sensor, session, last } = setup({}, { noDataMs: 40, watchdogMs: 10 });
  await session.start();
  sensor.connect();
  sensor.value(200);
  await until(() => last().status.code === 'noData');
  assert.equal(last().value, null);
  sensor.value(210);
  assert.equal(last().status.code, 'live');
  await session.stop();
});

test('a strap without skin contact is reported and does not drive the lights', async () => {
  const { bridge, sensor, session, last } = setup({ source: 'hr' });
  await session.start();
  sensor.connect('HRM');
  sensor.value(0, false);
  assert.deepEqual(last().status, { code: 'noContact', level: 'warn', params: { name: 'HRM' } });
  await sleep(30);
  assert.equal(bridge.commands.length, 0);
  sensor.value(150, true);
  assert.equal(last().status.code, 'live');
  await session.stop();
});

test('switching the source restarts the sensor without restoring the lights in between', async () => {
  const { bridge, sensor, session } = setup();
  await session.start();
  sensor.connect();
  sensor.value(300);
  await until(() => bridge.commands.length > 0);
  await session.configure({ ...session.cfg, source: 'hr' });
  assert.equal(sensor.runs.length, 2);
  assert.equal(sensor.runs[1]!.kind, 'hr');
  assert.equal(bridge.lights['1']!.colormode, 'rgb'); // not restored
  assert.equal(session.state.source, 'hr');
  await session.stop();
  assert.equal(bridge.lights['1']!.colormode, 'ct'); // restored at the end
});

test('changing the target restores the previous lights', async () => {
  const { bridge, sensor, session } = setup();
  await session.start();
  sensor.connect();
  sensor.value(300);
  await until(() => bridge.commands.length > 0);
  await session.configure({ ...session.cfg, target: { type: 'light', id: '3', name: 'Other' } });
  assert.equal(bridge.lights['1']!.colormode, 'ct');
  assert.equal(session.running, true);
  await session.stop();
});

test('an unreachable bridge is reported, then cleared once it answers', async () => {
  const { bridge, sensor, session, last } = setup();
  bridge.reachable = false;
  await session.start();
  await until(() => last().hue.ok === false);
  assert.equal(last().hue.problem, 'unreachable');
  bridge.reachable = true;
  sensor.connect();
  sensor.value(300);
  await until(() => last().hue.ok === true);
  await session.stop();
});

test('suspend keeps the lights, resume restarts the sensor', async () => {
  const { bridge, sensor, session } = setup();
  await session.start();
  sensor.connect();
  sensor.value(300);
  await until(() => bridge.commands.length > 0);
  await session.suspend();
  assert.equal(session.state.status.code, 'suspended');
  assert.equal(bridge.lights['1']!.colormode, 'rgb');
  await session.resume();
  assert.equal(sensor.runs.length, 2);
  await session.stop();
  assert.equal(bridge.lights['1']!.colormode, 'ct');
});

test('the color test cycles through every zone then restores the lights', async () => {
  const { bridge, session } = setup();
  const shown: number[] = [];
  session.on('test', (z) => shown.push(z.number));
  await session.testColors(220);
  assert.deepEqual(shown, [1, 2, 3, 4, 5, 6]);
  assert.ok(bridge.commands.length >= 5);
  assert.equal(bridge.lights['1']!.colormode, 'ct');
  assert.equal(session.testing, false);
});

test('the demo sensor ramps between its bounds', async () => {
  const metric = metricFor(configured({ ftp: 200 }));
  const values: number[] = [];
  const events: string[] = [];
  const controller = new AbortController();
  const run = demoSensor(metric, { signal: controller.signal, onValue: (m) => values.push(m.value), onEvent: (e) => events.push(e.type) }, 1);
  await until(() => values.length > 100, 5000);
  controller.abort();
  await run;
  assert.deepEqual(events, ['searching', 'connecting', 'connected']);
  assert.ok(Math.min(...values) >= 80 && Math.max(...values) <= 260);
});
