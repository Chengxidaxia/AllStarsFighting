# ALSF · 全冥星大坐站（AllStarFighting）—— 游戏设计文档

> 版本 `0.1`（定稿草案）｜项目路径 `K:\war.io\alsf`｜归属：war.io 游戏合集
> 类型：回合制 · 卡牌对战 · 多人大乱斗｜联机：Supabase(Auth+Postgres) + 自研 Node `ws` 对局服
> 平台：网页（桌面 + 手机），**不做桌面端**

---

## 1. 游戏概述

玩家被投放进一座矩形方格竞技场，**坚持到最后的玩家 / 队伍获胜**。
每局共享一副公共牌堆，玩家通过「出牌」驱动自己的英雄发起攻击、释放技能、回血或布置道具。
回合制推进，按座位顺序轮流行动；走位、出牌顺序、留牌取舍共同决定胜负。

一句话：**「一副牌、一张图、活到最后」**。

---

## 2. 核心循环与胜负

```
           ┌──────────────────────────── 一局 Match ────────────────────────────┐
等待房 → 选英雄 → 发牌(每人3张) → 选出生点 → ┌── 回合循环 ──┐ → 胜负结算 → 重开
                                             │ 移动 + 出牌  │
                                             └──────────────┘
```

- **胜利条件**：场上**存活队伍数 ≤ 1** 时该队（或其唯一成员）获胜。
- **平局**：全部玩家同时被淘汰 / 无人存活 → 平局。
- **淘汰**：玩家 HP 归 0 → 出局（观战）；其手牌按规则弃入弃牌堆，其英雄从棋盘移除。

---

## 3. 开局流程（对局状态机）

| 阶段 | 枚举值 | 等待什么 | 超时兜底 |
|---|---|---|---|
| 等待房 | `WAITING` | 人数满足所选模式且房主点「开始」 | 无（不自动开） |
| 选英雄 | `HERO_SELECT` | 每人各选 1 名英雄，**不可重复** | 超时自动分配未被选的英雄 |
| 发牌 | `DEAL` | 服务端完成：洗牌 + 每人 3 张 | 瞬时（无需等待） |
| 选出生点 | `SPAWN_SELECT` | 每人从地图出生点中选 1 个，**不可重复** | 超时自动分配剩余出生点 |
| 对战中 | `PLAYING` | 回合推进 | 回合超时自动结束回合 |
| 已结束 | `FINISHED` | 房主点「重开」或全部离开 | — |

**状态机**：`WAITING → HERO_SELECT → DEAL → SPAWN_SELECT → PLAYING → FINISHED →(重开) WAITING`
每个「等所有人确认」的阶段都必须有**超时兜底自动分配**，**绝不卡死**。

**边界处理**：

- **对局中有人掉线**：给 **45s 宽限**（座位保留、可重连）；超时则视为出局（HP 视为 0 淘汰），手牌入弃牌堆。
- **阶段中有人掉线**：从未确认的玩家由超时兜底代选。
- **人数不足**：`PLAYING` 期间人数跌破模式下限 → 直接结算（按存活判定）。
- **房主**：建房的玩家为房主；房主离开则顺位移交；房主可「开始 / 重开」。

---

## 4. 回合系统

- **回合顺序** = **座位序**：先按「队伍序」，同队内按「加入房间顺序」。
- **先手** = 座位序第 0 位（即**队伍序最小、队内最先加入者**）。
- **单个回合**包含两个**可各自跳过**的动作：
  1. **移动 1 格**（上下左右 4 邻，见 §9）
  2. **出 1 张牌**（手牌）
- **顺序自由**：可「先移动后出牌」或「先出牌后移动」。
- **不可跳过整回合**：即使什么都不做，也必须由 `END_TURN` 或超时推进到下一人。
- **结束条件**（满足任一即 `advanceTurn()`）：
  - 移动与出牌**两项都已完成**；
  - 玩家主动 `END_TURN`；
  - **回合超时**（**90 秒**，已定）。
