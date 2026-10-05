import puppeteer from 'puppeteer-core';
const b = await puppeteer.launch({ executablePath:'/usr/bin/google-chrome', headless:true,
  args:['--no-sandbox','--disable-dev-shm-usage'] });
const p = await b.newPage();
p.on('console', m => console.log(`[${m.type()}]`, m.text()));
p.on('pageerror', e => console.log('[pageerror]', e.message));
p.on('requestfailed', r => console.log('[reqfail]', r.url(), r.failure()?.errorText));
await p.goto('http://127.0.0.1:4400/', { waitUntil:'networkidle2', timeout:45000 });
await new Promise(r=>setTimeout(r,6000));
const st = await p.evaluate(() => ({
  appHidden: document.getElementById('app')?.hidden,
  boot: !!document.getElementById('boot'),
  panelHTML: (document.getElementById('panel')?.innerHTML || '').slice(0,600),
  nav: document.querySelectorAll('#nav button').length,
  legend: (document.getElementById('legend')?.innerHTML||'').slice(0,160),
}));
console.log(JSON.stringify(st,null,1));
await b.close();
