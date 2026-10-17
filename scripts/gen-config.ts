/**
 * 从仓库上一级的 token.env 生成 web/js/config.local.js（gitignored）。
 * 只取 ProjectURL / Publishablekey(anon) / Bucketname —— 绝不写入 service_role。
 *
 * 用法：tsx scripts/gen-config.ts
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const candidates = ['../token.env', '../../token.env', 'token.env'];
let text = '';
for (const p of candidates) {
  if (existsSync(p)) {
    text = readFileSync(p, 'utf8');
    break;
  }
}

const get = (k: string): string => {
  const m = text.match(new RegExp('^\\s*' + k + '\\s*=\\s*(.*)$', 'mi'));
  return m ? m[1].trim().replace(/^['"]|['"]$/g, '') : '';
};

const url = get('ProjectURL');
const key = get('Publishablekey') || get('AnonKey') || get('SUPABASE_ANON_KEY');
const bucket = get('Bucketname') || 'datapacks';
const mode = get('ALSF_MODE');
const safeMode = mode === 'host' || mode === 'guest' ? mode : '';
const auth = get('ALSF_AUTH');
const safeAuth = auth === 'on' || auth === 'off' ? auth : '';

const lines = [
  '/* 由 scripts/gen-config.ts 从 token.env 生成（gitignored），只含 publishable/anon key。 */',
  `window.__SUPABASE_URL = ${JSON.stringify(url)};`,
  `window.__SUPABASE_ANON_KEY = ${JSON.stringify(key)};`,
  `window.__ALSF_PACK_BUCKET = ${JSON.stringify(bucket)};`,
  `window.__ALSF_MODE = ${JSON.stringify(safeMode)};`,
];
if (safeAuth) lines.push(`window.__ALSF_AUTH = ${JSON.stringify(safeAuth)};`);
writeFileSync('web/js/config.local.js', lines.join('\n') + '\n');
console.log(`[web] config.local.js: url=${url ? 'set' : 'empty'} bucket=${bucket} mode=${safeMode || 'ws'} auth=${safeAuth || 'off'}`);
