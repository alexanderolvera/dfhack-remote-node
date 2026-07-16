// Low-level wire codec for the DFHack Remote RPC protocol.
//
// Protocol (see DFHack library/RemoteServer.cpp, library/include/RemoteClient.h):
//   Handshake:
//     -> RPCHandshakeHeader { magic: "DFHack?\n", version: i32 = 1 }
//     <- RPCHandshakeHeader { magic: "DFHack!\n", version: i32 = 1 }
//   Per call:
//     -> RPCMessage { header { id: i16, pad: u16, size: i32 }, body[size] }
//     <- RPCReply = { {TEXT, CoreTextNotification}* , (RESULT | FAIL) }
//
// A single call's reply is zero or more TEXT frames (console output) followed
// by exactly one RESULT frame (body = the reply protobuf) or one FAIL frame
// (size field carries the errno; no body). This module parses individual
// frames off a Buffer; call-level accumulation lives in connection.ts.

import { ProtocolError } from './errors.ts';

/** 'DFHack?\n' + i32(1) — the bytes the client sends to open the connection. */
export const REQUEST_MAGIC = Buffer.from([68, 70, 72, 97, 99, 107, 63, 10, 1, 0, 0, 0]);

/** 'DFHack!\n' — the 8 magic bytes of the server's handshake reply. */
export const RESPONSE_MAGIC = Buffer.from([68, 70, 72, 97, 99, 107, 33, 10]);

export const HANDSHAKE_LEN = 12; // 8 magic + 4 version

/** Reserved reply ids (RPCMessageHeader.id) — real methods use non-negative ids. */
export const RPC_REPLY = { RESULT: -1, FAIL: -2, TEXT: -3 } as const;
export const RPC_REQUEST = { QUIT: -4 } as const;

/** Error codes carried in a FAIL frame's size field (DFHack command_result). */
export const CR = {
  LINK_FAILURE: -3,
  NEEDS_CONSOLE: -2,
  NOT_IMPLEMENTED: -1,
  OK: 0,
  FAILURE: 1,
  WRONG_USAGE: 2,
  NOT_FOUND: 3,
} as const;

const HEADER_LEN = 8;
const MAX_BODY = 64 * 1024 * 1024; // 64 MiB sanity cap, matches DFHack

/** One parsed reply frame. `body` is null for FAIL frames (size holds the errno). */
export interface Frame {
  id: number;
  size: number;
  body: Buffer | null;
}

/** A frame plus how many bytes it consumed from the front of the buffer. */
export interface ParsedFrame {
  frame: Frame;
  consumed: number;
}

/** Encode one request message: 8-byte header (id, pad, size) + body. */
export function encodeMessage(id: number, body: Uint8Array): Buffer {
  const buf = Buffer.allocUnsafe(HEADER_LEN + body.length);
  buf.writeInt16LE(id, 0);
  buf.writeUInt16LE(0, 2); // padding
  buf.writeInt32LE(body.length, 4);
  Buffer.from(body).copy(buf, HEADER_LEN);
  return buf;
}

/**
 * Try to read the handshake reply from the front of `buf`.
 * Returns the number of bytes consumed (HANDSHAKE_LEN) once available, or 0 if
 * more data is needed. Throws ProtocolError if the magic doesn't match.
 */
export function readHandshake(buf: Buffer): number {
  if (buf.length < HANDSHAKE_LEN) return 0;
  if (!buf.subarray(0, 8).equals(RESPONSE_MAGIC)) {
    throw new ProtocolError('invalid DFHack handshake response');
  }
  return HANDSHAKE_LEN;
}

/**
 * Try to parse one frame off the front of `buf`.
 * Returns { frame, consumed }, or null if a complete frame isn't available yet.
 * For FAIL frames `size` is the errno and `body` is null; for RESULT/TEXT `body`
 * is a Buffer of length `size`.
 */
export function readFrame(buf: Buffer): ParsedFrame | null {
  if (buf.length < HEADER_LEN) return null;
  const id = buf.readInt16LE(0);
  const size = buf.readInt32LE(4);

  if (id === RPC_REPLY.FAIL) {
    // FAIL carries the errno in `size`; there is no body.
    return { frame: { id, size, body: null }, consumed: HEADER_LEN };
  }

  if (id === RPC_REPLY.RESULT || id === RPC_REPLY.TEXT) {
    if (size < 0 || size > MAX_BODY) {
      throw new ProtocolError(`invalid frame body size ${size}`);
    }
    if (buf.length < HEADER_LEN + size) return null; // wait for full body
    const body = Buffer.from(buf.subarray(HEADER_LEN, HEADER_LEN + size));
    return { frame: { id, size, body }, consumed: HEADER_LEN + size };
  }

  throw new ProtocolError(`unexpected reply id ${id}`);
}
