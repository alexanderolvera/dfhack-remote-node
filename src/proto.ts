// proto.json loading.
//
// The compiled protobuf bundle is imported as a JSON module (not read via
// readFileSync) so the bundler inlines it into dist and there's no __dirname
// fragility. `build/proto.json` is committed and regenerated with `gen-proto`.

import protobuf from 'protobufjs';
import protoJson from '../build/proto.json' with { type: 'json' };

/**
 * Build the protobuf Root from the committed bundle, applying the runtime
 * fix-ups the DFHack wire data needs.
 */
export function loadRoot(): protobuf.Root {
  const root = protobuf.Root.fromJSON(protoJson as unknown as protobuf.INamespace);
  relaxMapBlock(root);
  return root;
}

/**
 * RFR sends MapBlock without the "required" x/y/z the old proto declared; relax
 * them so decode doesn't throw. Harmless if the fields are absent.
 */
function relaxMapBlock(root: protobuf.Root): void {
  const mapBlock = root.lookup('RemoteFortressReader.MapBlock') as protobuf.Type | null;
  if (!mapBlock?.fields) return;
  for (const name of ['mapX', 'mapY', 'mapZ']) {
    // `rule` exists on the runtime Field (field.js) but isn't on its d.ts.
    const field = mapBlock.fields[name] as (protobuf.Field & { rule?: string }) | undefined;
    if (field && field.rule === 'required') field.rule = 'optional';
  }
}
