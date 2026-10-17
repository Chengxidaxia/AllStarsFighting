/**
 * 管理端 API（独立端口部署，无鉴权）：
 *
 *   GET  /admin/api/catalog   → 全量内容 JSON
 *   PUT  /admin/api/catalog   { maps, heroes, cards } → 校验 + 热更 + 落盘
 *
 * 管理端只挂在独立的 admin 端口上（见 index.ts），不随游戏端口对外暴露。
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { getCatalog, replaceCatalog } from '../data/store.js';
import type { CatalogData } from '../data/store.js';

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(JSON.stringify(body));
}

const TARGETING = new Set(['none', 'self', 'enemy', 'ally', 'tile']);
const CARD_KINDS = new Set(['general', 'item']);
const CARD_CATS = new Set(['atk', 'skill1', 'skill2', 'ult', 'heal']);
const TERRAIN = new Set(['plain', 'water', 'wall', 'spawn', 'heal']);
const ATTACK_TYPES = new Set(['ranged', 'melee', 'magic']);

const isObj = (x: unknown): x is Record<string, unknown> => x !== null && typeof x === 'object' && !Array.isArray(x);
const isStr = (x: unknown): x is string => typeof x === 'string';
const isNonEmptyStr = (x: unknown): x is string => typeof x === 'string' && x.trim() !== '';
const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const isInt = (x: unknown): x is number => typeof x === 'number' && Number.isInteger(x);

/** 每类内容 id 必须非空且不重复。 */
function checkIds(arr: unknown[], label: string): string | null {
  const seen = new Set<string>();
  for (const it of arr) {
    if (!isObj(it) || !isNonEmptyStr(it.id)) return `${label}存在空 id 或非对象条目`;
    if (seen.has(it.id)) return `${label} id 重复：${it.id}`;
    seen.add(it.id);
  }
  return null;
}

/**
 * 深度结构校验：数组 / 关键字段 / 嵌套结构 / 尺寸与边界 / 重复 id。
 * 管理端无鉴权，必须在落盘前拦住脏数据与恶意结构。
 */
function validate(c: unknown): string | null {
  if (!isObj(c)) return 'catalog 必须是对象';
  const { maps, heroes, cards } = c;
  if (!Array.isArray(maps) || !Array.isArray(heroes) || !Array.isArray(cards)) {
    return 'maps / heroes / cards 必须都是数组';
  }
  if (heroes.length === 0) return '至少需要 1 个英雄';
  if (maps.length === 0) return '至少需要 1 张地图';

  const dupH = checkIds(heroes, '英雄');
  if (dupH !== null) return dupH;
  const dupC = checkIds(cards, '卡牌');
  if (dupC !== null) return dupC;
  const dupM = checkIds(maps, '地图');
  if (dupM !== null) return dupM;

  for (const h of heroes as Record<string, unknown>[]) {
    const id = String(h.id);
    if (!isNonEmptyStr(h.name)) return `英雄 ${id} 缺少 name`;
    if (!isNum(h.maxHp) || h.maxHp <= 0) return `英雄 ${id} 的 maxHp 必须是正数`;
    const atk = h.attack;
    if (!isObj(atk) || !ATTACK_TYPES.has(String(atk.type)) || !isNum(atk.damage)) {
      return `英雄 ${id} 的 attack 不合法（type 需 ranged/melee/magic，damage 需数字）`;
    }
    for (const key of ['skill1', 'skill2', 'ult']) {
      const s = h[key];
      if (!isObj(s) || !isStr(s.name) || !TARGETING.has(String(s.targeting)) || !Array.isArray(s.effects)) {
        return `英雄 ${id} 的 ${key} 不合法（需 name/targeting/effects）`;
      }
    }
  }

  for (const cd of cards as Record<string, unknown>[]) {
    const id = String(cd.id);
    if (!isNonEmptyStr(cd.name)) return `卡牌 ${id} 缺少 name`;
    if (!CARD_KINDS.has(String(cd.kind))) return `卡牌 ${id} 的 kind 需为 general/item`;
    if (cd.kind === 'general' && !CARD_CATS.has(String(cd.category))) {
      return `卡牌 ${id} 的 category 不合法（需 atk/skill1/skill2/ult/heal）`;
    }
    if (!TARGETING.has(String(cd.targeting))) return `卡牌 ${id} 的 targeting 不合法`;
    if (!Array.isArray(cd.effects)) return `卡牌 ${id} 的 effects 必须是数组`;
    if (!isNum(cd.count) || cd.count < 0) return `卡牌 ${id} 的 count 必须是非负数`;
    for (const e of cd.effects) {
      if (!isObj(e) || !isStr(e.op)) return `卡牌 ${id} 存在缺少 op 的效果`;
      if (e.op === 'call' && !isStr(e.fn)) return `卡牌 ${id} 的 call 效果缺少 fn`;
      if (e.op === 'code' && !isStr(e.code)) return `卡牌 ${id} 的 code 效果缺少 code`;
    }
  }

  for (const m of maps as Record<string, unknown>[]) {
    const id = String(m.id);
    if (!isNonEmptyStr(m.name)) return `地图 ${id} 缺少 name`;
    if (!isInt(m.width) || m.width <= 0 || !isInt(m.height) || m.height <= 0) {
      return `地图 ${id} 的 width/height 必须是正整数`;
    }
    const w = m.width as number;
    const hgt = m.height as number;
    if (!Array.isArray(m.tiles) || m.tiles.length !== hgt) {
      return `地图 ${id} 的 tiles 行数与 height 不符`;
    }
    for (const row of m.tiles) {
      if (!Array.isArray(row) || row.length !== w) return `地图 ${id} 存在行宽与 width 不符`;
      for (const t of row) if (!TERRAIN.has(String(t))) return `地图 ${id} 含非法地形：${String(t)}`;
    }
    const inBounds = (p: unknown): boolean =>
      isObj(p) && isInt(p.x) && isInt(p.y) && p.x >= 0 && p.y >= 0 && p.x < w && p.y < hgt;
    if (!Array.isArray(m.spawns) || m.spawns.length === 0) return `地图 ${id} 至少需要 1 个出生点`;
    for (const p of m.spawns) if (!inBounds(p)) return `地图 ${id} 的出生点越界`;
    if (!Array.isArray(m.heals)) return `地图 ${id} 的 heals 必须是数组`;
    for (const p of m.heals) if (!inBounds(p)) return `地图 ${id} 的回血点越界`;
  }

  return null;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += String(chunk);
      if (data.length > 4 * 1024 * 1024) reject(new Error('body too large'));
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

/** 处理 /admin/api/*；返回 true 表示已接管。 */
export async function handleAdminApi(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const pathname = ((req.url ?? '').split('?')[0]) ?? '';
  if (!pathname.startsWith('/admin/api/')) return false;

  if (req.method === 'GET' && pathname === '/admin/api/catalog') {
    return json(res, 200, getCatalog()), true;
  }

  if (req.method === 'PUT' && pathname === '/admin/api/catalog') {
    try {
      const next = JSON.parse(await readBody(req)) as CatalogData;
      const err = validate(next);
      if (err !== null) return json(res, 400, { ok: false, msg: err }), true;
      replaceCatalog(next);
      return json(res, 200, { ok: true, msg: '已保存并热更（新对局生效）' }), true;
    } catch {
      return json(res, 400, { ok: false, msg: 'JSON 解析失败' }), true;
    }
  }

  return json(res, 404, { ok: false, msg: '未知管理接口' }), true;
}
