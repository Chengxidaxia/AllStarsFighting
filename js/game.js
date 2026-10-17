/*
 * 客户端状态与工具（镜像服务端权威状态 + 本地动画队列）。
 */

export const S = {
  me: null,            // { id, name }
  lobbyRooms: [],
  mapList: [],         // 可选地图 [{id,name,width,height}]（建房用）
  room: null,          // RoomState
  phase: 'WAITING',
  endsAt: 0,           // 阶段/回合到期（服务器时钟）
  map: null,           // { width, height, tiles, spawns, heals }
  heroes: [],          // WireHero[]
  hand: [],            // HandCard[]
  turn: null,          // TurnPayload
  deckCount: 0,
  discardCount: 0,
  topDiscard: null,    // 弃牌堆顶 {id,name,text} | null
  placed: [],
  heroOptions: [],
  takenHeroes: [],
  spawnOptions: [],
  takenSpawns: [],
  result: null,
  // 本地交互
  selectedUid: null,
  targeting: null,     // 'enemy' | 'tile' | null
  chatTab: 'all',
  chatAll: [],
  chatTeam: [],
  logs: [],
  // 动画
  floats: [],          // 飘字 {x,y,text,color,t0}
  shakes: [],          // {heroId, t0}
  moves: [],           // {heroId, from, to, t0, dur}
  deaths: [],          // {heroId, t0}
  turnPulse: 0,
};

export function resetMatch() {
  S.phase = 'WAITING';
  S.map = null;
  S.heroes = [];
  S.hand = [];
  S.turn = null;
  S.placed = [];
  S.result = null;
  S.selectedUid = null;
  S.targeting = null;
  S.floats = []; S.shakes = []; S.moves = []; S.deaths = [];
  S.chatAll = []; S.chatTeam = []; S.logs = [];
}

export function myHero() {
  if (S.me === null) return null;
  return S.heroes.find((h) => h.playerId === S.me.id) ?? null;
}

export function isMyTurn() {
  return S.turn !== null && S.turn.currentId === (S.me?.id ?? '');
}

export function heroById(id) {
  return S.heroes.find((h) => h.playerId === id) ?? null;
}

export function teamColor(team) {
  const c = ['#ef4444', '#3b82f6', '#22c55e', '#f59e0b'];
  return c[team] ?? '#64748b';
}

export function terrainChar(map, x, y) {
  if (map === null) return '.';
  const row = map.tiles[y];
  return row?.[x] ?? '.';
}

/** 本回合可移动的格子（服务端只允许 1 格 4 邻，这里高亮 4 邻）。 */
export function reachableTiles() {
  const me = myHero();
  if (me === null || !isMyTurn() || !me.alive) return [];
  if (S.turn?.moved === true) return [];
  const out = [];
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const x = me.x + dx, y = me.y + dy;
    if (S.map === null) continue;
    if (x < 0 || y < 0 || x >= S.map.width || y >= S.map.height) continue;
    const t = terrainChar(S.map, x, y);
    if (t === '#') continue;
    if (S.heroes.some((h) => h.alive && h.x === x && h.y === y)) continue;
    out.push({ x, y });
  }
  return out;
}

export function cardKindLabel(c) {
  // 基础 5 种（general）不显示分类，只显示卡名（c.label）
  if (c.kind !== 'item') return '';
  // 道具类：显示对应子分类
  if (c.subtype === 'passive') return '被动';
  if (c.subtype === 'placement') return '放置';
  return '道具';
}

export function fmtTime(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}
