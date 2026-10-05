// Validate the palette as the BROWSER computes it, not as the CSS source reads
// -- this catches a token that failed to override, a typo'd hex, or a dark
// block that never applied.
import puppeteer from 'puppeteer-core';
import { validate, validateOrdinal, contrast } from
  '/tmp/claude-1000/bundled-skills/2.1.261/a3c746be03abede669cf2b5d21dc6c67/dataviz/scripts/validate_palette.js';
const b = await puppeteer.launch({ executablePath:'/usr/bin/google-chrome', headless:true, args:['--no-sandbox'] });
let bad = 0;
for (const mode of ['light','dark']) {
  const p = await b.newPage();
  await p.emulateMediaFeatures([{name:'prefers-color-scheme',value:mode}]);
  await p.goto('http://127.0.0.1:4400/',{waitUntil:'domcontentloaded',timeout:60000});
  const T = await p.evaluate(() => {
    const g = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
    const many = (p,n) => Array.from({length:n},(_,i)=>g(`--${p}-${i+1}`));
    return { cat: many('cat',3), seq: many('seq',8), ord5: many('ord5',5), ord3: many('ord3',3),
             surface: g('--surface-1'), page: g('--page'), ink1: g('--ink-1'),
             ink2: g('--ink-2'), inkm: g('--ink-muted'), ui: g('--ui'), uiInk: g('--ui-ink'),
             statute: g('--statute') };
  });
  console.log(`\n--- ${mode} (surface ${T.surface}) ---`);
  const run = (label, fn) => {
    const { report, ok } = fn();
    if (!ok) bad++;
    console.log(`  ${ok?'PASS':'FAIL'}  ${label}`);
    for (const [n,st,d] of report) if (st!==true && st!=='pass') console.log(`        ${st==='fail'||st===false?'FAIL':'WARN'} ${n}: ${d}`);
  };
  run('categorical (tenure)', () => validate(T.cat,{mode,surface:T.surface,pairs:'all'}));
  for (const k of ['seq','ord5','ord3'])
    run(`ordinal ${k}`, () => validateOrdinal(T[k],{mode,surface:T.surface}));
  const texts = [['ink-1',T.ink1],['ink-2',T.ink2],['ink-muted',T.inkm]];
  for (const [n,c] of texts) {
    const r = Math.min(contrast(c,T.surface), contrast(c,T.page));
    if (r < 4.5) { bad++; console.log(`  FAIL  text ${n} ${r.toFixed(2)}:1 (needs 4.5)`); }
    else console.log(`  PASS  text ${n} ${r.toFixed(2)}:1`);
  }
  const btn = contrast(T.uiInk, T.ui);
  console.log(`  ${btn>=4.5?'PASS':'FAIL'}  selected tab ${btn.toFixed(2)}:1`); if (btn<4.5) bad++;
  const st = contrast(T.statute, T.surface);
  console.log(`  ${st>=3?'PASS':'FAIL'}  statute line ${st.toFixed(2)}:1`); if (st<3) bad++;
  await p.close();
}
await b.close();
console.log(bad ? `\n${bad} check(s) failed` : '\nAll palette checks pass');
process.exit(bad ? 1 : 0);