- **每回合最多出 1 张牌**；出牌后**立即补 1 张**（见 §5），手牌恒为 3。
- **回合归属广播**：`TURN` 消息**全房广播同一份**（含 `current` 座位、剩余时间），客户端自行比对 `current === myId` 判断「轮到我」。

---

## 5. 共享牌堆（Shared Deck）

| 项 | 规则 |
|---|---|
| 主牌堆 | 整局**只有 1 副**，所有玩家共用；开局打乱一次 |
| 抽取 | **不预先分发**；谁抽到什么由抽牌顺序决定 |
| 弃牌堆 | 打出的牌（含被动触发后弃掉的）进弃牌堆 |
| 补牌 | **出一张补一张**：打出后立即从主牌堆抽 1 张，手牌恒 3 张 |
| 重洗 | 主牌堆抽空 → **弃牌堆洗牌成为新主牌堆**，记录 `reshuffles` 次数 |
| 起手 | `DEAL` 阶段每人从主牌堆抽 3 张 |

**实例追踪**：每张实体牌有唯一 `uid`（不是"某种牌有 16 张"这个概念，而是 44 个具名实例）。用于手牌校验、弃牌、道具放置引用、复盘。

**确定性**：使用**可播种 PRNG**（`rng.ts`）。种子在开局生成，服务端持有；**种子不下发**给进行中的客户端（防预测抽牌）；对局结束后可随战绩落库供复盘。

**牌堆内容**（一般牌，合计 **44** 张）：

| 卡 | 张数 |
|---|---|
| 攻 | 16 |
| 技1 | 8 |
| 技2 | 8 |
| 大 | 4 |
| 桃 | 8 |
| **合计** | **44** |

> 道具牌另行定义（见 `cards.md`），加入主牌堆后总数会相应增加。

---

## 6. 卡牌系统

所有卡牌有一个**判别式联合**形状：

```ts
type CardKind = 'general' | 'item';
type ItemSubtype = 'plain' | 'passive' | 'placement';

interface CardDef {
  id: string;              // 'atk' | 'skill1' | 'skill2' | 'ult' | 'peach' | ...
  name: string;            // 显示名
  kind: CardKind;
  subtype?: ItemSubtype;   // 仅 item
  targeting: Targeting;    // 目标类型
  effects: EffectOp[];     // 效果算子列表（见 §14）
  text: string;            // 卡面描述
}

type Targeting =
  | { mode: 'none' }                                  // 无需目标（如 桃）
  | { mode: 'self' }
  | { mode: 'unit'; range: 'melee8' | 'ranged' | 'any' }  // 单体，受攻击类型约束
  | { mode: 'tile'; range: number }                   // 指定格子（放置类）
  | { mode: 'area'; radius: number };
```

### 6.1 一般牌（`general`）

| 卡 | 效果 | 目标 | 数量 |
|---|---|---|---|
| **攻** | 触发**英雄普攻**：以英雄的**攻击类型 + 伤害**结算 | 单体（按英雄攻击类型） | 16 |
| **技1** | 触发**英雄技能 1**（含其冷却） | 由技能定义 | 8 |
| **技2** | 触发**英雄技能 2** | 由技能定义 | 8 |
| **大** | 触发**英雄大招** | 由技能定义 | 4 |
| **桃** | 回复 **4 HP** | 自己 | 8 |

> **关键设计**：牌堆里的「技1/技2/大」是**触发牌**——打出它们 = **激活自己英雄的**对应技能。
> 因此「同一个『技1』牌，在不同英雄手里效果完全不同」。一套系统，简单自洽。（`§0` 已确认）

### 6.2 道具牌（`item`）三类

