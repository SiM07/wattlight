/**
 * Minimal mDNS discovery (RFC 6762): enough to find Hue bridges (`_hue._tcp.local`)
 * without Internet access or extra dependencies. Sends a PTR question and records who answers.
 */
import dgram from 'node:dgram';

const MDNS_ADDRESS = '224.0.0.251';
const MDNS_PORT = 5353;
const TYPE_A = 1;
const TYPE_PTR = 12;
const CLASS_IN_UNICAST = 0x8001; // QU bit: "answer me in unicast", for the ephemeral-port listener

export interface DnsRecord {
  name: string;
  type: number;
  data: string | null;
}

export function encodeQuery(name: string, type = TYPE_PTR): Buffer {
  const parts = [Buffer.from([0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0])]; // id 0, flags 0, 1 question
  for (const label of name.split('.').filter(Boolean)) parts.push(Buffer.from([label.length]), Buffer.from(label, 'ascii'));
  const tail = Buffer.alloc(5);
  tail.writeUInt16BE(type, 1);
  tail.writeUInt16BE(CLASS_IN_UNICAST, 3);
  parts.push(tail);
  return Buffer.concat(parts);
}

/** Reads a DNS name (with compression); returns [name, offset after the name]. */
function readName(buf: Buffer, offset: number): [string, number] {
  const labels: string[] = [];
  let end: number | null = null;
  for (let jumps = 0; jumps < 32; jumps++) {
    if (offset >= buf.length) throw new Error('truncated DNS name');
    const len = buf[offset]!;
    if (len === 0) return [labels.join('.'), end ?? offset + 1];
    if ((len & 0xc0) === 0xc0) {
      end ??= offset + 2;
      offset = ((len & 0x3f) << 8) | buf[offset + 1]!;
      continue;
    }
    labels.push(buf.toString('utf8', offset + 1, offset + 1 + len));
    offset += 1 + len;
  }
  throw new Error('DNS compression loop');
}

/** Decodes the records of a response (data = name for PTR, IPv4 address for A). */
export function decodeRecords(buf: Buffer): DnsRecord[] {
  if (buf.length < 12) return [];
  const questions = buf.readUInt16BE(4);
  const count = buf.readUInt16BE(6) + buf.readUInt16BE(8) + buf.readUInt16BE(10);
  let offset = 12;
  for (let i = 0; i < questions; i++) offset = readName(buf, offset)[1] + 4;
  const records: DnsRecord[] = [];
  for (let i = 0; i < count; i++) {
    const [name, next] = readName(buf, offset);
    const type = buf.readUInt16BE(next);
    const length = buf.readUInt16BE(next + 8);
    const start = next + 10;
    let data: string | null = null;
    if (type === TYPE_PTR) data = readName(buf, start)[0];
    else if (type === TYPE_A && length === 4) data = [...buf.subarray(start, start + 4)].join('.');
    records.push({ name: name.toLowerCase(), type, data });
    offset = start + length;
  }
  return records;
}

/** IPv4 address announced by a response about `service`, or null if the packet is unrelated. */
export function addressFromResponse(packet: Buffer, service: string, fallback: string): string | null {
  const wanted = service.toLowerCase();
  let records: DnsRecord[];
  try {
    records = decodeRecords(packet);
  } catch {
    return null; // malformed packet from another device
  }
  if (!records.some((r) => r.name === wanted || r.data?.toLowerCase().endsWith(`.${wanted}`))) return null;
  return records.find((r) => r.type === TYPE_A)?.data ?? fallback;
}

/**
 * Asks for `service` (e.g. `_hue._tcp.local`) and returns the IPv4 addresses of the devices
 * announcing it within `timeoutMs`.
 */
export async function browse(service: string, timeoutMs = 3000): Promise<string[]> {
  const found = new Set<string>();
  const sockets: dgram.Socket[] = [];

  const open = (port: number) =>
    new Promise<dgram.Socket | null>((resolve) => {
      const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      socket.on('error', () => resolve(null));
      socket.on('message', (msg, rinfo) => {
        const address = addressFromResponse(msg, service, rinfo.address);
        if (address) found.add(address);
      });
      socket.bind(port, () => {
        try {
          if (port === MDNS_PORT) socket.addMembership(MDNS_ADDRESS);
          socket.setMulticastTTL(255);
        } catch {
          // no multicast on this interface: the other socket takes over
        }
        sockets.push(socket);
        resolve(socket);
      });
    });

  // Ephemeral port for unicast answers, port 5353 for multicast answers (may already be taken).
  const opened = await Promise.all([open(0), open(MDNS_PORT)]);
  const query = encodeQuery(service);
  for (const socket of opened) socket?.send(query, MDNS_PORT, MDNS_ADDRESS, () => {});

  await new Promise((r) => setTimeout(r, timeoutMs));
  for (const socket of sockets) socket.close();
  return [...found];
}
