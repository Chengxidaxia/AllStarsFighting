/**
 * ALSF 线协议 v0.2 —— 三端契约（实际两处：TS 服务端 ↔ 网页客户端）。
 *
 * <p>共用方：
 * <ul>
 *   <li>TypeScript 服务端（本文件）</li>
 *   <li>网页客户端 {@code web/js/net.js}（常量表）</li>
 * </ul>
 * 改这里等于改协议，两边必须同步。
 *
 * <p>设计要点：
 * <ul>
 *   <li>回合制：**不需要** 60Hz STATE 广播，改为「阶段/回合到期驱动 + 事件推送」。</li>
 *   <li>TURN / STATE / EVENT / CHAT 全房同发；只有 WELCOME / HAND 逐会话。</li>
 *   <li>客户端靠比较 {@link TurnPayload.currentId} 与自己的 id 判断是否轮到自己。</li>
 * </ul>
 */

export const PROTOCOL_VERSION = '0.2.0';

export const MSG = {
  // ── 上行：客户端 → 服务端 ──
  /** 握手 / 进入。d = { protocol, name, token? }（token 为 Supabase access_token，可空） */
  JOIN: 'JOIN',
  /** 心跳。d = { ts } */
  PING: 'PING',
  /** 建房。d = { name?, mode } */
  CREATE_ROOM: 'CREATE_ROOM',
  /** 进房。d = { roomId } */
  JOIN_ROOM: 'JOIN_ROOM',
  /** 离开房间回大厅。d = {} */
  LEAVE_ROOM: 'LEAVE_ROOM',
  /** 房主开始对局。d = { roomId } */
  START_MATCH: 'START_MATCH',
  /** 等待房内自选队伍。d = { roomId, team } */
  CHOOSE_TEAM: 'CHOOSE_TEAM',
  /** 选英雄。d = { roomId, heroId } */
  PICK_HERO: 'PICK_HERO',
  /** 选出生点。d = { roomId, spawnIndex } */
  PICK_SPAWN: 'PICK_SPAWN',
  /** 回合内移动 1 格（4 邻）。d = { roomId, x, y } */
  MOVE: 'MOVE',
  /** 出牌。d = { roomId, uid, targetId?, x?, y? } */
  PLAY_CARD: 'PLAY_CARD',
  /** 弃牌（被动牌只能这样处理）。d = { roomId, uid } */
  DISCARD_CARD: 'DISCARD_CARD',
  /** 结束回合。d = { roomId } */
  END_TURN: 'END_TURN',
  /** 撤回本回合的移动（点击起点格）。d = { roomId } */
  UNDO_MOVE: 'UNDO_MOVE',
  /** 房主重开一局。d = { roomId } */
  RESTART_MATCH: 'RESTART_MATCH',

  // ── 下行：服务端 → 客户端 ──
  /** 握手成功。d = { id, protocol, serverTime } */
  WELCOME: 'WELCOME',
  /** 大厅房间列表（每秒一次）。d = { rooms: RoomInfo[] } */
  LOBBY: 'LOBBY',
  /** 房间内状态（房间维度）。d = RoomState */
  ROOM: 'ROOM',
  /** 阶段变化。d = { phase, endsAt? } */
  PHASE: 'PHASE',
  /** 可选英雄列表。d = { heroes: HeroOption[], taken: string[] } */
  HERO_OPTIONS: 'HERO_OPTIONS',
  /** 可选出生点。d = { spawns: Pos[], taken: number[] } */
  SPAWN_OPTIONS: 'SPAWN_OPTIONS',
  /** 地图 + 场上英雄（开局一次，重开再发）。d = { map, heroes } */
  MAP: 'MAP',
  /** 回合广播。d = TurnPayload */
  TURN: 'TURN',
  /** 手牌（**仅本人**）。d = { cards: HandCard[] } */
  HAND: 'HAND',
  /** 全场快照（每有变化广播）。d = StatePayload */
  STATE: 'STATE',
  /** 增量事件日志。d = { events: GameEvent[] } */
  EVENT: 'EVENT',
  /** 聊天（上行 d = { channel, text }；下行 d = { from, name, team, channel, text }） */
  CHAT: 'CHAT',
  /** 结算。d = { winners: number[], standings: Standing[] } */
  RESULT: 'RESULT',
  /** 心跳回包。d = { ts, serverTime } */
  PONG: 'PONG',
  /** 错误。d = { code, msg } */
  ERROR: 'ERROR',
} as const;

