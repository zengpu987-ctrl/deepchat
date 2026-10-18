import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';
const CHROME=process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ROOT=new URL('.', import.meta.url).pathname;
mkdirSync(ROOT+'/build',{recursive:true});
const browser=await chromium.launch({executablePath:CHROME,headless:true,args:['--no-first-run','--no-default-browser-check','--disable-gpu','--font-render-hinting=none']});
const page=await browser.newPage();
await page.goto('file://'+ROOT+'/paper.html',{waitUntil:'load',timeout:120000});
await page.emulateMedia({media:'print'});
await page.evaluate(async()=>{ await document.fonts.ready; await new Promise(r=>setTimeout(r,300)); });
const header=`<div style="width:100%;font-family:Helvetica,Arial,sans-serif;font-size:6.8px;color:#666;padding:0 16mm;display:flex;justify-content:space-between;align-items:flex-end;">
<span style="letter-spacing:.08em;text-transform:uppercase;">NATURE | ARTICLE</span><span>DeepChat · model-synchronising local chat</span></div>`;
const footer=`<div style="width:100%;font-family:Helvetica,Arial,sans-serif;font-size:6.8px;color:#666;padding:0 16mm;display:flex;justify-content:space-between;">
<span>Preprint · not peer reviewed · CC BY 4.0</span><span><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>`;
await page.pdf({path:ROOT+'/build/DeepChat-Nature-Bilingual.pdf',format:'A4',printBackground:true,displayHeaderFooter:true,headerTemplate:header,footerTemplate:footer,margin:{top:'20mm',bottom:'16mm',left:'16mm',right:'16mm'},preferCSSPageSize:false});
console.log('pdf written');
await browser.close();
