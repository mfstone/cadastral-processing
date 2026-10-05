import puppeteer from 'puppeteer-core';
const b = await puppeteer.launch({ executablePath:'/usr/bin/google-chrome', headless:true,
  args:['--no-sandbox','--disable-dev-shm-usage'] });
const p = await b.newPage();
await p.setViewport({ width: 760, height: 1500, deviceScaleFactor: 1 });
await p.emulateMediaFeatures([{ name:'prefers-color-scheme', value:'light' }]);
await p.goto('http://127.0.0.1:4400/', { waitUntil:'networkidle2', timeout:60000 });
await p.waitForSelector('#panel .card svg', { timeout:60000 });
await p.evaluate(()=>document.querySelectorAll('#nav button')[1].click());
await new Promise(r=>setTimeout(r,3000));
const el = await p.evaluateHandle(()=> [...document.querySelectorAll('#panel .card')]
  .find(c=>/checkerboard/i.test(c.textContent)));
await el.asElement().screenshot({ path:'/tmp/claude-1000/-home-mstone-Source/069d8995-1ca5-4289-91b3-73a7bd0ba0f3/scratchpad/shots/checkerboard.png' });
await b.close(); console.log('ok');
