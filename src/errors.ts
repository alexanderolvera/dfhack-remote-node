// Error types for the DFHack Remote RPC client.

/** Thrown when the peer violates the wire protocol (bad magic, stray frame, …). */
export class ProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProtocolError';
  }
}

/**
 * Thrown when an RPC call returns a FAIL frame.
 * `code` is DFHack's command_result (see {@link CR}); `text` is any console
 * (TEXT) output the call produced before failing.
 */
export class RpcError extends Error {
  readonly code: number;
  readonly text: string;

  constructor(message: string, code: number, text = '') {
    super(message);
    this.name = 'RpcError';
    this.code = code;
    this.text = text;
  }
}
