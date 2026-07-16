import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  outDir: 'dist',
  format: ['esm'],
  target: 'node20',
  platform: 'node',
  dts: true,
  clean: true,
  sourcemap: true,
  // Bundle so the `../build/proto.json` module import is inlined into dist and
  // there is no runtime file lookup. protobufjs stays external (a dependency).
  bundle: true,
  external: ['protobufjs'],
  // Allow the explicit `.ts` extensions our source uses under Node type-stripping.
  loader: { '.json': 'json' },
});
