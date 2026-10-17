/**
 * 对局聚合根：一局 = 一个 Match（挂在 Room 下）。
 *
 * 阶段机：WAITING → HERO_SELECT → DEAL → SPAWN_SELECT → PLAYING → FINISHED →(重开) WAITING
 * 每个等待阶段都有**超时兜底自动分配**，不会卡死。
 *
 * 服务端权威：客户端只发意图（MOVE / PLAY_CARD / END_TURN），一切结果由本类算出后广播。
 */

import type {
  GameEvent, GameEventKind, HandCard, MapWire, MatchMode, Phase, PlacedWire,
  ResultPayload, RoomPlayer, RoomState, Standing, StatePayload, TurnPayload,
} from '../protocol/types.js';
import { ERROR_CODE, modeShape } from '../protocol/types.js';
import type { CardDef, EffectDef, StatusKind } from '../protocol/types.js';
import { allCards, cardById } from '../data/store.js';
import { heroById } from '../data/store.js';
import { SharedDeck, type CardInstance } from './deck.js';
import { Grid, chebyshev, manhattan, posKey, samePos, type MapDef, type Pos, type Terrain } from './grid.js';
import { createRng, randomSeed, type Rng } from './rng.js';
import { createContext, runInContext } from 'node:vm';
import { randomBytes } from 'node:crypto';
import { getCatalog } from '../data/store.js';
import { collectModifiers, emptyModifiers, healAmount, type Modifiers, type StatusRt } from './effects.js';

export type ActionResult = { ok: true } | { ok: false; code: string; msg: string };

const OK: ActionResult = { ok: true };
function fail(code: string, msg: string): ActionResult {
  return { ok: false, code, msg };
}

/**
 * 数据包脚本的「加固」执行器。
 *
 * ⚠️ Node 的 vm **不是安全沙箱**（官方文档明确说明）。这里只做三层加固：
 *   1) 禁用字符串代码生成（eval / new Function / wasm）；
 *   2) 只暴露最小对象（api / self / target / tile / ctx）；
 *   3) 屏蔽 constructor / __proto__ / prototype 等常见逃逸入口，并保留 200ms 超时。
 * 这能挡住随手写的逃逸，**挡不住有意的宿主对象逃逸**。
 * 因此数据包必须来自可信来源（见 README「安全边界」）。
 */
const SHIELD_KEYS = new Set(['constructor', '__proto__', 'prototype', 'caller', 'callee']);

function shield<T extends object>(obj: T): T {
  return new Proxy(obj, {
    get(target, prop) {
      if (typeof prop === 'string' && SHIELD_KEYS.has(prop)) return undefined;
      const v = Reflect.get(target, prop);
      if (typeof v === 'function') {
        return new Proxy(v, {
          get(fn, fp) {
            if (typeof fp === 'string' && SHIELD_KEYS.has(fp)) return undefined;
            return Reflect.get(fn, fp);
          },
          apply(fn, _thisArg, args) { return Reflect.apply(fn, target, args); },
        });
      }
      return v;
    },
    getPrototypeOf() { return null; },
    setPrototypeOf() { return false; },
  });
}

function runSandboxed(code: string, sandbox: Record<string, unknown>): void {
  const context = createContext(sandbox, { codeGeneration: { strings: false, wasm: false } });
  runInContext(code, context, { timeout: 200 });
}

interface HeroRt {
  heroId: string;
  playerId: string;
  team: number;
  hp: number;
  maxHp: number;
  x: number;
  y: number;
  /** 选出生点阶段暂存的下标（落位后仍保留，用于判重）。 */
  spawnIdx: number;
  alive: boolean;
  shield: number;
  statuses: StatusRt[];
  hand: CardInstance[];
}

interface PlayerRt {
  id: string;
  name: string;
  /** 后端专用随机会话 ID（进房时分配，仅日志/调试用，不下发前端）。 */
  sessionId: string;
  team: number;
  seat: number;
  heroId: string | null;
  hero: HeroRt | null;
  connected: boolean;
  disconnectAt: number;
  kills: number;
  /** 淘汰名次（1 = 第一），淘汰时赋值。 */
  place: number;
}

interface PlacedObject {
  id: string;
  kind: 'trap' | 'rock' | 'altar';
  x: number;
  y: number;
  expiresIn: number;
  ownerTeam: number;
  /** 陷阱伤害（数据包可自定义，默认 3）。 */
  value?: number;
}

export interface MatchOpts {
  roomId: string;
  name: string;
  mode: MatchMode;
  hostId: string;
  mapId?: string;
  cfg: {
    phaseTimeoutMs: number;
    turnTimeoutMs: number;
    handSize: number;
    healCardAmount: number;
    healTileAmount: number;
    moveBudget: number;
  };
}

export class Match {
  phase: Phase = 'WAITING';
  readonly players = new Map<string, PlayerRt>();
  order: string[] = [];
  turnIndex = -1;
  turnNo = 0;
  turnEndsAt = 0;
  deck: SharedDeck | null = null;
  placed: PlacedObject[] = [];
  events: GameEvent[] = [];
  finished = false;
  winners: number[] = [];
  standings: Standing[] = [];
  /** 非正常结束原因（房主退出 / 掉线超时）；正常结束为空。 */
  private abortReason = '';
  seed = 0;
  readonly createdAt = Date.now();

  /** 当前回合行动计数。 */
  private movesLeft = 0;
  private playedCard = false;
  /** 本回合最后一步移动前的起点（用于撤回）；未移动为 null。 */
  private moveOrigin: { x: number; y: number } | null = null;
  /** 本回合已弃牌数（与出牌互斥，上限 1 张）。 */
  private discardedThisTurn = 0;
  private foreseeFlag = false;
  private pendingExtraTurn = false;
  private placeSeq = 0;
  private deathSeq = 0;
  /** 地形覆盖（岩石 / 祭坛 / 开路炸弹）。 */
  private terrainOverrides = new Map<string, Terrain>();

  /** 房主 id（可顺位移交）。 */
  hostId: string;
  readonly rng: Rng;
  readonly grid: Grid;
  readonly mapDef: MapDef;
  readonly shape: { teams: number; perTeam: number };

  constructor(readonly opts: MatchOpts) {
    this.hostId = opts.hostId;
    this.shape = modeShape(opts.mode);
    const map = getCatalog().maps.find((m) => m.id === opts.mapId) ?? getCatalog().maps[0]!;
    this.mapDef = map;
    this.grid = new Grid(map);
    this.seed = randomSeed();
    this.rng = createRng(this.seed);
  }

  // ── 成员管理（WAITING 阶段） ──

  addPlayer(id: string, name: string): PlayerRt {
    const seat = this.players.size;
    // 自选队伍：默认加入人数最少的队伍
    const counts = new Array<number>(this.shape.teams).fill(0);
    for (const p of this.players.values()) counts[p.team] = (counts[p.team] ?? 0) + 1;
    let team = 0;
    for (let t = 1; t < this.shape.teams; t++) {
      if ((counts[t] ?? 0) < (counts[team] ?? 0)) team = t;
    }
    const p: PlayerRt = {
      id, name, sessionId: randomBytes(3).toString('hex'), team, seat, heroId: null, hero: null,
      connected: true, disconnectAt: 0, kills: 0, place: 0,
    };
    this.players.set(id, p);
    this.emit('join', `${name} 加入了房间`);
    return p;
  }

  removePlayer(id: string): void {
    const p = this.players.get(id);
    if (p === undefined) return;
    if (this.phase === 'PLAYING' && p.hero?.alive === true) {
      this.killHero(p.hero, null);
      this.emit('leave', `${p.name} 离开了对局`);
      this.checkWin();
    } else {
      this.emit('leave', `${p.name} 离开了房间`);
    }
    this.players.delete(id);
    this.recomputeOrder();
  }

  setTeam(id: string, team: number): ActionResult {
    if (this.phase !== 'WAITING') return fail(ERROR_CODE.BAD_PHASE, '仅等待房内可切换队伍');
    const p = this.players.get(id);
    if (p === undefined) return fail(ERROR_CODE.NOT_IN_ROOM, '你不在该房间');
    if (!Number.isInteger(team) || team < 0 || team >= this.shape.teams) {
      return fail(ERROR_CODE.BAD_TEAM, '队伍不存在');
    }
    // 队伍人数不得超过每队上限
    let count = 0;
    for (const q of this.players.values()) if (q.team === team && q.id !== id) count++;
    if (count >= this.shape.perTeam) return fail(ERROR_CODE.BAD_TEAM, '该队伍已满');
    p.team = team;
    return OK;
  }

  // ── 阶段流转 ──