export const ERROR_CODE = {
  BAD_MESSAGE: 'BAD_MESSAGE',
  VERSION_MISMATCH: 'VERSION_MISMATCH',
  NOT_JOINED: 'NOT_JOINED',
  ROOM_NOT_FOUND: 'ROOM_NOT_FOUND',
  NOT_IN_ROOM: 'NOT_IN_ROOM',
  ROOM_FULL: 'ROOM_FULL',
  TOO_MANY_ROOMS: 'TOO_MANY_ROOMS',
  BAD_PHASE: 'BAD_PHASE',
  NOT_YOUR_TURN: 'NOT_YOUR_TURN',
  HERO_TAKEN: 'HERO_TAKEN',
  SPAWN_TAKEN: 'SPAWN_TAKEN',
  BAD_TARGET: 'BAD_TARGET',
  OUT_OF_RANGE: 'OUT_OF_RANGE',
  NO_LOS: 'NO_LOS',
  ILLEGAL_MOVE: 'ILLEGAL_MOVE',
  CARD_NOT_IN_HAND: 'CARD_NOT_IN_HAND',
  CARD_NOT_PLAYABLE: 'CARD_NOT_PLAYABLE',
  NOT_HOST: 'NOT_HOST',
  BAD_TEAM: 'BAD_TEAM',
} as const;

// ── 大厅 / 房间 ──

export type MatchMode = '1v1' | '1v1v1v1' | '2v2' | '3v3' | '4v4' | '2v2v2v2';

export const MATCH_MODES: readonly MatchMode[] = ['1v1', '1v1v1v1', '2v2', '3v3', '4v4', '2v2v2v2'];

/** 模式 → 队伍数 / 每队人数（用于校验与默认值）。 */
export function modeShape(mode: MatchMode): { teams: number; perTeam: number } {
  switch (mode) {
    case '1v1': return { teams: 2, perTeam: 1 };
    case '1v1v1v1': return { teams: 4, perTeam: 1 };
    case '2v2': return { teams: 2, perTeam: 2 };
    case '3v3': return { teams: 2, perTeam: 3 };
    case '4v4': return { teams: 2, perTeam: 4 };
    case '2v2v2v2': return { teams: 4, perTeam: 2 };
  }
}

export interface RoomInfo {
  id: string;
  name: string;
  mode: MatchMode;
  /** 房间内已加入的玩家人数（含淘汰/掉线占位）。 */
  players: number;
  /** 观战人数。 */
  spectators: number;
  capacity: number;
  phase: string;
  permanent: boolean;
  hostName: string;
  /** 房间使用的地图名。 */
  mapName: string;
}

export interface RoomPlayer {
  id: string;
  name: string;
  /** 自选队伍下标（0-based）。 */
  team: number;
  /** 座位序 = 加入顺序。 */
  seat: number;
  host: boolean;
  /** 等待房内是否就绪（点开始由房主触发，此字段预留给「全部就绪」提示）。 */
  connected: boolean;
}

/** ROOM 载荷：房间维度状态（与对局快照 STATE 分开）。 */
export interface RoomState {
  roomId: string;
  name: string;
  mode: MatchMode;
  hostId: string;
  /** 开局所需人数 = 队伍数 × 每队人数。 */
  capacity: number;
  phase: string;
  /** 阶段到期时间戳（ms，服务器时钟）；无则为 0。 */
  endsAt: number;
  players: RoomPlayer[];
  /** 对局已开始的房间才有意义。 */
  turnNo: number;
}

