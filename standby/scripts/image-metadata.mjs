// Minimal image-header parser for Telegram image documents. No third-party decoder required.
export function imageDimensionsFromBytes(input) {
  const b = Buffer.from(input);
  if (b.length >= 24 && b.toString('hex',0,8) === '89504e470d0a1a0a') {
    return { width:b.readUInt32BE(16), height:b.readUInt32BE(20), format:'png' };
  }
  if (b.length >= 10 && (b.toString('ascii',0,6) === 'GIF87a' || b.toString('ascii',0,6) === 'GIF89a')) {
    return { width:b.readUInt16LE(6), height:b.readUInt16LE(8), format:'gif' };
  }
  if (b.length >= 30 && b.toString('ascii',0,4) === 'RIFF' && b.toString('ascii',8,12) === 'WEBP') {
    const kind=b.toString('ascii',12,16);
    if (kind === 'VP8X' && b.length >= 30) return { width:1+b.readUIntLE(24,3), height:1+b.readUIntLE(27,3), format:'webp' };
    if (kind === 'VP8L' && b.length >= 25 && b[20] === 0x2f) {
      const bits=b.readUInt32LE(21);
      return { width:(bits & 0x3fff)+1, height:((bits >> 14) & 0x3fff)+1, format:'webp' };
    }
    if (kind === 'VP8 ' && b.length >= 30) {
      for (let i=20;i+9<b.length;i++) if (b[i]===0x9d && b[i+1]===0x01 && b[i+2]===0x2a) {
        return { width:b.readUInt16LE(i+3)&0x3fff, height:b.readUInt16LE(i+5)&0x3fff, format:'webp' };
      }
    }
  }
  if (b.length >= 4 && b[0]===0xff && b[1]===0xd8) {
    let i=2;
    while(i+4<=b.length) {
      if(b[i]!==0xff){i++;continue;}
      while(i<b.length&&b[i]===0xff)i++;
      const marker=b[i++];
      if(marker===0xd8||marker===0xd9||(marker>=0xd0&&marker<=0xd7))continue;
      if(i+2>b.length)break;
      const length=b.readUInt16BE(i);
      if(length<2||i+length>b.length)break;
      if([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)&&length>=7) {
        return {width:b.readUInt16BE(i+5),height:b.readUInt16BE(i+3),format:'jpeg'};
      }
      i+=length;
    }
  }
  return null;
}