  start(id: string, now: number): ActionResult {
    if (id !== this.hostId) return fail(ERROR_CODE.NOT_HOST, '只有房主可以开始');
    if (this.phase !== 'WAITING') return fail(ERROR_CODE.BAD_PHASE, '对局已开始');
    const need = this.shape.teams * this.shape.perTeam;
    if (this.players.size !== need) {
      return fail(ERROR_CODE.BAD_PHASE, `人数不齐：${this.players.size}/${need}`);
    }
    this.phase = 'HERO_SELECT';
    this.phaseEndsAt = now + this.opts.cfg.phaseTimeoutMs;
    this.emit('phase', '进入英雄选择阶段');
    return OK;
  }

  /** 阶段兜底超时（HERO_SELECT / SPAWN_SELECT）。 */
  phaseEndsAt = 0;

  pickHero(id: string, heroId: string): ActionResult {
    if (this.phase !== 'HERO_SELECT') return fail(ERROR_CODE.BAD_PHASE, '当前不是选英雄阶段');
    const p = this.players.get(id);
    if (p === undefined) return fail(ERROR_CODE.NOT_IN_ROOM, '你不在该房间');
    if (heroById(heroId) === undefined) return fail(ERROR_CODE.BAD_MESSAGE, '英雄不存在');
    for (const q of this.players.values()) {
      if (q.heroId === heroId && q.id !== id) return fail(ERROR_CODE.HERO_TAKEN, '该英雄已被选择');
    }
    p.heroId = heroId;
    this.emit('hero', `${p.name} 选择了 ${heroById(heroId)!.name}`);
    if ([...this.players.values()].every((q) => q.heroId !== null)) this.finishHeroSelect();
    return OK;
  }

  private finishHeroSelect(): void {
    // 兜底：未选的玩家自动分配剩余英雄
    const taken = new Set([...this.players.values()].map((p) => p.heroId));
    const free = getCatalog().heroes.filter((h) => !taken.has(h.id));
    for (const p of this.players.values()) {
      if (p.heroId === null) {
        const h = free.shift();
        if (h !== undefined) {
          p.heroId = h.id;
          this.emit('hero', `${p.name} 超时未选，自动分配 ${h.name}`);
        }
      }
    }
    this.phase = 'DEAL';
    this.deal();
    this.phase = 'SPAWN_SELECT';
    this.phaseEndsAt = Date.now() + this.opts.cfg.phaseTimeoutMs;
    this.emit('phase', '发牌完成，进入出生点选择');
  }

  /** 建共享牌堆 + 各发 3 张 + 建场上英雄。 */
  private deal(): void {
    const counts = new Map(allCards().map((c) => [c.id, c.count]));
    this.deck = new SharedDeck(counts, this.rng);
    for (const p of this.players.values()) {
      const def = heroById(p.heroId ?? '');
      if (def === undefined) continue;
      const hero: HeroRt = {
        heroId: def.id, playerId: p.id, team: p.team,
        hp: def.maxHp, maxHp: def.maxHp, x: -1, y: -1, spawnIdx: -1,
        alive: true, shield: 0, statuses: [], hand: [],
      };
      for (const e of def.modifiers) {
        if (e.op === 'status' && e.turns === -1) {
          hero.statuses.push({ kind: e.status, turns: -1, value: e.value ?? 1 });
        }
      }
      p.hero = hero;
      for (let i = 0; i < this.opts.cfg.handSize; i++) {
        const c = this.deck.draw();
        if (c !== null) hero.hand.push(c);
      }
    }
    this.recomputeOrder();
  }

  pickSpawn(id: string, spawnIndex: number): ActionResult {
    if (this.phase !== 'SPAWN_SELECT') return fail(ERROR_CODE.BAD_PHASE, '当前不是选出生点阶段');
    const p = this.players.get(id);
    if (p === undefined) return fail(ERROR_CODE.NOT_IN_ROOM, '你不在该房间');
    if (p.hero === null) return fail(ERROR_CODE.BAD_PHASE, '尚未选择英雄');
    const spawns = this.mapDef.spawns;
    if (!Number.isInteger(spawnIndex) || spawnIndex < 0 || spawnIndex >= spawns.length) {
      return fail(ERROR_CODE.BAD_MESSAGE, '出生点不存在');
    }
    const taken = new Set<number>();
    for (const q of this.players.values()) {
      if (q.hero !== null && q.id !== id && q.hero.spawnIdx >= 0) taken.add(q.hero.spawnIdx);
    }
    if (taken.has(spawnIndex)) return fail(ERROR_CODE.SPAWN_TAKEN, '该出生点已被选择');
    const s = spawns[spawnIndex]!;
    p.hero.spawnIdx = spawnIndex;
    p.hero.x = s.x;
    p.hero.y = s.y;
    this.emit('spawn', `${p.name} 就位`);
    if ([...this.players.values()].every((q) => q.hero !== null && q.hero.spawnIdx >= 0)) {
      this.beginPlay();
    }
    return OK;
  }

  private beginPlay(): void {
    this.phase = 'PLAYING';
    this.turnNo = 1;
    this.turnIndex = 0;
    this.emit('phase', '对局开始！');
    this.startTurn();
  }

  // ── 回合引擎 ──

  /** 座位序：先队伍序，同队按加入序（用户定案：先手按队伍顺序）。 */
  private recomputeOrder(): void {
    this.order = [...this.players.values()]
      .sort((a, b) => (a.team - b.team) || (a.seat - b.seat))
      .map((p) => p.id);
    if (this.turnIndex >= this.order.length) this.turnIndex = this.order.length - 1;
  }

  get currentId(): string {
    return this.order[this.turnIndex] ?? '';
  }

  private current(): PlayerRt | undefined {
    return this.players.get(this.currentId);
  }

  private modsOf(p: PlayerRt): Modifiers {
    if (p.hero === null) return collectModifiers(undefined, [], []);
    const def = heroById(p.hero.heroId);
    const held = p.hero.hand
      .map((c) => cardById(c.cardId))
      .filter((d): d is CardDef => d !== undefined && d.subtype === 'passive');
    return collectModifiers(def, p.hero.statuses, held);
  }

  private startTurn(): void {
    const p = this.current();
    if (p === undefined || p.hero === null) return;
    const mods = this.modsOf(p);
    this.movesLeft = this.opts.cfg.moveBudget + mods.moveBonus;
    this.playedCard = false;
    this.moveOrigin = null;
    this.discardedThisTurn = 0;
    this.foreseeFlag = false;
    this.turnEndsAt = Date.now() + this.opts.cfg.turnTimeoutMs;
    this.emit('turn', `── 第 ${this.turnNo} 回合：${p.name} ──`);

    // 回血点：站上去每回合开始回 1 HP（与出生点独立）
    if (this.tileAt(p.hero.x, p.hero.y) === 'heal') {
      const amount = healAmount(this.opts.cfg.healTileAmount, mods);
      this.applyHeal(p, amount, '回血点');
    }
    // 灼烧：回合开始受伤
    const burn = p.hero.statuses.find((s) => s.kind === 'burn' && s.turns !== 0);
    if (burn !== undefined && !mods.burnImmune) {
      this.dealDamage(p, p, burn.value, 'magic', false, '灼烧');
    }
    // 数据包钩子：onTurnStart（如水里回血 / 低血假死）
    const sp = heroById(p.heroId ?? '')?.special;
    if (sp?.onTurnStart !== undefined) this.runHook(sp.onTurnStart, p, p.hero, null, {});

    // 定身 / 假死：跳过本回合
    const skip = p.hero.statuses.find((s) => (s.kind === 'stun' || s.kind === 'fakedeath') && s.turns > 0);
    if (skip !== undefined) {
      this.emit('card', `${p.name} ${skip.kind === 'stun' ? '被定身' : '处于假死'}，本回合无法行动`);
      this.endTurnInternal('stun');
    }
  }

  endTurn(id: string): ActionResult {
    if (this.phase !== 'PLAYING') return fail(ERROR_CODE.BAD_PHASE, '当前不在对战阶段');
    if (id !== this.currentId) return fail(ERROR_CODE.NOT_YOUR_TURN, '还没到你的回合');
    this.endTurnInternal('manual');
    return OK;
  }

  private endTurnInternal(_reason: 'manual' | 'timeout' | 'stun' | 'death'): void {
    const p = this.current();
    if (p !== undefined && p.hero !== null && p.hero.alive) {
      // 剧毒：回合结束受伤
      const poison = p.hero.statuses.filter((s) => s.kind === 'poison' && s.turns > 0);
      for (const s of poison) this.dealDamage(p, p, s.value, 'magic', false, '剧毒');
      // 看破：回合结束额外抽 1 张
      if (this.foreseeFlag || this.modsOf(p).foresee) {
        const c = this.deck?.draw();
        if (c !== undefined && c !== null) p.hero.hand.push(c);
      }
      // 状态回合数递减（-1 常驻不递减）
      for (const s of p.hero.statuses) if (s.turns > 0) s.turns--;
      p.hero.statuses = p.hero.statuses.filter((s) => s.turns !== 0);
    }
    if (this.finished) return;
    this.checkWin();
    if (this.finished) return;

    if (this.pendingExtraTurn) {
      this.pendingExtraTurn = false;
      const again = this.current();
      if (again?.hero?.alive === true) {
        this.emit('card', `${again.name} 获得额外回合！`);
        this.startTurn();
        return;
      }
    }
    // 推进到下一个存活玩家
    for (let i = 1; i <= this.order.length; i++) {
      const idx = (this.turnIndex + i) % this.order.length;
      const q = this.players.get(this.order[idx] ?? '');
      if (q?.hero?.alive === true) {
        this.turnIndex = idx;
        this.turnNo++;
        this.startTurn();
        return;
      }
    }
    // 全场无人存活
    this.finish([]);
  }

