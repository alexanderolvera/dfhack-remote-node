# dfhack-remote (Node)

A Node client for the [DFHack](https://github.com/DFHack/dfhack) Remote RPC
protocol — protobuf over raw TCP (`localhost:5000`). It lets a Node process read
from (and, later, act on) a live Dwarf Fortress fort without compiling against
DFHack's C++.

This is a Node port of the original browser client
([alexchandel/dfhack-remote](https://github.com/alexchandel/dfhack-remote), ISC).
The protocol codec is carried over; the transport was rewritten from
WebSocket + `websockify` to Node `net.Socket`, `RunCommand` console output is now
captured instead of discarded, and methods bind lazily on first use.

Built primarily as the RPC layer for the DFHack MCP server.

## Setup

```sh
npm install
npm run gen-proto   # compile proto/*.proto -> build/proto.json (git-ignored)
```

`build/proto.json` is a generated artifact, so re-run `gen-proto` after a fresh
clone or when the `.proto` files change.

> ⚠️ The `.proto` files are inherited from the upstream project and predate
> Steam-era DF. Refresh them from the DFHack repo at the tag matching your
> installed version. `BindMethod` fails gracefully per method if a signature no
> longer matches, so drift is detectable at runtime.

## Usage

```js
import { DwarfClient } from 'dfhack-remote';

const df = new DwarfClient();          // defaults to 127.0.0.1:5000
await df.connect();                    // handshake

console.log(await df.getVersion());    // DFHack version string
const world = await df.getWorldInfo(); // decoded GetWorldInfoOut
console.log(world.worldName?.englishName);

// Arbitrary Lua snippet; returns whatever it prints (captured console output):
const text = await df.runLuaSnippet('print(#df.global.world.units.active)');

// Any bound method by name:
const map = await df.call('GetMapInfo');

df.close();
```

Every reply object also carries `_text` — the concatenated console output from
any TEXT frames the call produced.

## Tests

```sh
npm test        # offline: mock server speaks the real wire format, no game needed
npm run spike   # live: connect to a running fort, print version + world + fort name
```

`npm test` validates handshake, framing, lazy binding, protobuf round-trip, and
TEXT-frame capture against an in-process mock. `npm run spike` (M0) requires
Dwarf Fortress running with DFHack and a fort loaded.

## Protocol notes

- Handshake: client sends `DFHack?\n` + `i32(1)`, server replies `DFHack!\n` + `i32(1)`.
- Message header: `id:i16, pad:u16, size:i32` (little-endian), then `size` body bytes.
- A call's reply is zero or more `TEXT` frames (console output) followed by one
  `RESULT` frame (reply protobuf) or one `FAIL` frame (errno in the size field).
- Calls are serialized — DFHack handles one at a time per socket.
- `GetBlockList` only returns blocks *changed since the last call* — don't build a
  full-map snapshot on it naively (use `ResetMapHashes` to force a resend).
