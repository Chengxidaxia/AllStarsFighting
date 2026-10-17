var __defProp = Object.defineProperty;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);

// src/server/protocol/types.ts
var ERROR_CODE = {
  BAD_MESSAGE: "BAD_MESSAGE",
  VERSION_MISMATCH: "VERSION_MISMATCH",
  NOT_JOINED: "NOT_JOINED",
  ROOM_NOT_FOUND: "ROOM_NOT_FOUND",
  NOT_IN_ROOM: "NOT_IN_ROOM",
  ROOM_FULL: "ROOM_FULL",
  TOO_MANY_ROOMS: "TOO_MANY_ROOMS",
  BAD_PHASE: "BAD_PHASE",
  NOT_YOUR_TURN: "NOT_YOUR_TURN",
  HERO_TAKEN: "HERO_TAKEN",
  SPAWN_TAKEN: "SPAWN_TAKEN",
  BAD_TARGET: "BAD_TARGET",
  OUT_OF_RANGE: "OUT_OF_RANGE",
  NO_LOS: "NO_LOS",
  ILLEGAL_MOVE: "ILLEGAL_MOVE",
  CARD_NOT_IN_HAND: "CARD_NOT_IN_HAND",
  CARD_NOT_PLAYABLE: "CARD_NOT_PLAYABLE",
  NOT_HOST: "NOT_HOST",
  BAD_TEAM: "BAD_TEAM"
};
function modeShape(mode) {
  switch (mode) {
    case "1v1":
      return { teams: 2, perTeam: 1 };
    case "1v1v1v1":
      return { teams: 4, perTeam: 1 };
    case "2v2":
      return { teams: 2, perTeam: 2 };
    case "3v3":
      return { teams: 2, perTeam: 3 };
    case "4v4":
      return { teams: 2, perTeam: 4 };
    case "2v2v2v2":
      return { teams: 4, perTeam: 2 };
  }
}

// web/engine/store.browser.ts
var catalog = { maps: [], heroes: [], cards: [] };
function setCatalog(next) {
  catalog = next;
}
function getCatalog() {
  return catalog;
}
function heroById(id) {
  return catalog.heroes.find((h) => h.id === id);
}
function cardById(id) {
  return catalog.cards.find((c) => c.id === id);
}
function allCards() {
  return catalog.cards;
}

// src/server/game/deck.ts
var SharedDeck = class {
  constructor(counts, rng) {
    __publicField(this, "counts", counts);
    __publicField(this, "rng", rng);
    /** 主牌堆；用 head 指针抽牌，避免 shift() 的 O(N) 搬移。 */
    __publicField(this, "main", []);
    __publicField(this, "discardPile", []);
    /** 下一张要抽的下标；main[0..head-1] 是已抽过的历史槽位。 */
    __publicField(this, "head", 0);
    __publicField(this, "uidSeq", 0);
    /** 重洗次数（抽空后洗回弃牌堆）。 */
    __publicField(this, "reshuffles", 0);
    this.build();
    this.rng.shuffle(this.main);
  }
  /** 不进牌堆、直接生成一张实体牌（数据包「自选一张牌」用）。 */
  spawn(cardId) {
    if (!this.counts.has(cardId)) return null;
    return { uid: `c${++this.uidSeq}`, cardId };
  }
  build() {
    this.main = [];
    this.head = 0;
    for (const [cardId, count] of this.counts) {
      for (let i = 0; i < count; i++) {
        this.main.push({ uid: `c${++this.uidSeq}`, cardId });
      }
    }
  }
  get remaining() {
    return this.main.length - this.head;
  }
  get discarded() {
    return this.discardPile.length;
  }
  /** 弃牌堆顶（最近打出 / 弃掉的那张）；没有则 null。 */
  get topDiscard() {
    return this.discardPile[this.discardPile.length - 1] ?? null;
  }
  /** 抽一张；主牌堆空则把弃牌堆洗回。返回 null 表示全局无牌。 */
  draw() {
    if (this.head >= this.main.length) {
      if (this.discardPile.length === 0) return null;
      this.main = this.discardPile;
      this.discardPile = [];
      this.head = 0;
      this.rng.shuffle(this.main);
      this.reshuffles++;
    }
    return this.main[this.head++] ?? null;
  }
  /** 弃一张进弃牌堆。 */
  discard(card) {
    this.discardPile.push(card);
  }
  /** 把牌塞回主牌堆顶（偷牌失败回退等场景）。 */
  pushMain(card) {
    if (this.head > 0) {
      this.main[--this.head] = card;
    } else {
      this.main.unshift(card);
    }
  }
};

// src/server/game/grid.ts
function posKey(p) {
  return `${p.x},${p.y}`;
}
function samePos(a, b) {
  return a.x === b.x && a.y === b.y;
}
function manhattan(a, b) {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}
function chebyshev(a, b) {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}
var Grid = class {
  constructor(map) {
    __publicField(this, "map", map);
    __publicField(this, "width");
    __publicField(this, "height");
    this.width = map.width;
    this.height = map.height;
  }
  inBounds(x, y) {
    return x >= 0 && y >= 0 && x < this.width && y < this.height;
  }
  terrainAt(x, y) {
    if (!this.inBounds(x, y)) return "wall";
    const row = this.map.tiles[y];
    if (row === void 0) return "wall";
    return row[x] ?? "wall";
  }
  /** 是否可以站人（非墙、非越界）。水的通行性由调用方决定（当前按正常地块）。 */
  passable(x, y) {
    const t = this.terrainAt(x, y);
    return t !== "wall";
  }
  isHeal(x, y) {
    return this.terrainAt(x, y) === "heal";
  }
  /** 4 邻（上下左右），已过滤越界。 */
  neighbors4(p) {
    const out = [];
    if (p.x > 0) out.push({ x: p.x - 1, y: p.y });
    if (p.x < this.width - 1) out.push({ x: p.x + 1, y: p.y });
    if (p.y > 0) out.push({ x: p.x, y: p.y - 1 });
    if (p.y < this.height - 1) out.push({ x: p.x, y: p.y + 1 });
    return out;
  }
  /**
   * 中心对中心连线是否通畅（远 / ranged 攻击用）。
   * 用 Bresenham 逐格采样，**检查两端点之间**的格子，遇 `wall` 判定遮挡。
   */
  losClear(a, b, isBlocked) {
    const blocked = isBlocked ?? ((x, y) => this.terrainAt(x, y) === "wall");
    let x0 = a.x;
    let y0 = a.y;
    const x1 = b.x;
    const y1 = b.y;
    const dx = Math.abs(x1 - x0);
    const dy = Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let err = dx - dy;
    let guard = 0;
    while (guard++ < 4096) {
      if (x0 === x1 && y0 === y1) return true;
      const e2 = 2 * err;
      if (e2 > -dy) {
        err -= dy;
        x0 += sx;
      }
      if (e2 < dx) {
        err += dx;
        y0 += sy;
      }
      if (x0 === x1 && y0 === y1) return true;
      if (blocked(x0, y0)) return false;
    }
    return true;
  }
  /**
   * 从 from 出发、按 4 邻 BFS 求「可通行且未被其他角色占据」的格子的步数。
   * @param budget 最大步数（含）；返回 Map<"x,y", dist>
   */
  reachable(from, budget, occupied) {
    const result = /* @__PURE__ */ new Map();
    if (budget <= 0) return result;
    const seen = /* @__PURE__ */ new Set([posKey(from)]);
    let frontier = [from];
    for (let step = 1; step <= budget; step++) {
      const next = [];
      for (const p of frontier) {
        for (const n of this.neighbors4(p)) {
          const k = posKey(n);
          if (seen.has(k)) continue;
          if (!this.passable(n.x, n.y)) continue;
          if (occupied.has(k)) continue;
          seen.add(k);
          result.set(k, step);
          next.push(n);
        }
      }
      if (next.length === 0) break;
      frontier = next;
    }
    return result;
  }
  /** 最短 4 邻步数（不绕障碍，用 BFS）；不可达返回 Infinity。 */
  distance(from, to, occupied) {
    if (samePos(from, to)) return 0;
    const seen = /* @__PURE__ */ new Set([posKey(from)]);
    let frontier = [from];
    let step = 0;
    while (frontier.length > 0 && step < 512) {
      step++;
      const next = [];
      for (const p of frontier) {
        for (const n of this.neighbors4(p)) {
          const k = posKey(n);
          if (seen.has(k)) continue;
          if (!this.passable(n.x, n.y)) continue;
          if (!samePos(n, to) && occupied?.has(k) === true) continue;
          if (samePos(n, to)) return step;
          seen.add(k);
          next.push(n);
        }
      }
      frontier = next;
    }
    return Number.POSITIVE_INFINITY;
  }
};