// ── 卡牌 / 英雄（内容层，与 data 目录一致） ──

export type CardKind = 'general' | 'item';
export type ItemSubtype = 'plain' | 'passive' | 'placement';
/** 一般牌的子类：触发牌，触发自己英雄的对应能力。 */
export type GeneralCategory = 'atk' | 'skill1' | 'skill2' | 'ult' | 'heal';
export type TargetKind = 'none' | 'self' | 'enemy' | 'ally' | 'tile';
export type AttackType = 'ranged' | 'melee' | 'magic';

/** 效果算子（详见 cards.md；新增卡牌 = 新增数据，不改引擎）。 */
export type EffectDef =
  | { op: 'damage'; amount: number; kind?: 'physical' | 'magic' }
  | { op: 'heal'; amount: number }
  | { op: 'draw'; count: number }
  | { op: 'discard'; count: number; who: 'self' | 'target' }
  | { op: 'steal'; count: number }
  | { op: 'status'; status: StatusKind; turns: number; value?: number }
  | { op: 'shield'; amount: number }
  | { op: 'pierce'; ratio: number }
  | { op: 'splash'; ratio: number }
  | { op: 'lifesteal'; ratio: number }
  | { op: 'push'; tiles: number }
  | { op: 'pull'; tiles: number }
  | { op: 'teleport'; to: 'target' | 'spawn' | 'random' }
  | { op: 'swap' }
  | { op: 'move'; tiles: number }
  | { op: 'extraTurn' }
  | { op: 'place'; object: PlacedKind; expiresIn: number }
  | { op: 'terrain'; to: 'wall' | 'plain'; radius: number }
  | { op: 'foresee' }                 // 看破：本回合结束时额外抽 1 张牌
  // ── 常驻修正（英雄特殊属性 / 被动道具牌，持有期间持续生效） ──
  | { op: 'ghost' }                    // 穿墙：移动忽略 wall
  | { op: 'healBonus'; amount: number } // 受治疗加成
  | { op: 'burnImmune' }               // 免疫灼烧
  // ── 数据包引擎：调用游戏 API（≥20 个函数接口，见 match.buildApi） ──
  | { op: 'call'; fn: string; args?: Record<string, unknown> }
  | { op: 'code'; code: string };      // 直接执行 JavaScript（node:vm 沙箱，可调用 api.*）

export type StatusKind =
  | 'stun'      // 定身：下个自己的回合不能行动
  | 'disarm'    // 缴械：不能出攻击牌
  | 'silence'   // 沉默：不能出技能牌
  | 'burn'      // 灼烧：回合开始受到伤害
  | 'poison'    // 剧毒：回合结束受到伤害（可叠）
  | 'reflect'   // 反弹：反弹受击伤害
  | 'magicVeil' // 魔抗罩：法术减伤
  | 'thorn'     // 荆棘：受近战攻击反伤
  | 'fakedeath'; // 假死：无敌 + 跳过自己回合（不淘汰）

export type PlacedKind = 'trap' | 'rock' | 'altar';

export interface CardDef {
  id: string;
  name: string;
  kind: CardKind;
  /** item 才有；一般牌无。 */
  subtype?: ItemSubtype;
  /** 一般牌才有：触发牌类别。 */
  category?: GeneralCategory;
  targeting: TargetKind;
  effects: EffectDef[];
  text: string;
  /** 共享牌堆中的张数。 */
  count: number;
  /** 数据包：死亡时钩子（JavaScript，可调 api.*；设 hp>0 可免死）。 */
  hooks?: { onDeath?: string };
  /** 数据包：特殊 UI 交互（pickCard = 打出时弹面板从牌堆自选一张）。 */
  ui?: 'pickCard';
}

