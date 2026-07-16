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
```

`build/proto.json` (the compiled protobuf bundle the client loads at runtime) is
committed, so a fresh clone works immediately. After editing any `proto/*.proto`,
regenerate it with `npm run gen-proto`.

> The `.proto` files are pinned to **DFHack `53.15-r2`** (pulled from
> [DFHack/dfhack](https://github.com/DFHack/dfhack) at the commit the running
> build reports via `getGitDescription`). To retarget another version, replace
> the files from the matching tag and re-run `gen-proto`. Method input/output
> types in `METHODS` (src/client.js) are fully-qualified names that must match
> DFHack's registration, or `BindMethod` reports a "wrong signature" at runtime —
> which makes drift detectable per method.

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
