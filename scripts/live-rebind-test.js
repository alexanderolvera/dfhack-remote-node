// Live interop check for the per-connection method-id cache. Needs a running
// DFHack with a loaded fort on 127.0.0.1:5000 (override with DFHACK_HOST /
// DFHACK_PORT), so it is NOT part of `npm test` — run it with `npm run test:live`.
//
// A recording TCP proxy sits between DwarfClient and DFHack. It parses the
// client->server framing, so every method id the client puts on the wire is
// observed directly, and it can drop a connection pair on demand to simulate a
// socket death. DFHack is unmodified: the ids seen here are the ones its
// RemoteServer actually assigned.
//
// Fail closed: the exit code starts at 1 and is only cleared once every check
// has run.

import net from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { DwarfClient } from '../src/client.ts';
import { loadRoot } from '../src/proto.ts';
import { REQUEST_MAGIC, RPC_REPLY } from '../src/codec.ts';

const UPSTREAM = {
  host: process.env.DFHACK_HOST ?? '127.0.0.1',
  port: Number(process.env.DFHACK_PORT ?? 5000),
};
const PROXY_PORT = Number(process.env.PROXY_PORT ?? 5099);
/** How long to let DFHack answer before calling a step stuck. */
const SETTLE_MS = 5000;

const root = loadRoot();
const TextNotification = root.lookupType('dfproto.CoreTextNotification');

/**
 * A TCP proxy to DFHack that records the method id of every client->server
 * message, per connection, and can drop the current connection pair.
 */
function startRecordingProxy() {
  const conns = [];
  const server = net.createServer((client) => {
    const rec = { n: conns.length + 1, ids: [], client, upstream: null };
    conns.push(rec);
    const upstream = net.createConnection(UPSTREAM);
    rec.upstream = upstream;

    let buf = Buffer.alloc(0);
    let shook = false;
    client.on('data', (chunk) => {
      buf = buf.length ? Buffer.concat([buf, chunk]) : Buffer.from(chunk);
      for (;;) {
        if (!shook) {
          if (buf.length < REQUEST_MAGIC.length) break;
          buf = buf.subarray(REQUEST_MAGIC.length);
          shook = true;
          continue;
        }
        if (buf.length < 8) break;
        const id = buf.readInt16LE(0);
        const size = buf.readInt32LE(4);
        if (size < 0 || buf.length < 8 + size) break;
        rec.ids.push(id);
        buf = buf.subarray(8 + size);
      }
      upstream.write(chunk);
    });
    upstream.on('data', (chunk) => client.write(chunk));

    const drop = () => {
      client.destroy();
      upstream.destroy();
    };
    client.on('error', drop);
    upstream.on('error', drop);
    client.on('close', () => upstream.destroy());
    upstream.on('close', () => client.destroy());
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(PROXY_PORT, '127.0.0.1', () =>
      resolve({
        conns,
        /** Drop the newest connection pair: the client sees its socket die. */
        kill() {
          const rec = conns.at(-1);
          rec.client.destroy();
          rec.upstream.destroy();
        },
        stop: () => new Promise((done) => server.close(done)),
      })
    );
  });
}

/**
 * Send one method id straight to DFHack on a fresh connection, with no
 * BindMethod first, and report what comes back — i.e. exactly what a client
 * with a stale cache does.
 */
function probeUnboundId(id) {
  return new Promise((resolve) => {
    const sock = net.createConnection(UPSTREAM);
    const out = { id, reply: 'no reply', text: '' };
    let buf = Buffer.alloc(0);
    let shook = false;
    const done = () => {
      sock.destroy();
      resolve(out);
    };
    sock.setTimeout(SETTLE_MS, done);
    sock.on('error', done);
    sock.on('connect', () => sock.write(REQUEST_MAGIC));
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (!shook) {
        if (buf.length < REQUEST_MAGIC.length) return;
        buf = buf.subarray(REQUEST_MAGIC.length);
        shook = true;
        const header = Buffer.alloc(8); // id, zero padding, zero-length body
        header.writeInt16LE(id, 0);
        sock.write(header);
      }
      while (buf.length >= 8) {
        const fid = buf.readInt16LE(0);
        const size = buf.readInt32LE(4);
        if (fid === RPC_REPLY.FAIL) {
          out.reply = `FAIL (errno ${size})`;
          return done();
        }
        if (buf.length < 8 + size) break;
        const body = buf.subarray(8, 8 + size);
        if (fid === RPC_REPLY.TEXT) {
          const obj = TextNotification.toObject(TextNotification.decode(body), { defaults: true });
          out.text += (obj.fragments ?? []).map((f) => f.text ?? '').join('');
        } else if (fid === RPC_REPLY.RESULT) {
          out.reply = `RESULT (${size} bytes)`;
          return done();
        }
        buf = buf.subarray(8 + size);
      }
    });
  });
}

