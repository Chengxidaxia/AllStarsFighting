/**
 * 数据包加载（浏览器端）：
 *   - 配了 Supabase：扫描 Storage 桶 **datapacks 根目录**——每个文件夹 = 一个数据包；也识别 zip（.zip/.pack/.alsfpack）。
 *   - 没配 Supabase：读同源 `/datapacks/` 目录（本地运行时的数据包来源，由服务端 datapacks handler 提供）。
 *   - 每个包内：manifest.json + cards/*.json + stars/*.json + maps/*.json（+ 可选 js/、assets/）。
 *   - zip 一律下载到内存解包，不落硬盘。
 *
 * 映射逻辑与服务端 src/server/data/packages.ts 保持一致。
 */

const ATTACK_MAP = { FAR: 'ranged', NER: 'melee', MAG: 'magic' };
const CARD_TYPE_MAP = {
  BSC: { kind: 'item', subtype: 'plain' },
  PSV: { kind: 'item', subtype: 'passive' },
  PLB: { kind: 'item', subtype: 'placement' },
};

const utf8 = (u8) => new TextDecoder().decode(u8);

function resolveCode(code, jsFiles) {
  if (code.startsWith('js:')) {
    const body = jsFiles.get(code.slice(3));
    if (body === undefined) throw new Error('数据包脚本缺失: ' + code);
    return body;
  }
  return code;
}

function toEffects(src, jsFiles) {
  if (typeof src === 'string') return [{ op: 'code', code: resolveCode(src, jsFiles) }];
  if (!Array.isArray(src)) return [];
  const out = [];
  for (const step of src) {
    if (step !== null && typeof step === 'object' && typeof step.fn === 'string') {
      const { fn, ...args } = step;
      out.push({ op: 'call', fn, args });
    } else if (step !== null && typeof step === 'object' && typeof step.code === 'string') {
      out.push({ op: 'code', code: resolveCode(step.code, jsFiles) });
    }
  }
  return out;
}

function mapHero(src, jsFiles) {
  if (src === null || typeof src !== 'object') return null;
  const id = src.id;
  if (typeof id !== 'string' || typeof src.name !== 'string') return null;
  const atk = src.attack ?? {};
  const type = ATTACK_MAP[String(atk.type)] ?? 'ranged';
  const skillsRaw = Array.isArray(src.skills) ? src.skills : [];
  const toSkill = (s, fallback) => ({
    name: s && typeof s.name === 'string' ? s.name : fallback,
    targeting: s && typeof s.targeting === 'string' ? s.targeting : 'none',
    effects: toEffects(s ? (s.steps ?? s.code) : undefined, jsFiles),
    text: s && typeof s.text === 'string' ? s.text : '',
  });
  const specialRaw = src.special ?? null;
  return {
    id,
    name: src.name,
    title: typeof src.title === 'string' ? src.title : '',
    maxHp: typeof src.hp === 'number' ? src.hp : 10,
    attack: { type, damage: typeof atk.damage === 'number' ? atk.damage : 1 },
    modifiers: Array.isArray(src.modifiers) ? src.modifiers : [],
    special: specialRaw === null ? undefined : {
      text: typeof specialRaw.text === 'string' ? specialRaw.text : '',
      onTurnStart: typeof specialRaw.onTurnStart === 'string' ? resolveCode(specialRaw.onTurnStart, jsFiles) : undefined,
      onDamaged: typeof specialRaw.onDamaged === 'string' ? resolveCode(specialRaw.onDamaged, jsFiles) : undefined,
      onDeath: typeof specialRaw.onDeath === 'string' ? resolveCode(specialRaw.onDeath, jsFiles) : undefined,
    },
    skill1: toSkill(skillsRaw[0], '技能1'),
    skill2: toSkill(skillsRaw[1], '技能2'),
    ult: toSkill(skillsRaw[2], '大招'),
    text: typeof src.text === 'string' ? src.text : '',
  };
}

function mapCard(src, jsFiles) {
  if (src === null || typeof src !== 'object') return null;
  const id = src.id;
  if (typeof id !== 'string' || typeof src.name !== 'string') return null;
  const type = CARD_TYPE_MAP[String(src.type ?? 'BSC')] ?? CARD_TYPE_MAP.BSC;
  const kind = src.kind === 'general' ? 'general' : type.kind;
  const category = kind === 'general'
    ? (typeof src.category === 'string' ? src.category : 'atk')
    : type.category;
  return {
    id,
    name: src.name,
    kind,
    subtype: type.subtype,
    category,
    targeting: typeof src.targeting === 'string' ? src.targeting : 'none',
    effects: Array.isArray(src.effects) ? src.effects : toEffects(src.steps ?? src.code, jsFiles),
    text: typeof src.text === 'string' ? src.text : '',
    count: typeof src.amount === 'number' ? src.amount : 1,
    ui: src.ui === 'pickCard' ? 'pickCard' : undefined,
    hooks: src.hooks !== null && typeof src.hooks === 'object'
      ? {
          onDeath: typeof src.hooks.onDeath === 'string' ? resolveCode(src.hooks.onDeath, jsFiles) : undefined,
        }
      : undefined,
  };
}

