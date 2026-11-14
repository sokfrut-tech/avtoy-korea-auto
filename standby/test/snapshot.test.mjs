import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
test('snapshot builder exports approved listings only, strips contacts and never leaks Telegram file IDs',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'avtoy-snapshot-'));
 try{
  const input=path.join(dir,'private.json'),output=path.join(dir,'public.json');
  const photo={file_id:'secret-file-id',file_unique_id:'unique-photo',width:1600,height:1200};
  await writeFile(input,JSON.stringify({records:[
   {key:'car_approved:car_100555_1',value:{id:'car_100555_1',caption:'Kia Sportage 2023, комплектация Premium, полный привод, отличный автомобиль\nТелефон: +7 999 123-45-67\nКонтакт: @seller',photos:[photo],publishedAt:'2026-11-01'}},
   {key:'car_pending:car_100555_2',value:{id:'car_100555_2',caption:'Pending car with enough long text',photos:[photo]}},
   {key:'car_approved:car_100555_3',value:{id:'car_100555_3',caption:'Approved but no mirrored image and enough text',photos:[{file_id:'not-mapped'}]}},
   {key:'approved:review_1',value:{id:'review_1',kind:'photo',text:'Спасибо за подбор автомобиля, всё прошло отлично. Телефон: +7 999 123-45-67, запасной номер +49 151 2345 6789, Корея +82 10-1234-5678, Франция 0033 6 12 34 56 78, США +1 (415) 555-2671\nWhatsApp: @seller_korea',photos:[{file_id:'review-file',file_unique_id:'review-photo',width:1600,height:1200}]}}
  ],mediaMap:{'unique-photo':'/media/car-1.jpg','review-photo':'/media/review-1.jpg'}}));
  const run=spawnSync(process.execPath,[path.join(root,'scripts/build-public-snapshot.mjs'),input,output],{encoding:'utf8'});
  assert.equal(run.status,0,run.stderr);
  const text=await readFile(output,'utf8');const data=JSON.parse(text);
  assert.equal(data.cars.length,1);assert.equal(data.cars[0].id,'car_100555_1');assert.equal(data.reviews.length,1);assert.equal(data.reviews[0].id,'review_1');assert.equal(data.reviews[0].mediaItems[0].url,'/media/review-1.jpg');
  assert.equal(data.cars[0].mediaItems[0].url,'/media/car-1.jpg');
  assert.doesNotMatch(text,/secret-file-id|unique-photo|\+7 999|\+49 151|\+82 10|0033 6|\+1 \(415\)|@seller_korea/);
 }finally{await rm(dir,{recursive:true,force:true})}
});


test('snapshot builder reads the private media map separately and preserves ordered mixed albums',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'avtoy-ordered-album-'));
 try{
  const input=path.join(dir,'private.json'),output=path.join(dir,'public.json'),map=path.join(dir,'media-map.json');
  const photo={file_id:'private-photo-id',file_unique_id:'private-photo-unique',width:1600,height:1200,type:'photo'};
  const video={file_id:'private-video-id',file_unique_id:'private-video-unique',type:'video'};
  await writeFile(input,JSON.stringify({records:[
   {key:'car_approved:car_100555_9',value:{id:'car_100555_9',caption:'Kia Sportage 2024, комплектация Premium, полный привод, подтверждённая история обслуживания.',mediaItems:[video,photo,{...photo}]}}
  ]}));
  await writeFile(map,JSON.stringify({
   'private-photo-unique':'/media/photo-hash.jpg',
   'private-video-unique':'/media/video-hash.mp4'
  }));
  const run=spawnSync(process.execPath,[path.join(root,'scripts/build-public-snapshot.mjs'),input,output,map],{encoding:'utf8'});
  assert.equal(run.status,0,run.stderr);
  const serialized=await readFile(output,'utf8'),data=JSON.parse(serialized);
  assert.deepEqual(data.cars[0].mediaItems,[
   {type:'video',url:'/media/video-hash.mp4'},
   {type:'photo',url:'/media/photo-hash.jpg'}
  ]);
  assert.doesNotMatch(serialized,/private-photo-id|private-video-id|private-photo-unique|private-video-unique/);
 }finally{await rm(dir,{recursive:true,force:true})}
});


test('snapshot builder accepts mirrored image-document dimensions from the private map',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'avtoy-document-map-'));
 try{
  const input=path.join(dir,'private.json'),output=path.join(dir,'public.json'),map=path.join(dir,'media-map.json');
  await writeFile(input,JSON.stringify({records:[{key:'car_approved:car_100555_10',value:{
   id:'car_100555_10',
   caption:'Hyundai Tucson 2025, комплектация Premium, полный привод, расширенное описание автомобиля.',
   photos:[{file_id:'document-id',file_unique_id:'document-unique',mime_type:'image/jpeg'}]
  }}]}));
  await writeFile(map,JSON.stringify({'document-unique':{url:'/media/original-document.jpg',width:2400,height:1600}}));
  const run=spawnSync(process.execPath,[path.join(root,'scripts/build-public-snapshot.mjs'),input,output,map],{encoding:'utf8'});
  assert.equal(run.status,0,run.stderr);
  const data=JSON.parse(await readFile(output,'utf8'));
  assert.deepEqual(data.cars[0].mediaItems,[{type:'photo',url:'/media/original-document.jpg'}]);
 }finally{await rm(dir,{recursive:true,force:true})}
});


test('snapshot builder excludes an entire ordered album when any eligible media file is not mirrored',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'avtoy-incomplete-album-'));
 try{
  const input=path.join(dir,'private.json'),output=path.join(dir,'public.json'),map=path.join(dir,'media-map.json');
  const photoA={file_id:'photo-a-id',file_unique_id:'photo-a',width:1600,height:1200,type:'photo'};
  const photoB={file_id:'photo-b-id',file_unique_id:'photo-b',width:1600,height:1200,type:'photo'};
  const video={file_id:'video-id',file_unique_id:'video-unique',type:'video'};
  await writeFile(input,JSON.stringify({records:[
   {key:'car_approved:car_100555_11',value:{id:'car_100555_11',caption:'Kia Sportage 2025, комплектация Premium, полный привод, один владелец, отличное состояние.',mediaItems:[photoA,video,photoB]}},
   {key:'approved:review_incomplete',value:{id:'review_incomplete',text:'Спасибо за автомобиль, всё прошло отлично и быстро.',mediaItems:[photoA,photoB]}}
  ]}));
  await writeFile(map,JSON.stringify({'photo-a':'/media/photo-a.jpg','video-unique':'/media/video.mp4'}));
  const run=spawnSync(process.execPath,[path.join(root,'scripts/build-public-snapshot.mjs'),input,output,map],{encoding:'utf8'});
  assert.equal(run.status,0,run.stderr);
  const data=JSON.parse(await readFile(output,'utf8'));
  assert.deepEqual(data.cars,[]);
  assert.deepEqual(data.reviews,[]);
 }finally{await rm(dir,{recursive:true,force:true})}
});