async function main() {
  process.exitCode = 1;
  let failures = 0;
  const check = (name, ok, detail) => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ` (got: ${JSON.stringify(detail)})`}`);
    if (!ok) failures++;
  };

  let proxy;
  try {
    proxy = await startRecordingProxy();
  } catch (err) {
    console.log(`FAIL  could not open the recording proxy on ${PROXY_PORT} (${err.message})`);
    return;
  }

  const client = new DwarfClient({ host: '127.0.0.1', port: PROXY_PORT });
  try {
    try {
      await client.connect();
    } catch (err) {
      console.log(`FAIL  no DFHack on ${UPSTREAM.host}:${UPSTREAM.port} (${err.message})`);
      console.log('\nStart DF with DFHack and load a fort, then re-run.');
      return;
    }
    console.log(`DFHack ${await client.getVersion()} / DF ${await client.getDFVersion()}\n`);

    // A plugin method, because that is where the per-connection table bites:
    // core method ids come from a static table and answer even unbound.
    const firstInfo = await client.call('GetMapInfo');
    const c1 = proxy.conns.at(-1);
    const boundId = c1.ids.at(-1);
    check(
      'the first plugin call binds, then calls the assigned id',
      c1.ids.at(-2) === 0 && typeof boundId === 'number' && boundId > 0,
      c1.ids
    );

    const before = c1.ids.length;
    await client.call('GetMapInfo');
    check(
      'a repeat call on the live connection reuses the bound id',
      c1.ids.length === before + 1 && c1.ids.at(-1) === boundId,
      c1.ids.slice(before)
    );

    // What a stale cache would do: that id, unbound, on a fresh connection.
    // This is the reason the cache must not outlive its connection.
    const stale = await probeUnboundId(boundId);
    check(
      'DFHack rejects a plugin id that was never bound on this connection',
      stale.reply.startsWith('FAIL') && /invalid id/.test(stale.text),
      { reply: stale.reply, text: stale.text.trim() }
    );
    console.log(`        DFHack said: ${JSON.stringify(stale.text.trim())}`);

    // Socket death, then reconnect on the same client instance.
    proxy.kill();
    await sleep(200);
    check('the client sees the socket death', !client.connected, client.connected);
    await client.connect();
    check('the client reconnects', client.connected, client.connected);

    const c2 = proxy.conns.at(-1);
    const afterDeath = await client.call('GetMapInfo');
    check('a reconnect opens a new DFHack connection', c2 !== c1, proxy.conns.length);
    check('the call after a socket death re-binds first', c2.ids[0] === 0, c2.ids);
    check(
      'the re-bound plugin call succeeds and agrees with connection #1',
      afterDeath.blockSizeX === firstInfo.blockSizeX &&
        afterDeath.blockSizeY === firstInfo.blockSizeY,
      { first: firstInfo.blockSizeX, after: afterDeath.blockSizeX }
    );

    // The explicit close() path.
    client.close();
    await sleep(150);
    await client.connect();
    const c3 = proxy.conns.at(-1);
    const afterClose = await client.call('GetMapInfo');
    check(
      'the call after close() + connect() re-binds first',
      c3 !== c2 && c3.ids[0] === 0,
      c3.ids
    );
    check(
      'the re-bound plugin call succeeds after an explicit close()',
      afterClose.blockSizeX === firstInfo.blockSizeX,
      { expected: firstInfo.blockSizeX, got: afterClose.blockSizeX }
    );
  } catch (err) {
    check(`no unexpected exception (${err.message})`, false, err.stack);
  } finally {
    try {
      client.close();
    } catch {
      /* already down */
    }
    await proxy.stop();
  }

  console.log(failures === 0 ? '\nAll live checks passed.' : `\n${failures} live check(s) failed.`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((err) => {
  console.log(`FAIL  the live suite crashed (${err?.stack ?? err})`);
  process.exit(1);
});
