import puppeteer from 'puppeteer-core';
const OUT='/tmp/claude-1000/-home-mstone-Source/069d8995-1ca5-4289-91b3-73a7bd0ba0f3/scratchpad/shots';
const b = await puppeteer.launch({ executablePath:'/usr/bin/google-chrome', headless:true,
  args:['--no-sandbox','--disable-dev-shm-usage'] });
const p = await b.newPage();
const errs=[]; p.on('console',m=>{if(m.type()==='error')errs.push(m.text())}); p.on('pageerror',e=>errs.push(String(e)));
await p.setViewport({ width: 1100, height: 820 });
await p.emulateMediaFeatures([{ name:'prefers-color-scheme', value:'light' }]);
await p.goto('http://127.0.0.1:4400/', { waitUntil:'networkidle2', timeout:60000 });
await p.waitForSelector('#panel .card svg', { timeout:60000 });
const shots = [
  ['z9-townships',  [-111.035,45.68],  9.0],
  ['z11-parcels',   [-111.035,45.68], 11.2],
  ['z13-parcels',   [-111.045,45.68], 13.2],
];
for (const [name, center, zoom] of shots) {
  await p.evaluate((c,z)=>window.__map.map.jumpTo({center:c, zoom:z}), center, zoom);
  await new Promise(r=>setTimeout(r,7000));
  const m = await p.$('#mapwrap');
  await m.screenshot({ path: `${OUT}/${name}.png` });
  const info = await p.evaluate(()=>{
    const mp = window.__map.map;
    return { zoom: +mp.getZoom().toFixed(1),
             parcels: mp.queryRenderedFeatures({layers:['parcel-fill']}).length };
  });
  console.log(name, JSON.stringify(info));
}
console.log('errors:', errs.slice(0,3));
await b.close();