function parseRows(id, name, rows) {
  const height = rows.length;
  const width = Math.max(...rows.map((r) => r.length), 0);
  const tiles = [];
  const spawns = [];
  const heals = [];
  for (let y = 0; y < height; y++) {
    const row = [];
    const chars = rows[y] ?? '';
    for (let x = 0; x < width; x++) {
      switch (chars[x]) {
        case '#': row.push('wall'); break;
        case '~': row.push('water'); break;
        case 'S': row.push('spawn'); spawns.push({ x, y }); break;
        case 'H': row.push('heal'); heals.push({ x, y }); break;
        default: row.push('plain');
      }
    }
    tiles.push(row);
  }
  return { id, name, width, height, tiles, spawns, heals };
}

function mapWorld(src) {
  if (src === null || typeof src !== 'object' || typeof src.id !== 'string') return null;
  const rows = src.tiles;
  if (!Array.isArray(rows) || rows.length === 0) return null;
  if (rows.every((r) => typeof r === 'string')) {
    return parseRows(src.id, typeof src.name === 'string' ? src.name : src.id, rows);
  }
  if (rows.every((r) => Array.isArray(r))) {
    return {
      id: src.id,
      name: typeof src.name === 'string' ? src.name : src.id,
      width: typeof src.width === 'number' ? src.width : (rows[0]?.length ?? 0),
      height: typeof src.height === 'number' ? src.height : rows.length,
      tiles: rows,
      spawns: Array.isArray(src.spawns) ? src.spawns : [],
      heals: Array.isArray(src.heals) ? src.heals : [],
    };
  }
  return null;
}

function mapPack(manifest, stars, cards, maps, jsFiles) {
  const heroSources = [...(Array.isArray(manifest.heroes) ? manifest.heroes : []), ...stars];
  const cardSources = [...(Array.isArray(manifest.cards) ? manifest.cards : []), ...cards];
  const mapSources = [
    ...(Array.isArray(manifest.maps) ? manifest.maps : []),
    ...(Array.isArray(manifest.worlds) ? manifest.worlds : []),
    ...maps,
  ];
  return {
    heroes: heroSources.map((s) => mapHero(s, jsFiles)).filter((x) => x !== null),
    cards: cardSources.map((s) => mapCard(s, jsFiles)).filter((x) => x !== null),
    maps: mapSources.map(mapWorld).filter((x) => x !== null),
    defaultMap: typeof manifest.defaultMap === 'string' ? manifest.defaultMap : '',
  };
}

/** 合并多个包：id 去重（先到先得），defaultMap 置顶。 */
function mergePacks(packs) {
  const heroes = [], cards = [], maps = [];
  const hIds = new Set(), cIds = new Set(), mIds = new Set();
  let defaultMap = '';
  for (const p of packs) {
    for (const h of p.heroes) {
      if (hIds.has(h.id)) { console.warn('[pack] 重复英雄 id，已忽略：' + h.id); continue; }
      hIds.add(h.id); heroes.push(h);
    }
    for (const c of p.cards) {
      if (cIds.has(c.id)) { console.warn('[pack] 重复卡牌 id，已忽略：' + c.id); continue; }
      cIds.add(c.id); cards.push(c);
    }
    for (const m of p.maps) {
      if (mIds.has(m.id)) { console.warn('[pack] 重复地图 id，已忽略：' + m.id); continue; }
      mIds.add(m.id); maps.push(m);
    }
    if (defaultMap === '' && p.defaultMap !== '') defaultMap = p.defaultMap;
  }
  if (defaultMap !== '') {
    const i = maps.findIndex((m) => m.id === defaultMap);
    if (i > 0) maps.unshift(...maps.splice(i, 1));
  }
  return { maps, heroes, cards };
}

// ── Supabase Storage REST ──

