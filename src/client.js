// High-level DFHack client: protobuf (de)serialization + lazy method binding.
//
// Differences from the original browser lib.js:
//   * transport is Node TCP (see connection.js), not WebSocket/websockify
//   * methods bind lazily on first call, not all ~50 eagerly at connect
//   * TEXT console output is surfaced (was discarded) — every call returns
//     { ...decodedReply, _text } and RunCommand returns the text directly

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import protobuf from 'protobufjs';
import { DfConnection } from './connection.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROTO_JSON = join(__dirname, '..', 'build', 'proto.json');

// method name -> { plugin, input, output }. plugin=null for core methods.
// input/output are FULLY-QUALIFIED protobuf type names (with package), because a
// method's input and output can live in different packages — e.g. RFR methods
// take a dfproto.EmptyMessage but return a RemoteFortressReader.* message. This
// is exactly the full name DFHack matches during BindMethod, so a mismatch here
// surfaces as "Requested wrong signature for RPC method".
// Ported from FUNC_DEFS in the original lib.js; extend as tools need methods.
const METHODS = {
  // core (dfproto package)
  BindMethod:   { plugin: null, input: 'dfproto.CoreBindRequest', output: 'dfproto.CoreBindReply' },
  RunCommand:   { plugin: null, input: 'dfproto.CoreRunCommandRequest', output: 'dfproto.EmptyMessage' },
  RunLua:       { plugin: null, input: 'dfproto.CoreRunLuaRequest', output: 'dfproto.StringListMessage' },
  GetVersion:   { plugin: null, input: 'dfproto.EmptyMessage', output: 'dfproto.StringMessage' },
  GetDFVersion: { plugin: null, input: 'dfproto.EmptyMessage', output: 'dfproto.StringMessage' },
  GetWorldInfo: { plugin: null, input: 'dfproto.EmptyMessage', output: 'dfproto.GetWorldInfoOut' },
  ListUnits:    { plugin: null, input: 'dfproto.ListUnitsIn', output: 'dfproto.ListUnitsOut' },
  ListSquads:   { plugin: null, input: 'dfproto.ListSquadsIn', output: 'dfproto.ListSquadsOut' },

  // RemoteFortressReader plugin: dfproto.EmptyMessage in, RemoteFortressReader.* out.
  GetMapInfo:   { plugin: 'RemoteFortressReader', input: 'dfproto.EmptyMessage', output: 'RemoteFortressReader.MapInfo' },
  GetUnitList:  { plugin: 'RemoteFortressReader', input: 'dfproto.EmptyMessage', output: 'RemoteFortressReader.UnitList' },
  GetViewInfo:  { plugin: 'RemoteFortressReader', input: 'dfproto.EmptyMessage', output: 'RemoteFortressReader.ViewInfo' },
  GetWorldMapCenter: { plugin: 'RemoteFortressReader', input: 'dfproto.EmptyMessage', output: 'RemoteFortressReader.WorldMap' },
};

export class DwarfClient {
  constructor({ host, port } = {}) {
    this._root = protobuf.Root.fromJSON(JSON.parse(readFileSync(PROTO_JSON, 'utf8')));
    this._sanitizeProtos();

    this._TextNotification = this._root.lookupType('dfproto.CoreTextNotification');
    this._conn = new DfConnection({
      host,
      port,
      textDecoder: (body) => this._decodeText(body),
    });
    this._boundIds = new Map(); // method name -> runtime id (or null if unbindable)
  }

  /** RFR sends MapBlock without the "required" x/y/z the old proto declared;
   *  relax them so decode doesn't throw. Harmless if the fields are absent. */
  _sanitizeProtos() {
    const mapBlock = this._root.lookup('RemoteFortressReader.MapBlock');
    if (mapBlock?.fields) {
      for (const name of ['mapX', 'mapY', 'mapZ']) {
        const f = mapBlock.fields[name];
        if (f && f.rule === 'required') f.rule = 'optional';
      }
    }
  }

  _decodeText(body) {
    try {
      const msg = this._TextNotification.decode(body);
      const obj = this._TextNotification.toObject(msg, { defaults: true });
      return (obj.fragments ?? []).map((f) => f.text ?? '').join('');
    } catch {
      return body.toString('utf8');
    }
  }

  /** True once connected and past the handshake. */
  get connected() {
    return this._conn.connected;
  }

  async connect() {
    await this._conn.connect();
    return this;
  }

  close() {
    this._conn.close();
  }

  /** Resolve (and cache) a method's runtime id via BindMethod. */
  async _bind(name) {
    if (this._boundIds.has(name)) return this._boundIds.get(name);
    const def = METHODS[name];
    if (!def) throw new Error(`unknown method ${name}`);

    const BindReq = this._root.lookupType('dfproto.CoreBindRequest');
    const BindReply = this._root.lookupType('dfproto.CoreBindReply');
    const reqBody = BindReq.encode(
      BindReq.create({
        method: name,
        inputMsg: def.input,
        outputMsg: def.output,
        plugin: def.plugin ?? undefined,
      })
    ).finish();

    // BindMethod itself is always method id 0.
    const { result } = await this._conn.call(0, reqBody);
    const reply = BindReply.toObject(BindReply.decode(result));
    const id = reply.assignedId ?? null;
    this._boundIds.set(name, id);
    return id;
  }

  /** Call a bound method by name; returns the decoded reply with `_text` attached. */
  async call(name, input = {}) {
    const def = METHODS[name];
    if (!def) throw new Error(`unknown method ${name}`);
    const id = await this._bind(name);
    if (id == null) throw new Error(`method ${name} is not available on this DFHack`);

    const InputType = this._root.lookupType(def.input);
    const OutputType = this._root.lookupType(def.output);
    const body = InputType.encode(InputType.create(input)).finish();

    const { result, text } = await this._conn.call(id, body);
    const out = OutputType.toObject(OutputType.decode(result), {
      longs: Number,
      enums: String,
      defaults: false,
    });
    out._text = text;
    return out;
  }

  // Convenience wrappers for the methods M0/M1 need.
  async getVersion() {
    return (await this.call('GetVersion')).value ?? '';
  }
  async getDFVersion() {
    return (await this.call('GetDFVersion')).value ?? '';
  }
  async getWorldInfo() {
    return this.call('GetWorldInfo');
  }
  /** Run a DFHack command; returns its console (TEXT) output as a string. */
  async runCommand(command, args = []) {
    const out = await this.call('RunCommand', { command, arguments: args });
    return out._text ?? '';
  }
  /**
   * Run an arbitrary Lua snippet and return whatever it prints.
   * The DFHack `lua` command joins its arguments and runs them as a chunk (the
   * console-only `-e` flag is NOT accepted over RPC — it gets parsed as code),
   * so the snippet is passed as the argument directly. Console output is
   * captured via TEXT frames. This is the workhorse for semantic tools:
   * the snippet builds JSON and prints it.
   */
  async runLuaSnippet(snippet) {
    return this.runCommand('lua', [snippet]);
  }
  /**
   * Invoke a named Lua function via the core RunLua RPC:
   * `module.function(...args)`. Returns the function's string-list result.
   * (Distinct from runLuaSnippet: this calls an existing function, not code.)
   */
  async callLua(module, fn, args = []) {
    const out = await this.call('RunLua', { module, function: fn, arguments: args });
    return out.value ?? [];
  }
}

export { METHODS };
