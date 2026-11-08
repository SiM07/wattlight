import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addressFromResponse, decodeRecords, encodeQuery } from '../src/mdns.ts';

/** Builds an answer: PTR _hue._tcp.local -> Bridge._hue._tcp.local (compressed), then an A record. */
function hueAnswer(): Buffer {
  const header = Buffer.from([0, 0, 0x84, 0, 0, 0, 0, 2, 0, 0, 0, 0]);
  const name = Buffer.from([4, ...Buffer.from('_hue'), 4, ...Buffer.from('_tcp'), 5, ...Buffer.from('local'), 0]); // at offset 12
  const ptrData = Buffer.from([6, ...Buffer.from('Bridge'), 0xc0, 12]);
  const ptr = Buffer.concat([name, Buffer.from([0, 12, 0, 1, 0, 0, 0x11, 0x94, 0, ptrData.length]), ptrData]);
  const a = Buffer.concat([Buffer.from([0xc0, 12]), Buffer.from([0, 1, 0x80, 1, 0, 0, 0, 120, 0, 4, 192, 168, 1, 20])]);
  return Buffer.concat([header, ptr, a]);
}

test('encodes a PTR question with the unicast-response bit', () => {
  const query = encodeQuery('_hue._tcp.local');
  assert.equal(query.readUInt16BE(4), 1); // one question
  assert.equal(query.subarray(12, 17).toString('latin1'), '\x04_hue');
  assert.equal(query.readUInt16BE(query.length - 4), 12); // PTR
  assert.equal(query.readUInt16BE(query.length - 2), 0x8001);
});

test('decodes PTR and A records, including compressed names', () => {
  const records = decodeRecords(hueAnswer());
  assert.deepEqual(records, [
    { name: '_hue._tcp.local', type: 12, data: 'Bridge._hue._tcp.local' },
    { name: '_hue._tcp.local', type: 1, data: '192.168.1.20' },
  ]);
});

test('extracts the bridge address and ignores other services', () => {
  assert.equal(addressFromResponse(hueAnswer(), '_hue._tcp.local', '10.0.0.1'), '192.168.1.20');
  assert.equal(addressFromResponse(hueAnswer(), '_airplay._tcp.local', '10.0.0.1'), null);
  assert.equal(addressFromResponse(Buffer.from([1, 2, 3]), '_hue._tcp.local', '10.0.0.1'), null);
  assert.equal(addressFromResponse(Buffer.from([0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0xc0, 12]), '_hue._tcp.local', 'x'), null); // pointer loop
});
