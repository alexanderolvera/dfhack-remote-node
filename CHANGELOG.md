# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- `DwarfClient` no longer reuses method ids bound on a dead connection. DFHack's
  `RemoteServer` builds its RPC function table per connection, so the id
  `BindMethod` assigns is only valid on the socket it was bound on. The cache is
  now keyed on a connection generation that `DfConnection` bumps on every
  teardown, so after a socket death or an explicit `close()` the next call
  re-binds instead of addressing a stale id on the new connection.

  Measured against DFHack 53.17-r1: plugin methods (RemoteFortressReader and
  friends) were the ones that broke, failing with `RPC call of invalid id N`
  once reused on a new connection. Core method ids are served from a static
  table and answer even unbound, which is why core-only callers never saw this.

### Added

- `npm run test:live` (`scripts/live-rebind-test.js`): a live interop harness
  that proxies `DwarfClient` through a recording TCP proxy to a running DFHack,
  so the method ids on the wire — and the re-bind after a socket death — can be
  checked against the real server. Not part of `npm test`; it needs DF running
  with a loaded fort.

## [2.0.1] - 2026-08-09

### Fixed

- `engines.node` now declares `>=20` rather than `>=18`. `dist/` is compiled
  for node20, so the old range advertised support for runtimes the package was
  never built against.

### Documentation

- README states the Node 20 runtime floor, and separately the Node 24 needed to
  develop on a clone (the tests run the TypeScript sources directly, which needs
  type-stripping and JSON import attributes from Node 23.6+).

## [2.0.0] - 2026-07-16

Forked from [alexchandel/dfhack-remote](https://github.com/alexchandel/dfhack-remote)
and rewritten as a maintained Node library.

### Changed

- Rewritten in TypeScript with a `tsup` dist build. Transport swapped from
  WebSocket/websockify to Node `net.Socket`. Per-method lazy binding.
- TEXT frames surfaced as `{ result, text }` per call and attached to
  `RpcError.text` (carries DFHack Lua stack traces).
- Protocol definitions pinned to **DFHack 53.15-r2**. The method table uses
  fully-qualified protobuf type names, so a method's input and output may live in
  different packages — fixes RemoteFortressReader getters (`GetMapInfo`,
  `GetUnitList`, `GetWorldMapCenter`), which take `dfproto.EmptyMessage` and
  return `RemoteFortressReader.*`.

### Added

- `build/proto.json` is committed (runtime-required; consumers need no build
  step). Regenerate with `npm run gen-proto` after editing any `proto/*.proto`.

[Unreleased]: https://github.com/alexanderolvera/dfhack-remote-node/compare/v2.0.1...HEAD
[2.0.1]: https://github.com/alexanderolvera/dfhack-remote-node/compare/v2.0.0...v2.0.1
[2.0.0]: https://github.com/alexanderolvera/dfhack-remote-node/releases/tag/v2.0.0
