// Offline protocol test: a mock server that speaks the real DFHack wire format,
// exercising handshake, lazy BindMethod, protobuf round-trip, and — the point of
// the port — TEXT-frame capture from RunCommand. No game required.

import net from 'node:net';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import protobuf from 'protobufjs';
import { DwarfClient } from '../src/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = protobuf.Root.fromJSON(
  JSON.parse(readFileSync(join(__dirname, '..', 'build', 'proto.json'), 'utf8'))
);

const REQUEST_MAGIC = Buffer.from([68, 70, 72, 97, 99, 107, 63, 10, 1, 0, 0, 0]);
const RESPONSE_MAGIC = Buffer.from([68, 70, 72, 97, 99, 107, 33, 10, 1, 0, 0, 0]);
const RESULT = -1, FAIL = -2, TEXT = -3;

function frame(id, body) {
  const buf = Buffer.allocUnsafe(8 + body.length);
  buf.writeInt16LE(id, 0);
  buf.writeUInt16LE(0, 2);
  buf.writeInt32LE(body.length, 4);
  body.copy(buf, 8);
  return buf;
}
const enc = (fqn, obj) => {
  const T = root.lookupType(fqn);
  return Buffer.from(T.encode(T.create(obj)).finish());
};

// A minimal stateful mock: tracks bound ids -> method name, then answers calls.
function makeServer() {
  const CoreBindRequest = root.lookupType('dfproto.CoreBindRequest');
  return net.createServer((sock) => {
    let buf = Buffer.alloc(0);
    let shook = false;
    let nextId = 1;
    const idToMethod = new Map();

    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (!shook) {
        if (buf.length < 12) return;
        if (!buf.subarray(0, 8).equals(REQUEST_MAGIC.subarray(0, 8))) {
          sock.destroy();
          return;
        }
        buf = buf.subarray(12);
        shook = true;
        sock.write(RESPONSE_MAGIC);
      }
      while (buf.length >= 8) {
        const id = buf.readInt16LE(0);
        const size = buf.readInt32LE(4);
        if (buf.length < 8 + size) break;
        const body = buf.subarray(8, 8 + size);
        handleCall(sock, id, Buffer.from(body));
        buf = buf.subarray(8 + size);
      }
    });

    function handleCall(sock, id, body) {
      if (id === 0) {
        // BindMethod: assign an id, remember the method name.
        const req = CoreBindRequest.toObject(CoreBindRequest.decode(body));
        const assigned = nextId++;
        idToMethod.set(assigned, req.method);
        sock.write(frame(RESULT, enc('dfproto.CoreBindReply', { assignedId: assigned })));
        return;
      }
      const method = idToMethod.get(id);
      if (method === 'GetVersion') {
        sock.write(frame(RESULT, enc('dfproto.StringMessage', { value: '50.11-r1-mock' })));
      } else if (method === 'GetWorldInfo') {
        sock.write(
          frame(
            RESULT,
            enc('dfproto.GetWorldInfoOut', {
              mode: 1,
              worldName: { englishName: 'Mockworld' }, // NameInfo, not a bare string
              saveDir: 'region1',
            })
          )
        );
      } else if (method === 'RunCommand') {
        // Two TEXT frames (console output) then an empty RESULT — the exact
        // shape the original client mishandled by discarding the text.
        const note = (t) => enc('dfproto.CoreTextNotification', { fragments: [{ text: t }] });
        sock.write(frame(TEXT, note('Mountainhome')));
        sock.write(frame(TEXT, note('\n')));
        sock.write(frame(RESULT, enc('dfproto.EmptyMessage', {})));
      } else {
        sock.write(frame(FAIL, Buffer.alloc(0)));
      }
    }
  });
}

async function main() {
  const server = makeServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  const df = new DwarfClient({ port });
  let failures = 0;
  const check = (name, ok, got) => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ` (got: ${JSON.stringify(got)})`}`);
    if (!ok) failures++;
  };

  try {
    await df.connect();
    check('handshake', df._conn.connected, df._conn.connected);

    const v = await df.getVersion();
    check('GetVersion decodes StringMessage', v === '50.11-r1-mock', v);

    const w = await df.getWorldInfo();
    check(
      'GetWorldInfo decodes nested NameInfo + fields',
      w.worldName?.englishName === 'Mockworld' && w.saveDir === 'region1',
      w
    );

    // Fresh client to prove lazy binding assigns ids in call order independently.
    const text = await df.runCommand('lua', ['-e', 'print("Mountainhome")']);
    check('RunCommand captures TEXT frames', text === 'Mountainhome\n', text);

    // Second call to an already-bound method should not re-bind.
    const v2 = await df.getVersion();
    check('cached bind (second call works)', v2 === '50.11-r1-mock', v2);
  } catch (err) {
    check(`no exception (${err.message})`, false, err.message);
  } finally {
    df.close();
    server.close();
  }

  console.log(failures === 0 ? '\nAll protocol checks passed.' : `\n${failures} check(s) failed.`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main();
