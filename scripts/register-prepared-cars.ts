import { readFile,writeFile,stat,mkdir,rename } from 'node:fs/promises';
import path from 'node:path';
import yauzl from 'yauzl';
import JSON5 from 'json5';
import sharp from 'sharp';
import { inspectMod } from '../desktop/metadata';
import { metadataSchema } from '../shared/schema';
const file='data/collection/manifest.json';
const manifest=JSON.parse(await readFile(file,'utf8'));
const ledger=JSON.parse(await readFile('../work/506w/lighting-state.json','utf8'));
const duplicates=JSON.parse(await readFile('../work/506w/duplicates.json','utf8'));
await mkdir('data/collection/pictures',{recursive:true});
async function readPicture(archive:string){return new Promise<{raw:Buffer;member:string}|null>((resolve,reject)=>yauzl.open(archive,{lazyEntries:true,autoClose:false},(err,zip)=>{if(err||!zip)return reject(err);let info:any;const entries:yauzl.Entry[]=[];const read=(entry:yauzl.Entry)=>new Promise<Buffer>((ok,fail)=>zip.openReadStream(entry,(error,stream)=>{if(error||!stream)return fail(error);const parts:Buffer[]=[];stream.on('data',part=>parts.push(part));stream.on('end',()=>ok(Buffer.concat(parts)));stream.on('error',fail);}));zip.on('error',reject);zip.on('entry',async entry=>{entries.push(entry);if(/^vehicles\/(?!common\/)[^/]+\/info.json$/i.test(entry.fileName)){try{info={folder:path.posix.dirname(entry.fileName),data:JSON5.parse((await read(entry)).toString('utf8'))};}catch{}}zip.readEntry();});zip.on('end',async()=>{try{const prefix=info?.folder+'/'+info?.data?.default_pc;const entry=entries.find(e=>[prefix+'.jpg',prefix+'.png',prefix+'.jpeg'].includes(e.fileName))||entries.find(e=>/^vehicles\/(?!common\/)[^/]+\/default\.(jpg|png)$/i.test(e.fileName))||entries.find(e=>/^vehicles\/(?!common\/)[^/]+\/[^/]+\.(jpg|png)$/i.test(e.fileName)&&entries.some(pc=>pc.fileName.toLowerCase()===e.fileName.replace(/\.(jpg|png)$/i,'.pc').toLowerCase()));if(!entry)return resolve(null);resolve({raw:await read(entry),member:entry.fileName});}catch(e){reject(e);}finally{zip.close();}});zip.readEntry();}));}
for(const [filename,value] of Object.entries(ledger) as [string,any][]){
 if(duplicates.some((v:any)=>v.filename===filename&&v.duplicate))continue;
 if(/chiron|rolls|rocket/i.test(filename+' '+value.name))throw Error('Excluded car cannot be registered');
 const existing=manifest.items.find((x:any)=>x.filename===filename);if(existing)continue;
 const target=path.resolve(value.output), info=await stat(target),detected=await inspectMod(target);
 const name=value.name+(!/\b(?:19|20)\d{2}\b/.test(value.name)&&detected.years?' '+detected.years:'')+(value.changes.length?' (0.40 update)':'');
 const metadata=metadataSchema.parse({...detected,name,description:'',lightingUpdated:value.changes.length>0});
 const image=await readPicture(target);let pictureFile:string|undefined;
 if(image){pictureFile=path.resolve('data/collection/pictures',value.sha256+'.jpg');await sharp(image.raw).resize({width:960,height:600,fit:'inside',withoutEnlargement:true}).jpeg({quality:86}).toFile(pictureFile);}
 manifest.items.push({filename,file:target,sourceFile:value.source,size:info.size,modified:info.mtimeMs,sha256:value.sha256,status:'prepared',metadata,picture:pictureFile,evidence:{creator:detected.creator==='Unknown'?'unverified':'embedded original metadata',sourcePicture:image?{zip:target,member:image.member}:null},lightingEvidence:value.changes});
 console.log('Registered '+filename+' — '+name);
}
await writeFile(file+'.tmp',JSON.stringify(manifest,null,2));await rename(file+'.tmp',file);
