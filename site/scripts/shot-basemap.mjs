import puppeteer from 'puppeteer-core';
const OUT='/tmp/claude-1000/-home-mstone-Source/069d8995-1ca5-4289-91b3-73a7bd0ba0f3/scratchpad/shots';
const b = await puppeteer.launch({ executablePath:'/usr/bin/google-chrome', headless:true,
  args:['--no-sandbox','--disable-dev-shm-usage','--use-gl=swiftshader','--enable-unsafe-swiftshader'] });
const p = await b.newPage();
await p.setViewport({ width: 900, height: 760 });
await p.emulateMediaFeatures([{ name:'prefers-color-scheme', value:'light' }]);
await p.goto('http://127.0.0.1:4400/', { waitUntil:'networkidle2', timeout:60000 });
await p.waitForSelector('#panel .card svg', { timeout:60000 });
await p.select('#basemap','positron');
await new Promise(r=>setTimeout(r,9000));
const mapEl = await p.$('#mapwrap');
await mapEl.screenshot({ path:`${OUT}/basemap.png` });
console.log('captured');
await b.close();