| 子类 | 枚举值 | 能否主动打出 | 说明 |
|---|---|---|---|
| **一般道具** | `plain` | ✅ 可以 | 常规打出，立刻结算效果 |
| **被动道具** | `passive` | ❌ 不能 | 抽到后留在手牌，满足条件时**被动触发**；也可主动**弃掉** |
| **放置道具** | `placement` | ✅ 可以 | 打出后放到**地图格**上，成为 `PlacedObject`，可设持续回合数 |

> 具体道具条目待用户填写（`§17` 待定项 7）；本轮在 `cards.md` 给出**框架 + 首批示例**。

---

## 7. 英雄系统

### 7.1 定义（静态数据，来自 Supabase / 种子）

```ts
interface HeroDef {
  id: string;
  name: string;
  maxHp: number;
  attack: {
    type: 'ranged' | 'melee' | 'magic';  // 远 / 近 / 法
    damage: number;
  };
  modifiers: Modifier[];   // 特殊属性（类型化列表，见 §7.3）
  skill1: SkillDef;
  skill2: SkillDef;
  ultimate: SkillDef;
  art?: string;            // 立绘/图标
}

interface SkillDef {
  name: string;
  cooldown: number;        // 冷却回合数
  targeting: Targeting;
  effects: EffectOp[];
  text: string;
}
```

### 7.2 对局内实例态（运行时，不进定义）

```ts
interface HeroInstance {
  playerId: string;
  heroId: string;
  hp: number;
  pos: { x: number; y: number };
  statuses: Status[];        // 灼烧 / 定身 / 沉默 / 护盾...
  cooldowns: Record<string, number>;  // skill1/skill2/ult → 剩余冷却
  hand: string[];            // 手牌 uid（仅服务端 + 本人可见）
  alive: boolean;
}
```

### 7.3 特殊属性（`Modifier`，类型化）

示例：`穿墙`、`起手多抽 N 张`、`减免 X 点法术伤害`、`普攻伤害 +X`、`每回合多走 N 格`、`吸血`、`免疫某状态`、`首次致死免疫`…
全部实现为**类型化数据**，**新增英雄 = 新增数据，无需改引擎**。

---

## 8. 攻击与战斗

### 8.1 三种攻击类型

| 类型 | 判定规则 |
|---|---|
| **远**（ranged） | 施法者中心 ↔ 目标中心**连成一条线**，**中间无障碍（墙）**则可攻击。用 Bresenham 逐格检查。 |
| **近**（melee） | **周围 8 格**内的**单体**。 |
| **法**（magic） | **不限条件**（无距离、无遮挡限制）。 |

> 墙**阻挡远程视线**（`§17` 待定项 5，推荐为「是」）。

### 8.2 伤害管线（`combat.ts`）

```
计算基础伤害(英雄攻击/技能)
  → 应用攻方增伤 modifier
  → 应用守方减伤/护盾（普通伤害 vs 法术伤害分别判定）
  → 扣 HP
  → 触发后续效果（吸血/反弹/灼烧/剧毒…）
  → HP ≤ 0 → 死亡 → 淘汰 → checkWin()
```

- **回血**：桃 +4 HP；回血点（`§9`）；吸血效果。
- **护盾 vs 魔抗罩**：护盾吸普通伤害、魔抗罩吸法术伤害，二者独立。
- **死亡与淘汰**：HP 归 0 立即移除英雄、手牌入弃牌堆，随后**立刻 `checkWin()`**。

---

## 9. 地图与格子（`grid.ts`）

```ts
interface MapDef {
  id: string;
  name: string;
  width: number;
  height: number;
  tiles: Terrain[][];        // [y][x]，行主序
  spawns: { x: number; y: number }[];   // 出生点（选出生点阶段每人独占）
  heals:  { x: number; y: number }[];   // 回血点
}

type Terrain = 'plain' | 'water' | 'wall' | 'spawn' | 'heal';
```

