import puppeteer from 'puppeteer-core';
const OUT='/tmp/claude-1000/-home-mstone-Source/069d8995-1ca5-4289-91b3-73a7bd0ba0f3/scratchpad/shots';
const b = await puppeteer.launch({ executablePath:'/usr/bin/google-chrome', headless:true,
  args:['--no-sandbox','--disable-dev-shm-usage'] });
const p = await b.newPage();
const errs=[]; p.on('console',m=>{if(m.type()==='error')errs.push(m.text())}); p.on('pageerror',e=>errs.push(String(e)));
await p.setViewport({ width: 1150, height: 800 });
await p.emulateMediaFeatures([{ name:'prefers-color-scheme', value:'light' }]);
await p.goto('http://127.0.0.1:4400/', { waitUntil:'networkidle2', timeout:60000 });
await p.waitForSelector('#panel .card svg', { timeout:60000 });
// overlays on, statewide
await p.click('#lyr-reservations'); await new Promise(r=>setTimeout(r,2500));
await p.click('#lyr-publiclands');  await new Promise(r=>setTimeout(r,9000));
const st = await p.evaluate(()=>({ status: document.getElementById('lyr-status').textContent,
  res: !!window.__map.map.getLayer('ov-reservations-fill'),
  pl: !!window.__map.map.getLayer('ov-publiclands-fill') }));
console.log('overlays:', JSON.stringify(st));
let m = await p.$('#mapwrap'); await m.screenshot({ path:`${OUT}/overlays.png` });
// parcel click + legend at depth
await p.evaluate(()=>window.__map.map.jumpTo({center:[-111.038,45.681], zoom:13.4}));
await new Promise(r=>setTimeout(r,7000));
const box = await p.evaluate(()=>{
  const mp=window.__map.map;
  const f=mp.queryRenderedFeatures({layers:['parcel-fill']})[0];
  if(!f) return null; window.__map.onParcel(f.properties); 
  return document.getElementById('parcelinfo').innerText.slice(0,200);
});
console.log('parcel popup:', JSON.stringify(box));
console.log('legend mode:', await p.evaluate(()=>document.getElementById('legend').dataset.mode));
console.log('legend text:', await p.evaluate(()=>document.getElementById('legend').innerText.slice(0,120)));
m = await p.$('#mapwrap'); await m.screenshot({ path:`${OUT}/parcel-detail.png` });
console.log('errors:', errs.slice(0,3));
await b.close();
