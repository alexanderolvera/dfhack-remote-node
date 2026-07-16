# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/alexanderolvera/dfhack-remote-node/compare/v2.0.0...HEAD
[2.0.0]: https://github.com/alexanderolvera/dfhack-remote-node/releases/tag/v2.0.0