| 地形 | 通行 | 备注 |
|---|---|---|
| 平原 `plain` | ✅ | 默认格 |
| 水 `water` | ✅ | **按正常地块**（无额外消耗，`§0` 已确认） |
| 墙 `wall` | ❌ | 不可进入；**阻挡远程视线** |
| 出生点 `spawn` | ✅ | 选出生点阶段每人独占一个 |
| 回血点 `heal` | ✅ | **与出生点相互独立**（不重叠）；英雄**站在回血点上时，每回合开始回 1 HP** |

- **移动**：每回合 **1 格**，**上下左右 4 邻**（非 8 邻）；目标格必须可通行且无其他英雄。
- **寻路 / 可达判定**：BFS（用于 UI 高亮可走格）。
- **视线**：Bresenham 逐格采样，遇 `wall` 判定为遮挡。
- **放置物**（`PlacedObject`）：占用格（可作为障碍或触发物），带 `expiresIn` 回合数，`housekeeping` 到期移除。

---

## 10. 聊天与社交

| 频道 | 枚举值 | 可见范围 |
|---|---|---|
| 全体广播 | `all` | 房间内所有人 |
| 队伍聊天 | `team` | 同队成员（自由混战模式下等同全体） |

- 协议：上行 `CHAT { channel, text }`，下行 `CHAT { channel, from, fromTeam, text, ts }`。
- 长度限制 200 字；简单频率限制（防刷屏）。

---

## 11. 组队与对局模式

| 模式 | 队伍结构 | 建议人数 |
|---|---|---|
| `1v1v1v1` | 4 队 × 1 人 | 4 |
| `2v2` | 2 队 × 2 人 | 4 |
| `3v3` | 2 队 × 3 人 | 6 |
| `4v4` | 2 队 × 4 人 | 8 |
| `2v2v2v2` | 4 队 × 2 人 | 8 |

- 建房者（房主）在建房时选模式。
- **组队分配**：**玩家在等待房内自选队伍**（可加入已有队，也可自己开新队；房主可要求均衡）。
- **回合顺序**：按「队伍序 → 队内加入序」；**先手 = 队伍序最小的队伍中、最先加入者**。

---

## 12. 服务端架构（`src/server/`）

### 12.1 模块布局

| 文件 | 动作 | 职责 |
|---|---|---|
| `game/arena.ts` | **删除** | 旧 60Hz 实时物理，被回合制取代 |
| `game/match.ts` | **新增** | 聚合根：`dispatch(action)` / `snapshot()`，持有全部对局状态 |
| `game/phase.ts` | **新增** | 阶段枚举 + 转移表 + 阶段超时 |
| `game/turn.ts` | **新增** | 回合引擎：座位序、`movedThisTurn/playedThisTurn`、`advanceTurn()`、`checkWin()` |
| `game/deck.ts` | **新增** | `SharedDeck { draw[], discard[], rng, reshuffles }`，`drawOne()` / `recycleDiscard()` |
| `game/grid.ts` | **新增** | 瓦片网格：地形、出生/回血、4 邻、BFS 移动、Bresenham 视线 |
| `game/combat.ts` | **新增** | 伤害管线 + 远/近/法规则 + 死亡淘汰 |
| `game/rng.ts` | **新增** | 可播种 PRNG（确定性洗牌） |
| `game/cards/{types,effects,registry}.ts` | **新增** | 卡牌定义 / `EffectOp` 算子 / 注册表 |
| `game/heroes/{types,registry}.ts` | **新增** | 英雄定义 / 注册表 |
| `game/room.ts` | **重写** | 房间 = 一局 `Match` + 会话索引 + 房主/模式 |
| `game/lobby.ts` | **保留** | 房间集合管理；`step()` 改为驱动阶段/回合超时 |
| `game/loop.ts` | **降级** | 不再是 60Hz 物理循环（见 §12.3） |
| `net/gateway.ts` | **重写** | 新协议路由（AUTH/房间/阶段/回合/聊天） |
| `net/auth.ts` | **新增（S7）** | Supabase JWT 校验，失败降级游客 |
| `data/{supabase,catalog}.ts` | **新增（S7）** | 启动全量拉取 maps/heroes/cards 进内存 |
| `protocol/types.ts` | **重写** | v0.2 协议契约 |
| `config.ts` | **改** | 新常量（超时、模式、人数） |
| `http/static.ts`、`index.ts` | **改** | 静态服务 + 接线 + `/health` |

