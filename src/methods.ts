// The RPC method table.
//
// `input`/`output` are FULLY-QUALIFIED protobuf type names (with package),
// because a method's input and output can live in different packages — e.g. RFR
// methods take a dfproto.EmptyMessage but return a RemoteFortressReader.* message.
// This is exactly the full name DFHack matches during BindMethod, so a mismatch
// here surfaces as "Requested wrong signature for RPC method".
// Ported from FUNC_DEFS in the original lib.js; extend as tools need methods.

/** One RPC method definition. `plugin` is null for core (dfproto) methods. */
export interface MethodDef {
  plugin: string | null;
  input: string;
  output: string;
}

export const METHODS = {
  // core (dfproto package)
  BindMethod: { plugin: null, input: 'dfproto.CoreBindRequest', output: 'dfproto.CoreBindReply' },
  RunCommand: {
    plugin: null,
    input: 'dfproto.CoreRunCommandRequest',
    output: 'dfproto.EmptyMessage',
  },
  RunLua: { plugin: null, input: 'dfproto.CoreRunLuaRequest', output: 'dfproto.StringListMessage' },
  GetVersion: { plugin: null, input: 'dfproto.EmptyMessage', output: 'dfproto.StringMessage' },
  GetDFVersion: { plugin: null, input: 'dfproto.EmptyMessage', output: 'dfproto.StringMessage' },
  GetWorldInfo: { plugin: null, input: 'dfproto.EmptyMessage', output: 'dfproto.GetWorldInfoOut' },
  ListUnits: { plugin: null, input: 'dfproto.ListUnitsIn', output: 'dfproto.ListUnitsOut' },
  ListSquads: { plugin: null, input: 'dfproto.ListSquadsIn', output: 'dfproto.ListSquadsOut' },

  // RemoteFortressReader plugin: dfproto.EmptyMessage in, RemoteFortressReader.* out.
  GetMapInfo: {
    plugin: 'RemoteFortressReader',
    input: 'dfproto.EmptyMessage',
    output: 'RemoteFortressReader.MapInfo',
  },
  GetUnitList: {
    plugin: 'RemoteFortressReader',
    input: 'dfproto.EmptyMessage',
    output: 'RemoteFortressReader.UnitList',
  },
  GetViewInfo: {
    plugin: 'RemoteFortressReader',
    input: 'dfproto.EmptyMessage',
    output: 'RemoteFortressReader.ViewInfo',
  },
  GetWorldMapCenter: {
    plugin: 'RemoteFortressReader',
    input: 'dfproto.EmptyMessage',
    output: 'RemoteFortressReader.WorldMap',
  },
} as const satisfies Record<string, MethodDef>;

/** Names of every method in {@link METHODS}. */
export type MethodName = keyof typeof METHODS;
