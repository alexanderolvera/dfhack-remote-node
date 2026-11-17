// Offline connection lifecycle test. Fake sockets let each test control event
// order precisely: an old socket's error, late close, and repeated events can
// be delivered after a replacement socket has connected.
//
// Fail closed: the process exit code starts at 1 and is only cleared after
// every check has run. Each awaited promise is settled under a timeout, and a
// watchdog fails the run if a stuck await or a leaked handle keeps it going, so
// a regression can never print FAIL lines and still exit 0.

import net from 'node:net';
import { EventEmitter } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import { setTimeout as setTimer, clearTimeout } from 'node:timers';
import { DfConnection } from '../src/connection.ts';
import { DwarfClient } from '../src/client.ts';
import { HANDSHAKE_LEN, REQUEST_MAGIC, RESPONSE_MAGIC, RPC_REPLY } from '../src/codec.ts';
import { loadRoot } from '../src/proto.ts';

const COMPLETE_RESPONSE_MAGIC = Buffer.alloc(HANDSHAKE_LEN);
RESPONSE_MAGIC.copy(COMPLETE_RESPONSE_MAGIC);
COMPLETE_RESPONSE_MAGIC.writeInt32LE(1, RESPONSE_MAGIC.length);

/** How long a single awaited lifecycle event may take before it is a failure. */
const SETTLE_TIMEOUT_MS = 1000;
/** Whole-suite watchdog: a hung await must still fail the process. */
const HARNESS_TIMEOUT_MS = 30000;

class FakeSocket extends EventEmitter {
  writes = [];
  ended = false;
  destroyedWith = null;

  write(chunk) {
    this.writes.push(Buffer.from(chunk));
    return true;
  }

  end() {
    this.ended = true;
    return this;
  }

  destroy(err) {
    this.destroyedWith = err ?? null;
    return this;
  }
}

const originalCreateConnection = net.createConnection;
const sockets = [];

function installFakeSockets() {
  sockets.length = 0;
  net.createConnection = () => {
    const sock = new FakeSocket();
    sockets.push(sock);
    return sock;
  };
}

function restoreSockets() {
  net.createConnection = originalCreateConnection;
}

function observe(promise) {
  const result = { status: 'pending', error: null, promise };
  promise.then(
    () => {
      result.status = 'fulfilled';
    },
    (err) => {
      result.status = 'rejected';
      result.error = err;
    }
  );
  return result;
}

function flushPromises() {
  return sleep(0);
}

/**
 * Await a promise until it settles or the timeout elapses. Returns the observed
 * state so a never-settling promise becomes a failed check instead of a hang.
 */
async function settleWithin(promise, ms = SETTLE_TIMEOUT_MS) {
  const state = observe(promise);
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimer(resolve, ms);
  });
  try {
    await Promise.race([new Promise((resolve) => promise.then(resolve, resolve)), timeout]);
  } finally {
    clearTimeout(timer);
  }
  return state;
}

async function connectedPair() {
  const df = new DfConnection();
  const ready = df.connect();
  const sock = sockets.at(-1);
  sock.emit('connect');
  sock.emit('data', COMPLETE_RESPONSE_MAGIC);
  await settleWithin(ready);
  return { df, sock };
}

// --- DwarfClient method-binding helpers ------------------------------------
//
// FakeSocket records raw writes; the checks below need the *method id* out of
// each one, because that is the only way to see whether the client re-bound
// (wire id 0 = BindMethod) or went straight to a cached id.

const root = loadRoot();

function encode(fqn, obj) {
  const T = root.lookupType(fqn);
  return Buffer.from(T.encode(T.create(obj)).finish());
}

/** One reply frame: the 8-byte header plus body, exactly as DFHack sends it. */
function replyFrame(id, body) {
  const buf = Buffer.allocUnsafe(8 + body.length);
  buf.writeInt16LE(id, 0);
  buf.writeUInt16LE(0, 2);
  buf.writeInt32LE(body.length, 4);
  body.copy(buf, 8);
  return buf;
}

function bindReply(assignedId) {
  return replyFrame(RPC_REPLY.RESULT, encode('dfproto.CoreBindReply', { assignedId }));
}

function stringReply(value) {
  return replyFrame(RPC_REPLY.RESULT, encode('dfproto.StringMessage', { value }));
}

/**
 * Method ids of the RPC messages written to a fake socket, in order, with the
 * leading handshake write dropped.
 */
