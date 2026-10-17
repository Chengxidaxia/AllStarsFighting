/**
 * 把 packages-src/system 按「文件夹包」上传到 Supabase Storage 桶根（system/…）。
 * 只读 ../token.env 的 ProjectURL / Secretkey / Bucketname；密钥不打印。
 * 用法：node scripts/upload-pack.mjs
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';

const envPath = ['../token.env', '../../token.env', 'token.env'].find((p) => {
  try { readFileSync(p); return true; } catch { return false; }
});
if (envPath === undefined) { console.error('找不到 token.env'); process.exit(1); }
const text = readFileSync(envPath, 'utf8');
const get = (k) => {
  const m = text.match(new RegExp('^\\s*' + k + '\\s*=\\s*(.*)$', 'mi'));
  return m ? m[1].trim().replace(/^['"]|['"]$/g, '') : '';
};

const url = get('ProjectURL').replace(/\/+$/, '');
const secret = get('Secretkey') || get('ServiceRoleKey') || get('SUPABASE_SERVICE_ROLE_KEY');
const publishable = get('Publishablekey') || get('AnonKey');
const bucket = get('Bucketname') || 'datapack';
if (url === '' || secret === '') { console.error('缺少 ProjectURL / Secretkey'); process.exit(1); }

const root = 'packages-src/system';
const files = [];
const walk = (dir) => {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p);
    else files.push(p);
  }
};
walk(root);
const MIME = { '.json': 'application/json', '.js': 'text/javascript', '.md': 'text/markdown', '.txt': 'text/plain' };
const seg = (p) => p.split('/').map(encodeURIComponent).join('/');

let ok = 0;
for (const f of files) {
  const rel = relative(root, f).split(/[\\/]/).join('/');
  const key = `system/${rel}`;
  const res = await fetch(`${url}/storage/v1/object/${bucket}/${seg(key)}`, {
    method: 'POST',
    headers: {
      apikey: secret,
      Authorization: `Bearer ${secret}`,
      'Content-Type': MIME[extname(f)] ?? 'application/octet-stream',
      'x-upsert': 'true',
      'cache-control': '3600',
    },
    body: new Uint8Array(readFileSync(f)),
  });
  if (res.ok) ok++;
  else console.error('FAIL', res.status, key, (await res.text()).slice(0, 200));
}
console.log(`uploaded ${ok}/${files.length} files → ${bucket}/system/`);

if (publishable !== '') {
  const res = await fetch(`${url}/storage/v1/object/list/${bucket}`, {
    method: 'POST',
    headers: { apikey: publishable, Authorization: `Bearer ${publishable}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ prefix: '', limit: 100, offset: 0 }),
  });
  console.log('root list (anon):', res.status, (await res.text()).slice(0, 500));
}
