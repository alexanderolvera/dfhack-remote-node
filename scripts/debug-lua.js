// Confirm stress-category direction: category vs raw stress value.
import { DwarfClient } from '../src/index.js';
const df = new DwarfClient();
await df.connect();
const snip =
  'for _,u in ipairs(dfhack.units.getCitizens(true)) do ' +
  'local s=u.status.current_soul and u.status.current_soul.personality.stress or 0 ' +
  'print(dfhack.units.getStressCategory(u).." stress="..s) end';
const out = await df.runLuaSnippet(snip);
const seen = {};
for (const line of out.trim().split('\n')) {
  const c = line[0];
  if (!seen[c]) seen[c] = line;
}
console.log('one sample per category (cat stress=value):');
console.log(Object.keys(seen).sort().map((k) => '  ' + seen[k]).join('\n'));
df.close();