  // ── 行动：移动 ──

  move(id: string, x: number, y: number): ActionResult {
    if (this.phase !== 'PLAYING') return fail(ERROR_CODE.BAD_PHASE, '当前不在对战阶段');
    if (id !== this.currentId) return fail(ERROR_CODE.NOT_YOUR_TURN, '还没到你的回合');
    const p = this.current();
    if (p?.hero === undefined || p.hero === null || !p.hero.alive) {
      return fail(ERROR_CODE.BAD_PHASE, '你已出局');
    }
    const hero = p.hero;
    if (this.movesLeft <= 0) return fail(ERROR_CODE.ILLEGAL_MOVE, '本回合移动次数已用完');
    if (hero.statuses.some((s) => s.kind === 'stun' && s.turns > 0)) {
      return fail(ERROR_CODE.ILLEGAL_MOVE, '被定身，无法移动');
    }
    if (!this.grid.inBounds(x, y)) return fail(ERROR_CODE.ILLEGAL_MOVE, '超出地图');
    if (manhattan({ x: hero.x, y: hero.y }, { x, y }) !== 1) {
      return fail(ERROR_CODE.ILLEGAL_MOVE, '每回合只能移动 1 格（上下左右）');
    }
    const mods = this.modsOf(p);
    if (!this.passableAt(x, y, mods.ghost)) return fail(ERROR_CODE.ILLEGAL_MOVE, '目标格不可通行');
    if (this.occupiedByHero(x, y)) return fail(ERROR_CODE.ILLEGAL_MOVE, '目标格已有角色');
    const origin = { x: hero.x, y: hero.y };
    hero.x = x;
    hero.y = y;
    this.movesLeft--;
    this.moveOrigin = origin;
    this.emit('move', `${p.name} 移动到 (${x}, ${y})`);
    this.triggerTraps(p);
    return OK;
  }

  /** 撤回本回合的移动：英雄移回起点，恢复一次移动次数（不重触发陷阱 / 回血）。 */
  undoMove(id: string): ActionResult {
    if (this.phase !== 'PLAYING') return fail(ERROR_CODE.BAD_PHASE, '当前不在对战阶段');
    if (id !== this.currentId) return fail(ERROR_CODE.NOT_YOUR_TURN, '还没到你的回合');
    if (this.moveOrigin === null) return fail(ERROR_CODE.ILLEGAL_MOVE, '本回合还没有移动，无法撤回');
    const p = this.current();
    if (p?.hero === undefined || p.hero === null || !p.hero.alive) {
      return fail(ERROR_CODE.BAD_PHASE, '你已出局');
    }
    p.hero.x = this.moveOrigin.x;
    p.hero.y = this.moveOrigin.y;
    this.movesLeft++;
    this.moveOrigin = null;
    this.emit('move', `${p.name} 撤回了移动`);
    return OK;
  }

  // ── 行动：出牌 / 弃牌 ──

  playCard(id: string, uid: string, targetId?: string, x?: number, y?: number, pick?: string): ActionResult {
    if (this.phase !== 'PLAYING') return fail(ERROR_CODE.BAD_PHASE, '当前不在对战阶段');
    if (id !== this.currentId) return fail(ERROR_CODE.NOT_YOUR_TURN, '还没到你的回合');
    const p = this.current();
    if (p?.hero === undefined || p.hero === null || !p.hero.alive) {
      return fail(ERROR_CODE.BAD_PHASE, '你已出局');
    }
    const hero = p.hero;
    const idx = hero.hand.findIndex((c) => c.uid === uid);
    if (idx < 0) return fail(ERROR_CODE.CARD_NOT_IN_HAND, '手牌中没有这张牌');
    const card = cardById(hero.hand[idx]!.cardId);
    if (card === undefined) return fail(ERROR_CODE.CARD_NOT_IN_HAND, '牌不存在');
    if (this.playedCard) return fail(ERROR_CODE.BAD_PHASE, '本回合已经出过牌');

    if (card.kind === 'item' && card.subtype === 'passive') {
      return fail(ERROR_CODE.CARD_NOT_PLAYABLE, '被动牌不能打出，只能弃掉');
    }
    // 缴械 / 沉默
    if (card.kind === 'general' && card.category === 'atk' &&
        hero.statuses.some((s) => s.kind === 'disarm' && s.turns > 0)) {
      return fail(ERROR_CODE.CARD_NOT_PLAYABLE, '被缴械，无法出攻击牌');
    }
    if (card.kind === 'general' && (card.category === 'skill1' || card.category === 'skill2' || card.category === 'ult') &&
        hero.statuses.some((s) => s.kind === 'silence' && s.turns > 0)) {
      return fail(ERROR_CODE.CARD_NOT_PLAYABLE, '被沉默，无法出技能牌');
    }

    // 数据包 UI：自选一张牌（打出本牌 → 从牌堆任意选一张入手）
    if (card.ui === 'pickCard') {
      if (pick === undefined || pick === '') return fail(ERROR_CODE.BAD_MESSAGE, '请先在面板中选择一张牌');
      const chosen = cardById(pick);
      if (chosen === undefined) return fail(ERROR_CODE.BAD_MESSAGE, '所选牌不存在');
      const inst = this.deck?.spawn(pick);
      if (inst != null) hero.hand.push(inst);
      this.finishPlay(p, idx, `${p.name} 打出【${card.name}】，获得了【${chosen.name}】`);
      this.checkWin();
      return OK;
    }

    // 触发牌：效果取自英雄技能；桃取自牌面
    let effects: EffectDef[];
    let targeting = card.targeting;
    let label = card.name;
    if (card.kind === 'general') {
      const def = heroById(hero.heroId);
      if (card.category === 'heal') {
        effects = [{ op: 'heal', amount: this.opts.cfg.healCardAmount }];
      } else if (card.category === 'atk') {
        effects = [];
        const tr = this.validateAttack(p, def, targetId);
        if (!tr.ok) return tr;
        const atk = def!.attack;
        const tp = this.players.get(targetId!)!;
        this.dealDamage(p, tp, atk.damage,
          atk.type === 'magic' ? 'magic' : 'physical', atk.type === 'melee', '普攻');
        this.finishPlay(p, idx, `${p.name} 打出【${label}】`);
        this.checkWin();
        return OK;
      } else {
        const skill = card.category === 'skill1' ? def?.skill1 : card.category === 'skill2' ? def?.skill2 : def?.ult;
        if (skill === undefined) return fail(ERROR_CODE.BAD_MESSAGE, '技能缺失');
        effects = skill.effects;
        targeting = skill.targeting;
        label = `${card.name}·${skill.name}`;
      }
    } else {
      effects = card.effects;
    }

    // 目标校验
    let targetHero: HeroRt | null = null;
    let tile: Pos | null = null;
    if (targeting === 'enemy' || targeting === 'ally') {
      const q = targetId === undefined ? undefined : this.players.get(targetId);
      if (q?.hero === undefined || q.hero === null || !q.hero.alive) {
        return fail(ERROR_CODE.BAD_TARGET, '目标不存在或已出局');
      }
      if (targeting === 'enemy' && q.team === p.team) return fail(ERROR_CODE.BAD_TARGET, '不能攻击队友');
      if (targeting === 'ally' && q.team !== p.team) return fail(ERROR_CODE.BAD_TARGET, '只能选择队友');
      targetHero = q.hero;
    } else if (targeting === 'tile') {
      if (x === undefined || y === undefined || !this.grid.inBounds(x, y)) {
        return fail(ERROR_CODE.BAD_TARGET, '需要指定地图格');
      }
      tile = { x, y };
    }

    this.applyEffects(p, targetHero, tile, effects);
    this.finishPlay(p, idx, `${p.name} 打出【${label}】`);
    this.checkWin();
    return OK;
  }

