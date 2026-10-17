/**
 * 生成浏览器用的内容目录：把当前数据包（packages/*.zip 或 data/catalog.json）
 * 导出成 web/pack/catalog.json，供浏览器引擎与 Supabase 存储桶使用。
 * 用法：tsx scripts/gen-catalog.ts
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getCatalog } from '../src/server/data/store.js';

const c = getCatalog();
mkdirSync('web/pack', { recursive: true });
writeFileSync(join('web/pack', 'catalog.json'), JSON.stringify(c), 'utf8');
console.log(`[web] catalog.json: ${c.heroes.length} heroes / ${c.cards.length} cards / ${c.maps.length} maps`);