// src/server/game/rng.ts
function createRng(seed) {
  let state = seed >>> 0;
  const next = () => {
    state = state + 1831565813 >>> 0;
    let t = state;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
  return {
    next,
    int(n) {
      if (n <= 0) return 0;
      return Math.floor(next() * n) % n;
    },
    shuffle(list) {
      for (let i = list.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        const a = list[i];
        list[i] = list[j];
        list[j] = a;
      }
      return list;
    }
  };
}
function randomSeed() {
  return (Math.floor(Math.random() * 4294967295) ^ Date.now()) >>> 0;
}

// web/engine/shim-vm.js
function createContext(obj) {
  return obj;
}
function runInContext(code, context) {
  const keys = Object.keys(context);
  const fn = new Function(...keys, code);
  fn(...keys.map((k) => context[k]));
}

// web/engine/shim-crypto.js
function randomBytes(n) {
  const a = new Uint8Array(n);
  crypto.getRandomValues(a);
  const hex = Array.from(a, (b) => b.toString(16).padStart(2, "0")).join("");
  return { length: n, toString: () => hex };
}

// src/server/game/effects.ts
function emptyModifiers() {
  return {
    pierce: 0,
    splash: 0,
    lifesteal: 0,
    ghost: false,
    healBonus: 0,
    burnImmune: false,
    thorn: 0,
    magicVeil: 0,
    reflect: 0,
    moveBonus: 0,
    foresee: false
  };
}
function applyEffect(m, e) {
  switch (e.op) {
    case "pierce":
      m.pierce = Math.max(m.pierce, e.ratio);
      break;
    case "splash":
      m.splash = Math.max(m.splash, e.ratio);
      break;
    case "lifesteal":
      m.lifesteal = Math.max(m.lifesteal, e.ratio);
      break;
    case "ghost":
      m.ghost = true;
      break;
    case "healBonus":
      m.healBonus += e.amount;
      break;
    case "burnImmune":
      m.burnImmune = true;
      break;
    case "move":
      m.moveBonus += e.tiles;
      break;
    case "foresee":
      m.foresee = true;
      break;
    case "status":
      if (e.status === "thorn") m.thorn = Math.max(m.thorn, e.value ?? 1);
      else if (e.status === "magicVeil") m.magicVeil = Math.max(m.magicVeil, e.value ?? 1);
      else if (e.status === "reflect") m.reflect = Math.max(m.reflect, e.value ?? 1);
      break;
    default:
      break;
  }
}
function collectModifiers(heroDef, statuses, heldDefs) {
  const m = emptyModifiers();
  if (heroDef) for (const e of heroDef.modifiers) applyEffect(m, e);
  for (const s of statuses) {
    if (s.turns === 0) continue;
    if (s.kind === "thorn") m.thorn = Math.max(m.thorn, s.value);
    else if (s.kind === "magicVeil") m.magicVeil = Math.max(m.magicVeil, s.value);
    else if (s.kind === "reflect") m.reflect = Math.max(m.reflect, s.value);
  }
  for (const d of heldDefs) {
    if (d.subtype !== "passive") continue;
    for (const e of d.effects) applyEffect(m, e);
  }
  return m;
}
function healAmount(base, mods) {
  return base + mods.healBonus;
}

// src/server/game/match.ts
var OK = { ok: true };
function fail(code, msg) {
  return { ok: false, code, msg };
}
var SHIELD_KEYS = /* @__PURE__ */ new Set(["constructor", "__proto__", "prototype", "caller", "callee"]);
function shield(obj) {
  return new Proxy(obj, {
    get(target, prop) {
      if (typeof prop === "string" && SHIELD_KEYS.has(prop)) return void 0;
      const v = Reflect.get(target, prop);
      if (typeof v === "function") {
        return new Proxy(v, {
          get(fn, fp) {
            if (typeof fp === "string" && SHIELD_KEYS.has(fp)) return void 0;
            return Reflect.get(fn, fp);
          },
          apply(fn, _thisArg, args) {
            return Reflect.apply(fn, target, args);
          }
        });
      }
      return v;
    },
    getPrototypeOf() {
      return null;
    },
    setPrototypeOf() {
      return false;
    }
  });
}
function runSandboxed(code, sandbox) {
  const context = createContext(sandbox, { codeGeneration: { strings: false, wasm: false } });
  runInContext(code, context, { timeout: 200 });
}
var _Match = class _Match {
  constructor(opts) {
    __publicField(this, "opts", opts);
    __publicField(this, "phase", "WAITING");
    __publicField(this, "players", /* @__PURE__ */ new Map());
    __publicField(this, "order", []);
    __publicField(this, "turnIndex", -1);
    __publicField(this, "turnNo", 0);
    __publicField(this, "turnEndsAt", 0);
    __publicField(this, "deck", null);
    __publicField(this, "placed", []);
    __publicField(this, "events", []);
    __publicField(this, "finished", false);
    __publicField(this, "winners", []);
    __publicField(this, "standings", []);
    /** 非正常结束原因（房主退出 / 掉线超时）；正常结束为空。 */
    __publicField(this, "abortReason", "");
    __publicField(this, "seed", 0);
    __publicField(this, "createdAt", Date.now());
    /** 当前回合行动计数。 */
    __publicField(this, "movesLeft", 0);
    __publicField(this, "playedCard", false);
    /** 本回合最后一步移动前的起点（用于撤回）；未移动为 null。 */
    __publicField(this, "moveOrigin", null);
    /** 本回合已弃牌数（与出牌互斥，上限 1 张）。 */
    __publicField(this, "discardedThisTurn", 0);
    __publicField(this, "foreseeFlag", false);
    __publicField(this, "pendingExtraTurn", false);
    __publicField(this, "placeSeq", 0);
    __publicField(this, "deathSeq", 0);
    /** 地形覆盖（岩石 / 祭坛 / 开路炸弹）。 */
    __publicField(this, "terrainOverrides", /* @__PURE__ */ new Map());
    /** 房主 id（可顺位移交）。 */
    __publicField(this, "hostId");
    __publicField(this, "rng");
    __publicField(this, "grid");
    __publicField(this, "mapDef");
    __publicField(this, "shape");
    /** 阶段兜底超时（HERO_SELECT / SPAWN_SELECT）。 */
    __publicField(this, "phaseEndsAt", 0);
    this.hostId = opts.hostId;
    this.shape = modeShape(opts.mode);
    const map = getCatalog().maps.find((m) => m.id === opts.mapId) ?? getCatalog().maps[0];
    this.mapDef = map;
    this.grid = new Grid(map);
    this.seed = opts.seed ?? randomSeed();
    this.rng = createRng(this.seed);
  }
  // ── 成员管理（WAITING 阶段） ──
  addPlayer(id, name) {
    const seat = this.players.size;
    const counts = new Array(this.shape.teams).fill(0);
    for (const p2 of this.players.values()) counts[p2.team] = (counts[p2.team] ?? 0) + 1;
    let team = 0;
    for (let t = 1; t < this.shape.teams; t++) {
      if ((counts[t] ?? 0) < (counts[team] ?? 0)) team = t;
    }
    const p = {
      id,
      name,
      sessionId: randomBytes(3).toString("hex"),
      team,
      seat,
      heroId: null,
      hero: null,
      connected: true,
      disconnectAt: 0,
      kills: 0,
      place: 0
    };
    this.players.set(id, p);
    this.emit("join", `${name} \u52A0\u5165\u4E86\u623F\u95F4`);
    return p;
  }
  removePlayer(id) {
    const p = this.players.get(id);
    if (p === void 0) return;
    if (this.phase === "PLAYING" && p.hero?.alive === true) {
      this.killHero(p.hero, null);
      this.emit("leave", `${p.name} \u79BB\u5F00\u4E86\u5BF9\u5C40`);
      this.checkWin();
    } else {
      this.emit("leave", `${p.name} \u79BB\u5F00\u4E86\u623F\u95F4`);
    }
    this.players.delete(id);
    this.recomputeOrder();
  }
  setTeam(id, team) {
    if (this.phase !== "WAITING") return fail(ERROR_CODE.BAD_PHASE, "\u4EC5\u7B49\u5F85\u623F\u5185\u53EF\u5207\u6362\u961F\u4F0D");
    const p = this.players.get(id);
    if (p === void 0) return fail(ERROR_CODE.NOT_IN_ROOM, "\u4F60\u4E0D\u5728\u8BE5\u623F\u95F4");
    if (!Number.isInteger(team) || team < 0 || team >= this.shape.teams) {
      return fail(ERROR_CODE.BAD_TEAM, "\u961F\u4F0D\u4E0D\u5B58\u5728");
    }
    let count = 0;
    for (const q of this.players.values()) if (q.team === team && q.id !== id) count++;
    if (count >= this.shape.perTeam) return fail(ERROR_CODE.BAD_TEAM, "\u8BE5\u961F\u4F0D\u5DF2\u6EE1");
    p.team = team;
    return OK;
  }
  // ── 阶段流转 ──
  start(id, now) {
    if (id !== this.hostId) return fail(ERROR_CODE.NOT_HOST, "\u53EA\u6709\u623F\u4E3B\u53EF\u4EE5\u5F00\u59CB");
    if (this.phase !== "WAITING") return fail(ERROR_CODE.BAD_PHASE, "\u5BF9\u5C40\u5DF2\u5F00\u59CB");
    const need = this.shape.teams * this.shape.perTeam;
    if (this.players.size !== need) {
      return fail(ERROR_CODE.BAD_PHASE, `\u4EBA\u6570\u4E0D\u9F50\uFF1A${this.players.size}/${need}`);
    }
    this.phase = "HERO_SELECT";
    this.phaseEndsAt = now + this.opts.cfg.phaseTimeoutMs;
    this.emit("phase", "\u8FDB\u5165\u82F1\u96C4\u9009\u62E9\u9636\u6BB5");
    return OK;
  }
  pickHero(id, heroId) {
    if (this.phase !== "HERO_SELECT") return fail(ERROR_CODE.BAD_PHASE, "\u5F53\u524D\u4E0D\u662F\u9009\u82F1\u96C4\u9636\u6BB5");
    const p = this.players.get(id);
    if (p === void 0) return fail(ERROR_CODE.NOT_IN_ROOM, "\u4F60\u4E0D\u5728\u8BE5\u623F\u95F4");
    if (heroById(heroId) === void 0) return fail(ERROR_CODE.BAD_MESSAGE, "\u82F1\u96C4\u4E0D\u5B58\u5728");
    for (const q of this.players.values()) {
      if (q.heroId === heroId && q.id !== id) return fail(ERROR_CODE.HERO_TAKEN, "\u8BE5\u82F1\u96C4\u5DF2\u88AB\u9009\u62E9");
    }
    p.heroId = heroId;
    this.emit("hero", `${p.name} \u9009\u62E9\u4E86 ${heroById(heroId).name}`);
    if ([...this.players.values()].every((q) => q.heroId !== null)) this.finishHeroSelect();
    return OK;
  }
  finishHeroSelect() {
    const taken = new Set([...this.players.values()].map((p) => p.heroId));
    const free = getCatalog().heroes.filter((h) => !taken.has(h.id));
    for (const p of this.players.values()) {
      if (p.heroId === null) {
        const h = free.shift();
        if (h !== void 0) {
          p.heroId = h.id;
          this.emit("hero", `${p.name} \u8D85\u65F6\u672A\u9009\uFF0C\u81EA\u52A8\u5206\u914D ${h.name}`);
        }
      }
    }
    this.phase = "DEAL";
    this.deal();
    this.phase = "SPAWN_SELECT";
    this.phaseEndsAt = Date.now() + this.opts.cfg.phaseTimeoutMs;
    this.emit("phase", "\u53D1\u724C\u5B8C\u6210\uFF0C\u8FDB\u5165\u51FA\u751F\u70B9\u9009\u62E9");
  }
  /** 建共享牌堆 + 各发 3 张 + 建场上英雄。 */
  deal() {
    const counts = new Map(allCards().map((c) => [c.id, c.count]));
    this.deck = new SharedDeck(counts, this.rng);
    for (const p of this.players.values()) {
      const def = heroById(p.heroId ?? "");
      if (def === void 0) continue;
      const hero = {
        heroId: def.id,
        playerId: p.id,
        team: p.team,
        hp: def.maxHp,
        maxHp: def.maxHp,
        x: -1,
        y: -1,
        spawnIdx: -1,
        alive: true,
        shield: 0,
        statuses: [],
        hand: []
      };
      for (const e of def.modifiers) {
        if (e.op === "status" && e.turns === -1) {
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
  pickSpawn(id, spawnIndex) {
    if (this.phase !== "SPAWN_SELECT") return fail(ERROR_CODE.BAD_PHASE, "\u5F53\u524D\u4E0D\u662F\u9009\u51FA\u751F\u70B9\u9636\u6BB5");
    const p = this.players.get(id);
    if (p === void 0) return fail(ERROR_CODE.NOT_IN_ROOM, "\u4F60\u4E0D\u5728\u8BE5\u623F\u95F4");
    if (p.hero === null) return fail(ERROR_CODE.BAD_PHASE, "\u5C1A\u672A\u9009\u62E9\u82F1\u96C4");
    const spawns = this.mapDef.spawns;
    if (!Number.isInteger(spawnIndex) || spawnIndex < 0 || spawnIndex >= spawns.length) {
      return fail(ERROR_CODE.BAD_MESSAGE, "\u51FA\u751F\u70B9\u4E0D\u5B58\u5728");
    }
    const taken = /* @__PURE__ */ new Set();
    for (const q of this.players.values()) {
      if (q.hero !== null && q.id !== id && q.hero.spawnIdx >= 0) taken.add(q.hero.spawnIdx);
    }
    if (taken.has(spawnIndex)) return fail(ERROR_CODE.SPAWN_TAKEN, "\u8BE5\u51FA\u751F\u70B9\u5DF2\u88AB\u9009\u62E9");
    const s = spawns[spawnIndex];
    p.hero.spawnIdx = spawnIndex;
    p.hero.x = s.x;
    p.hero.y = s.y;
    this.emit("spawn", `${p.name} \u5C31\u4F4D`);
    if ([...this.players.values()].every((q) => q.hero !== null && q.hero.spawnIdx >= 0)) {
      this.beginPlay();
    }
    return OK;
  }
  beginPlay() {
    this.phase = "PLAYING";
    this.turnNo = 1;
    this.turnIndex = 0;
    this.emit("phase", "\u5BF9\u5C40\u5F00\u59CB\uFF01");
    this.startTurn();
  }
  // ── 回合引擎 ──
  /** 座位序：先队伍序，同队按加入序（用户定案：先手按队伍顺序）。 */
  recomputeOrder() {
    this.order = [...this.players.values()].sort((a, b) => a.team - b.team || a.seat - b.seat).map((p) => p.id);
    if (this.turnIndex >= this.order.length) this.turnIndex = this.order.length - 1;
  }
  get currentId() {
    return this.order[this.turnIndex] ?? "";
  }
  current() {
    return this.players.get(this.currentId);
  }
  modsOf(p) {
    if (p.hero === null) return collectModifiers(void 0, [], []);
    const def = heroById(p.hero.heroId);
    const held = p.hero.hand.map((c) => cardById(c.cardId)).filter((d) => d !== void 0 && d.subtype === "passive");
    return collectModifiers(def, p.hero.statuses, held);
  }
  startTurn() {
    const p = this.current();
    if (p === void 0 || p.hero === null) return;
    const mods = this.modsOf(p);
    this.movesLeft = this.opts.cfg.moveBudget + mods.moveBonus;
    this.playedCard = false;
    this.moveOrigin = null;
    this.discardedThisTurn = 0;
    this.foreseeFlag = false;
    this.turnEndsAt = Date.now() + this.opts.cfg.turnTimeoutMs;
    this.emit("turn", `\u2500\u2500 \u7B2C ${this.turnNo} \u56DE\u5408\uFF1A${p.name} \u2500\u2500`);
    if (this.tileAt(p.hero.x, p.hero.y) === "heal") {
      const amount = healAmount(this.opts.cfg.healTileAmount, mods);
      this.applyHeal(p, amount, "\u56DE\u8840\u70B9");
    }
    const burn = p.hero.statuses.find((s) => s.kind === "burn" && s.turns !== 0);
    if (burn !== void 0 && !mods.burnImmune) {
      this.dealDamage(p, p, burn.value, "magic", false, "\u707C\u70E7");
    }
    const sp = heroById(p.heroId ?? "")?.special;
    if (sp?.onTurnStart !== void 0) this.runHook(sp.onTurnStart, p, p.hero, null, {});
    const skip = p.hero.statuses.find((s) => (s.kind === "stun" || s.kind === "fakedeath") && s.turns > 0);
    if (skip !== void 0) {
      this.emit("card", `${p.name} ${skip.kind === "stun" ? "\u88AB\u5B9A\u8EAB" : "\u5904\u4E8E\u5047\u6B7B"}\uFF0C\u672C\u56DE\u5408\u65E0\u6CD5\u884C\u52A8`);
      this.endTurnInternal("stun");
    }
  }
  endTurn(id) {
    if (this.phase !== "PLAYING") return fail(ERROR_CODE.BAD_PHASE, "\u5F53\u524D\u4E0D\u5728\u5BF9\u6218\u9636\u6BB5");
    if (id !== this.currentId) return fail(ERROR_CODE.NOT_YOUR_TURN, "\u8FD8\u6CA1\u5230\u4F60\u7684\u56DE\u5408");
    this.endTurnInternal("manual");
    return OK;
  }
  endTurnInternal(_reason) {
    const p = this.current();
    if (p !== void 0 && p.hero !== null && p.hero.alive) {
      const poison = p.hero.statuses.filter((s) => s.kind === "poison" && s.turns > 0);
      for (const s of poison) this.dealDamage(p, p, s.value, "magic", false, "\u5267\u6BD2");
      if (this.foreseeFlag || this.modsOf(p).foresee) {
        const c = this.deck?.draw();
        if (c !== void 0 && c !== null) p.hero.hand.push(c);
      }
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
        this.emit("card", `${again.name} \u83B7\u5F97\u989D\u5916\u56DE\u5408\uFF01`);
        this.startTurn();
        return;
      }
    }
    for (let i = 1; i <= this.order.length; i++) {
      const idx = (this.turnIndex + i) % this.order.length;
      const q = this.players.get(this.order[idx] ?? "");
      if (q?.hero?.alive === true) {
        this.turnIndex = idx;
        this.turnNo++;
        this.startTurn();
        return;
      }
    }
    this.finish([]);
  }
  // ── 行动：移动 ──
  move(id, x, y) {
    if (this.phase !== "PLAYING") return fail(ERROR_CODE.BAD_PHASE, "\u5F53\u524D\u4E0D\u5728\u5BF9\u6218\u9636\u6BB5");
    if (id !== this.currentId) return fail(ERROR_CODE.NOT_YOUR_TURN, "\u8FD8\u6CA1\u5230\u4F60\u7684\u56DE\u5408");
    const p = this.current();
    if (p?.hero === void 0 || p.hero === null || !p.hero.alive) {
      return fail(ERROR_CODE.BAD_PHASE, "\u4F60\u5DF2\u51FA\u5C40");
    }
    const hero = p.hero;
    if (this.movesLeft <= 0) return fail(ERROR_CODE.ILLEGAL_MOVE, "\u672C\u56DE\u5408\u79FB\u52A8\u6B21\u6570\u5DF2\u7528\u5B8C");
    if (hero.statuses.some((s) => s.kind === "stun" && s.turns > 0)) {
      return fail(ERROR_CODE.ILLEGAL_MOVE, "\u88AB\u5B9A\u8EAB\uFF0C\u65E0\u6CD5\u79FB\u52A8");
    }
    if (!this.grid.inBounds(x, y)) return fail(ERROR_CODE.ILLEGAL_MOVE, "\u8D85\u51FA\u5730\u56FE");
    if (manhattan({ x: hero.x, y: hero.y }, { x, y }) !== 1) {
      return fail(ERROR_CODE.ILLEGAL_MOVE, "\u6BCF\u56DE\u5408\u53EA\u80FD\u79FB\u52A8 1 \u683C\uFF08\u4E0A\u4E0B\u5DE6\u53F3\uFF09");
    }
    const mods = this.modsOf(p);
    if (!this.passableAt(x, y, mods.ghost)) return fail(ERROR_CODE.ILLEGAL_MOVE, "\u76EE\u6807\u683C\u4E0D\u53EF\u901A\u884C");
    if (this.occupiedByHero(x, y)) return fail(ERROR_CODE.ILLEGAL_MOVE, "\u76EE\u6807\u683C\u5DF2\u6709\u89D2\u8272");
    const origin = { x: hero.x, y: hero.y };
    hero.x = x;
    hero.y = y;
    this.movesLeft--;
    this.moveOrigin = origin;
    this.emit("move", `${p.name} \u79FB\u52A8\u5230 (${x}, ${y})`);
    this.triggerTraps(p);
    return OK;
  }
  /** 撤回本回合的移动：英雄移回起点，恢复一次移动次数（不重触发陷阱 / 回血）。 */
  undoMove(id) {
    if (this.phase !== "PLAYING") return fail(ERROR_CODE.BAD_PHASE, "\u5F53\u524D\u4E0D\u5728\u5BF9\u6218\u9636\u6BB5");
    if (id !== this.currentId) return fail(ERROR_CODE.NOT_YOUR_TURN, "\u8FD8\u6CA1\u5230\u4F60\u7684\u56DE\u5408");
    if (this.moveOrigin === null) return fail(ERROR_CODE.ILLEGAL_MOVE, "\u672C\u56DE\u5408\u8FD8\u6CA1\u6709\u79FB\u52A8\uFF0C\u65E0\u6CD5\u64A4\u56DE");
    const p = this.current();
    if (p?.hero === void 0 || p.hero === null || !p.hero.alive) {
      return fail(ERROR_CODE.BAD_PHASE, "\u4F60\u5DF2\u51FA\u5C40");
    }
    p.hero.x = this.moveOrigin.x;
    p.hero.y = this.moveOrigin.y;
    this.movesLeft++;
    this.moveOrigin = null;
    this.emit("move", `${p.name} \u64A4\u56DE\u4E86\u79FB\u52A8`);
    return OK;
  }
  // ── 行动：出牌 / 弃牌 ──
  playCard(id, uid, targetId, x, y, pick) {
    if (this.phase !== "PLAYING") return fail(ERROR_CODE.BAD_PHASE, "\u5F53\u524D\u4E0D\u5728\u5BF9\u6218\u9636\u6BB5");
    if (id !== this.currentId) return fail(ERROR_CODE.NOT_YOUR_TURN, "\u8FD8\u6CA1\u5230\u4F60\u7684\u56DE\u5408");
    const p = this.current();
    if (p?.hero === void 0 || p.hero === null || !p.hero.alive) {
      return fail(ERROR_CODE.BAD_PHASE, "\u4F60\u5DF2\u51FA\u5C40");
    }
    const hero = p.hero;
    const idx = hero.hand.findIndex((c) => c.uid === uid);
    if (idx < 0) return fail(ERROR_CODE.CARD_NOT_IN_HAND, "\u624B\u724C\u4E2D\u6CA1\u6709\u8FD9\u5F20\u724C");
    const card = cardById(hero.hand[idx].cardId);
    if (card === void 0) return fail(ERROR_CODE.CARD_NOT_IN_HAND, "\u724C\u4E0D\u5B58\u5728");
    if (this.playedCard) return fail(ERROR_CODE.BAD_PHASE, "\u672C\u56DE\u5408\u5DF2\u7ECF\u51FA\u8FC7\u724C");
    if (card.kind === "item" && card.subtype === "passive") {
      return fail(ERROR_CODE.CARD_NOT_PLAYABLE, "\u88AB\u52A8\u724C\u4E0D\u80FD\u6253\u51FA\uFF0C\u53EA\u80FD\u5F03\u6389");
    }
    if (card.kind === "general" && card.category === "atk" && hero.statuses.some((s) => s.kind === "disarm" && s.turns > 0)) {
      return fail(ERROR_CODE.CARD_NOT_PLAYABLE, "\u88AB\u7F34\u68B0\uFF0C\u65E0\u6CD5\u51FA\u653B\u51FB\u724C");
    }
    if (card.kind === "general" && (card.category === "skill1" || card.category === "skill2" || card.category === "ult") && hero.statuses.some((s) => s.kind === "silence" && s.turns > 0)) {
      return fail(ERROR_CODE.CARD_NOT_PLAYABLE, "\u88AB\u6C89\u9ED8\uFF0C\u65E0\u6CD5\u51FA\u6280\u80FD\u724C");
    }
    if (card.ui === "pickCard") {
      if (pick === void 0 || pick === "") return fail(ERROR_CODE.BAD_MESSAGE, "\u8BF7\u5148\u5728\u9762\u677F\u4E2D\u9009\u62E9\u4E00\u5F20\u724C");
      const chosen = cardById(pick);
      if (chosen === void 0) return fail(ERROR_CODE.BAD_MESSAGE, "\u6240\u9009\u724C\u4E0D\u5B58\u5728");
      const inst = this.deck?.spawn(pick);
      if (inst != null) hero.hand.push(inst);
      this.finishPlay(p, idx, `${p.name} \u6253\u51FA\u3010${card.name}\u3011\uFF0C\u83B7\u5F97\u4E86\u3010${chosen.name}\u3011`);
      this.checkWin();
      return OK;
    }
    let effects;
    let targeting = card.targeting;
    let label = card.name;
    if (card.kind === "general") {
      const def = heroById(hero.heroId);
      if (card.category === "heal") {
        effects = [{ op: "heal", amount: this.opts.cfg.healCardAmount }];
      } else if (card.category === "atk") {
        effects = [];
        const tr = this.validateAttack(p, def, targetId);
        if (!tr.ok) return tr;
        const atk = def.attack;
        const tp = this.players.get(targetId);
        this.dealDamage(
          p,
          tp,
          atk.damage,
          atk.type === "magic" ? "magic" : "physical",
          atk.type === "melee",
          "\u666E\u653B"
        );
        this.finishPlay(p, idx, `${p.name} \u6253\u51FA\u3010${label}\u3011`);
        this.checkWin();
        return OK;
      } else {
        const skill = card.category === "skill1" ? def?.skill1 : card.category === "skill2" ? def?.skill2 : def?.ult;
        if (skill === void 0) return fail(ERROR_CODE.BAD_MESSAGE, "\u6280\u80FD\u7F3A\u5931");
        effects = skill.effects;
        targeting = skill.targeting;
        label = `${card.name}\xB7${skill.name}`;
      }
    } else {
      effects = card.effects;
    }
    let targetHero = null;
    let tile = null;
    if (targeting === "enemy" || targeting === "ally") {
      const q = targetId === void 0 ? void 0 : this.players.get(targetId);
      if (q?.hero === void 0 || q.hero === null || !q.hero.alive) {
        return fail(ERROR_CODE.BAD_TARGET, "\u76EE\u6807\u4E0D\u5B58\u5728\u6216\u5DF2\u51FA\u5C40");
      }
      if (targeting === "enemy" && q.team === p.team) return fail(ERROR_CODE.BAD_TARGET, "\u4E0D\u80FD\u653B\u51FB\u961F\u53CB");
      if (targeting === "ally" && q.team !== p.team) return fail(ERROR_CODE.BAD_TARGET, "\u53EA\u80FD\u9009\u62E9\u961F\u53CB");
      targetHero = q.hero;
    } else if (targeting === "tile") {
      if (x === void 0 || y === void 0 || !this.grid.inBounds(x, y)) {
        return fail(ERROR_CODE.BAD_TARGET, "\u9700\u8981\u6307\u5B9A\u5730\u56FE\u683C");
      }
      tile = { x, y };
    }
    this.applyEffects(p, targetHero, tile, effects);
    this.finishPlay(p, idx, `${p.name} \u6253\u51FA\u3010${label}\u3011`);
    this.checkWin();
    return OK;
  }
  /** 普攻目标校验：远(视线)/近(8格)/法(不限)。 */
  validateAttack(p, def, targetId) {
    if (targetId === void 0) return fail(ERROR_CODE.BAD_TARGET, "\u9700\u8981\u9009\u62E9\u653B\u51FB\u76EE\u6807");
    const q = this.players.get(targetId);
    if (q?.hero === void 0 || q.hero === null || !q.hero.alive) {
      return fail(ERROR_CODE.BAD_TARGET, "\u76EE\u6807\u4E0D\u5B58\u5728\u6216\u5DF2\u51FA\u5C40");
    }
    if (q.team === p.team) return fail(ERROR_CODE.BAD_TARGET, "\u4E0D\u80FD\u653B\u51FB\u961F\u53CB");
    const atk = def?.attack;
    if (atk === void 0) return fail(ERROR_CODE.BAD_MESSAGE, "\u82F1\u96C4\u6570\u636E\u7F3A\u5931");
    const from = { x: p.hero.x, y: p.hero.y };
    const to = { x: q.hero.x, y: q.hero.y };
    if (atk.type === "ranged") {
      if (!this.losClear(from, to)) return fail(ERROR_CODE.NO_LOS, "\u89C6\u7EBF\u88AB\u963B\u6321\uFF0C\u65E0\u6CD5\u653B\u51FB");
    } else if (atk.type === "melee") {
      if (chebyshev(from, to) > 1) return fail(ERROR_CODE.OUT_OF_RANGE, "\u8FD1\u6218\u53EA\u80FD\u6253\u5468\u56F4 8 \u683C");
    }
    return OK;
  }
  discardCard(id, uid) {
    if (this.phase !== "PLAYING") return fail(ERROR_CODE.BAD_PHASE, "\u5F53\u524D\u4E0D\u5728\u5BF9\u6218\u9636\u6BB5");
    if (id !== this.currentId) return fail(ERROR_CODE.NOT_YOUR_TURN, "\u8FD8\u6CA1\u5230\u4F60\u7684\u56DE\u5408");
    const p = this.players.get(id);
    if (p?.hero === void 0 || p.hero === null) return fail(ERROR_CODE.NOT_IN_ROOM, "\u4F60\u4E0D\u5728\u8BE5\u623F\u95F4");
    if (this.playedCard) return fail(ERROR_CODE.BAD_PHASE, "\u672C\u56DE\u5408\u5DF2\u7ECF\u51FA\u8FC7\u724C\uFF0C\u4E0D\u80FD\u518D\u5F03\u724C");
    if (this.discardedThisTurn >= 1) return fail(ERROR_CODE.BAD_PHASE, "\u672C\u56DE\u5408\u53EA\u80FD\u5F03 1 \u5F20\u724C");
    const idx = p.hero.hand.findIndex((c) => c.uid === uid);
    if (idx < 0) return fail(ERROR_CODE.CARD_NOT_IN_HAND, "\u624B\u724C\u4E2D\u6CA1\u6709\u8FD9\u5F20\u724C");
    const [card] = p.hero.hand.splice(idx, 1);
    if (card !== void 0) this.deck?.discard(card);
    this.discardedThisTurn++;
    this.playedCard = true;
    this.emit("card", `${p.name} \u5F03\u6389\u4E86\u4E00\u5F20\u724C`);
    return OK;
  }
  finishPlay(p, idx, text) {
    const hero = p.hero;
    const [card] = hero.hand.splice(idx, 1);
    if (card !== void 0) this.deck?.discard(card);
    this.playedCard = true;
    const drawn = this.deck?.draw();
    if (drawn !== void 0 && drawn !== null) hero.hand.push(drawn);
    this.emit("card", text);
  }
  // ── 效果应用 ──
  applyEffects(actor, target, tile, effects) {
    const hero = actor.hero;
    const local = { ...this.modsOf(actor) };
    for (const e of effects) {
      switch (e.op) {
        case "damage": {
          if (target === null) break;
          const melee = manhattan({ x: hero.x, y: hero.y }, { x: target.x, y: target.y }) <= 1;
          this.dealDamageWith(actor, target, e.amount, e.kind ?? "physical", melee, local, "\u5361\u724C");
          break;
        }
        case "heal": {
          const t = target ?? hero;
          this.applyHeal(actor, healAmount(e.amount, this.modsOf(actor)), "\u5361\u724C", t);
          break;
        }
        case "draw": {
          for (let i = 0; i < e.count; i++) {
            const c = this.deck?.draw();
            if (c !== void 0 && c !== null) hero.hand.push(c);
          }
          break;
        }
        case "discard": {
          const pool = e.who === "self" ? hero.hand : target?.hand ?? [];
          for (let i = 0; i < e.count && pool.length > 0; i++) {
            const j = this.rng.int(pool.length);
            const [c] = pool.splice(j, 1);
            if (c !== void 0) this.deck?.discard(c);
          }
          break;
        }
        case "steal": {
          if (target === null) break;
          for (let i = 0; i < e.count && target.hand.length > 0; i++) {
            const j = this.rng.int(target.hand.length);
            const [c] = target.hand.splice(j, 1);
            if (c !== void 0) hero.hand.push(c);
          }
          break;
        }
        case "status": {
          const t = target ?? hero;
          this.addStatus(t, e.status, e.turns, e.value ?? 1);
          break;
        }
        case "shield":
          hero.shield += e.amount;
          break;
        case "pierce":
          local.pierce = Math.max(local.pierce, e.ratio);
          break;
        case "splash":
          local.splash = Math.max(local.splash, e.ratio);
          break;
        case "lifesteal":
          local.lifesteal = Math.max(local.lifesteal, e.ratio);
          break;
        case "push":
          if (target !== null) this.displace(actor, target, e.tiles, 1);
          break;
        case "pull":
          if (target !== null) this.displace(actor, target, e.tiles, -1);
          break;
        case "teleport": {
          const to = tile ?? (target !== null ? { x: target.x, y: target.y } : null);
          if (to === null) break;
          if (!this.passableAt(to.x, to.y, this.modsOf(actor).ghost) || this.occupiedByHero(to.x, to.y)) break;
          hero.x = to.x;
          hero.y = to.y;
          this.emit("move", `${actor.name} \u4F20\u9001\u5230\u4E86 (${to.x}, ${to.y})`);
          this.triggerTraps(actor);
          break;
        }
        case "swap": {
          if (target === null) break;
          const hx = hero.x, hy = hero.y;
          hero.x = target.x;
          hero.y = target.y;
          target.x = hx;
          target.y = hy;
          this.emit("move", `${actor.name} \u4E0E\u76EE\u6807\u4EA4\u6362\u4E86\u4F4D\u7F6E`);
          break;
        }
        case "move":
          this.movesLeft += e.tiles;
          break;
        case "extraTurn":
          this.pendingExtraTurn = true;
          break;
        case "place": {
          if (tile === null) break;
          if (e.object === "rock" || e.object === "altar") {
            this.terrainOverrides.set(posKey(tile), e.object === "rock" ? "wall" : "heal");
          }
          this.placed.push({
            id: `o${++this.placeSeq}`,
            kind: e.object,
            x: tile.x,
            y: tile.y,
            expiresIn: e.expiresIn,
            ownerTeam: actor.team
          });
          this.emit("place", `${actor.name} \u653E\u7F6E\u4E86${e.object === "trap" ? "\u9677\u9631" : e.object === "rock" ? "\u5CA9\u77F3" : "\u796D\u575B"}`);
          break;
        }
        case "terrain": {
          if (tile === null) break;
          for (let dy = -e.radius; dy <= e.radius; dy++) {
            for (let dx = -e.radius; dx <= e.radius; dx++) {
              const nx = tile.x + dx, ny = tile.y + dy;
              if (!this.grid.inBounds(nx, ny)) continue;
              this.terrainOverrides.set(posKey({ x: nx, y: ny }), e.to);
            }
          }
          this.emit("place", `${actor.name} \u6539\u53D8\u4E86\u5730\u5F62`);
          break;
        }
        case "foresee":
          this.foreseeFlag = true;
          break;
        case "ghost":
        case "healBonus":
        case "burnImmune":
          break;
        // ── 数据包引擎：声明式 API 调用 / JavaScript 沙箱 ──
        case "call":
          this.runApiFn(actor, target, tile, e.fn, e.args ?? {});
          break;
        case "code":
          this.runApiCode(actor, target, tile, e.code);
          break;
        default:
          break;
      }
    }
  }
  /** 解析英雄引用：'self' | 'target' | playerId（不接受任意对象，防越权）。 */
  apiResolve(actor, target, ref) {
    if (ref === "self" || ref === void 0 || ref === null) return actor.hero;
    if (ref === "target") return target;
    if (typeof ref === "string") {
      const q = this.players.get(ref);
      if (q?.hero != null) return q.hero;
      for (const p of this.players.values()) if (p.hero?.heroId === ref) return p.hero;
    }
    return null;
  }
  runApiFn(actor, target, tile, fn, args) {
    const api = this.buildApi(actor, target, tile);
    const f = api[fn];
    if (typeof f !== "function") {
      this.emit("card", `\u672A\u77E5\u6E38\u620F\u51FD\u6570\uFF1A${fn}`);
      return;
    }
    const order = _Match.API_PARAMS[fn];
    const argv = order === void 0 ? [args] : order.map((k) => args[k]);
    try {
      f(...argv);
    } catch (err) {
      this.emit("card", `\u51FD\u6570 ${fn} \u6267\u884C\u51FA\u9519\uFF1A${String(err).slice(0, 80)}`);
    }
  }
  /** 在沙箱中执行数据包 JavaScript（ctx 可被脚本修改，如 onDamaged 的 ctx.amount）。 */
  runApiCode(actor, target, tile, code) {
    try {
      const sandbox = {
        api: shield(this.buildApi(actor, target, tile)),
        self: actor.id,
        target: target?.playerId ?? null,
        tile: tile === null ? null : shield({ x: tile.x, y: tile.y }),
        ctx: shield({ x: tile?.x ?? null, y: tile?.y ?? null })
      };
      runSandboxed(code, sandbox);
    } catch (err) {
      this.emit("card", `\u811A\u672C\u6267\u884C\u51FA\u9519\uFF1A${String(err).slice(0, 80)}`);
    }
  }
  /** 行为钩子（onTurnStart / onDamaged / onDeath）。 */
  runHook(code, player, hero, tile, ctx) {
    try {
      const sandbox = { api: shield(this.buildApi(player, null, tile)), self: player.id, ctx: shield(ctx) };
      runSandboxed(code, sandbox);
    } catch (err) {
      this.emit("card", `\u94A9\u5B50\u6267\u884C\u51FA\u9519\uFF1A${String(err).slice(0, 80)}`);
    }
  }
  /** 构建绑定到当前出牌上下文的游戏 API（ref 统一为 'self'/'target'/playerId 字符串）。 */
  buildApi(actor, target, tile) {
    const M = this;
    const res = (ref) => M.apiResolve(actor, target, ref);
    const moveHeroTo = (h, x, y) => {
      if (!M.grid.inBounds(x, y)) return false;
      const q = M.players.get(h.playerId);
      if (q === void 0) return false;
      if (!M.passableAt(x, y, M.modsOf(q).ghost) || M.occupiedByHero(x, y)) return false;
      h.x = x;
      h.y = y;
      M.emit("move", `${M.nameOf(h.playerId)} \u79FB\u52A8\u5230 (${x}, ${y})`);
      M.triggerTraps(q);
      return true;
    };
    const api = {
      /** 造成伤害，返回实际伤害值。mode：'FAR' 远 / 'NER' 近 / 'MAG' 法。 */
      damage(ref, amount = 1, mode = "FAR") {
        const h = res(ref);
        if (h === null || !h.alive) return 0;
        const kind = mode === "MAG" ? "magic" : "physical";
        const before = h.hp + h.shield;
        M.dealDamageWith(actor, h, Math.max(0, Number(amount) || 0), kind, mode === "NER", M.modsOf(actor), "\u6548\u679C");
        return before - (h.hp + h.shield);
      },
      heal(ref, amount = 1) {
        const h = res(ref);
        if (h === null) return 0;
        const q = M.players.get(h.playerId);
        if (q === void 0) return 0;
        const before = h.hp;
        M.applyHeal(q, Math.max(0, Number(amount) || 0), "\u6548\u679C", h);
        return h.hp - before;
      },
      shield(ref, amount = 1) {
        const h = res(ref);
        if (h !== null) h.shield += Math.max(0, Number(amount) || 0);
      },
      setHp(ref, hp = 1) {
        const h = res(ref);
        if (h === null) return;
        h.hp = Math.max(0, Math.min(h.maxHp, Number(hp) || 0));
        if (h.hp > 0 && !h.alive) {
          h.alive = true;
          M.emit("heal", `${M.nameOf(h.playerId)} \u91CD\u65B0\u7AD9\u8D77\u6765\u4E86\uFF01`);
        }
      },
      hp(ref) {
        return res(ref)?.hp ?? 0;
      },
      maxHp(ref) {
        return res(ref)?.maxHp ?? 0;
      },
      alive(ref) {
        return res(ref)?.alive === true;
      },
      addStatus(ref, kind = "stun", turns = 1, value = 1) {
        const h = res(ref);
        if (h !== null) M.addStatus(h, String(kind), Number(turns) || 0, Number(value) || 1);
      },
      removeStatus(ref, kind = "") {
        const h = res(ref);
        if (h !== null) h.statuses = h.statuses.filter((s) => s.kind !== kind);
      },
      grantMove(tiles = 1) {
        M.movesLeft += Math.max(0, Number(tiles) || 0);
      },
      extraTurn() {
        M.pendingExtraTurn = true;
      },
      drawCards(count = 1) {
        const h = actor.hero;
        if (h === null) return;
        for (let i = 0; i < (Number(count) || 0); i++) {
          const c = M.deck?.draw();
          if (c !== void 0 && c !== null) h.hand.push(c);
        }
      },
      discardRandom(ref, count = 1) {
        const h = res(ref);
        if (h === null) return;
        for (let i = 0; i < (Number(count) || 0) && h.hand.length > 0; i++) {
          const j = M.rng.int(h.hand.length);
          const [c] = h.hand.splice(j, 1);
          if (c !== void 0) M.deck?.discard(c);
        }
      },
      stealCards(from, count = 1) {
        const f = res(from);
        if (f === null || actor.hero === null) return;
        for (let i = 0; i < (Number(count) || 0) && f.hand.length > 0; i++) {
          const j = M.rng.int(f.hand.length);
          const [c] = f.hand.splice(j, 1);
          if (c !== void 0) actor.hero.hand.push(c);
        }
      },
      exchangeHands(ref) {
        const f = res(ref);
        if (f === null || actor.hero === null) return;
        const tmp = actor.hero.hand;
        actor.hero.hand = f.hand;
        f.hand = tmp;
        M.emit("card", `${actor.name} \u4E0E ${M.nameOf(f.playerId)} \u4EA4\u6362\u4E86\u624B\u724C`);
      },
      teleportTo(ref, x = 0, y = 0) {
        const h = res(ref);
        if (h === null) return;
        if (!moveHeroTo(h, Number(x), Number(y))) {
          M.emit("card", `\u65E0\u6CD5\u79FB\u52A8\u5230 (${x}, ${y})`);
        }
      },
      teleportToWall() {
        const walls = [];
        for (let y = 0; y < M.mapDef.height; y++) {
          for (let x = 0; x < M.mapDef.width; x++) {
            if (M.tileAt(x, y) === "wall") walls.push({ x, y });
          }
        }
        if (walls.length === 0 || actor.hero === null) return;
        const w = walls[M.rng.int(walls.length)];
        if (!moveHeroTo(actor.hero, w.x, w.y)) M.emit("card", "\u6CA1\u6709\u53EF\u4F20\u9001\u7684\u5899\u683C");
      },
      teleportRandomAll() {
        for (const q of M.players.values()) {
          if (q.hero?.alive !== true) continue;
          for (let tries = 0; tries < 60; tries++) {
            const x = M.rng.int(M.mapDef.width);
            const y = M.rng.int(M.mapDef.height);
            if (moveHeroTo(q.hero, x, y)) break;
          }
        }
        M.emit("move", "\u5730\u56FE\u88AB\u6447\u6643\u4E86\uFF0C\u6240\u6709\u4EBA\u88AB\u968F\u673A\u4F20\u9001\uFF01");
      },
      sendToSpawn(ref) {
        const h = res(ref);
        if (h === null) return;
        const free = M.mapDef.spawns.filter((s) => !M.occupiedByHero(s.x, s.y));
        const to = free[0] ?? M.mapDef.spawns[0];
        if (to === void 0 || !moveHeroTo(h, to.x, to.y)) M.emit("card", "\u6CA1\u6709\u53EF\u7528\u51FA\u751F\u70B9");
      },
      swapPositions(ref) {
        const f = res(ref);
        const h = actor.hero;
        if (f === null || h === null) return;
        const tx = f.x, ty = f.y;
        f.x = h.x;
        f.y = h.y;
        h.x = tx;
        h.y = ty;
        M.emit("move", `${actor.name} \u4E0E ${M.nameOf(f.playerId)} \u4EA4\u6362\u4E86\u4F4D\u7F6E`);
        const qa = M.players.get(h.playerId);
        const qb = M.players.get(f.playerId);
        if (qa !== void 0) M.triggerTraps(qa);
        if (qb !== void 0) M.triggerTraps(qb);
      },
      push(ref, tiles = 1) {
        const h = res(ref);
        if (h !== null) M.displace(actor, h, Math.max(0, Number(tiles) || 0), 1);
      },
      pull(ref, tiles = 1) {
        const h = res(ref);
        if (h !== null) M.displace(actor, h, Math.max(0, Number(tiles) || 0), -1);
      },
      /** 放置地刺（一次性陷阱，踩中扣 damage 点）。默认放在目标格 / 自己脚下。 */
      placeTrap(damage = 3) {
        const at = tile ?? { x: actor.hero.x, y: actor.hero.y };
        M.placed.push({
          id: `o${++M.placeSeq}`,
          kind: "trap",
          x: at.x,
          y: at.y,
          expiresIn: 999,
          ownerTeam: actor.team,
          value: Math.max(1, Number(damage) || 3)
        });
        M.emit("place", `${actor.name} \u57CB\u8BBE\u4E86\u5730\u523A`);
      },
      /** 放置岩石（把目标格变成墙）。 */
      placeRock() {
        const at = tile ?? { x: actor.hero.x, y: actor.hero.y };
        M.placed.push({ id: `o${++M.placeSeq}`, kind: "rock", x: at.x, y: at.y, expiresIn: 999, ownerTeam: actor.team });
        M.terrainOverrides.set(posKey(at), "wall");
        M.emit("place", `${actor.name} \u653E\u7F6E\u4E86\u5CA9\u77F3`);
      },
      /** 放置祭坛（把目标格变成回血点）。 */
      placeAltar() {
        const at = tile ?? { x: actor.hero.x, y: actor.hero.y };
        M.placed.push({ id: `o${++M.placeSeq}`, kind: "altar", x: at.x, y: at.y, expiresIn: 999, ownerTeam: actor.team });
        M.terrainOverrides.set(posKey(at), "heal");
        M.emit("place", `${actor.name} \u653E\u7F6E\u4E86\u796D\u575B`);
      },
      /** 以自身为原点的十字格（blockedByWall=true 时被墙阻挡）。 */
      crossTiles(blockedByWall = true) {
        const h = actor.hero;
        const out = [];
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          let x = h.x + dx;
          let y = h.y + dy;
          while (M.grid.inBounds(x, y)) {
            out.push({ x, y });
            if (blockedByWall === true && M.tileAt(x, y) === "wall") break;
            x += dx;
            y += dy;
          }
        }
        return out;
      },
      enemiesInTiles(tiles = []) {
        const ids = [];
        for (const q of M.players.values()) {
          if (q.hero?.alive !== true || q.team === actor.team) continue;
          if (tiles.some((t) => t.x === q.hero.x && t.y === q.hero.y)) ids.push(q.id);
        }
        return ids;
      },
      enemiesInRadius(ref, radius = 2) {
        const h = res(ref);
        if (h === null) return [];
        const ids = [];
        for (const q of M.players.values()) {
          if (q.hero?.alive !== true || q.team === actor.team) continue;
          if (chebyshev({ x: q.hero.x, y: q.hero.y }, { x: h.x, y: h.y }) <= Math.max(0, Number(radius) || 0)) {
            ids.push(q.id);
          }
        }
        return ids;
      },
      allies(ref) {
        const h = res(ref);
        if (h === null) return [];
        const ids = [];
        for (const q of M.players.values()) {
          if (q.hero?.alive !== true || q.id === h.playerId || q.team !== actor.team) continue;
          ids.push(q.id);
        }
        return ids;
      },
      aliveEnemies(ref) {
        const h = res(ref);
        if (h === null) return [];
        const ids = [];
        for (const q of M.players.values()) {
          if (q.hero?.alive !== true || q.team === actor.team) continue;
          ids.push(q.id);
        }
        return ids;
      },
      randomInt(n = 2) {
        return M.rng.int(Math.max(1, Number(n) || 1));
      },
      announce(text = "") {
        M.emit("card", String(text));
      },
      terrainAt(ref) {
        const h = res(ref);
        if (h === null) return ".";
        const t = M.tileAt(h.x, h.y);
        return t === "wall" ? "#" : t === "water" ? "~" : t === "spawn" ? "S" : t === "heal" ? "H" : ".";
      },
      pos(ref) {
        const h = res(ref);
        return h === null ? null : { x: h.x, y: h.y };
      },
      placeTrapAt(x = 0, y = 0, damage = 3) {
        if (!M.grid.inBounds(Number(x), Number(y))) return;
        M.placed.push({
          id: `o${++M.placeSeq}`,
          kind: "trap",
          x: Number(x),
          y: Number(y),
          expiresIn: 999,
          ownerTeam: actor.team,
          value: Math.max(1, Number(damage) || 3)
        });
        M.emit("place", `${actor.name} \u57CB\u8BBE\u4E86\u5730\u523A (${x}, ${y})`);
      },
      isWall(x = 0, y = 0) {
        return M.tileAt(Number(x), Number(y)) === "wall";
      },
      inBounds(x = 0, y = 0) {
        return M.grid.inBounds(Number(x), Number(y));
      },
      selfId: actor.id,
      targetId: target?.playerId ?? null
    };
    return api;
  }
  addStatus(hero, kind, turns, value) {
    const exist = hero.statuses.find((s) => s.kind === kind && s.turns > 0);
    if (exist !== void 0) {
      exist.turns = Math.max(exist.turns, turns);
      exist.value = Math.max(exist.value, value);
      return;
    }
    hero.statuses.push({ kind, turns, value });
  }
  /** 推 / 拉：沿远离 / 靠近施法者方向逐格移动，遇障碍停止。 */
  displace(actor, target, tiles, dir) {
    const hero = actor.hero;
    let cx = target.x, cy = target.y;
    const sx = Math.sign(hero.x - target.x) * dir;
    const sy = Math.sign(hero.y - target.y) * dir;
    for (let i = 0; i < tiles; i++) {
      const nx = cx + sx, ny = cy + sy;
      if (!this.grid.inBounds(nx, ny) || !this.passableAt(nx, ny, false) || this.occupiedByHero(nx, ny)) break;
      cx = nx;
      cy = ny;
    }
    if (cx !== target.x || cy !== target.y) {
      target.x = cx;
      target.y = cy;
      this.emit("move", "\u76EE\u6807\u88AB\u4F4D\u79FB\u4E86");
      const owner = this.players.get(target.playerId);
      if (owner !== void 0) this.triggerTraps(owner);
    }
  }
  // ── 伤害 / 治疗 / 死亡 ──
  dealDamage(actor, target, amount, kind, melee, label) {
    this.dealDamageWith(actor, target.hero, amount, kind, melee, this.modsOf(actor), label);
  }
  dealDamageWith(actor, target, amount, kind, melee, local, label) {
    const targetPlayer = this.players.get(target.playerId);
    const defMods = targetPlayer !== void 0 ? this.modsOf(targetPlayer) : actor !== null ? this.modsOf(actor) : emptyModifiers();
    if (target.statuses.some((s) => s.kind === "fakedeath" && s.turns > 0)) {
      this.emit("damage", `${this.nameOf(target.playerId)} \u5904\u4E8E\u5047\u6B7B\u72B6\u6001\uFF0C\u514D\u75AB\u4E86\u8FD9\u6B21\u4F24\u5BB3`);
      return;
    }
    const attackType = kind === "magic" ? "MAG" : melee ? "NER" : "FAR";
    const hookCtx = { amount, attackType, melee, cancelled: false };
    const sp = targetPlayer !== void 0 && targetPlayer.heroId !== null ? heroById(targetPlayer.heroId)?.special : void 0;
    if (sp?.onDamaged !== void 0 && targetPlayer !== void 0) {
      this.runHook(sp.onDamaged, targetPlayer, target, null, hookCtx);
      if (hookCtx.cancelled) {
        this.emit("damage", `${this.nameOf(target.playerId)} \u514D\u9664\u4E86\u8FD9\u6B21\u4F24\u5BB3`);
        return;
      }
      amount = hookCtx.amount;
    }
    let dmg = Math.max(0, amount);
    if (kind === "magic" && defMods.magicVeil > 0) {
      dmg = Math.max(0, dmg - defMods.magicVeil * (1 - local.pierce));
    }
    const absorbed = Math.min(target.shield, dmg);
    target.shield -= absorbed;
    dmg -= absorbed;
    target.hp -= dmg;
    this.emit("damage", `${this.nameOf(target.playerId)} \u53D7\u5230 ${dmg + absorbed} \u70B9${label}\u4F24\u5BB3` + (absorbed > 0 ? `\uFF08\u62A4\u76FE\u5438\u6536 ${absorbed}\uFF09` : ""));
    if (local.lifesteal > 0 && actor !== null && actor.hero !== null) {
      const back = Math.floor(amount * local.lifesteal);
      if (back > 0) this.applyHeal(actor, back, "\u5438\u8840");
    }
    if (local.splash > 0 && actor !== null) {
      for (const q of this.players.values()) {
        if (q.hero === null || !q.hero.alive || q.hero === target) continue;
        if (q.team === actor.team) continue;
        if (chebyshev({ x: q.hero.x, y: q.hero.y }, { x: target.x, y: target.y }) > 1) continue;
        this.dealDamageWith(actor, q.hero, Math.floor(amount * local.splash), kind, false, local, "\u6E85\u5C04");
      }
    }
    if (melee && kind === "physical" && defMods.thorn > 0 && actor !== null && actor.hero !== null && actor.hero.alive) {
      this.dealDamageWith(targetPlayer ?? actor, actor.hero, defMods.thorn, "physical", false, defMods, "\u8346\u68D8");
    }
    if (defMods.reflect > 0 && actor !== null && actor.hero !== null && actor.hero.alive) {
      this.dealDamageWith(targetPlayer ?? actor, actor.hero, defMods.reflect, "magic", false, defMods, "\u53CD\u5F39");
    }
    if (target.hp <= 0 && target.alive) this.killHero(target, actor);
  }
  applyHeal(p, amount, label, heroOverride) {
    const hero = heroOverride ?? p.hero;
    if (hero === null || !hero.alive || amount <= 0) return;
    const before = hero.hp;
    hero.hp = Math.min(hero.maxHp, hero.hp + amount);
    if (hero.hp > before) {
      this.emit("heal", `${this.nameOf(hero.playerId)} \u56DE\u590D ${hero.hp - before} HP\uFF08${label}\uFF09`);
    }
  }
  killHero(hero, killer) {
    const victimPlayer = this.players.get(hero.playerId);
    if (victimPlayer !== void 0) {
      const sp = heroById(victimPlayer.heroId ?? "")?.special;
      if (sp?.onDeath !== void 0) {
        this.runHook(sp.onDeath, victimPlayer, hero, null, {});
        if (hero.hp > 0) {
          this.emit("death", `${this.nameOf(hero.playerId)} \u514D\u9664\u4E86\u6DD8\u6C70\uFF01`);
          return;
        }
      }
      for (const c of hero.hand) {
        const def = cardById(c.cardId);
        if (def?.hooks?.onDeath === void 0) continue;
        this.runHook(def.hooks.onDeath, victimPlayer, hero, null, {});
        if (hero.hp > 0) {
          this.emit("death", `${this.nameOf(hero.playerId)} \u514D\u9664\u4E86\u6DD8\u6C70\uFF01`);
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
    if (victim !== void 0) victim.place = ++this.deathSeq + (this.players.size - this.deathSeq);
    this.emit("death", `${this.nameOf(hero.playerId)} \u88AB\u6DD8\u6C70\u4E86`);
  }
  /** 检查是否只剩一队 → 结束对局（淘汰/掉线后调用）。 */
  checkWin() {
    if (this.phase !== "PLAYING") return;
    const aliveTeams = /* @__PURE__ */ new Set();
    for (const p of this.players.values()) if (p.hero?.alive === true) aliveTeams.add(p.team);
    if (aliveTeams.size <= 1) this.finish([...aliveTeams]);
  }
  finish(winners, reason = "") {
    if (this.finished) return;
    this.finished = true;
    this.phase = "FINISHED";
    this.winners = winners;
    this.abortReason = reason;
    const list = [...this.players.values()].sort((a, b) => {
      const pa = a.place === 0 ? 1 : a.place;
      const pb = b.place === 0 ? 1 : b.place;
      return pa - pb;
    }).map((p) => ({
      playerId: p.id,
      name: p.name,
      team: p.team,
      place: p.place === 0 ? 1 : p.place,
      heroName: heroById(p.heroId ?? "")?.name ?? "\u2014",
      kills: p.kills
    }));
    this.standings = list;
    this.emit("result", reason !== "" ? reason : winners.length === 0 ? "\u5E73\u5C40\uFF01" : `\u961F\u4F0D ${winners.map((w) => w + 1).join("/")} \u83B7\u80DC\uFF01`);
  }
  /** 中止对局（如房主退出）：判为结束、无胜者，并记录原因。 */
  abort(reason) {
    if (this.finished) return;
    this.finish([], reason);
  }
  /** 房主重开：保留玩家与队伍，清空对局状态。 */
  restart(id) {
    if (id !== this.hostId) return fail(ERROR_CODE.NOT_HOST, "\u53EA\u6709\u623F\u4E3B\u53EF\u4EE5\u91CD\u5F00");
    if (this.phase !== "FINISHED") return fail(ERROR_CODE.BAD_PHASE, "\u5BF9\u5C40\u5C1A\u672A\u7ED3\u675F");
    this.phase = "WAITING";
    this.order = [];
    this.turnIndex = -1;
    this.turnNo = 0;
    this.deck = null;
    this.placed = [];
    this.finished = false;
    this.winners = [];
    this.standings = [];
    this.abortReason = "";
    this.terrainOverrides.clear();
    this.pendingExtraTurn = false;
    for (const p of this.players.values()) {
      p.heroId = null;
      p.hero = null;
      p.kills = 0;
      p.place = 0;
    }
    this.emit("phase", "\u623F\u4E3B\u91CD\u5F00\u4E86\u5BF9\u5C40\uFF0C\u91CD\u65B0\u9009\u62E9\u82F1\u96C4");
    return OK;
  }
  // ── 定时器 ──
  tick(now) {
    if (this.phase === "HERO_SELECT" && now >= this.phaseEndsAt) this.finishHeroSelect();
    else if (this.phase === "SPAWN_SELECT" && now >= this.phaseEndsAt) {
      const used = new Set([...this.players.values()].map((q) => q.hero?.spawnIdx ?? -1));
      for (const p of this.players.values()) {
        if (p.hero !== null && p.hero.spawnIdx < 0) {
          const free = this.mapDef.spawns.map((_, i) => i).filter((i) => !used.has(i));
          const idx = free[0] ?? 0;
          const s = this.mapDef.spawns[idx];
          if (s !== void 0) {
            p.hero.spawnIdx = idx;
            p.hero.x = s.x;
            p.hero.y = s.y;
            used.add(idx);
          }
        }
      }
      this.beginPlay();
    } else if (this.phase === "PLAYING" && now >= this.turnEndsAt) {
      this.emit("turn", "\u56DE\u5408\u8D85\u65F6\uFF0C\u81EA\u52A8\u7ED3\u675F");
      this.endTurnInternal("timeout");
    }
    if (this.placed.length > 0) {
      for (const o of this.placed) o.expiresIn--;
      const expired = this.placed.filter((o) => o.expiresIn <= 0);
      for (const o of expired) {
        if (o.kind === "rock" || o.kind === "altar") this.terrainOverrides.delete(posKey({ x: o.x, y: o.y }));
      }
      this.placed = this.placed.filter((o) => o.expiresIn > 0);
    }
  }
  // ── 掉线 / 重连 ──
  onDisconnect(id, now, graceMs) {
    const p = this.players.get(id);
    if (p === void 0) return;
    p.connected = false;
    p.disconnectAt = now;
    this.emit("leave", `${p.name} \u6389\u7EBF\uFF0C${Math.round(graceMs / 1e3)} \u79D2\u5185\u53EF\u91CD\u8FDE`);
    if (this.phase === "PLAYING" && this.currentId === id) this.endTurnInternal("death");
  }
  onReconnect(id) {
    const p = this.players.get(id);
    if (p === void 0) return;
    p.connected = true;
    p.disconnectAt = 0;
    this.emit("join", `${p.name} \u91CD\u8FDE\u4E86`);
  }
  /** 掉线超过宽限 → 判出局。 */
  sweepDisconnected(now, graceMs) {
    for (const p of [...this.players.values()]) {
      if (!p.connected && p.disconnectAt > 0 && now - p.disconnectAt >= graceMs) {
        const wasHost = p.id === this.hostId;
        if (p.hero?.alive === true) {
          this.killHero(p.hero, null);
          this.emit("leave", `${p.name} \u8D85\u65F6\u672A\u91CD\u8FDE\uFF0C\u5224\u4E3A\u51FA\u5C40`);
          this.checkWin();
        }
        this.players.delete(p.id);
        this.recomputeOrder();
        if (wasHost && this.phase !== "WAITING" && this.phase !== "FINISHED") {
          this.abort("\u623F\u4E3B\u6389\u7EBF\u8D85\u65F6\uFF0C\u5BF9\u5C40\u7ED3\u675F");
        }
      }
    }
  }
  // ── 查询 / 快照 ──
  nameOf(id) {
    return this.players.get(id)?.name ?? "\u67D0\u4EBA";
  }
  tileAt(x, y) {
    return this.terrainOverrides.get(posKey({ x, y })) ?? this.grid.terrainAt(x, y);
  }
  passableAt(x, y, ghost) {
    const t = this.tileAt(x, y);
    if (t === "wall") return ghost;
    return this.grid.inBounds(x, y);
  }
  /** 视线：墙（含放置的岩石）阻挡。 */
  losClear(a, b) {
    return this.grid.losClear(a, b, (x, y) => this.tileAt(x, y) === "wall");
  }
  occupiedByHero(x, y) {
    for (const p of this.players.values()) {
      if (p.hero?.alive === true && p.hero.x === x && p.hero.y === y) return true;
    }
    return false;
  }
  /** 陷阱：敌人踩上扣血并移除。 */
  triggerTraps(p) {
    if (p.hero === null) return;
    const i = this.placed.findIndex(
      (o) => o.kind === "trap" && o.x === p.hero.x && o.y === p.hero.y && o.ownerTeam !== p.team
    );
    if (i < 0) return;
    const [trap] = this.placed.splice(i, 1);
    if (trap !== void 0) {
      this.emit("place", `${p.name} \u8E29\u5230\u4E86\u9677\u9631\uFF01`);
      const owner = this.players.get(this.order.find((id) => this.players.get(id)?.team === trap.ownerTeam) ?? "") ?? null;
      this.dealDamageWith(
        owner,
        p.hero,
        trap.value ?? 3,
        "physical",
        false,
        owner !== null ? this.modsOf(owner) : emptyModifiers(),
        "\u9677\u9631"
      );
      this.checkWin();
    }
  }
  isInMatch(id) {
    return this.players.has(id);
  }
  playerCount() {
    return this.players.size;
  }
  roomState() {
    const players = [...this.players.values()].sort((a, b) => a.seat - b.seat).map((p) => ({
      id: p.id,
      name: p.name,
      team: p.team,
      seat: p.seat,
      host: p.id === this.hostId,
      connected: p.connected
    }));
    return {
      roomId: this.opts.roomId,
      name: this.opts.name,
      mode: this.opts.mode,
      hostId: this.hostId,
      capacity: this.shape.teams * this.shape.perTeam,
      phase: this.phase,
      endsAt: this.phase === "PLAYING" ? this.turnEndsAt : this.phaseEndsAt,
      players,
      turnNo: this.turnNo
    };
  }
  snapshot() {
    const heroes = [...this.players.values()].filter((p) => p.hero !== null).map((p) => ({
      id: p.id,
      playerId: p.id,
      heroId: p.hero.heroId,
      name: p.name,
      team: p.team,
      hp: Math.max(0, p.hero.hp),
      maxHp: p.hero.maxHp,
      x: p.hero.x,
      y: p.hero.y,
      alive: p.hero.alive,
      statuses: p.hero.statuses.filter((s) => s.turns !== 0).map((s) => ({ kind: s.kind, turns: s.turns })),
      handCount: p.hero.hand.length
    }));
    const top = this.deck?.topDiscard ?? null;
    const topDef = top === null ? void 0 : cardById(top.cardId);
    return {
      phase: this.phase,
      turnNo: this.turnNo,
      currentId: this.currentId,
      heroes,
      deckCount: this.deck?.remaining ?? 0,
      discardCount: this.deck?.discarded ?? 0,
      topDiscard: topDef === void 0 ? null : { id: topDef.id, name: topDef.name, text: topDef.text },
      placed: this.placed.map((o) => ({
        id: o.id,
        kind: o.kind,
        x: o.x,
        y: o.y,
        expiresIn: o.expiresIn,
        ownerTeam: o.ownerTeam
      })),
      endsAt: this.turnEndsAt
    };
  }
  turnPayload() {
    if (this.phase !== "PLAYING") return null;
    return {
      turnNo: this.turnNo,
      order: [...this.order],
      currentIndex: this.turnIndex,
      currentId: this.currentId,
      endsAt: this.turnEndsAt,
      moved: this.movesLeft < this.opts.cfg.moveBudget + this.modsOf(this.current() ?? { hero: null }).moveBonus,
      played: this.playedCard,
      discarded: this.discardedThisTurn > 0,
      moveOrigin: this.moveOrigin
    };
  }
  handOf(id) {
    const p = this.players.get(id);
    if (p?.hero === void 0 || p.hero === null) return [];
    const heroDef = heroById(p.hero.heroId);
    return p.hero.hand.map((c) => {
      const def = cardById(c.cardId);
      const passive = def?.kind === "item" && def.subtype === "passive";
      let targeting = def?.targeting ?? "none";
      let label = def?.name ?? "\u672A\u77E5\u724C";
      let text = def?.text ?? "";
      if (def?.kind === "general" && def.category !== void 0 && def.category !== "heal") {
        if (def.category === "atk") {
          targeting = "enemy";
          text = `\u666E\u653B\uFF08${heroDef?.attack.type === "ranged" ? "\u8FDC\u7A0B" : heroDef?.attack.type === "melee" ? "\u8FD1\u6218" : "\u6CD5\u672F"} ${heroDef?.attack.damage ?? 0} \u4F24\uFF09`;
        } else {
          const skill = def.category === "skill1" ? heroDef?.skill1 : def.category === "skill2" ? heroDef?.skill2 : heroDef?.ult;
          if (skill !== void 0) {
            targeting = skill.targeting;
            label = skill.name;
            text = skill.text;
          }
        }
      }
      return {
        uid: c.uid,
        cardId: c.cardId,
        label,
        kind: def?.kind ?? "general",
        subtype: def?.subtype,
        category: def?.category,
        targeting,
        text,
        ui: def?.ui,
        playable: !passive
      };
    });
  }
  mapWire() {
    const tiles = [];
    for (let y = 0; y < this.mapDef.height; y++) {
      let row = "";
      for (let x = 0; x < this.mapDef.width; x++) {
        const t = this.tileAt(x, y);
        row += t === "wall" ? "#" : t === "water" ? "~" : t === "spawn" ? "S" : t === "heal" ? "H" : ".";
      }
      tiles.push(row);
    }
    return {
      width: this.mapDef.width,
      height: this.mapDef.height,
      tiles,
      spawns: this.mapDef.spawns,
      heals: this.mapDef.heals
    };
  }
  resultPayload() {
    return { winners: this.winners, standings: this.standings, reason: this.abortReason || void 0 };
  }
  heroOptions() {
    return getCatalog().heroes.map((h) => ({
      id: h.id,
      name: h.name,
      maxHp: h.maxHp,
      attack: { type: h.attack.type, damage: h.attack.damage },
      text: h.text,
      specialText: h.special?.text ?? "",
      // 依次 技1 / 技2 / 大：保留 name 与 text（详情），前端据此展示「名称 + 效果」
      skills: [
        { name: h.skill1.name, text: h.skill1.text },
        { name: h.skill2.name, text: h.skill2.text },
        { name: h.ult.name, text: h.ult.text }
      ],
      modifiers: h.modifiers ?? []
    }));
  }
  /** 可被「自选一张牌」类卡牌选取的牌清单（客户端选牌面板用）。 */
  cardList() {
    return getCatalog().cards.filter((c) => c.ui === void 0).map((c) => ({ id: c.id, name: c.name, text: c.text, kind: c.kind }));
  }
  takenHeroes() {
    return [...this.players.values()].map((p) => p.heroId).filter((h) => h !== null);
  }
  takenSpawns() {
    const out = [];
    for (const p of this.players.values()) {
      if (p.hero !== null && p.hero.spawnIdx >= 0) out.push(p.hero.spawnIdx);
    }
    return out;
  }
  teamOf(id) {
    return this.players.get(id)?.team ?? -1;
  }
  /** 后端专用随机会话 ID（进房时分配，仅日志/调试用，不下发前端）。 */
  sessionIdOf(id) {
    return this.players.get(id)?.sessionId ?? "";
  }
  emit(kind, text, actorId) {
    this.events.push({ kind, text, actorId, at: Date.now() });
    if (this.events.length > 200) this.events.splice(0, this.events.length - 200);
  }
  drainEvents() {
    if (this.events.length === 0) return [];
    const out = this.events;
    this.events = [];
    return out;
  }
};
// ── 数据包引擎：游戏 API（≥20 个函数接口，供 manifest steps / JS 沙箱调用） ──
/** steps 参数顺序表：runApiFn 按 here 顺序把 args 对象展开成位置参数。 */
__publicField(_Match, "API_PARAMS", {
  damage: ["ref", "amount", "mode"],
  heal: ["ref", "amount"],
  shield: ["ref", "amount"],
  setHp: ["ref", "hp"],
  hp: ["ref"],
  maxHp: ["ref"],
  alive: ["ref"],
  addStatus: ["ref", "kind", "turns", "value"],
  removeStatus: ["ref", "kind"],
  grantMove: ["tiles"],
  extraTurn: [],
  drawCards: ["count"],
  discardRandom: ["ref", "count"],
  stealCards: ["from", "count"],
  exchangeHands: ["ref"],
  teleportTo: ["ref", "x", "y"],
  teleportToWall: [],
  teleportRandomAll: [],
  sendToSpawn: ["ref"],
  swapPositions: ["ref"],
  push: ["ref", "tiles"],
  pull: ["ref", "tiles"],
  placeTrap: ["damage"],
  placeRock: [],
  placeAltar: [],
  crossTiles: ["blockedByWall"],
  enemiesInTiles: ["tiles"],
  enemiesInRadius: ["ref", "radius"],
  allies: ["ref"],
  aliveEnemies: ["ref"],
  randomInt: ["n"],
  announce: ["text"],
  terrainAt: ["ref"],
  pos: ["ref"],
  placeTrapAt: ["x", "y", "damage"],
  isWall: ["x", "y"],
  inBounds: ["x", "y"]
});
var Match = _Match;
export {
  Match,
  getCatalog,
  setCatalog
};