  /** 普攻目标校验：远(视线)/近(8格)/法(不限)。 */
  private validateAttack(p: PlayerRt, def: ReturnType<typeof heroById>, targetId?: string): ActionResult {
    if (targetId === undefined) return fail(ERROR_CODE.BAD_TARGET, '需要选择攻击目标');
    const q = this.players.get(targetId);
    if (q?.hero === undefined || q.hero === null || !q.hero.alive) {
      return fail(ERROR_CODE.BAD_TARGET, '目标不存在或已出局');
    }
    if (q.team === p.team) return fail(ERROR_CODE.BAD_TARGET, '不能攻击队友');
    const atk = def?.attack;
    if (atk === undefined) return fail(ERROR_CODE.BAD_MESSAGE, '英雄数据缺失');
    const from = { x: p.hero!.x, y: p.hero!.y };
    const to = { x: q.hero.x, y: q.hero.y };
    if (atk.type === 'ranged') {
      if (!this.losClear(from, to)) return fail(ERROR_CODE.NO_LOS, '视线被阻挡，无法攻击');
    } else if (atk.type === 'melee') {
      if (chebyshev(from, to) > 1) return fail(ERROR_CODE.OUT_OF_RANGE, '近战只能打周围 8 格');
    }
    return OK;
  }

  discardCard(id: string, uid: string): ActionResult {
    if (this.phase !== 'PLAYING') return fail(ERROR_CODE.BAD_PHASE, '当前不在对战阶段');
    if (id !== this.currentId) return fail(ERROR_CODE.NOT_YOUR_TURN, '还没到你的回合');
    const p = this.players.get(id);
    if (p?.hero === undefined || p.hero === null) return fail(ERROR_CODE.NOT_IN_ROOM, '你不在该房间');
    if (this.playedCard) return fail(ERROR_CODE.BAD_PHASE, '本回合已经出过牌，不能再弃牌');
    if (this.discardedThisTurn >= 1) return fail(ERROR_CODE.BAD_PHASE, '本回合只能弃 1 张牌');
    const idx = p.hero.hand.findIndex((c) => c.uid === uid);
    if (idx < 0) return fail(ERROR_CODE.CARD_NOT_IN_HAND, '手牌中没有这张牌');
    const [card] = p.hero.hand.splice(idx, 1);
    if (card !== undefined) this.deck?.discard(card);
    this.discardedThisTurn++;
    this.playedCard = true; // 弃牌与出牌互斥：本回合不能再出牌
    this.emit('card', `${p.name} 弃掉了一张牌`);
    return OK;
  }

  private finishPlay(p: PlayerRt, idx: number, text: string): void {
    const hero = p.hero!;
    const [card] = hero.hand.splice(idx, 1);
    if (card !== undefined) this.deck?.discard(card);
    this.playedCard = true;
    // 出一张补一张（手牌恒 3）
    const drawn = this.deck?.draw();
    if (drawn !== undefined && drawn !== null) hero.hand.push(drawn);
    this.emit('card', text);
  }

  // ── 效果应用 ──

  private applyEffects(actor: PlayerRt, target: HeroRt | null, tile: Pos | null, effects: readonly EffectDef[]): void {
    const hero = actor.hero!;
    // 牌面局部修正（pierce/splash/lifesteal 只对同一张牌内的伤害生效）
    const local: Modifiers = { ...this.modsOf(actor) };
    for (const e of effects) {
      switch (e.op) {
        case 'damage': {
          if (target === null) break;
          const melee = manhattan({ x: hero.x, y: hero.y }, { x: target.x, y: target.y }) <= 1;
          this.dealDamageWith(actor, target, e.amount, e.kind ?? 'physical', melee, local, '卡牌');
          break;
        }
        case 'heal': {
          const t = target ?? hero;
          this.applyHeal(actor, healAmount(e.amount, this.modsOf(actor)), '卡牌', t);
          break;
        }
        case 'draw': {
          for (let i = 0; i < e.count; i++) {
            const c = this.deck?.draw();
            if (c !== undefined && c !== null) hero.hand.push(c);
          }
          break;
        }
        case 'discard': {
          const pool = e.who === 'self' ? hero.hand : (target?.hand ?? []);
          for (let i = 0; i < e.count && pool.length > 0; i++) {
            const j = this.rng.int(pool.length);
            const [c] = pool.splice(j, 1);
            if (c !== undefined) this.deck?.discard(c);
          }
          break;
        }
        case 'steal': {
          if (target === null) break;
          for (let i = 0; i < e.count && target.hand.length > 0; i++) {
            const j = this.rng.int(target.hand.length);
            const [c] = target.hand.splice(j, 1);
            if (c !== undefined) hero.hand.push(c);
          }
          break;
        }
        case 'status': {
          const t = target ?? hero;
          this.addStatus(t, e.status, e.turns, e.value ?? 1);
          break;
        }
        case 'shield': hero.shield += e.amount; break;
        case 'pierce': local.pierce = Math.max(local.pierce, e.ratio); break;
        case 'splash': local.splash = Math.max(local.splash, e.ratio); break;
        case 'lifesteal': local.lifesteal = Math.max(local.lifesteal, e.ratio); break;
        case 'push': if (target !== null) this.displace(actor, target, e.tiles, +1); break;
        case 'pull': if (target !== null) this.displace(actor, target, e.tiles, -1); break;
        case 'teleport': {
          const to = tile ?? (target !== null ? { x: target.x, y: target.y } : null);
          if (to === null) break;
          if (!this.passableAt(to.x, to.y, this.modsOf(actor).ghost) || this.occupiedByHero(to.x, to.y)) break;
          hero.x = to.x;
          hero.y = to.y;
          this.emit('move', `${actor.name} 传送到了 (${to.x}, ${to.y})`);
          this.triggerTraps(actor);
          break;
        }
        case 'swap': {
          if (target === null) break;
          const hx = hero.x, hy = hero.y;
          hero.x = target.x; hero.y = target.y;
          target.x = hx; target.y = hy;
          this.emit('move', `${actor.name} 与目标交换了位置`);
          break;
        }
        case 'move': this.movesLeft += e.tiles; break;
        case 'extraTurn': this.pendingExtraTurn = true; break;
        case 'place': {
          if (tile === null) break;
          if (e.object === 'rock' || e.object === 'altar') {
            this.terrainOverrides.set(posKey(tile), e.object === 'rock' ? 'wall' : 'heal');
          }
          this.placed.push({
            id: `o${++this.placeSeq}`, kind: e.object,
            x: tile.x, y: tile.y, expiresIn: e.expiresIn, ownerTeam: actor.team,
          });
          this.emit('place', `${actor.name} 放置了${e.object === 'trap' ? '陷阱' : e.object === 'rock' ? '岩石' : '祭坛'}`);
          break;
        }
        case 'terrain': {
          if (tile === null) break;
          for (let dy = -e.radius; dy <= e.radius; dy++) {
            for (let dx = -e.radius; dx <= e.radius; dx++) {
              const nx = tile.x + dx, ny = tile.y + dy;
              if (!this.grid.inBounds(nx, ny)) continue;
              this.terrainOverrides.set(posKey({ x: nx, y: ny }), e.to);
            }
          }
          this.emit('place', `${actor.name} 改变了地形`);
          break;
        }
        case 'foresee': this.foreseeFlag = true; break;
        case 'ghost': case 'healBonus': case 'burnImmune': break;
        // ── 数据包引擎：声明式 API 调用 / JavaScript 沙箱 ──
        case 'call': this.runApiFn(actor, target, tile, e.fn, e.args ?? {}); break;
        case 'code': this.runApiCode(actor, target, tile, e.code); break;
        default: break;
      }
    }
  }

  // ── 数据包引擎：游戏 API（≥20 个函数接口，供 manifest steps / JS 沙箱调用） ──

  /** steps 参数顺序表：runApiFn 按 here 顺序把 args 对象展开成位置参数。 */
  private static readonly API_PARAMS: Record<string, string[]> = {
    damage: ['ref', 'amount', 'mode'],
    heal: ['ref', 'amount'],
    shield: ['ref', 'amount'],
    setHp: ['ref', 'hp'],
    hp: ['ref'],
    maxHp: ['ref'],
    alive: ['ref'],
    addStatus: ['ref', 'kind', 'turns', 'value'],
    removeStatus: ['ref', 'kind'],
    grantMove: ['tiles'],
    extraTurn: [],
    drawCards: ['count'],
    discardRandom: ['ref', 'count'],
    stealCards: ['from', 'count'],
    exchangeHands: ['ref'],
    teleportTo: ['ref', 'x', 'y'],
    teleportToWall: [],
    teleportRandomAll: [],
    sendToSpawn: ['ref'],
    swapPositions: ['ref'],
    push: ['ref', 'tiles'],
    pull: ['ref', 'tiles'],
    placeTrap: ['damage'],
    placeRock: [],
    placeAltar: [],
    crossTiles: ['blockedByWall'],
    enemiesInTiles: ['tiles'],
    enemiesInRadius: ['ref', 'radius'],
    allies: ['ref'],
    aliveEnemies: ['ref'],
    randomInt: ['n'],
    announce: ['text'],
    terrainAt: ['ref'],
    pos: ['ref'],
    placeTrapAt: ['x', 'y', 'damage'],
    isWall: ['x', 'y'],
    inBounds: ['x', 'y'],
  };

