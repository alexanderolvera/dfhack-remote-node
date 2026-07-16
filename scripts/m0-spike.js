// M0 spike: prove the pipe end-to-end against a live fort.
//
// Connects to DFHack Remote RPC on localhost:5000, then prints:
//   1. DFHack version + DF version        (protobuf reply decode works)
//   2. world name / mode / save dir       (GetWorldInfo decode works)
//   3. fort (site) name via a Lua snippet (RunCommand + TEXT capture works)
//
// Requires Dwarf Fortress running with DFHack and a fort loaded.
// Run: npm run spike

import { DwarfClient } from '../src/index.ts';

// Robustly fetch the current fortress site name, or 'unknown'.
// dfhack.translation.translateName is the current API (was dfhack.TranslateName
// in older DFHack); passed as one chunk because `lua -e` isn't accepted over RPC.
const FORT_NAME_LUA =
  'local ok, name = pcall(function() ' +
  'return dfhack.translation.translateName(df.global.world.world_data.active_site[0].name, true) ' +
  'end) print(ok and name or "unknown")';

async function main() {
  const df = new DwarfClient();

  try {
    await df.connect();
    console.log('handshake: OK (connected to DFHack on 127.0.0.1:5000)\n');
  } catch (err) {
    console.error('Could not connect. Is DF running with DFHack, and a fort loaded?');
    console.error(`  ${err.message}`);
    process.exitCode = 1;
    return;
  }

  try {
    const dfhackVersion = await df.getVersion();
    const dfVersion = await df.getDFVersion();
    console.log(`DFHack version : ${dfhackVersion}`);
    console.log(`DF version     : ${dfVersion}`);

    const world = await df.getWorldInfo();
    console.log(`\nworld name     : ${world.worldName?.englishName ?? '(none)'}`);
    console.log(`mode           : ${world.mode ?? '(unknown)'}`);
    console.log(`save dir       : ${world.saveDir ?? '(none)'}`);

    const fortName = (await df.runLuaSnippet(FORT_NAME_LUA)).trim();
    console.log(`\nfort name      : ${fortName || '(empty — RunCommand returned no text)'}`);

    console.log('\nM0 pipe proven.');
  } catch (err) {
    console.error(`\nCall failed: ${err.message}`);
    process.exitCode = 1;
  } finally {
    df.close();
  }
}

main();
