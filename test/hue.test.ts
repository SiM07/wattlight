import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deviceType, discoverBridges, restoreBody, rgbToXy } from '../src/hue.ts';

test('RGB -> xy conversion', () => {
  const [rx, ry] = rgbToXy([255, 0, 0]);
  assert.ok(rx > 0.6 && ry < 0.35);
  const [bx, by] = rgbToXy([0, 0, 255]);
  assert.ok(bx < 0.2 && by < 0.1);
  assert.deepEqual(rgbToXy([0, 0, 0]), [0.3227, 0.329]);
});

test('device type stays within the Hue limits', () => {
  assert.equal(deviceType('Simons-MacBook-Pro.local'), 'wattlight#Simons-MacBook-Pro');
  assert.equal(deviceType('a-very-long-hostname-for-a-computer'), 'wattlight#a-very-long-hostnam');
  assert.equal(deviceType('é'), 'wattlight#computer');
});

test('restore puts back the previous color mode', () => {
  assert.deepEqual(restoreBody({ on: false, bri: 10 }), { on: false, transitiontime: 10 });
  assert.deepEqual(restoreBody({ on: true, bri: 100, colormode: 'ct', ct: 300 }), { on: true, transitiontime: 10, bri: 100, ct: 300 });
  assert.deepEqual(restoreBody({ on: true, bri: 50, colormode: 'xy', xy: [0.1, 0.2] }), { on: true, transitiontime: 10, bri: 50, xy: [0.1, 0.2] });
  assert.deepEqual(restoreBody({ on: true, colormode: 'hs', hue: 1000 }), { on: true, transitiontime: 10, hue: 1000, sat: 254 });
});

test('discovery merges mDNS and cloud results and keeps only real bridges', async () => {
  const bridges = await discoverBridges({
    mdns: async () => ['192.168.1.20', '192.168.1.30'],
    cloud: async () => ['192.168.1.20'],
    info: async (ip) => (ip === '192.168.1.20' ? { ip, name: 'Hue Bridge', id: 'abc' } : null),
  });
  assert.deepEqual(bridges, [{ ip: '192.168.1.20', name: 'Hue Bridge', id: 'abc' }]);
});

test('discovery survives an mDNS failure', async () => {
  const bridges = await discoverBridges({
    mdns: async () => {
      throw new Error('no multicast');
    },
    cloud: async () => ['10.0.0.2'],
    info: async (ip) => ({ ip, name: 'B', id: '1' }),
  });
  assert.equal(bridges.length, 1);
});
