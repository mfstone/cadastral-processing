import puppeteer from 'puppeteer-core';
const OUT='/tmp/claude-1000/-home-mstone-Source/069d8995-1ca5-4289-91b3-73a7bd0ba0f3/scratchpad/shots';
const b = await puppeteer.launch({ executablePath:'/usr/bin/google-chrome', headless:true,
  args:['--no-sandbox','--disable-dev-shm-usage'] });
const p = await b.newPage();
await p.setViewport({ width: 1500, height: 940 });
await p.emulateMediaFeatures([{ name:'prefers-color-scheme', value:'light' }]);
await p.goto('http://127.0.0.1:4400/', { waitUntil:'networkidle2', timeout:60000 });
await p.waitForSelector('#panel .card svg', { timeout:60000 });
// jump to 2009-07-05 (index 10)
await p.evaluate(()=>{ const s=document.getElementById('snap'); s.value='10';
  s.dispatchEvent(new Event('input',{bubbles:true})); s.dispatchEvent(new Event('change',{bubbles:true})); });
await new Promise(r=>setTimeout(r,3000));
const st = await p.evaluate(()=>({
  label: document.getElementById('snaplabel').textContent,
  warn: !document.getElementById('snapwarn').hidden,
  legend: document.getElementById('legend').innerText.slice(0,180),
  firstCard: document.querySelector('#panel .card h3')?.textContent,
}));
console.log(JSON.stringify(st,null,1));
await p.screenshot({ path:`${OUT}/2009-ladder.png` });
// and the neighbouring good snapshot
await p.evaluate(()=>{ const s=document.getElementById('snap'); s.value='9';
  s.dispatchEvent(new Event('input',{bubbles:true})); s.dispatchEvent(new Event('change',{bubbles:true})); });
await new Promise(r=>setTimeout(r,3000));
const st2 = await p.evaluate(()=>({ label: document.getElementById('snaplabel').textContent,
  warn: !document.getElementById('snapwarn').hidden,
  firstCard: document.querySelector('#panel .card h3')?.textContent }));
console.log('neighbour:', JSON.stringify(st2));
await b.close();
