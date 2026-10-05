import puppeteer from 'puppeteer-core';
const URL = process.env.SMOKE_URL || 'http://127.0.0.1:4400';
const OUT = process.env.SHOT_DIR || '/tmp/claude-1000/-home-mstone-Source/069d8995-1ca5-4289-91b3-73a7bd0ba0f3/scratchpad/shots';
import { mkdirSync } from 'fs';
mkdirSync(OUT, { recursive: true });
const b = await puppeteer.launch({ executablePath:'/usr/bin/google-chrome', headless:true,
  args:['--no-sandbox','--disable-dev-shm-usage','--force-color-profile=srgb'] });
const p = await b.newPage();
await p.setViewport({ width: 1500, height: 980, deviceScaleFactor: 1 });
await p.emulateMediaFeatures([{ name:'prefers-color-scheme', value:'light' }]);
await p.goto(URL, { waitUntil:'networkidle2', timeout:60000 });
await p.waitForSelector('#panel .card svg', { timeout:60000 });
await new Promise(r=>setTimeout(r,2500));
const names = await p.$$eval('#nav button', bs=>bs.map(b=>b.textContent.trim()));
for (let i=0;i<names.length;i++){
  await p.evaluate(n=>document.querySelectorAll('#nav button')[n].click(), i);
  await new Promise(r=>setTimeout(r,2600));
  await p.screenshot({ path:`${OUT}/${i}-${names[i].toLowerCase()}.png` });
  // overflow + collision probe
  const diag = await p.evaluate(()=>{
    const bodyOverflow = document.documentElement.scrollWidth > window.innerWidth + 1;
    const panel = document.getElementById('panel');
    const cards = [...panel.querySelectorAll('.card')];
    const texts = [...panel.querySelectorAll('svg text')];
    // crude overlap check on axis labels within each svg
    let collisions = 0;
    const bySvg = new Map();
    for (const t of texts){ const s=t.ownerSVGElement; if(!bySvg.has(s)) bySvg.set(s,[]); bySvg.get(s).push(t); }
    for (const [,arr] of bySvg){
      for (let a=0;a<arr.length;a++) for (let c=a+1;c<arr.length;c++){
        const r1=arr[a].getBoundingClientRect(), r2=arr[c].getBoundingClientRect();
        if (!r1.width||!r2.width) continue;
        if (r1.left<r2.right-1 && r2.left<r1.right-1 && r1.top<r2.bottom-1 && r2.top<r1.bottom-1) collisions++;
      }
    }
    const overflowing = cards.filter(c=>c.scrollWidth>c.clientWidth+1).length;
    return { bodyOverflow, cards: cards.length, collisions, overflowing,
             emptyText: texts.filter(t=>!t.textContent.trim()).length };
  });
  console.log(`${names[i]}:`, JSON.stringify(diag));
}
// dark mode
await p.emulateMediaFeatures([{ name:'prefers-color-scheme', value:'dark' }]);
await p.evaluate(()=>document.querySelectorAll('#nav button')[0].click());
await new Promise(r=>setTimeout(r,2600));
await p.screenshot({ path:`${OUT}/dark.png` });
await b.close();
console.log('shots in', OUT);
