// Node net.Socket transport for DFHack Remote RPC.
//
// Replaces the original browser WebSocket + websockify proxy: DFHack speaks raw
// TCP on localhost:5000, so in Node we talk to it directly. The wire framing is
// unchanged (see codec.js).
//
// DFHack processes one call at a time on the socket, so calls are serialized
// through a queue. Each call resolves with { result, text } where `result` is
// the RESULT frame body (Buffer) and `text` is the concatenated console output
// from any interleaved TEXT frames — the piece the original client discarded.

import net from 'node:net';
import {
  REQUEST_MAGIC,
  RPC_REPLY,
  CR,
  encodeMessage,
  readHandshake,
  readFrame,
  ProtocolError,
} from './codec.js';

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 5000;

export class RpcError extends Error {
  constructor(message, code, text = '') {
    super(message);
    this.name = 'RpcError';
    this.code = code;
    this.text = text; // console (TEXT) output the call produced before failing
  }
}

export class DfConnection {
  constructor({ host = DEFAULT_HOST, port = DEFAULT_PORT, textDecoder } = {}) {
    this.host = host;
    this.port = port;
    // How to turn TEXT frame bodies into strings. Default: raw utf-8 of the
    // frame body. The client layer swaps in a CoreTextNotification decoder.
    this._decodeText = textDecoder ?? ((body) => body.toString('utf8'));

    this._sock = null;
    this._buf = Buffer.alloc(0);
    this._shookHands = false;

    this._queue = []; // pending calls: { id, body, resolve, reject }
    this._active = null; // the call awaiting a reply
    this._textFrames = []; // TEXT bodies accumulated for the active call
  }

  get connected() {
    return this._shookHands;
  }

  /** Connect and complete the handshake. Resolves once ready for calls. */
  connect() {
    if (this._sock) return this._ready;
    this._ready = new Promise((resolve, reject) => {
      this._sock = net.createConnection({ host: this.host, port: this.port });
      this._sock.on('connect', () => this._sock.write(REQUEST_MAGIC));
      this._sock.on('data', (chunk) => {
        try {
          this._onData(chunk, resolve);
        } catch (err) {
          this._fail(err);
          reject(err);
        }
      });
      this._sock.on('error', (err) => {
        this._fail(err);
        reject(err);
      });
      this._sock.on('close', () => this._fail(new Error('connection closed')));
    });
    return this._ready;
  }

  _onData(chunk, onHandshake) {
    this._buf = this._buf.length ? Buffer.concat([this._buf, chunk]) : chunk;

    if (!this._shookHands) {
      const consumed = readHandshake(this._buf);
      if (consumed === 0) return; // need more bytes
      this._buf = this._buf.subarray(consumed);
      this._shookHands = true;
      onHandshake();
      this._pump();
    }

    // Parse as many complete frames as the buffer holds.
    for (;;) {
      const parsed = readFrame(this._buf);
      if (!parsed) break;
      this._buf = this._buf.subarray(parsed.consumed);
      this._handleFrame(parsed.frame);
    }
  }

  _handleFrame(frame) {
    if (frame.id === RPC_REPLY.TEXT) {
      this._textFrames.push(frame.body);
      return;
    }

    const call = this._active;
    this._active = null;
    const text = this._textFrames.map((b) => this._decodeText(b)).join('');
    this._textFrames = [];

    if (!call) {
      // A reply with no waiting call: protocol desync — surface loudly.
      this._fail(new ProtocolError('reply frame with no pending call'));
      return;
    }

    if (frame.id === RPC_REPLY.FAIL) {
      const detail = text.trim();
      call.reject(
        new RpcError(
          `RPC call failed (${frame.size})${detail ? `: ${detail}` : ''}`,
          frame.size,
          text
        )
      );
    } else if (frame.id === RPC_REPLY.RESULT) {
      call.resolve({ result: frame.body, text });
    } else {
      call.reject(new ProtocolError(`unexpected frame id ${frame.id}`));
    }
    this._pump();
  }

  /** Send the next queued call if the socket is idle. */
  _pump() {
    if (!this._shookHands || this._active || this._queue.length === 0) return;
    const call = this._queue.shift();
    this._active = call;
    this._textFrames = [];
    this._sock.write(encodeMessage(call.id, call.body));
  }

  /**
   * Send one RPC call. `id` is the bound method id (0 for BindMethod).
   * Returns { result: Buffer, text: string }.
   */
  call(id, body) {
    return new Promise((resolve, reject) => {
      this._queue.push({ id, body, resolve, reject });
      this._pump();
    });
  }

  _fail(err) {
    const pending = this._active ? [this._active, ...this._queue] : [...this._queue];
    this._active = null;
    this._queue = [];
    for (const call of pending) call.reject(err);
  }

  close() {
    if (this._sock) {
      this._sock.end();
      this._sock = null;
    }
    this._shookHands = false;
  }
}

export { CR };
