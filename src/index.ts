// Public API for the dfhack-remote-node client.
export { DwarfClient } from './client.ts';
export type { DwarfClientOptions, DecodedReply, GetWorldInfoReply, NameInfo } from './client.ts';

export { METHODS } from './methods.ts';
export type { MethodDef, MethodName } from './methods.ts';

export { DfConnection } from './connection.ts';
export type { DfConnectionOptions, CallResult, TextDecoder } from './connection.ts';

export { RpcError, ProtocolError } from './errors.ts';

export { CR, RPC_REPLY, encodeMessage, readHandshake, readFrame } from './codec.ts';
export type { Frame, ParsedFrame } from './codec.ts';
