// Find the correct name-translation API + fort name in this DFHack version.
import { DwarfClient } from '../src/index.js';

const probes = [
  ['translation module exists', 'print(type(dfhack.translation))'],
  ['translateName fn', 'print(type(dfhack.translation and dfhack.translation.translateName))'],
  ['old TranslateName', 'print(type(dfhack.TranslateName))'],
  ['active_site name via translation',
    'local s=df.global.world.world_data.active_site[0] print(dfhack.translation.translateName(s.name, true))'],
  ['fortress entity name',
    'local e=df.global.plotinfo.main.fortress_entity print(e and dfhack.translation.translateName(e.name, true) or "no entity")'],
];

const df = new DwarfClient();
await df.connect();
for (const [label, snippet] of probes) {
  try {
    const out = await df.runCommand('lua', [snippet]);
    console.log(`OK   ${label}: ${JSON.stringify(out.trim())}`);
  } catch (err) {
    console.log(`FAIL ${label}: ${err.message.split('\n')[0]}`);
  }
}
df.close();