### 12.2 Match 聚合根

```ts
class Match {
  phase: Phase;                       // WAITING | HERO_SELECT | DEAL | SPAWN_SELECT | PLAYING | FINISHED
  mode: MatchMode;                    // '1v1v1v1' | '2v2' | ...
  seats: Seat[];                      // 座位序数组
  deck: SharedDeck;
  heroes: Map<PlayerId, HeroInstance>;
  placed: PlacedObject[];             // 地图上的放置物
  current: number;                    // 当前座位索引
  turnDeadline: number;               // 回合到期时间戳
  dispatch(a: Action): Event[]        // 统一入口（含权限/合法性校验）
  snapshot(): MatchSnapshot           // 广播快照（隐藏他人手牌）
  tick(now: number): Event[]          // 到期扫描（阶段/回合超时）
}
```

### 12.3 定时器模型（不再需要 60Hz）

- **取消**固定 tick 物理循环。
- **阶段/回合到期**：每个阶段、每个回合一个 `setTimeout` 到期器（`tick(now)` 校验）。
- **1Hz housekeeping**：刷新大厅列表、扫描超时、放置物到期、掉线宽限。
- **15s WS 心跳**：保留，清理死连接。
- **动画纯客户端播放，服务端不等动画**（服务端只管状态与到期）。

---

## 13. 线协议 v0.2（`protocol/types.ts` ↔ `web/js/net.js` 同步）

信封：`{ t: MSG, d: payload }`。协议版本 `0.1.0 → 0.2.0`。

### 13.1 上行（客户端 → 服务端）

| MSG | 载荷 |
|---|---|
| `AUTH` | `{ token?: string, name?: string, protocol: string }` |
| `PING` | `{ ts }` |
| `CREATE_ROOM` | `{ name, mode, mapId }` |
| `JOIN_ROOM` | `{ roomId }` |
| `LEAVE_ROOM` | `{}` |
| `START_MATCH` | `{}`（房主） |
| `PICK_HERO` | `{ heroId }` |
| `PICK_SPAWN` | `{ x, y }` |
| `MOVE` | `{ to: { x, y } }` |
| `PLAY_CARD` | `{ uid, target?: { playerId } \| { x, y } }` |
| `DISCARD_CARD` | `{ uid }` |
| `END_TURN` | `{}` |
| `CHAT` | `{ channel: 'all' \| 'team', text }` |

### 13.2 下行（服务端 → 客户端）

| MSG | 载荷 | 范围 |
|---|---|---|
| `HELLO` | `{ id, name, guest, protocol }` | 逐会话 |
| `LOBBY` | `{ rooms: RoomInfo[] }` | 逐会话/大厅 |
| `ROOM` | `{ id, name, mode, hostId, members[], phase }` | 逐会话 |
| `PHASE` | `{ phase, deadline, payload? }` | 全房 |
| `HERO_OPTIONS` | `{ heroes: HeroDef[] }` | 全房 |
| `SPAWN_OPTIONS` | `{ spawns, taken[] }` | 全房 |
| `MAP` | `MapDef` | 全房 |
| `MATCH` | `MatchSnapshot`（隐藏他人手牌） | 全房 |
| `TURN` | `{ current, seatOrder, deadline, round }` | **全房**（客户端自行比对） |
| `HAND` | `{ cards: CardDef[] }` | **仅本人** |
| `STATE` | `{ heroes: HeroView[], placed[] }` | 全房 |
| `EVENT` | `{ events: [{ kind, text, ... }] }` | 全房 |
| `CHAT` | `{ channel, from, fromTeam, text, ts }` | 全房/队伍 |
| `RESULT` | `{ winner: teamId \| null, standings[] }` | 全房 |
| `PONG` | `{ ts, serverTime }` | 逐会话 |
| `ERROR` | `{ code, msg }` | 逐会话 |

