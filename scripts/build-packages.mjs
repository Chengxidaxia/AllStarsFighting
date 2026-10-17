/**
 * 数据包构建：packages-src/<包名>/ → datapacks/<包名>.zip（store 方式，零依赖）。
 * 用法：node scripts/build-packages.mjs
 */

import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const SRC = join(root, 'packages-src');
const OUT = join(root, 'datapacks');

function crc32(data) {
  crc32.t ??= (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    return t;
  })();
  let crc = -1;
  for (let i = 0; i < data.length; i++) crc = (crc >>> 8) ^ crc32.t[(crc ^ data[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

function writeZip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const crc = crc32(e.data);
    const size = e.data.length;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(size, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    chunks.push(local, name, e.data);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(size, 20); cd.writeUInt32LE(size, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, name);
    offset += 30 + name.length + size;
  }
  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, cdBuf, eocd]);
}

function walk(dir, prefix = '') {
  const out = [];
  for (const f of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, f.name);
    if (f.isDirectory()) out.push(...walk(p, prefix + f.name + '/'));
    else out.push({ name: prefix + f.name, data: readFileSync(p) });
  }
  return out;
}

mkdirSync(OUT, { recursive: true });
for (const pkg of readdirSync(SRC, { withFileTypes: true })) {
  if (!pkg.isDirectory()) continue;
  // outdated* 是历史存档，不参与运行时 datapacks/
  if (pkg.name.startsWith('outdated')) continue;
  const entries = walk(join(SRC, pkg.name));
  const zip = writeZip(entries);
  writeFileSync(join(OUT, `${pkg.name}.zip`), zip);
  console.log(`[build] ${pkg.name}.zip（${entries.length} 个文件，${zip.length} 字节）`);
}