function makeClient(url, anonKey, bucket) {
  const base = url.replace(/\/+$/, '');
  const headers = { apikey: anonKey, Authorization: `Bearer ${anonKey}` };
  const seg = (p) => p.split('/').map(encodeURIComponent).join('/');

  async function list(prefix) {
    const res = await fetch(`${base}/storage/v1/object/list/${bucket}`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ prefix, limit: 1000, offset: 0 }),
    });
    if (!res.ok) throw new Error(`list ${prefix || '/'} → ${res.status}`);
    return res.json();
  }

  async function getBytes(path) {
    const s = seg(path);
    let res = await fetch(`${base}/storage/v1/object/${bucket}/${s}`, { headers });
    if (!res.ok) res = await fetch(`${base}/storage/v1/object/public/${bucket}/${s}`);
    if (!res.ok) throw new Error(`get ${path} → ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  }

  return { list, getBytes };
}

const isFolder = (e) => e !== null && typeof e === 'object'
  && (e.id === null || e.id === undefined)
  && (e.metadata === null || e.metadata === undefined);

async function loadJsFiles(client, prefix) {
  const map = new Map();
  for (const dir of ['', 'js', 'cards/js', 'stars/js', 'maps/js']) {
    const p = dir === '' ? prefix : `${prefix}/${dir}`;
    let entries;
    try { entries = await client.list(p); } catch { continue; }
    for (const e of entries) {
      if (!e.name.endsWith('.js')) continue;
      const body = utf8(await client.getBytes(`${p}/${e.name}`));
      map.set(e.name, body);
      map.set(`${dir === '' ? '' : dir + '/'}${e.name}`, body);
    }
  }
  return map;
}

async function readJsonFiles(client, prefix, dir) {
  const entries = await client.list(`${prefix}/${dir}`);
  const out = [];
  for (const e of entries) {
    if (!e.name.endsWith('.json')) continue;
    const parsed = JSON.parse(utf8(await client.getBytes(`${prefix}/${dir}/${e.name}`)));
    if (Array.isArray(parsed)) out.push(...parsed);
    else if (parsed !== null && typeof parsed === 'object') out.push(parsed);
  }
  return out;
}

async function loadFolderPack(client, prefix) {
  const manifest = JSON.parse(utf8(await client.getBytes(`${prefix}/manifest.json`)));
  const jsFiles = await loadJsFiles(client, prefix);
  const stars = await readJsonFiles(client, prefix, 'stars');
  const cards = await readJsonFiles(client, prefix, 'cards');
  const maps = await readJsonFiles(client, prefix, 'maps');
  return mapPack(manifest, stars, cards, maps, jsFiles);
}

async function loadZipPack(client, path) {
  const raw = await client.getBytes(path);
  if (raw.length < 4 || raw[0] !== 0x50 || raw[1] !== 0x4b) throw new Error('不是 zip（缺少 PK 头）');
  const files = await unzip(raw);
  if (!files.has('manifest.json')) throw new Error('zip 缺少 manifest.json: ' + path);
  return packFromZipFiles(files);
}

/** zip 内存解包后的公共解析（桶 zip 与本地 zip 共用）。 */
function packFromZipFiles(files) {
  const manifest = JSON.parse(utf8(files.get('manifest.json')));
  const jsFiles = new Map();
  for (const [name, data] of files) {
    if (!name.endsWith('.js')) continue;
    const body = utf8(data);
    jsFiles.set(name.split('/').pop(), body);
    jsFiles.set(name, body);
  }
  const read = (dir) => {
    const out = [];
    for (const [name, data] of files) {
      const sub = name.startsWith(dir + '/') ? name.slice(dir.length + 1) : null;
      if (sub === null || sub.indexOf('/') !== -1 || !name.endsWith('.json')) continue;
      const parsed = JSON.parse(utf8(data));
      if (Array.isArray(parsed)) out.push(...parsed);
      else if (parsed !== null && typeof parsed === 'object') out.push(parsed);
    }
    return out;
  };
  return mapPack(manifest, read('stars'), read('cards'), read('maps'), jsFiles);
}

/** 扫描桶根：文件夹 = 数据包；.zip/.pack/.alsfpack = 数据包。 */
async function scanBucket(url, anonKey, bucket) {
  const client = makeClient(url, anonKey, bucket);
  let root = [];
  try {
    root = await client.list('');
  } catch (err) {
    console.warn('[pack] 桶根 list 失败：' + String(err));
  }
  const names = root.filter((e) => !e.name.startsWith('.'));
  const packs = [];
  for (const e of names) {
    if (isFolder(e)) {
      try { packs.push(await loadFolderPack(client, e.name)); }
      catch (err) { console.warn(`[pack] 文件夹包 ${e.name} 加载失败：${String(err)}`); }
    } else {
      const lower = e.name.toLowerCase();
      // .zip 容易被 IDM 拦截；推荐用 .pack/.alsfpack，或直接用文件夹
      if (lower.endsWith('.zip') || lower.endsWith('.pack') || lower.endsWith('.alsfpack')) {
        try { packs.push(await loadZipPack(client, e.name)); }
        catch (err) { console.warn(`[pack] zip 包 ${e.name} 加载失败：${String(err)}`); }
      }
    }
  }
  if (packs.length === 0) throw new Error(`存储桶 ${bucket} 根目录没有可识别的数据包（文件夹 / .pack / .zip）`);
  return mergePacks(packs);
}

// ── 本地 /datapacks/ 目录（与桶同构：文件夹包 + zip 包，zip 内存解包）──

async function fetchBytes(url) {
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) throw new Error(url + ' → ' + res.status);
  return new Uint8Array(await res.arrayBuffer());
}

async function loadLocalFolderPack(name) {
  const res = await fetch(`datapacks/${encodeURIComponent(name)}/?list=1`, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`读取 ${name} 清单失败 → ${res.status}`);
  const { files } = await res.json();
  const base = `datapacks/${name}/`;
  const jsFiles = new Map();
  for (const rel of files) {
    if (!rel.endsWith('.js')) continue;
    const body = utf8(await fetchBytes(base + rel));
    jsFiles.set(rel.split('/').pop(), body);
    jsFiles.set(rel, body);
  }
  const readJson = async (dir) => {
    const out = [];
    for (const rel of files) {
      const sub = rel.startsWith(dir + '/') ? rel.slice(dir.length + 1) : null;
      if (sub === null || sub.indexOf('/') !== -1 || !rel.endsWith('.json')) continue;
      const parsed = JSON.parse(utf8(await fetchBytes(base + rel)));
      if (Array.isArray(parsed)) out.push(...parsed);
      else if (parsed !== null && typeof parsed === 'object') out.push(parsed);
    }
    return out;
  };
  const manifest = JSON.parse(utf8(await fetchBytes(base + 'manifest.json')));
  const stars = await readJson('stars');
  const cards = await readJson('cards');
  const maps = await readJson('maps');
  return mapPack(manifest, stars, cards, maps, jsFiles);
}

async function loadLocalZipPack(name) {
  const raw = await fetchBytes(`datapacks/${encodeURIComponent(name)}`);
  if (raw.length < 4 || raw[0] !== 0x50 || raw[1] !== 0x4b) throw new Error('不是 zip（缺少 PK 头）');
  const files = await unzip(raw);
  if (!files.has('manifest.json')) throw new Error('zip 缺少 manifest.json: ' + name);
  return packFromZipFiles(files);
}

async function scanLocal() {
  const res = await fetch('datapacks/?list=1', { cache: 'no-cache' });
  if (!res.ok) throw new Error(`本地数据包目录缺失（datapacks/?list=1 → ${res.status}），请确认服务端已启动且 datapacks/ 存在`);
  const { items } = await res.json();
  const packs = [];
  for (const it of items ?? []) {
    try {
      if (it.type === 'folder') packs.push(await loadLocalFolderPack(it.name));
      else if (it.type === 'zip') packs.push(await loadLocalZipPack(it.name));
    } catch (err) {
      console.warn(`[pack] 本地包 ${it.name} 加载失败：${String(err)}`);
    }
  }
  if (packs.length === 0) throw new Error('datapacks/ 目录没有可识别的数据包（文件夹 / .zip）');
  return mergePacks(packs);
}

// ── zip（store / deflate-raw）──

async function inflateRaw(data) {
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function unzip(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  const min = Math.max(0, bytes.length - 22 - 0xffff);
  for (let i = bytes.length - 22; i >= min; i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('zip: 找不到 EOCD');
  const count = view.getUint16(eocd + 10, true);
  let off = view.getUint32(eocd + 16, true);
  const out = new Map();
  for (let n = 0; n < count; n++) {
    if (view.getUint32(off, true) !== 0x02014b50) break;
    const method = view.getUint16(off + 10, true);
    const compSize = view.getUint32(off + 20, true);
    const nameLen = view.getUint16(off + 28, true);
    const extraLen = view.getUint16(off + 30, true);
    const commentLen = view.getUint16(off + 32, true);
    const localOff = view.getUint32(off + 42, true);
    const name = utf8(bytes.subarray(off + 46, off + 46 + nameLen));
    const lNameLen = view.getUint16(localOff + 26, true);
    const lExtraLen = view.getUint16(localOff + 28, true);
    const dataOff = localOff + 30 + lNameLen + lExtraLen;
    const comp = bytes.subarray(dataOff, dataOff + compSize);
    if (!name.endsWith('/')) {
      let raw;
      if (method === 0) raw = comp;
      else if (method === 8) raw = await inflateRaw(comp);
      else throw new Error('zip: 不支持的压缩方式 ' + method);
      out.set(name, raw);
    }
    off += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/**
 * 加载内容目录。
 * 配了 url/anonKey：扫描 Supabase Storage 桶 datapacks 根（文件夹 + zip，zip 内存解包）；
 * 否则读同源 /datapacks/ 目录（本地运行）。
 */
export async function loadCatalog({ url, anonKey, bucket = 'datapacks' } = {}) {
  if (url && anonKey) return scanBucket(url, anonKey, bucket);
  return scanLocal();
}

export { unzip, mapPack, mergePacks };
