import { readFile, writeFile } from 'node:fs/promises';
import sharp from 'sharp';
import { parse } from 'dotenv';
const planFile='data/collection/extra-covers/plan.json';
const plan=JSON.parse(await readFile(planFile,'utf8'));
const manifest=JSON.parse(await readFile('data/collection/manifest.json','utf8'));
const config=parse(await readFile('.env','utf8'));
const escape=s=>s.replace(/[<>&"]/g,c=>({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[c]));
for (const row of plan) {
 if(row.draw) {
  const wheel=/wheel/i.test(row.name), plate=/plate/i.test(row.name), smoke=/smoke/i.test(row.name);
  const symbol=wheel ? '<circle cx="0" cy="0" r="108"/><circle cx="0" cy="0" r="76"/><circle cx="0" cy="0" r="18"/>'+Array.from({length:5},(_,i)=>`<path transform="rotate(${i*72})" d="M-9 -25L-22 -69L22 -69L9 -25Z"/>`).join('') : plate ? '<rect x="-158" y="-75" width="316" height="150" rx="12"/><path d="M-112 24h224M-112 -24h224"/>' : smoke ? '<path d="M-140 50C-40 80 -40 -10 30 0S130 -55 65 -80M-100 85C-20 100 15 45 80 65S170 10 120 -30"/>' : '<path d="M-105 -80h210v160h-210Z M-60 -35h120M-60 0h90M-60 35h105"/>';
  let lines=[],line='';for(const word of row.name.split(' ')){if((line+' '+word).trim().length>33){lines.push(line);line=word;}else line=(line+' '+word).trim();}if(line)lines.push(line);
  const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="675"><rect width="1200" height="675" fill="#151517"/><g transform="translate(600 220)" stroke="#d8d8db" fill="none" stroke-width="8" stroke-linejoin="round" stroke-linecap="round">${symbol}</g><g fill="#f1f1f2" text-anchor="middle" font-family="Segoe UI,Arial" font-size="46" font-weight="600">${lines.map((v,i)=>`<text x="600" y="${440+i*58}">${escape(v)}</text>`).join('')}</g>${row.creator&&row.creator!=='Unknown'?`<text x="600" y="${440+lines.length*58+18}" text-anchor="middle" fill="#aaaab1" font-size="26" font-family="Segoe UI,Arial">${escape(row.creator)}</text>`:''}</svg>`;
  await sharp(Buffer.from(svg)).jpeg({quality:90}).toFile(row.picture);
 }
 const bytes=await sharp(await readFile(row.picture)).resize(1200,675,{fit:'contain',background:'#151517'}).jpeg({quality:88}).toBuffer();
 await writeFile(row.picture,bytes);const image=await sharp(bytes).metadata();
 const item=manifest.items.find(x=>x.filename===row.filename);
 const r=await fetch('https://team-razka-program.team-razka-program.workers.dev/api/v1/publish/thumbnail',{method:'POST',headers:{authorization:`Bearer ${config.PUBLISH_CALLBACK_SECRET}`,'content-type':'application/json'},body:JSON.stringify({ownerId:config.ADMIN_DISCORD_IDS.split(',')[0].trim(),sha256:item.sha256,body:bytes.toString('base64'),width:image.width,height:image.height}),signal:AbortSignal.timeout(60000)});
 if(!r.ok)throw new Error(`Cover upload ${r.status}: ${row.filename}`);row.published=true;console.log(`Cover published: ${row.filename}`);await writeFile(planFile,JSON.stringify(plan,null,2));
}