function writtenIds(sock) {
  const start = sock.writes[0]?.equals(REQUEST_MAGIC) ? 1 : 0;
  return sock.writes.slice(start).map((w) => w.readInt16LE(0));
}

async function connectedClient() {
  const client = new DwarfClient();
  const ready = client.connect();
  const sock = sockets.at(-1);
  sock.emit('connect');
  sock.emit('data', COMPLETE_RESPONSE_MAGIC);
  await settleWithin(ready);
  return { client, sock };
}

async function reconnectClient(client) {
  const reconnecting = client.connect();
  const sock = sockets.at(-1);
  sock.emit('connect');
  sock.emit('data', COMPLETE_RESPONSE_MAGIC);
  await settleWithin(reconnecting);
  return sock;
}

/**
 * Run one DwarfClient call to completion over a fake socket, answering each
 * message the way DFHack would: wire id 0 (BindMethod) gets `assignedId`,
 * anything else gets `reply`. Returns the observed promise state plus the wire
 * ids written during this call — so a missing leading 0 is a skipped bind.
 */
async function runCall(sock, start, { assignedId, reply }) {
  const first = writtenIds(sock).length;
  let cursor = first;
  const state = observe(start());
  // Bind and call are separate round trips: write, answer, flush, write again.
  for (let round = 0; round < 4; round++) {
    await flushPromises();
    const ids = writtenIds(sock);
    if (cursor >= ids.length) break; // nothing new on the wire to answer
    const id = ids[cursor++];
    sock.emit('data', id === 0 ? bindReply(assignedId) : reply);
  }
  await settleWithin(state.promise);
  return { state, ids: writtenIds(sock).slice(first) };
}