  /** 解析英雄引用：'self' | 'target' | playerId（不接受任意对象，防越权）。 */
  private apiResolve(actor: PlayerRt, target: HeroRt | null, ref: unknown): HeroRt | null {
    if (ref === 'self' || ref === undefined || ref === null) return actor.hero;
    if (ref === 'target') return target;
    if (typeof ref === 'string') {
      const q = this.players.get(ref);
      if (q?.hero != null) return q.hero;
      for (const p of this.players.values()) if (p.hero?.heroId === ref) return p.hero;
    }
    return null;
  }

  private runApiFn(
    actor: PlayerRt, target: HeroRt | null, tile: Pos | null,
    fn: string, args: Record<string, unknown>,
  ): void {
    const api = this.buildApi(actor, target, tile);
    const f = api[fn];
    if (typeof f !== 'function') {
      this.emit('card', `未知游戏函数：${fn}`);
      return;
    }
    const order = Match.API_PARAMS[fn];
    const argv = order === undefined ? [args] : order.map((k) => args[k]);
    try {
      (f as (...a: unknown[]) => unknown)(...argv);
    } catch (err) {
      this.emit('card', `函数 ${fn} 执行出错：${String(err).slice(0, 80)}`);
    }
  }

  /** 在沙箱中执行数据包 JavaScript（ctx 可被脚本修改，如 onDamaged 的 ctx.amount）。 */
  private runApiCode(
    actor: PlayerRt, target: HeroRt | null, tile: Pos | null, code: string,
  ): void {
    try {
      const sandbox = {
        api: shield(this.buildApi(actor, target, tile)),
        self: actor.id,
        target: target?.playerId ?? null,
        tile: tile === null ? null : shield({ x: tile.x, y: tile.y }),
        ctx: shield({ x: tile?.x ?? null, y: tile?.y ?? null }),
      };
      runSandboxed(code, sandbox);
    } catch (err) {
      this.emit('card', `脚本执行出错：${String(err).slice(0, 80)}`);
    }
  }

  /** 行为钩子（onTurnStart / onDamaged / onDeath）。 */
  private runHook(
    code: string, player: PlayerRt, hero: HeroRt | null, tile: Pos | null, ctx: Record<string, unknown>,
  ): void {
    try {
      const sandbox = { api: shield(this.buildApi(player, null, tile)), self: player.id, ctx: shield(ctx) };
      runSandboxed(code, sandbox);
    } catch (err) {
      this.emit('card', `钩子执行出错：${String(err).slice(0, 80)}`);
    }
  }

