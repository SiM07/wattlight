import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { configDir, DEFAULTS, isComplete, load, save, validatePatch } from '../src/config.ts';

const tmp = () => join(mkdtempSync(join(tmpdir(), 'wattlight-')), 'config.json');

test('power is the default source', () => {
  assert.equal(DEFAULTS.source, 'power');
});

test('config directory per platform', () => {
  assert.equal(configDir({ APPDATA: 'C:\\Users\\me\\AppData\\Roaming' }, 'win32'), join('C:\\Users\\me\\AppData\\Roaming', 'wattlight'));
  assert.equal(configDir({ XDG_CONFIG_HOME: '/xdg' }, 'linux'), join('/xdg', 'wattlight'));
  assert.match(configDir({}, 'darwin'), /\.config[/\\]wattlight$/);
});

test('missing file gives the defaults; saved values win; legacy "zones" key migrates', () => {
  const path = tmp();
  assert.deepEqual(load(path), DEFAULTS);
  writeFileSync(path, JSON.stringify({ ftp: 300, zones: [{ fromPct: 0, color: '#000000' }] }));
  const cfg = load(path);
  assert.equal(cfg.ftp, 300);
  assert.equal(cfg.source, 'power');
  assert.deepEqual(cfg.hrZones, [{ fromPct: 0, color: '#000000' }]);
  assert.equal('zones' in cfg, false);
});

test('save then load round-trips', () => {
  const path = tmp();
  save({ ...DEFAULTS, maxHr: 185 }, path);
  assert.equal(load(path).maxHr, 185);
  assert.ok(readFileSync(path, 'utf8').endsWith('\n'));
});

test('a corrupted file gives a clear error', () => {
  const path = tmp();
  writeFileSync(path, '{ nope');
  assert.throws(() => load(path), /unreadable config file/);
});

test('isComplete needs bridge, pairing and target', () => {
  assert.equal(isComplete(DEFAULTS), false);
  assert.equal(isComplete({ ...DEFAULTS, bridgeIp: '1.2.3.4', username: 'u', target: { type: 'group', id: '1', name: 'Room' } }), true);
});

test('validatePatch coerces and bounds values', () => {
  assert.deepEqual(validatePatch({ ftp: '260', brightness: 100.4 }), { ftp: 260, brightness: 100 });
  assert.throws(() => validatePatch({ ftp: 20 }), /ftp must be between 50 and 2000/);
  assert.throws(() => validatePatch({ maxHr: '' }), /maxHr/);
  assert.throws(() => validatePatch({ source: 'cadence' }), /source/);
  assert.throws(() => validatePatch({ username: 'x' }), /unknown setting/);
  assert.throws(() => validatePatch([]), /invalid settings/);
  assert.deepEqual(validatePatch({ target: { type: 'light', id: '3', name: 'Lamp', extra: 1 } }), { target: { type: 'light', id: '3', name: 'Lamp' } });
  assert.throws(() => validatePatch({ target: { type: 'scene', id: '1' } }), /invalid target/);
  assert.deepEqual(validatePatch({ powerMeter: { id: 'abc' }, hrm: null }), { powerMeter: { id: 'abc', name: null }, hrm: null });
  assert.deepEqual(validatePatch({ language: 'fr', restoreOnExit: 0 }), { language: 'fr', restoreOnExit: false });
  assert.throws(() => validatePatch({ language: 'de' }), /language/);
});