async function main() {
  // Set before any await: an early exit can never look green.
  process.exitCode = 1;

  installFakeSockets();
  let failures = 0;
  const unhandled = [];
  process.on('unhandledRejection', (err) => {
    unhandled.push(err);
  });
  const check = (name, ok, detail) => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ` (got: ${JSON.stringify(detail)})`}`);
    if (!ok) failures++;
  };

  const watchdog = setTimer(() => {
    console.log(`FAIL  the lifecycle suite did not finish within ${HARNESS_TIMEOUT_MS}ms`);
    console.log('\nlifecycle harness timed out; failing closed.');
    process.exit(1);
  }, HARNESS_TIMEOUT_MS);

  try {
    {
      const { df, sock } = await connectedPair();
      const active = observe(df.call(7, Uint8Array.of(1)));
      const queued = observe(df.call(8, Uint8Array.of(2)));
      check('handshake starts connected', df.connected, df.connected);

      df.close();
      await flushPromises();

      check('close() rejects the in-flight call', active.status === 'rejected', active.status);
      check('close() rejects the queued call', queued.status === 'rejected', queued.status);
      check('close() resets connected', !df.connected, df.connected);
      check('close() ends the socket without destroying it', sock.ended && !sock.destroyedWith, {
        ended: sock.ended,
        destroyed: Boolean(sock.destroyedWith),
      });

      const reconnecting = df.connect();
      const replacement = sockets.at(-1);
      replacement.emit('connect');
      replacement.emit('data', COMPLETE_RESPONSE_MAGIC);
      await settleWithin(reconnecting);
      check('connect() after close() can reuse the instance', df.connected, df.connected);
    }

    {
      const { df, sock } = await connectedPair();
      const active = observe(df.call(7, Uint8Array.of(1)));
      sock.emit('error', new Error('socket died'));
      await flushPromises();

      check('socket error rejects the in-flight call', active.status === 'rejected', active.status);
      check('socket error resets connected', !df.connected, df.connected);
    }

    {
      const { df, sock: dead } = await connectedPair();
      const active = observe(df.call(7, Uint8Array.of(1)));
      let reconnect;
      const recovered = active.promise.catch(() => {
        reconnect = df.connect();
        return reconnect;
      });

      dead.emit('error', new Error('socket died'));
      await flushPromises();

      const replacement = sockets.at(-1);
      check(
        'caller observes the rejection before reconnecting',
        Boolean(reconnect),
        Boolean(reconnect)
      );
      check('a reconnect creates a new socket', replacement !== dead, sockets.length);
      replacement.emit('connect');
      replacement.emit('data', COMPLETE_RESPONSE_MAGIC);
      await settleWithin(recovered);
      check('reconnect succeeds immediately after a failure', df.connected, df.connected);

      dead.emit('close');
      dead.emit('error', new Error('late dead-socket error'));
      await flushPromises();

      check('the dead socket does not take the new one down', df.connected, df.connected);
      check(
        'old socket events leave the replacement alive',
        !replacement.destroyedWith && !replacement.ended,
        { destroyed: Boolean(replacement.destroyedWith), ended: replacement.ended }
      );
      check('reconnect wrote the handshake', replacement.writes.at(0)?.equals(REQUEST_MAGIC), {
        writes: replacement.writes.length,
      });
    }

    {
      const { df, sock: dying } = await connectedPair();
      dying.emit('error', new Error('socket died'));
      await flushPromises();
      check('socket error resets connected before reconnecting', !df.connected, df.connected);

      const reconnecting = df.connect();
      const replacement = sockets.at(-1);
      replacement.emit('connect');
      replacement.emit('data', COMPLETE_RESPONSE_MAGIC);
      await settleWithin(reconnecting);
      check('reconnect succeeds after an error', df.connected, df.connected);
    }

    {
      const { df, sock } = await connectedPair();
      const active = observe(df.call(7, Uint8Array.of(1)));
      const queued = observe(df.call(8, Uint8Array.of(2)));

      df.close();
      df.close();
      sock.emit('close');
      sock.emit('error', new Error('late close error'));
      await flushPromises();

      check(
        'repeated close() is safe',
        active.status === 'rejected' && queued.status === 'rejected',
        {
          active: active.status,
          queued: queued.status,
        }
      );
      check('events after intentional close are safe', !df.connected, df.connected);

      const reconnecting = df.connect();
      const replacement = sockets.at(-1);
      replacement.emit('connect');
      replacement.emit('data', COMPLETE_RESPONSE_MAGIC);
      await settleWithin(reconnecting);
      check('late events after close() do not break reuse', df.connected, df.connected);
    }

    // Guard sanity: a promise that never settles must be observed as pending
    // instead of suspending the suite (this is what makes the harness fail
    // closed on a real regression).
    {
      const never = await settleWithin(new Promise(() => {}), 10);
      check('the settle guard reports a stuck promise as pending', never.status === 'pending', {
        status: never.status,
      });
    }

    // Remote close before the handshake reply: connect() must reject promptly
    // with the causal error, and a later stale error must not touch the next
    // attempt.
    {
      const df = new DfConnection();
      const first = observe(df.connect());
      const dead = sockets.at(-1);
      dead.emit('connect');
      dead.emit('close');
      await flushPromises();

      check(
        'remote close before handshake rejects connect()',
        first.status === 'rejected',
        first.status
      );
      check(
        'remote close before handshake reports the causal error',
        first.error instanceof Error && /closed/.test(first.error.message),
        first.error?.message ?? null
      );
      check('remote close before handshake leaves the client disconnected', !df.connected, true);

      const second = observe(df.connect());
      const replacement = sockets.at(-1);
      check(
        'connect() after a pre-handshake close creates a new socket',
        replacement !== dead && second.status === 'pending',
        { newSocket: replacement !== dead, status: second.status }
      );

      dead.emit('close');
      dead.emit('error', new Error('stale dead-socket error'));
      await flushPromises();
      check(
        'a stale error after the pre-handshake close cannot settle the new connect()',
        second.status === 'pending',
        second.error?.message ?? second.status
      );
      check(
        'the aborted connect() keeps its causal error, not the stale one',
        first.status === 'rejected' && !/stale/.test(first.error?.message ?? ''),
        { status: first.status, message: first.error?.message ?? null }
      );

      replacement.emit('connect');
      replacement.emit('data', COMPLETE_RESPONSE_MAGIC);
      await flushPromises();
      check(
        'the replacement handshake still completes after stale events',
        second.status === 'fulfilled' && df.connected,
        { status: second.status, connected: df.connected }
      );
      check(
        'the probe socket survives old-socket events',
        !replacement.destroyedWith && !replacement.ended,
        { destroyed: Boolean(replacement.destroyedWith), ended: replacement.ended }
      );
    }

    // Same pre-handshake abort, but the stale error arrives before the caller
    // reconnects: the original promise keeps the causal error either way.
    {
      const df = new DfConnection();
      const first = observe(df.connect());
      const dead = sockets.at(-1);
      dead.emit('connect');
      dead.emit('close');
      await flushPromises();
      dead.emit('error', new Error('stale error after clean close'));
      await flushPromises();
      check(
        'a stale error cannot re-settle an already rejected connect()',
        first.status === 'rejected' && !/stale/.test(first.error?.message ?? ''),
        { status: first.status, message: first.error?.message ?? null }
      );
      check(
        'the aborted connect() error stays the clean-close error',
        first.error?.message === 'connection closed',
        first.error?.message ?? null
      );
    }

    {
      const df = new DfConnection();
      const first = observe(df.connect());
      const dead = sockets.at(-1);
      dead.emit('connect');
      dead.emit('error', new Error('socket reset before handshake'));
      await flushPromises();

      check(
        'socket error before handshake rejects connect() with that error',
        first.status === 'rejected' && first.error?.message === 'socket reset before handshake',
        { status: first.status, message: first.error?.message ?? null }
      );
      check(
        'a pre-handshake socket error leaves the client disconnected',
        !df.connected,
        df.connected
      );
      check(
        'a pre-handshake socket error destroys the socket with the cause',
        dead.destroyedWith?.message === 'socket reset before handshake',
        dead.destroyedWith?.message ?? null
      );
    }

    // Explicit close() while the handshake is outstanding.
    {
      const df = new DfConnection();
      const first = observe(df.connect());
      const sock = sockets.at(-1);
      sock.emit('connect');
      df.close();
      df.close();
      await flushPromises();

      check(
        'close() before handshake rejects connect()',
        first.status === 'rejected',
        first.status
      );
      check(
        'close() before handshake reports the causal error',
        first.error instanceof Error && /closed/.test(first.error.message),
        first.error?.message ?? null
      );
      check(
        'close() before handshake ends the socket without destroying it',
        sock.ended && !sock.destroyedWith,
        { ended: sock.ended, destroyed: Boolean(sock.destroyedWith) }
      );

      sock.emit('close');
      sock.emit('error', new Error('late error after explicit close'));
      await flushPromises();

      const second = observe(df.connect());
      const replacement = sockets.at(-1);
      replacement.emit('connect');
      replacement.emit('data', COMPLETE_RESPONSE_MAGIC);
      await flushPromises();
      check(
        'the instance is reusable after a pre-handshake close()',
        second.status === 'fulfilled' && df.connected,
        { status: second.status, connected: df.connected }
      );
      check(
        'duplicate pre-handshake events cannot settle the reused connect()',
        second.status === 'fulfilled' && replacement.writes.length === 1,
        { status: second.status, writes: replacement.writes.length }
      );
    }

    // A successful handshake must clear the stored settlement callback, so a
    // later close reports no spurious rejection of the settled promise.
    {
      const { df, sock } = await connectedPair();
      const ready = observe(df.connect());
      await flushPromises();
      check(
        'connect() on a live connection resolves without a new socket',
        ready.status === 'fulfilled' && sockets.at(-1) === sock,
        { status: ready.status, sameSocket: sockets.at(-1) === sock }
      );
    }

    // Public API: DwarfClient.connect() inherits the settlement, so the hang was
    // visible to library consumers too.
    {
      const df = new DwarfClient({ port: 5000 });
      const first = observe(df.connect());
      const sock = sockets.at(-1);
      sock.emit('connect');
      sock.emit('close');
      await flushPromises();
      check(
        'DwarfClient.connect() rejects when the remote closes before handshake',
        first.status === 'rejected',
        first.status
      );
      check(
        'DwarfClient.connect() reports the same causal error',
        first.error instanceof Error && /closed/.test(first.error.message),
        first.error?.message ?? null
      );
    }

    // Method ids are per-connection: DFHack's RemoteServer builds its RPC
    // function table per connection, so an assignedId from a dead socket means
    // nothing on the next one. After a socket death the client must re-bind.
    {
      const { client, sock } = await connectedClient();
      const first = await runCall(sock, () => client.getVersion(), {
        assignedId: 100,
        reply: stringReply('50.11-r1'),
      });
      check(
        'the first call binds before calling',
        first.state.status === 'fulfilled' && first.ids[0] === 0 && first.ids[1] === 100,
        { status: first.state.status, ids: first.ids, error: first.state.error?.message ?? null }
      );

      const repeat = await runCall(sock, () => client.getVersion(), {
        assignedId: 100,
        reply: stringReply('50.11-r1'),
      });
      check(
        'a second call on the same connection reuses the bound id',
        repeat.state.status === 'fulfilled' && repeat.ids.length === 1 && repeat.ids[0] === 100,
        { status: repeat.state.status, ids: repeat.ids }
      );

      sock.emit('error', new Error('socket died'));
      await flushPromises();
      const fresh = await reconnectClient(client);
      check('the reconnected client is connected', client.connected, client.connected);

      const after = await runCall(fresh, () => client.getVersion(), {
        assignedId: 200,
        reply: stringReply('50.11-r1'),
      });
      check('a call after a socket death re-binds before calling', after.ids[0] === 0, after.ids);
      check(
        'no id from the dead connection reaches the new socket',
        !after.ids.includes(100) && after.ids.includes(200),
        after.ids
      );
      check(
        'the re-bound call resolves on the new connection',
        after.state.status === 'fulfilled',
        after.state.error?.message ?? after.state.status
      );
    }

    // Same invalidation on the explicit path: close() then connect().
    {
      const { client, sock } = await connectedClient();
      const first = await runCall(sock, () => client.getVersion(), {
        assignedId: 100,
        reply: stringReply('50.11-r1'),
      });
      check(
        'the pre-close call binds and resolves',
        first.state.status === 'fulfilled' && first.ids[0] === 0,
        { status: first.state.status, ids: first.ids }
      );

      client.close();
      const fresh = await reconnectClient(client);
      const after = await runCall(fresh, () => client.getVersion(), {
        assignedId: 200,
        reply: stringReply('50.11-r1'),
      });
      check(
        'a call after close() + connect() re-binds before calling',
        after.ids[0] === 0 && after.ids.includes(200) && !after.ids.includes(100),
        after.ids
      );
      check(
        'the re-bound call resolves after an explicit close()',
        after.state.status === 'fulfilled',
        after.state.error?.message ?? after.state.status
      );
    }

    // A cached miss (`null` — "not available on this DFHack") is a cache state
    // the invalidation has to cover too: the replacement connection can be a
    // different build, or have different plugins loaded.
    //
    // The wire cannot produce one today — CoreBindReply.assigned_id is
    // `required`, so a reply without it fails to decode, and DFHack answers an
    // unknown method with a FAIL frame (which rejects and caches nothing). The
    // entry is therefore seeded on the instance directly: what is under test is
    // the cache's lifetime, not the route by which a miss gets stored.
    {
      const { client, sock } = await connectedClient();
      client.boundIds.set('GetVersion', null);
      client.boundGeneration = client.conn.generation;

      const cachedMiss = await runCall(sock, () => client.getVersion(), {
        assignedId: 42,
        reply: stringReply('unreachable'),
      });
      check(
        'a cached miss is honoured without re-probing the live connection',
        cachedMiss.state.status === 'rejected' &&
          /not available/.test(cachedMiss.state.error?.message ?? '') &&
          cachedMiss.ids.length === 0,
        {
          status: cachedMiss.state.status,
          message: cachedMiss.state.error?.message ?? null,
          ids: cachedMiss.ids,
        }
      );

      client.close();
      const fresh = await reconnectClient(client);
      const reprobed = await runCall(fresh, () => client.getVersion(), {
        assignedId: 42,
        reply: stringReply('50.11-r1'),
      });
      check(
        'a cached miss is re-probed on a new connection',
        reprobed.ids[0] === 0 && reprobed.ids.includes(42),
        reprobed.ids
      );
      check(
        'the re-probed method resolves once the new DFHack has it',
        reprobed.state.status === 'fulfilled',
        reprobed.state.error?.message ?? reprobed.state.status
      );
    }

    // The signal the client keys its cache on.
    {
      const { df, sock } = await connectedPair();
      const atConnect = df.generation;
      sock.emit('error', new Error('socket died'));
      await flushPromises();
      const afterFail = df.generation;
      await settleWithin(
        df.connect().catch(() => {}),
        10
      );
      df.close();
      await flushPromises();
      check(
        'generation advances on socket death and on close()',
        afterFail > atConnect && df.generation > afterFail,
        { atConnect, afterFail, afterClose: df.generation }
      );
    }
  } catch (err) {
    check(`no unexpected exception (${err.message})`, false, err.stack);
  } finally {
    clearTimeout(watchdog);
    restoreSockets();
  }

  check('no unhandled promise rejections', unhandled.length === 0, unhandled.map(String));
  console.log(failures === 0 ? '\nAll lifecycle checks passed.' : `\n${failures} check(s) failed.`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((err) => {
  console.log(`FAIL  the lifecycle suite crashed (${err?.stack ?? err})`);
  process.exit(1);
});
