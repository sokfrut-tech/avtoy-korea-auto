import test from 'node:test';
import assert from 'node:assert/strict';
import { imageDimensionsFromBytes } from '../scripts/image-metadata.mjs';

test('reads PNG dimensions from original document bytes',()=>{
 const bytes=Buffer.alloc(24);
 Buffer.from('89504e470d0a1a0a','hex').copy(bytes,0);
 bytes.writeUInt32BE(2400,16);bytes.writeUInt32BE(1600,20);
 assert.deepEqual(imageDimensionsFromBytes(bytes),{width:2400,height:1600,format:'png'});
});
test('reads GIF dimensions',()=>{
 const bytes=Buffer.alloc(10);
 bytes.write('GIF89a',0,'ascii');bytes.writeUInt16LE(1280,6);bytes.writeUInt16LE(900,8);
 assert.deepEqual(imageDimensionsFromBytes(bytes),{width:1280,height:900,format:'gif'});
});
test('rejects unknown or truncated image data',()=>{
 assert.equal(imageDimensionsFromBytes(Buffer.from('not-an-image')),null);
 assert.equal(imageDimensionsFromBytes(Buffer.from('89504e470d0a1a0a','hex')),null);
});