> **关键设计**：`TURN` **全房广播同一份**，客户端自行判定是否轮到自己 → 省带宽、防偷看。**只有 `HAND` / `HELLO` 是逐会话**。

### 13.3 错误码

`BAD_MESSAGE` / `VERSION_MISMATCH` / `NOT_AUTHED` / `ROOM_NOT_FOUND` / `ROOM_FULL` / `NOT_IN_ROOM` / `NOT_HOST` / `BAD_PHASE` / `INVALID_ACTION` / `NOT_YOUR_TURN` / `TOO_MANY_ROOMS`

---

## 14. 效果算子（`EffectOp`）—— 扩展的唯一入口

**新增卡牌 = 新增数据，无需改引擎**。核心算子（`game/cards/effects.ts`）：

```ts
type EffectOp =
  | { op: 'damage'; amount: number; dtype: 'physical' | 'magic' }
  | { op: 'heal'; amount: number }
  | { op: 'move'; to: Pos | 'push' | 'pull'; dist: number }
  | { op: 'teleport'; to: Pos }
  | { op: 'swap' }                       // 与目标换位
  | { op: 'draw'; count: number }
  | { op: 'discard'; count: number; from: 'self' | 'target' }
  | { op: 'stealCard'; count: number }   // 偷 1 张手牌
  | { op: 'status'; status: StatusKind; turns: number }
  | { op: 'shield'; amount: number; dtype?: 'physical' | 'magic' }
  | { op: 'summon'; unit: string; at: Pos }
  | { op: 'place'; object: string; at: Pos; expiresIn: number }
  | { op: 'terrain'; at: Pos; radius: number; make: Terrain; turns: number }
  | { op: 'extraMoves'; amount: number }
  | { op: 'extraTurn' }
  | { op: 'pierce' }                     // 本次攻击无视护盾
  | { op: 'splash'; ratio: number }      // 相邻格半伤
  | { op: 'lifesteal'; ratio: number };
```

> ≥24 条特殊属性/功能的完整脑暴见 `cards.md`。

---

## 15. Supabase 边界与网页管理后台

### 15.1 Postgres 表

| 表 | 关键列 |
|---|---|
| `maps` | `id, name, width, height, tiles jsonb, spawns jsonb, heals jsonb` |
| `heroes` | `id, name, max_hp, attack jsonb, modifiers jsonb, skills jsonb` |
| `cards` | `id, name, kind, subtype, targeting jsonb, effects jsonb, text` |
| `profiles` | `id → auth.users, username, role`（`role='admin'` 可写内容表） |
| `match_records` | `id, seed, mode, participants jsonb, winner, turns, started_at, ended_at` |

### 15.2 匹配服与库的边界

- 启动时把 `maps / heroes / cards` **全量拉进内存**（`data/catalog.ts`），带 `catalogVersion`。
- 刷新：订阅 Supabase Realtime 或 `POST /admin/reload`。
- **每局对局不查库**（避免对局中的网络抖动）。
- 对局记录用 **service-role key** 在服务端写（`match_records`）。

### 15.3 管理后台

- 独立静态页 `web/admin/`：Supabase Auth 登录 → 用**用户 JWT 直连 Postgres**。
- 靠 **RLS** 限制「只有 `role='admin'` 可写内容表」→ **Node 服务里不实现 CRUD**。
- 功能：地图编辑器（方格画布）/ 英雄编辑 / 卡牌编辑（含 `EffectOp` 可视化拼装）。

### 15.4 认证

