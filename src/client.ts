// High-level DFHack client: protobuf (de)serialization + lazy method binding.
//
// Differences from the original browser lib.js:
//   * transport is Node TCP (see connection.ts), not WebSocket/websockify
//   * methods bind lazily on first call, not all ~50 eagerly at connect
//   * TEXT console output is surfaced (was discarded) — every call returns
//     { ...decodedReply, _text } and RunCommand returns the text directly

import type protobuf from 'protobufjs';
import { DfConnection } from './connection.ts';
import { METHODS } from './methods.ts';
import type { MethodName } from './methods.ts';
import { loadRoot } from './proto.ts';

/** Any decoded reply carries the call's captured console output on `_text`. */
export interface DecodedReply {
  _text: string;
  [key: string]: unknown;
}

/** A DFHack translated-name sub-message (as decoded by protobufjs). */
export interface NameInfo {
  englishName?: string;
  [key: string]: unknown;
}

/** Decoded `dfproto.GetWorldInfoOut`. */
export interface GetWorldInfoReply extends DecodedReply {
  mode?: number;
  worldName?: NameInfo;
  saveDir?: string;
}

export interface DwarfClientOptions {
  host?: string;
  port?: number;
}

export class DwarfClient {
  private readonly root: protobuf.Root;
  private readonly conn: DfConnection;
  private readonly textNotification: protobuf.Type;
  private readonly boundIds = new Map<MethodName, number | null>();

  constructor({ host, port }: DwarfClientOptions = {}) {
    this.root = loadRoot();
    this.textNotification = this.root.lookupType('dfproto.CoreTextNotification');
    this.conn = new DfConnection({ host, port, textDecoder: (body) => this.decodeText(body) });
  }

  private decodeText(body: Buffer): string {
    try {
      const msg = this.textNotification.decode(body);
      const obj = this.textNotification.toObject(msg, { defaults: true }) as {
        fragments?: { text?: string }[];
      };
      return (obj.fragments ?? []).map((f) => f.text ?? '').join('');
    } catch {
      return body.toString('utf8');
    }
  }

  /** True once connected and past the handshake. */
  get connected(): boolean {
    return this.conn.connected;
  }

  async connect(): Promise<this> {
    await this.conn.connect();
    return this;
  }

  close(): void {
    this.conn.close();
  }

  /** Resolve (and cache) a method's runtime id via BindMethod. */
  private async bind(name: MethodName): Promise<number | null> {
    const cached = this.boundIds.get(name);
    if (cached !== undefined) return cached;
    const def = METHODS[name];

    const BindReq = this.root.lookupType('dfproto.CoreBindRequest');
    const BindReply = this.root.lookupType('dfproto.CoreBindReply');
    const reqBody = BindReq.encode(
      BindReq.create({
        method: name,
        inputMsg: def.input,
        outputMsg: def.output,
        plugin: def.plugin ?? undefined,
      })
    ).finish();

    // BindMethod itself is always method id 0.
    const { result } = await this.conn.call(0, reqBody);
    const reply = BindReply.toObject(BindReply.decode(result)) as { assignedId?: number };
    const id = reply.assignedId ?? null;
    this.boundIds.set(name, id);
    return id;
  }

  /** Call a bound method by name; returns the decoded reply with `_text` attached. */
  async call(name: MethodName, input: Record<string, unknown> = {}): Promise<DecodedReply> {
    const def = METHODS[name];
    const id = await this.bind(name);
    if (id == null) throw new Error(`method ${name} is not available on this DFHack`);

    const InputType = this.root.lookupType(def.input);
    const OutputType = this.root.lookupType(def.output);
    const body = InputType.encode(InputType.create(input)).finish();

    const { result, text } = await this.conn.call(id, body);
    const out = OutputType.toObject(OutputType.decode(result), {
      longs: Number,
      enums: String,
      defaults: false,
    }) as DecodedReply;
    out._text = text;
    return out;
  }

  // Convenience wrappers for common methods.
  async getVersion(): Promise<string> {
    return ((await this.call('GetVersion')).value as string | undefined) ?? '';
  }

  async getDFVersion(): Promise<string> {
    return ((await this.call('GetDFVersion')).value as string | undefined) ?? '';
  }

  async getWorldInfo(): Promise<GetWorldInfoReply> {
    return (await this.call('GetWorldInfo')) as GetWorldInfoReply;
  }

  /** Run a DFHack command; returns its console (TEXT) output as a string. */
  async runCommand(command: string, args: string[] = []): Promise<string> {
    const out = await this.call('RunCommand', { command, arguments: args });
    return out._text ?? '';
  }

  /**
   * Run an arbitrary Lua snippet and return whatever it prints.
   * The DFHack `lua` command joins its arguments and runs them as a chunk (the
   * console-only `-e` flag is NOT accepted over RPC — it gets parsed as code),
   * so the snippet is passed as the argument directly. Console output is captured
   * via TEXT frames. This is the workhorse for semantic tools: the snippet builds
   * JSON and prints it.
   */
  async runLuaSnippet(snippet: string): Promise<string> {
    return this.runCommand('lua', [snippet]);
  }

  /**
   * Invoke a named Lua function via the core RunLua RPC: `module.function(...args)`.
   * Returns the function's string-list result. (Distinct from runLuaSnippet: this
   * calls an existing function, not code.)
   */
  async callLua(module: string, fn: string, args: string[] = []): Promise<string[]> {
    const out = await this.call('RunLua', { module, function: fn, arguments: args });
    return (out.value as string[] | undefined) ?? [];
  }
}