export interface HandCard {
  uid: string;
  cardId: string;
  /** 展示名（触发牌会带上英雄技能名，如「技1 · 火球术」）。 */
  label: string;
  kind: CardKind;
  subtype?: ItemSubtype;
  category?: GeneralCategory;
  /** **有效**目标类型：触发牌按英雄技能解析（self/enemy/tile）。 */
  targeting: TargetKind;
  text: string;
  /** 数据包：特殊 UI（pickCard = 打出时弹面板自选一张牌）。 */
  ui?: 'pickCard';
  /** 被动牌不能打出。 */
  playable: boolean;
}

export interface HeroOption {
  id: string;
  name: string;
  maxHp: number;
  attack: { type: AttackType; damage: number };
  text: string;
}

// ── 对局载荷 ──

export type Phase = 'WAITING' | 'HERO_SELECT' | 'DEAL' | 'SPAWN_SELECT' | 'PLAYING' | 'FINISHED';

export interface TurnPayload {
  /** 本局第几个回合（从 1 开始）。 */
  turnNo: number;
  /** 完整座位序（按 队伍序 → 队内加入序）。 */
  order: string[];
  currentIndex: number;
  currentId: string;
  /** 回合到期时间戳（ms，服务器时钟）。 */
  endsAt: number;
  /** 当前行动玩家是否已移动 / 已出牌（用于 UI 勾选态）。 */
  moved: boolean;
  played: boolean;
  /** 本回合是否已弃牌（与出牌互斥，上限 1 张）。 */
  discarded: boolean;
  /** 本回合最后一步移动前的起点格（用于撤回；未移动为 null）。 */
  moveOrigin: { x: number; y: number } | null;
}

export interface WireHero {
  /** 玩家 id（= 英雄归属）。 */
  playerId: string;
  id: string;
  heroId: string;
  name: string;
  team: number;
  hp: number;
  maxHp: number;
  x: number;
  y: number;
  alive: boolean;
  /** 简易状态展示：stun/burn/... 及剩余回合。 */
  statuses: { kind: StatusKind; turns: number }[];
  handCount: number;
}

export interface PlacedWire {
  id: string;
  kind: PlacedKind;
  x: number;
  y: number;
  expiresIn: number;
  ownerTeam: number;
}

export interface StatePayload {
  phase: Phase;
  turnNo: number;
  currentId: string;
  heroes: WireHero[];
  /** 主牌堆剩余 / 弃牌堆数量。 */
  deckCount: number;
  discardCount: number;
  /** 弃牌堆顶（最近打出/弃掉的牌）；无则 null。 */
  topDiscard?: { id: string; name: string; text: string } | null;
  placed: PlacedWire[];
  /** 当前玩家剩余行动提示（轮到自己时客户端使用）。 */
  endsAt: number;
}

export type GameEventKind =
  | 'system' | 'join' | 'leave' | 'hero' | 'spawn' | 'move' | 'card'
  | 'damage' | 'heal' | 'death' | 'turn' | 'phase' | 'result' | 'chat' | 'place';

export interface GameEvent {
  kind: GameEventKind;
  text: string;
  /** 事件归属玩家（若有）。 */
  actorId?: string;
  at: number;
}

export interface Standing {
  playerId: string;
  name: string;
  team: number;
  place: number;
  heroName: string;
  kills: number;
}

export interface ResultPayload {
  /** 获胜队伍下标列表（平局可多个）。 */
  winners: number[];
  standings: Standing[];
  /** 非正常结束时的原因（如「房主退出，对局结束」）；正常结束为空。 */
  reason?: string;
}

// ── 内部：Match 快照给 gateway 用的形状 ──

export interface MapWire {
  width: number;
  height: number;
  /** 行主序地形字符。 */
  tiles: string[];
  spawns: { x: number; y: number }[];
  heals: { x: number; y: number }[];
}

export interface JoinPayload {
  name?: string;
  protocol?: string;
  /** Supabase access_token（可空 → 游客）。 */
  token?: string;
  /** 断线重连：上次服务端分配的玩家 id。 */
  resumeId?: string;
}

export interface ChatPayload {
  channel: 'all' | 'team';
  text: string;
}

export interface CreateRoomPayload {
  name?: string;
  mode?: MatchMode;
}