- 客户端 Supabase 登录拿 `access_token` → `AUTH` 上报 → 服务端 `supabase.auth.getUser(token)` 校验。
- **无 token 降级游客**：可玩，不记战绩。
- 依赖 `@supabase/supabase-js`；env：`SUPABASE_URL` / `SUPABASE_ANON_KEY`（读）/ `SUPABASE_SERVICE_ROLE_KEY`（**仅服务端**，严禁下发）。

---

## 16. 客户端（`web/`，零构建）

- **屏幕**：进入/登录 → **游戏大厅** → 房间/等待房 → 选英雄 → 选出生点 → 对战 → 结算。
- **对战渲染**：Canvas 方格棋盘（相机居中止）+ 英雄 + 血条 + 手牌 + 聊天面板。
- **⚠️ 视觉分区原则（硬要求）**：对战界面必须把**「游戏内」**与**「游戏外」**在视觉上明确分开——
  - **游戏内**（棋盘地图 + 手牌卡牌）= **视觉主体**，占据中央大面积、高对比、无遮挡；
  - **游戏外**（界面头 / 聊天 / 日志 / 回合提示条）= **退到边缘、降低对比与饱和度**，用独立底框与棋盘分隔，
    绝不允许挤压或叠压在棋盘/手牌之上；
  - 两区之间用**明确的边线/间隙/底色差**划分，让人一眼看出「哪块是在玩、哪块是信息」。
- **动画**（必须有）：出牌飞入、受击抖动/闪红、移动滑格、回合切换脉冲、死亡消散、面板开合。
- **手机端兼容**：`viewport-fit=cover` + 安全区、触摸事件、点击高亮可走格/可目标格、大按钮 ≥44px、输入框 ≥16px 防 iOS 缩放、横竖屏自适应。
- **零构建**：原生 ES Module，改完硬刷新即生效。

---

## 17. 规则定案（均已确认）

| # | 议题 | 结论 |
|---|---|---|
| 1 | 组队分配方式 | **玩家在等待房内自选队伍**（可加入已有队或开新队） |
| 2 | 回合超时 | **90 秒** |
| 3 | 掉线宽限 / 投降阈值 | 宽限 **45s**、超时判负（**60s**） |
| 4 | 回血点 | **与出生点独立**；站在其上**每回合开始回 1 HP** |
| 5 | 墙是否阻挡远程视线 | **是** |
| 6 | 先手 | **按队伍顺序**（队伍序最小队伍中、最先加入者） |
| 7 | 道具牌具体条目 | 待用户提供；本轮定**三类框架 + 示例** |

---

## 18. 实施阶段

| 阶段 | 内容 | 可演示 |
|---|---|---|
| **本轮** | 设计文档 + 卡牌脑暴 + 可点击预览页 + 截图 + 命名/登记/README 更新 | 可看可点 |
| S1 | 协议 v0.2 骨架 + 模块重排（删 `arena`、`JOIN→AUTH` 游客、新增 `ROOM/PHASE`、网关重建）+ JSON 种子数据 | 能进「游戏大厅」、建/进房 |
| S2 | 对局状态机全链路（等待房→选英雄→发牌→选出生点）+ 超时兜底 | 看到棋盘与选人 |
| S3 | 回合引擎 + 4 邻 1 格移动 + `END_TURN` + 超时 | 轮流走格子 |
| S4 | 共享牌堆 + 手牌 + 出牌 + 战斗（攻/技/大/桃）+ HP/死亡/胜负 | **首个完整可玩 1v1 死斗** |
| S5 | 道具牌三类 + `EffectOp` 全部 op + 24 条特殊属性 | 玩法丰富 |
| S6 | 聊天（全体/队伍）+ 组队 5 模式 + 重开 + 掉线宽限 | 完整体验 |
| S7 | Supabase 接入（Auth 校验 / Catalog 读库 / 战绩落库）+ `web/admin/` CRUD | 可运营 |
| S8 | 客户端网格/卡牌/动画打磨 + 手机端适配 + E2E | 上线 |

---

*本文件为设计定稿草案，如有改动以最新对话结论为准。*