  /** 构建绑定到当前出牌上下文的游戏 API（ref 统一为 'self'/'target'/playerId 字符串）。 */
  private buildApi(actor: PlayerRt, target: HeroRt | null, tile: Pos | null): Record<string, (...a: never[]) => unknown> {
    const M = this;
    const res = (ref: unknown): HeroRt | null => M.apiResolve(actor, target, ref);
    const moveHeroTo = (h: HeroRt, x: number, y: number): boolean => {
      if (!M.grid.inBounds(x, y)) return false;
      const q = M.players.get(h.playerId);
      if (q === undefined) return false;
      if (!M.passableAt(x, y, M.modsOf(q).ghost) || M.occupiedByHero(x, y)) return false;
      h.x = x;
      h.y = y;
      M.emit('move', `${M.nameOf(h.playerId)} 移动到 (${x}, ${y})`);
      M.triggerTraps(q);
      return true;
    };
    const api = {
      /** 造成伤害，返回实际伤害值。mode：'FAR' 远 / 'NER' 近 / 'MAG' 法。 */
      damage(ref: unknown, amount = 1, mode = 'FAR'): number {
        const h = res(ref);
        if (h === null || !h.alive) return 0;
        const kind = mode === 'MAG' ? 'magic' : 'physical';
        const before = h.hp + h.shield;
        M.dealDamageWith(actor, h, Math.max(0, Number(amount) || 0), kind, mode === 'NER', M.modsOf(actor), '效果');
        return before - (h.hp + h.shield);
      },
      heal(ref: unknown, amount = 1): number {
        const h = res(ref);
        if (h === null) return 0;
        const q = M.players.get(h.playerId);
        if (q === undefined) return 0;
        const before = h.hp;
        M.applyHeal(q, Math.max(0, Number(amount) || 0), '效果', h);
        return h.hp - before;
      },
      shield(ref: unknown, amount = 1): void {
        const h = res(ref);
        if (h !== null) h.shield += Math.max(0, Number(amount) || 0);
      },
      setHp(ref: unknown, hp = 1): void {
        const h = res(ref);
        if (h === null) return;
        h.hp = Math.max(0, Math.min(h.maxHp, Number(hp) || 0));
        if (h.hp > 0 && !h.alive) {
          h.alive = true;
          M.emit('heal', `${M.nameOf(h.playerId)} 重新站起来了！`);
        }
      },
      hp(ref: unknown): number { return res(ref)?.hp ?? 0; },
      maxHp(ref: unknown): number { return res(ref)?.maxHp ?? 0; },
      alive(ref: unknown): boolean { return res(ref)?.alive === true; },
      addStatus(ref: unknown, kind = 'stun', turns = 1, value = 1): void {
        const h = res(ref);
        if (h !== null) M.addStatus(h, String(kind) as StatusKind, Number(turns) || 0, Number(value) || 1);
      },
      removeStatus(ref: unknown, kind = ''): void {
        const h = res(ref);
        if (h !== null) h.statuses = h.statuses.filter((s) => s.kind !== kind);
      },
      grantMove(tiles = 1): void { M.movesLeft += Math.max(0, Number(tiles) || 0); },
      extraTurn(): void { M.pendingExtraTurn = true; },
      drawCards(count = 1): void {
        const h = actor.hero;
        if (h === null) return;
        for (let i = 0; i < (Number(count) || 0); i++) {
          const c = M.deck?.draw();
          if (c !== undefined && c !== null) h.hand.push(c);
        }
      },
      discardRandom(ref: unknown, count = 1): void {
        const h = res(ref);
        if (h === null) return;
        for (let i = 0; i < (Number(count) || 0) && h.hand.length > 0; i++) {
          const j = M.rng.int(h.hand.length);
          const [c] = h.hand.splice(j, 1);
          if (c !== undefined) M.deck?.discard(c);
        }
      },
      stealCards(from: unknown, count = 1): void {
        const f = res(from);
        if (f === null || actor.hero === null) return;
        for (let i = 0; i < (Number(count) || 0) && f.hand.length > 0; i++) {
          const j = M.rng.int(f.hand.length);
          const [c] = f.hand.splice(j, 1);
          if (c !== undefined) actor.hero.hand.push(c);
        }
      },
      exchangeHands(ref: unknown): void {
        const f = res(ref);
        if (f === null || actor.hero === null) return;
        const tmp = actor.hero.hand;
        actor.hero.hand = f.hand;
        f.hand = tmp;
        M.emit('card', `${actor.name} 与 ${M.nameOf(f.playerId)} 交换了手牌`);
      },
      teleportTo(ref: unknown, x = 0, y = 0): void {
        const h = res(ref);
        if (h === null) return;
        if (!moveHeroTo(h, Number(x), Number(y))) {
          M.emit('card', `无法移动到 (${x}, ${y})`);
        }
      },
      teleportToWall(): void {
        const walls: Pos[] = [];
        for (let y = 0; y < M.mapDef.height; y++) {
          for (let x = 0; x < M.mapDef.width; x++) {
            if (M.tileAt(x, y) === 'wall') walls.push({ x, y });
          }
        }
        if (walls.length === 0 || actor.hero === null) return;
        const w = walls[M.rng.int(walls.length)]!;
        if (!moveHeroTo(actor.hero, w.x, w.y)) M.emit('card', '没有可传送的墙格');
      },
      teleportRandomAll(): void {
        for (const q of M.players.values()) {
          if (q.hero?.alive !== true) continue;
          for (let tries = 0; tries < 60; tries++) {
            const x = M.rng.int(M.mapDef.width);
            const y = M.rng.int(M.mapDef.height);
            if (moveHeroTo(q.hero, x, y)) break;
          }
        }
        M.emit('move', '地图被摇晃了，所有人被随机传送！');
      },
      sendToSpawn(ref: unknown): void {
        const h = res(ref);
        if (h === null) return;
        const free = M.mapDef.spawns.filter((s) => !M.occupiedByHero(s.x, s.y));
        const to = free[0] ?? M.mapDef.spawns[0];
        if (to === undefined || !moveHeroTo(h, to.x, to.y)) M.emit('card', '没有可用出生点');
      },
      swapPositions(ref: unknown): void {
        const f = res(ref);
        const h = actor.hero;
        if (f === null || h === null) return;
        const tx = f.x, ty = f.y;
        f.x = h.x; f.y = h.y;
        h.x = tx; h.y = ty;
        M.emit('move', `${actor.name} 与 ${M.nameOf(f.playerId)} 交换了位置`);
        const qa = M.players.get(h.playerId);
        const qb = M.players.get(f.playerId);
        if (qa !== undefined) M.triggerTraps(qa);
        if (qb !== undefined) M.triggerTraps(qb);
      },
      push(ref: unknown, tiles = 1): void {
        const h = res(ref);
        if (h !== null) M.displace(actor, h, Math.max(0, Number(tiles) || 0), 1);
      },
      pull(ref: unknown, tiles = 1): void {
        const h = res(ref);
        if (h !== null) M.displace(actor, h, Math.max(0, Number(tiles) || 0), -1);
      },
      /** 放置地刺（一次性陷阱，踩中扣 damage 点）。默认放在目标格 / 自己脚下。 */
      placeTrap(damage = 3): void {
        const at = tile ?? { x: actor.hero!.x, y: actor.hero!.y };
        M.placed.push({
          id: `o${++M.placeSeq}`, kind: 'trap',
          x: at.x, y: at.y, expiresIn: 999, ownerTeam: actor.team, value: Math.max(1, Number(damage) || 3),
        });
        M.emit('place', `${actor.name} 埋设了地刺`);
      },
      /** 放置岩石（把目标格变成墙）。 */
      placeRock(): void {
        const at = tile ?? { x: actor.hero!.x, y: actor.hero!.y };
        M.placed.push({ id: `o${++M.placeSeq}`, kind: 'rock', x: at.x, y: at.y, expiresIn: 999, ownerTeam: actor.team });
        M.terrainOverrides.set(posKey(at), 'wall');
        M.emit('place', `${actor.name} 放置了岩石`);
      },
      /** 放置祭坛（把目标格变成回血点）。 */
      placeAltar(): void {
        const at = tile ?? { x: actor.hero!.x, y: actor.hero!.y };
        M.placed.push({ id: `o${++M.placeSeq}`, kind: 'altar', x: at.x, y: at.y, expiresIn: 999, ownerTeam: actor.team });
        M.terrainOverrides.set(posKey(at), 'heal');
        M.emit('place', `${actor.name} 放置了祭坛`);
      },
      /** 以自身为原点的十字格（blockedByWall=true 时被墙阻挡）。 */
      crossTiles(blockedByWall = true): { x: number; y: number }[] {
        const h = actor.hero!;
        const out: { x: number; y: number }[] = [];
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
          let x = h.x + dx;
          let y = h.y + dy;
          while (M.grid.inBounds(x, y)) {
            out.push({ x, y });
            if (blockedByWall === true && M.tileAt(x, y) === 'wall') break;
            x += dx;
            y += dy;
          }
        }
        return out;
      },
      enemiesInTiles(tiles: { x: number; y: number }[] = []): string[] {
        const ids: string[] = [];
        for (const q of M.players.values()) {
          if (q.hero?.alive !== true || q.team === actor.team) continue;
          if (tiles.some((t) => t.x === q.hero!.x && t.y === q.hero!.y)) ids.push(q.id);
        }
        return ids;
      },
      enemiesInRadius(ref: unknown, radius = 2): string[] {
        const h = res(ref);
        if (h === null) return [];
        const ids: string[] = [];
        for (const q of M.players.values()) {
          if (q.hero?.alive !== true || q.team === actor.team) continue;
          if (chebyshev({ x: q.hero.x, y: q.hero.y }, { x: h.x, y: h.y }) <= Math.max(0, Number(radius) || 0)) {
            ids.push(q.id);
          }
        }
        return ids;
      },
      allies(ref: unknown): string[] {
        const h = res(ref);
        if (h === null) return [];
        const ids: string[] = [];
        for (const q of M.players.values()) {
          if (q.hero?.alive !== true || q.id === h.playerId || q.team !== actor.team) continue;
          ids.push(q.id);
        }
        return ids;
      },
      aliveEnemies(ref: unknown): string[] {
        const h = res(ref);
        if (h === null) return [];
        const ids: string[] = [];
        for (const q of M.players.values()) {
          if (q.hero?.alive !== true || q.team === actor.team) continue;
          ids.push(q.id);
        }
        return ids;
      },
      randomInt(n = 2): number { return M.rng.int(Math.max(1, Number(n) || 1)); },
      announce(text = ''): void { M.emit('card', String(text)); },
      terrainAt(ref: unknown): string {
        const h = res(ref);
        if (h === null) return '.';
        const t = M.tileAt(h.x, h.y);
        return t === 'wall' ? '#' : t === 'water' ? '~' : t === 'spawn' ? 'S' : t === 'heal' ? 'H' : '.';
      },
      pos(ref: unknown): { x: number; y: number } | null {
        const h = res(ref);
        return h === null ? null : { x: h.x, y: h.y };
      },
      placeTrapAt(x = 0, y = 0, damage = 3): void {
        if (!M.grid.inBounds(Number(x), Number(y))) return;
        M.placed.push({
          id: `o${++M.placeSeq}`, kind: 'trap',
          x: Number(x), y: Number(y), expiresIn: 999, ownerTeam: actor.team, value: Math.max(1, Number(damage) || 3),
        });
        M.emit('place', `${actor.name} 埋设了地刺 (${x}, ${y})`);
      },
      isWall(x = 0, y = 0): boolean { return M.tileAt(Number(x), Number(y)) === 'wall'; },
      inBounds(x = 0, y = 0): boolean { return M.grid.inBounds(Number(x), Number(y)); },
      selfId: actor.id,
      targetId: target?.playerId ?? null,
    };
    return api as unknown as Record<string, (...a: never[]) => unknown>;
  }

  private addStatus(hero: HeroRt, kind: StatusKind, turns: number, value: number): void {
    const exist = hero.statuses.find((s) => s.kind === kind && s.turns > 0);
    if (exist !== undefined) {
      exist.turns = Math.max(exist.turns, turns);
      exist.value = Math.max(exist.value, value);
      return;
    }
    hero.statuses.push({ kind, turns, value });
  }

  /** 推 / 拉：沿远离 / 靠近施法者方向逐格移动，遇障碍停止。 */
  private displace(actor: PlayerRt, target: HeroRt, tiles: number, dir: 1 | -1): void {
    const hero = actor.hero!;
    let cx = target.x, cy = target.y;
    const sx = Math.sign(hero.x - target.x) * dir;
    const sy = Math.sign(hero.y - target.y) * dir;
    for (let i = 0; i < tiles; i++) {
      const nx = cx + sx, ny = cy + sy;
      if (!this.grid.inBounds(nx, ny) || !this.passableAt(nx, ny, false) || this.occupiedByHero(nx, ny)) break;
      cx = nx; cy = ny;
    }
    if (cx !== target.x || cy !== target.y) {
      target.x = cx; target.y = cy;
      this.emit('move', '目标被位移了');
      const owner = this.players.get(target.playerId);
      if (owner !== undefined) this.triggerTraps(owner);
    }
  }

  // ── 伤害 / 治疗 / 死亡 ──

  private dealDamage(actor: PlayerRt, target: PlayerRt, amount: number, kind: 'physical' | 'magic', melee: boolean, label: string): void {
    this.dealDamageWith(actor, target.hero!, amount, kind, melee, this.modsOf(actor), label);
  }

  private dealDamageWith(
    actor: PlayerRt | null, target: HeroRt, amount: number, kind: 'physical' | 'magic',
    melee: boolean, local: Modifiers, label: string,
  ): void {
    const targetPlayer = this.players.get(target.playerId);
    const defMods = targetPlayer !== undefined
      ? this.modsOf(targetPlayer)
      : actor !== null ? this.modsOf(actor) : emptyModifiers();

    // 假死：无敌
    if (target.statuses.some((s) => s.kind === 'fakedeath' && s.turns > 0)) {
      this.emit('damage', `${this.nameOf(target.playerId)} 处于假死状态，免疫了这次伤害`);
      return;
    }

    // 数据包钩子：onDamaged（可减免 / 免除）
    const attackType = kind === 'magic' ? 'MAG' : melee ? 'NER' : 'FAR';
    const hookCtx: { amount: number; attackType: string; melee: boolean; cancelled: boolean } =
      { amount, attackType, melee, cancelled: false };
    const sp = targetPlayer !== undefined && targetPlayer.heroId !== null ? heroById(targetPlayer.heroId)?.special : undefined;
    if (sp?.onDamaged !== undefined && targetPlayer !== undefined) {
      this.runHook(sp.onDamaged, targetPlayer, target, null, hookCtx);
      if (hookCtx.cancelled) {
        this.emit('damage', `${this.nameOf(target.playerId)} 免除了这次伤害`);
        return;
      }
      amount = hookCtx.amount;
    }

    let dmg = Math.max(0, amount);
    if (kind === 'magic' && defMods.magicVeil > 0) {
      dmg = Math.max(0, dmg - defMods.magicVeil * (1 - local.pierce));
    }
    const absorbed = Math.min(target.shield, dmg);
    target.shield -= absorbed;
    dmg -= absorbed;
    target.hp -= dmg;
    this.emit('damage', `${this.nameOf(target.playerId)} 受到 ${dmg + absorbed} 点${label}伤害` +
      (absorbed > 0 ? `（护盾吸收 ${absorbed}）` : ''));

    // 吸血
    if (local.lifesteal > 0 && actor !== null && actor.hero !== null) {
      const back = Math.floor(amount * local.lifesteal);
      if (back > 0) this.applyHeal(actor, back, '吸血');
    }
    // 溅射（不再递归）
    if (local.splash > 0 && actor !== null) {
      for (const q of this.players.values()) {
        if (q.hero === null || !q.hero.alive || q.hero === target) continue;
        if (q.team === actor.team) continue;
        if (chebyshev({ x: q.hero.x, y: q.hero.y }, { x: target.x, y: target.y }) > 1) continue;
        this.dealDamageWith(actor, q.hero, Math.floor(amount * local.splash), kind, false, local, '溅射');
      }
    }
    // 荆棘（近战物理）/ 反弹
    if (melee && kind === 'physical' && defMods.thorn > 0 && actor !== null && actor.hero !== null && actor.hero.alive) {
      this.dealDamageWith(targetPlayer ?? actor, actor.hero, defMods.thorn, 'physical', false, defMods, '荆棘');
    }
    if (defMods.reflect > 0 && actor !== null && actor.hero !== null && actor.hero.alive) {
      this.dealDamageWith(targetPlayer ?? actor, actor.hero, defMods.reflect, 'magic', false, defMods, '反弹');
    }
    if (target.hp <= 0 && target.alive) this.killHero(target, actor);
  }

  private applyHeal(p: PlayerRt, amount: number, label: string, heroOverride?: HeroRt): void {
    const hero = heroOverride ?? p.hero;
    if (hero === null || !hero.alive || amount <= 0) return;
    const before = hero.hp;
    hero.hp = Math.min(hero.maxHp, hero.hp + amount);
    if (hero.hp > before) {
      this.emit('heal', `${this.nameOf(hero.playerId)} 回复 ${hero.hp - before} HP（${label}）`);
    }
  }

  private killHero(hero: HeroRt, killer: PlayerRt | null): void {
    // 数据包钩子：onDeath（英雄特殊属性 / 持有的被动牌）——把 hp 恢复到 >0 可免死
    const victimPlayer = this.players.get(hero.playerId);
    if (victimPlayer !== undefined) {
      const sp = heroById(victimPlayer.heroId ?? '')?.special;
      if (sp?.onDeath !== undefined) {
        this.runHook(sp.onDeath, victimPlayer, hero, null, {});
        if (hero.hp > 0) {
          this.emit('death', `${this.nameOf(hero.playerId)} 免除了淘汰！`);
          return;
        }
      }
      for (const c of hero.hand) {
        const def = cardById(c.cardId);
        if (def?.hooks?.onDeath === undefined) continue;
        this.runHook(def.hooks.onDeath, victimPlayer, hero, null, {});
        if (hero.hp > 0) {
          this.emit('death', `${this.nameOf(hero.playerId)} 免除了淘汰！`);
          return;
        }
      }
    }
    hero.alive = false;
    hero.hp = 0;
    hero.statuses = [];
    for (const c of hero.hand) this.deck?.discard(c);
    hero.hand = [];
    if (killer !== null && killer.id !== hero.playerId) killer.kills++;
    const victim = this.players.get(hero.playerId);
    if (victim !== undefined) victim.place = ++this.deathSeq + (this.players.size - this.deathSeq);
    this.emit('death', `${this.nameOf(hero.playerId)} 被淘汰了`);
  }

  /** 检查是否只剩一队 → 结束对局（淘汰/掉线后调用）。 */
  checkWin(): void {
    if (this.phase !== 'PLAYING') return;
    const aliveTeams = new Set<number>();
    for (const p of this.players.values()) if (p.hero?.alive === true) aliveTeams.add(p.team);
    if (aliveTeams.size <= 1) this.finish([...aliveTeams]);
  }

  private finish(winners: number[], reason = ''): void {
    if (this.finished) return;
    this.finished = true;
    this.phase = 'FINISHED';
    this.winners = winners;
    this.abortReason = reason;
    const list: Standing[] = [...this.players.values()]
      .sort((a, b) => {
        const pa = a.place === 0 ? 1 : a.place;
        const pb = b.place === 0 ? 1 : b.place;
        return pa - pb;
      })
      .map((p) => ({
        playerId: p.id, name: p.name, team: p.team,
        place: p.place === 0 ? 1 : p.place,
        heroName: heroById(p.heroId ?? '')?.name ?? '—', kills: p.kills,
      }));
    this.standings = list;
    this.emit('result', reason !== '' ? reason : winners.length === 0 ? '平局！' : `队伍 ${winners.map((w) => w + 1).join('/')} 获胜！`);
  }

  /** 中止对局（如房主退出）：判为结束、无胜者，并记录原因。 */
  abort(reason: string): void {
    if (this.finished) return;
    this.finish([], reason);
  }

  /** 房主重开：保留玩家与队伍，清空对局状态。 */
  restart(id: string): ActionResult {
    if (id !== this.hostId) return fail(ERROR_CODE.NOT_HOST, '只有房主可以重开');
    if (this.phase !== 'FINISHED') return fail(ERROR_CODE.BAD_PHASE, '对局尚未结束');
    this.phase = 'WAITING';
    this.order = [];
    this.turnIndex = -1;
    this.turnNo = 0;
    this.deck = null;
    this.placed = [];
    this.finished = false;
    this.winners = [];
    this.standings = [];
    this.abortReason = '';
    this.terrainOverrides.clear();
    this.pendingExtraTurn = false;
    for (const p of this.players.values()) {
      p.heroId = null;
      p.hero = null;
      p.kills = 0;
      p.place = 0;
    }
    this.emit('phase', '房主重开了对局，重新选择英雄');
    return OK;
  }

  // ── 定时器 ──

  tick(now: number): void {
    if (this.phase === 'HERO_SELECT' && now >= this.phaseEndsAt) this.finishHeroSelect();
    else if (this.phase === 'SPAWN_SELECT' && now >= this.phaseEndsAt) {
      const used = new Set([...this.players.values()].map((q) => q.hero?.spawnIdx ?? -1));
      for (const p of this.players.values()) {
        if (p.hero !== null && p.hero.spawnIdx < 0) {
          const free = this.mapDef.spawns
            .map((_, i) => i)
            .filter((i) => !used.has(i));
          const idx = free[0] ?? 0;
          const s = this.mapDef.spawns[idx];
          if (s !== undefined) {
            p.hero.spawnIdx = idx;
            p.hero.x = s.x;
            p.hero.y = s.y;
            used.add(idx);
          }
        }
      }
      this.beginPlay();
    } else if (this.phase === 'PLAYING' && now >= this.turnEndsAt) {
      this.emit('turn', '回合超时，自动结束');
      this.endTurnInternal('timeout');
    }
    // 放置物到期
    if (this.placed.length > 0) {
      for (const o of this.placed) o.expiresIn--;
      const expired = this.placed.filter((o) => o.expiresIn <= 0);
      for (const o of expired) {
        if (o.kind === 'rock' || o.kind === 'altar') this.terrainOverrides.delete(posKey({ x: o.x, y: o.y }));
      }
      this.placed = this.placed.filter((o) => o.expiresIn > 0);
    }
  }

  // ── 掉线 / 重连 ──

  onDisconnect(id: string, now: number, graceMs: number): void {
    const p = this.players.get(id);
    if (p === undefined) return;
    p.connected = false;
    p.disconnectAt = now;
    this.emit('leave', `${p.name} 掉线，${Math.round(graceMs / 1000)} 秒内可重连`);
    if (this.phase === 'PLAYING' && this.currentId === id) this.endTurnInternal('death');
  }

  onReconnect(id: string): void {
    const p = this.players.get(id);
    if (p === undefined) return;
    p.connected = true;
    p.disconnectAt = 0;
    this.emit('join', `${p.name} 重连了`);
  }

  /** 掉线超过宽限 → 判出局。 */
  sweepDisconnected(now: number, graceMs: number): void {
    for (const p of [...this.players.values()]) {
      if (!p.connected && p.disconnectAt > 0 && now - p.disconnectAt >= graceMs) {
        const wasHost = p.id === this.hostId;
        if (p.hero?.alive === true) {
          this.killHero(p.hero, null);
          this.emit('leave', `${p.name} 超时未重连，判为出局`);
          this.checkWin();
        }
        this.players.delete(p.id);
        this.recomputeOrder();
        if (wasHost && this.phase !== 'WAITING' && this.phase !== 'FINISHED') {
          this.abort('房主掉线超时，对局结束');
        }
      }
    }
  }

  // ── 查询 / 快照 ──

  private nameOf(id: string): string {
    return this.players.get(id)?.name ?? '某人';
  }

  private tileAt(x: number, y: number): Terrain {
    return this.terrainOverrides.get(posKey({ x, y })) ?? this.grid.terrainAt(x, y);
  }

  passableAt(x: number, y: number, ghost: boolean): boolean {
    const t = this.tileAt(x, y);
    if (t === 'wall') return ghost;
    return this.grid.inBounds(x, y);
  }

  /** 视线：墙（含放置的岩石）阻挡。 */
  losClear(a: Pos, b: Pos): boolean {
    return this.grid.losClear(a, b, (x, y) => this.tileAt(x, y) === 'wall');
  }

  occupiedByHero(x: number, y: number): boolean {
    for (const p of this.players.values()) {
      if (p.hero?.alive === true && p.hero.x === x && p.hero.y === y) return true;
    }
    return false;
  }

  /** 陷阱：敌人踩上扣血并移除。 */
  private triggerTraps(p: PlayerRt): void {
    if (p.hero === null) return;
    const i = this.placed.findIndex(
      (o) => o.kind === 'trap' && o.x === p.hero!.x && o.y === p.hero!.y && o.ownerTeam !== p.team,
    );
    if (i < 0) return;
    const [trap] = this.placed.splice(i, 1);
    if (trap !== undefined) {
      this.emit('place', `${p.name} 踩到了陷阱！`);
      // 陷阱主人可能已离开/被移除：此时 attacker 为 null（不能退化成踩雷者，否则会自吸血/自反伤）
      const owner = this.players.get(this.order.find((id) => this.players.get(id)?.team === trap.ownerTeam) ?? '') ?? null;
      this.dealDamageWith(owner, p.hero, trap.value ?? 3, 'physical', false,
        owner !== null ? this.modsOf(owner) : emptyModifiers(), '陷阱');
      this.checkWin();
    }
  }

  isInMatch(id: string): boolean {
    return this.players.has(id);
  }

  playerCount(): number {
    return this.players.size;
  }

  roomState(): RoomState {
    const players: RoomPlayer[] = [...this.players.values()]
      .sort((a, b) => a.seat - b.seat)
      .map((p) => ({
        id: p.id, name: p.name, team: p.team, seat: p.seat,
        host: p.id === this.hostId, connected: p.connected,
      }));
    return {
      roomId: this.opts.roomId, name: this.opts.name, mode: this.opts.mode,
      hostId: this.hostId,
      capacity: this.shape.teams * this.shape.perTeam,
      phase: this.phase,
      endsAt: this.phase === 'PLAYING' ? this.turnEndsAt : this.phaseEndsAt,
      players, turnNo: this.turnNo,
    };
  }

  snapshot(): StatePayload {
    const heroes = [...this.players.values()]
      .filter((p) => p.hero !== null)
      .map((p) => ({
        id: p.id,
        playerId: p.id,
        heroId: p.hero!.heroId,
        name: p.name,
        team: p.team,
        hp: Math.max(0, p.hero!.hp),
        maxHp: p.hero!.maxHp,
        x: p.hero!.x,
        y: p.hero!.y,
        alive: p.hero!.alive,
        statuses: p.hero!.statuses
          .filter((s) => s.turns !== 0)
          .map((s) => ({ kind: s.kind, turns: s.turns })),
        handCount: p.hero!.hand.length,
      }));
    const top = this.deck?.topDiscard ?? null;
    const topDef = top === null ? undefined : cardById(top.cardId);
    return {
      phase: this.phase,
      turnNo: this.turnNo,
      currentId: this.currentId,
      heroes,
      deckCount: this.deck?.remaining ?? 0,
      discardCount: this.deck?.discarded ?? 0,
      topDiscard: topDef === undefined ? null : { id: topDef.id, name: topDef.name, text: topDef.text },
      placed: this.placed.map((o) => ({
        id: o.id, kind: o.kind, x: o.x, y: o.y, expiresIn: o.expiresIn, ownerTeam: o.ownerTeam,
      })),
      endsAt: this.turnEndsAt,
    };
  }

  turnPayload(): TurnPayload | null {
    if (this.phase !== 'PLAYING') return null;
    return {
      turnNo: this.turnNo,
      order: [...this.order],
      currentIndex: this.turnIndex,
      currentId: this.currentId,
      endsAt: this.turnEndsAt,
      moved: this.movesLeft < this.opts.cfg.moveBudget + this.modsOf(this.current() ?? { hero: null } as PlayerRt).moveBonus,
      played: this.playedCard,
      discarded: this.discardedThisTurn > 0,
      moveOrigin: this.moveOrigin,
    };
  }

  handOf(id: string): HandCard[] {
    const p = this.players.get(id);
    if (p?.hero === undefined || p.hero === null) return [];
    const heroDef = heroById(p.hero.heroId);
    return p.hero.hand.map((c) => {
      const def = cardById(c.cardId);
      const passive = def?.kind === 'item' && def.subtype === 'passive';
      // 触发牌：目标与文案按自己英雄的技能解析
      let targeting = def?.targeting ?? 'none';
      let label = def?.name ?? '未知牌';
      let text = def?.text ?? '';
      if (def?.kind === 'general' && def.category !== undefined && def.category !== 'heal') {
        if (def.category === 'atk') {
          targeting = 'enemy';
          text = `普攻（${heroDef?.attack.type === 'ranged' ? '远程' : heroDef?.attack.type === 'melee' ? '近战' : '法术'} ${heroDef?.attack.damage ?? 0} 伤）`;
        } else {
          const skill = def.category === 'skill1' ? heroDef?.skill1
            : def.category === 'skill2' ? heroDef?.skill2 : heroDef?.ult;
          if (skill !== undefined) {
            targeting = skill.targeting;
            label = skill.name; // 仅显示英雄技能名（去掉「技2 ·」前缀）
            text = skill.text;
          }
        }
      }
      return {
        uid: c.uid,
        cardId: c.cardId,
        label,
        kind: def?.kind ?? 'general',
        subtype: def?.subtype,
        category: def?.category,
        targeting,
        text,
        ui: def?.ui,
        playable: !passive,
      };
    });
  }

  mapWire(): MapWire {
    const tiles: string[] = [];
    for (let y = 0; y < this.mapDef.height; y++) {
      let row = '';
      for (let x = 0; x < this.mapDef.width; x++) {
        const t = this.tileAt(x, y);
        row += t === 'wall' ? '#' : t === 'water' ? '~' : t === 'spawn' ? 'S' : t === 'heal' ? 'H' : '.';
      }
      tiles.push(row);
    }
    return {
      width: this.mapDef.width, height: this.mapDef.height, tiles,
      spawns: this.mapDef.spawns, heals: this.mapDef.heals,
    };
  }

  resultPayload(): ResultPayload {
    return { winners: this.winners, standings: this.standings, reason: this.abortReason || undefined };
  }

  heroOptions(): {
    id: string; name: string; maxHp: number;
    attack: { type: string; damage: number }; text: string;
    specialText: string;
    skills: { name: string; text: string }[];
    modifiers: { op: string; [k: string]: unknown }[];
  }[] {
    return getCatalog().heroes.map((h) => ({
      id: h.id, name: h.name, maxHp: h.maxHp,
      attack: { type: h.attack.type, damage: h.attack.damage }, text: h.text,
      specialText: h.special?.text ?? '',
      // 依次 技1 / 技2 / 大：保留 name 与 text（详情），前端据此展示「名称 + 效果」
      skills: [
        { name: h.skill1.name, text: h.skill1.text },
        { name: h.skill2.name, text: h.skill2.text },
        { name: h.ult.name, text: h.ult.text },
      ],
      modifiers: h.modifiers ?? [],
    }));
  }

  /** 可被「自选一张牌」类卡牌选取的牌清单（客户端选牌面板用）。 */
  cardList(): { id: string; name: string; text: string; kind: string }[] {
    return getCatalog().cards
      .filter((c) => c.ui === undefined) // 选牌面板不再嵌套 pickCard
      .map((c) => ({ id: c.id, name: c.name, text: c.text, kind: c.kind }));
  }

  takenHeroes(): string[] {
    return [...this.players.values()]
      .map((p) => p.heroId)
      .filter((h): h is string => h !== null);
  }

  takenSpawns(): number[] {
    const out: number[] = [];
    for (const p of this.players.values()) {
      if (p.hero !== null && p.hero.spawnIdx >= 0) out.push(p.hero.spawnIdx);
    }
    return out;
  }

  teamOf(id: string): number {
    return this.players.get(id)?.team ?? -1;
  }

  /** 后端专用随机会话 ID（进房时分配，仅日志/调试用，不下发前端）。 */
  sessionIdOf(id: string): string {
    return this.players.get(id)?.sessionId ?? '';
  }

  private emit(kind: GameEventKind, text: string, actorId?: string): void {
    this.events.push({ kind, text, actorId, at: Date.now() });
    if (this.events.length > 200) this.events.splice(0, this.events.length - 200);
  }

  drainEvents(): GameEvent[] {
    if (this.events.length === 0) return [];
    const out = this.events;
    this.events = [];
    return out;
  }
}
