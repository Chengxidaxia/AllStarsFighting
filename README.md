# ALSF · 全冥星大坐站

**AllStarFighting（简称 ALSF）** —— 回合制卡牌对战 · 多人乱斗。TypeScript 权威服务端 + 原生网页客户端（零构建），桌面与手机同一入口。

> **进度**：S1–S7+ 已实现 —— 游戏大厅 / 等待房自选组队 / 选英雄 / 选出生点 / 共享牌堆回合战斗 / 全体与队伍聊天 / 掉线重连与重开 / 内容管理端 / 对局观战 / 个人设置 / 数据包（zip）驱动内容。
> 设计文档：`docs/design/alsf-design.md` ｜ 界面预览：`docs/preview/alsf-preview.html`

---

## 游戏介绍

ALSF 是一款**多人回合制卡牌乱斗**：所有玩家被投进一张矩形方格地图，每人选一位专属英雄、抽一手公共牌堆的牌，轮流「走一格、出一张」，用普攻、技能、大招、道具把对手全部打倒——**坚持到最后的玩家 / 队伍获胜**。

一句话：**一副共通牌堆，一张方格战场，活到最后。**

### 核心特色

| 特色 | 说明 |
|---|---|
| **共通牌堆** | 整局只有 1 副公共牌堆，所有人从中抽牌——不是各摸各的。打出的进弃牌堆，抽空后弃牌堆洗回。信息与博弈全在公共资源上展开。 |
| **触发牌机制** | 牌堆里的「攻 / 技1 / 技2 / 大」是触发牌：打出即释放**你自己英雄**的普攻与技能。同一张牌，在不同英雄手里是不同的招式。 |
| **走格战斗** | 每回合**移动 1 格**（上下左右 4 邻）+ **出 1 张牌**，顺序自由、可分别跳过、不可跳过整回合。 |
| **远 / 近 / 法** | 普攻分三类：**远**＝中心连线无墙可打；**近**＝周围 8 格单体；**法**＝不限条件。卡位挡线、贴脸输出各有打法。 |
| **地形博弈** | 墙不可走且挡视线；水可正常通行；回血点**站上去每回合回 1 HP**；出生点互不重复。放置类道具还能临时造墙、造回血点。 |
| **三类道具牌** | 一般（直接打出）/ **被动**（在手中就生效，只能弃掉）/ **放置**（打到地图上变陷阱、岩石、祭坛）。 |
| **组队乱斗** | 等待房内**自选队伍**，支持 `1v1v1v1 / 2v2 / 3v3 / 4v4 / 2v2v2v2` 五种模式，按队伍顺序行动。 |
| **聊天** | 全体广播 + 队伍密聊 + 战报日志，边打边吹。 |
| **观战** | 对局开始后，外部玩家可进入房间**观战**：不占座位、不进回合序、不收手牌，但实时同步棋盘 / 战况 / 战报。 |
| **数据包** | 英雄 / 卡牌 / 地图全部来自 `packages/*.zip`，每个内容一个 JSON 文件（id 写在文件内）；内置默认数据包名为 **AllStarFighting System Core Content Pack**，新增内容无需改引擎。 |
| **个人设置** | 大厅顶栏「设置」：渲染方式（Canvas2D 默认 / WebGL 实验）、本地昵称缓存。 |

### 一局流程

```
游戏大厅 → 等待房（自选组队）→ 选英雄（不可重复）→ 发牌（各 3 张）
       → 选出生点（不可重复）→ 回合循环（走一格 + 出一张）→ 结算 → 可重开
```

### 回合规则要点

| 规则 | 说明 |
|---|---|
| 回合行动 | 移动 1 格（4 邻）+ 出 1 张牌，顺序自由、各自可跳过，**不可跳过整回合** |
| 移动撤回 | 回合结束前，点击**移动前的起点格**可撤回本次移动 |
| 出牌 / 弃牌 | 单回合**只能二选一**；弃牌单回合**上限 1 张**；被动牌只能弃掉 |
| 手牌 | 恒定 3 张（出一张补一张）；牌堆抽空后弃牌堆洗回 |
| 移动 + 出牌 | 两者都完成后**自动结束回合**，轮到下一位 |
| 超时 | 回合超时 **90 秒**自动结束；选英雄 / 出生点超时自动分配，永不卡死 |
| 先手 | 按**队伍顺序** |
| 掉线 | **45 秒**内重连可回原席位，超时判出局 |
| 房主 | 等待房内可**重开一局**；对局进行中房主退出，对局**自动结束** |

> 具体有哪些英雄、卡牌、地图，属于**数据包内容**，不在本 README 记载范围——请直接查看数据包或管理端。

---

## 快速开始

| 目的 | 操作 |
|---|---|
| 启动服务端 | `npm run dev`（默认端口 24710；Windows 本地还可用 `start-server.bat`） |
| 打开客户端 | 浏览器开 `http://localhost:24710/`（Windows 本地还可用 `start-client.bat`） |
| 手机试玩 | 手机与电脑同一局域网，浏览器访问 `http://<电脑IP>:24710/` |
| 管理端 | `http://localhost:24711/admin/`（独立端口、**无鉴权**，不随根入口暴露）；端口可用 `ALSF_ADMIN_PORT` 覆盖 |

> 手机访问需放行 Windows 防火墙的 24710 端口；端口可用 `ALSF_PORT` 覆盖。

### 账号与登录（仓库范围）

本仓库是**独立可运行的 ALSF 服务**，不包含父级合集网关与账号系统：

- `root/server.mjs`（24740，`/alsf/` 准入 + `hub_session` 账号会话）、`home/` 合集主页、`data/users.json` / `data/sessions.json` 都在**父级合集**里，**不在本仓库**。
- 独立运行时，客户端 `fetch('/api/me')` 取不到账号 → 自动回退为本地昵称 / 访客名（`星海NNN`），可直接开局。
- 正式上线计划用 **Supabase Auth**（邮箱 / OAuth）替代父级自建账号；实时对局仍走本服务 ws。

### 操作

| 平台 | 移动 | 出牌 |
|---|---|---|
| 桌面 | **点击相邻空格**（或看棋盘高亮） | 点击手牌 → 按提示点目标 / 格子 → 结束回合 |
| 手机 | 同左（触摸） | 同左；聊天按钮展开/收起聊天面板 |

### 常用命令

```bat
npm run dev            :: 开发启动（tsx watch，热重载）
npm run typecheck      :: 类型检查
npx vitest run         :: 全部测试
npm run build          :: 编译到 dist/
npm start              :: 生产启动（需先 build）
node scripts\build-packages.mjs                    :: 重新打包数据包
node scripts\smoke.mjs ws://127.0.0.1:24710/ws     :: 多客户端冒烟（完整对局）
node scripts\verify-web.mjs http://127.0.0.1:24710/ :: 桌面 + 手机 E2E 截图
```

---

## 目录结构

```
alsf/
├── src/server/                 服务端（Node 22 + ws，权威）
│   ├── index.ts                入口：静态服务 + /health + WS + 1Hz housekeeping
│   ├── env.ts                  极简 .env 加载（先于 config）
│   ├── config.ts               端口 / 超时 / 手牌数 / 回血量 等规则参数
│   ├── protocol/types.ts       ★ 线协议契约 v0.2（改这里 = 改协议）
│   ├── data/
│   │   ├── packages.ts         ★ 数据包加载（zip：manifest + stars/ cards/ maps/ + js）
│   │   ├── store.ts            默认内容（数据包）+ data/catalog.json 管理端覆盖
│   │   └── zip.ts              零依赖 zip 读写
│   ├── game/
│   │   ├── match.ts            ★ 对局聚合根：阶段机 + 回合 + 行动派发 + 中止
│   │   ├── deck.ts / rng.ts    共享牌堆（抽空洗回）+ 可播种随机
│   │   ├── effects.ts          伤害管线 + 修正收集（被动牌 / 状态）
│   │   ├── grid.ts             方格地图：4 邻 / BFS / Bresenham 视线
│   │   └── room.ts / lobby.ts  房间（= 一局）+ 游戏大厅 + 观战者集合
│   ├── net/gateway.ts          ★ 消息分派 + 房间路由 + 广播 + 重连 + 观战
│   ├── net/admin.ts            管理端 API（独立端口，无鉴权）
│   └── http/static.ts          静态文件服务
├── web/                        网页客户端（原生 JS，零构建）
│   ├── index.html              7 屏：进入/大厅/房间/选英雄/选出生点/对战/结算
│   ├── css/style.css           主题 + 游戏内/游戏外分区 + 动画 + 手机适配
│   └── js/{net,game,render,main}.js
├── packages/                   已打包的数据包（*.zip）
├── packages-src/               数据包源（per-file；node scripts/build-packages.mjs 打包）
├── data/                       运行期数据（管理端保存的 catalog.json 等）
├── test/                       vitest（grid / deck / match / lobby / gateway）
├── docs/design/                设计文档
├── docs/preview/               界面预览与截图
└── scripts/                    smoke.mjs / verify-web.mjs / build-packages.mjs
```

---

## 数据包机制

内容（英雄 / 卡牌 / 地图）**不写死在代码里**，全部由数据包提供。本机自带的**默认数据包**名为 **AllStarFighting System Core Content Pack**；新增 / 修改内容只需改数据包，不用改引擎。

> 默认数据包**内部具体有哪些英雄 / 卡牌 / 地图**不在本 README 记载范围（属于数据包内容，请直接查看数据包或管理端）。

### 安全边界（重要）

数据包里的自定义 JS 由服务端用 Node `vm` 执行。**`vm` 不是安全沙箱**（Node 官方文档明确说明）。当前只做了「加固」而非「隔离」：

- 禁用字符串代码生成（`eval` / `new Function` / wasm）；
- 只暴露最小对象（`api` / `self` / `target` / `tile` / `ctx`）；
- 屏蔽 `constructor` / `__proto__` / `prototype` 等常见逃逸入口；
- 单次执行 200ms 超时。

这能挡住随手写的逃逸，**挡不住有意的宿主对象逃逸**。因此：**只加载你自己或信任的人编写的数据包 / Mod**；不要接受「任意玩家可上传脚本」的数据包。若要支持不可信 Mod，请改用 `isolated-vm` / QuickJS 等真正的隔离引擎。

### 包结构

每个数据包是 `packages/<name>.zip`，源目录在 `packages-src/<name>/`：

```
manifest.json          基础信息（见下表）
stars/<id>.json        每个人物一个文件（id 写在文件里）
stars/js/*.js          人物脚本（special / skills 里用 "js:文件名.js" 引用）
cards/<id>.json        每张卡牌一个文件（id 写在文件里）
cards/js/*.js          卡牌脚本
maps/<id>.json         每张地图一个文件（id 写在文件里）
maps/js/*.js           地图脚本
assets/                图片等素材
```

- 一个包可以只提供其中一类，也可以全都有。
- `js:` 按**文件名**解析，脚本放 `stars/js/`、`cards/js/`、`maps/js/` 都能被引用。
- 旧的「manifest 内联 `heroes[] / cards[]`」格式仍兼容，可与 per-file 混用。

### manifest.json 字段

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | string | 包标识 |
| `name` | string | 包名（展示用） |
| `defaultMap` | string? | 默认地图 id；声明后该地图会排到加载结果首位，作为未指定地图时的兜底 |
| `heroes` / `cards` / `maps` | array? | 可选：旧格式的内联数组（不推荐，新内容请用 per-file） |

### 内容对象格式（schema，非内容清单）

> 以下是**字段格式规范**；数据包里具体有哪些内容不在本 README 记载范围。

**人物 `stars/<id>.json`**

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` / `name` | string | 标识 / 显示名 |
| `title` | string? | 称号 |
| `hp` | number | 初始生命 |
| `attack` | `{ type: 'FAR'\|'NER'\|'MAG', damage: number }` | 普攻类型（远/近/法）与伤害 |
| `special` | `{ text?, onTurnStart?, onDamaged?, onDeath? }` | 常驻特殊效果；钩子值可为内联 JS 或 `"js:x.js"` |
| `skills` | 3 项 | 依次对应牌堆「技1 / 技2 / 大」；每项 `{ name, targeting, steps? \| code?, text? }` |

**卡牌 `cards/<id>.json`**

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` / `name` | string | 标识 / 显示名 |
| `type` | `'BSC'\|'PSV'\|'PLB'` | 一般 / 被动 / 放置 |
| `amount` | number | 牌堆份数 |
| `targeting` | `'none'\|'self'\|'enemy'\|'ally'\|'tile'` | 目标类型 |
| `steps` \| `code` | array \| string | 声明式步骤，或沙箱 JS |
| `text` | string? | 牌面说明 |
| `hooks` | `{ onDeath? }` | 被动牌钩子 |
| `ui` | `'pickCard'?` | 特殊交互（自选一张牌） |
| `kind` / `category` | string? | 触发牌：`kind:'general'` + `category:'atk'\|'skill1'\|'skill2'\|'ult'\|'heal'` |

**地图 `maps/<id>.json`**

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` / `name` | string | 标识 / 显示名 |
| `tiles` | string[] \| array[] | 地形：`.~#SH` 字符串行，或二维 `Terrain[][]`（plain/water/wall/spawn/heal） |
| `spawns` / `heals` | `{x,y}[]`? | 使用字符串行时自动从 `S`/`H` 推导；二维数组时手填 |

### 加载与生效

1. 服务端启动时扫描 `packages/*.zip`（按文件名顺序合并），逐个解析 `manifest` 与 per-file 内容。
2. 得到一份内存目录（英雄 / 卡牌 / 地图）；`manifest.defaultMap` 指定的地图置顶。
3. 管理端保存后写入 `data/catalog.json`，**覆盖**数据包默认值；`data/catalog.json` 存在时优先使用它。
4. 管理端保存会**热更内存**，新对局立即生效（无需重启）。

### 构建数据包

```bat
node scripts\build-packages.mjs
```

会扫描 `packages-src/<name>/` 下所有文件，递归打包为 `packages/<name>.zip`（零依赖 store 方式）。

### Supabase 存储桶（云端数据包）

桶**根目录**扫描：每个 **文件夹** = 一个数据包；`.pack`（**推荐**）或 `.zip` 也是一个数据包；根目录的 `catalog.json`（合并目录）可直接用。

- 上传：`node scripts/upload-pack.mjs`（读取上一级 `token.env` 的 `ProjectURL` / `Secretkey` / `Bucketname`，把 `packages-src/system` 传到 `system/`）。
- 桶需 **public**（Storage → Make public），浏览器才能读。
- 若要 **文件夹 / zip 扫描**（依赖 `list`），还需给 `storage.objects` 加匿名 SELECT 策略：
  ```sql
  create policy "datapack public read" on storage.objects for select using (bucket_id = 'datapack');
  ```
  不加策略也能用根 `catalog.json`（public 可直接下载，不需要 `list`）。
- ⚠️ **IDM 会拦截 `.zip`**：桶里不要放 `.zip`；用文件夹、根 `catalog.json`，或把 zip 改名 `.pack`（loader 按 PK 头识别，不认后缀）。
- 本地调试：`npm run build:web` 会把当前包导出 `web/pack/catalog.json`，并生成 `web/js/config.local.js`（读 `token.env`，只含 publishable key，已 gitignore）。

---

## 管理端

独立端口（默认 `ALSF_ADMIN_PORT` = 游戏端口 + 1），**无鉴权**，默认只绑 **`127.0.0.1`**（`ALSF_ADMIN_HOST`），不对外；根入口不暴露（网关对 `/alsf/admin` 返回 404）。

- 左侧分「卡牌 / 英雄 / 地图」，右侧可视化表单；`JSON 视图` 可手改完整对象。
- 卡牌效果可用「op 下拉 + ＋加一条」逐条编辑（伤害 / 回血 / 状态 / 位移 / 抽牌…）。
- `id` 可修改（保存前会校验非空与同分类不重复）。
- 地图支持网格点格子切地形（空地 → 水 → 墙）。
- 「保存全部」写入 `data/catalog.json` 并热更，新对局生效。

---

## 架构要点

- **回合制无 tick**：不用 60Hz 主循环；阶段/回合到期、掉线宽限、房间回收全部在 **1Hz housekeeping** 里推进，动画纯客户端。
- **阶段机**：`WAITING → HERO_SELECT → DEAL → SPAWN_SELECT → PLAYING → FINISHED`，每个等待阶段有超时兜底自动分配。
- **权威服务端**：客户端只发意图（`MOVE / PLAY_CARD / DISCARD_CARD / END_TURN / UNDO_MOVE`），一切判定（视线 / 范围 / 伤害 / 胜负）在服务端。
- **协议 v0.2**：`TURN / STATE / EVENT / CHAT` 全房同发；只有 `WELCOME / HAND` 逐会话。客户端比对 `TURN.currentId` 判断轮到自己。
- **观战**：非 `WAITING` 阶段加入房间的会话进入观战集合，参与广播但不进回合序、不收手牌。
- **掉线重连**：重连时带 `resumeId`（上次的 playerId）即可回到原房间与席位。
- **会话 ID**：每个玩家进房时分配一个随机会话 ID，**仅后端日志/调试使用**，不下发前端。
- **游戏内 / 游戏外分区**（硬要求）：棋盘 + 手牌 = 亮底实线边框；信息头 / 聊天 = 暗底虚线边框，绝不叠压。
- **手机端**：`viewport-fit=cover` 安全区、Pointer Events 触摸、`≥16px` 输入框防 iOS 缩放、横竖屏自适应。
- **零构建客户端**：`web/js/*.js` 为原生 ES Module，改完刷新即生效（无打包步骤）。

---

## 协议 v0.2（摘要）

信封：`{ "t": "<类型>", "d": { … } }`

**上行**：`JOIN / PING / CREATE_ROOM / JOIN_ROOM / LEAVE_ROOM / START_MATCH / CHOOSE_TEAM / PICK_HERO / PICK_SPAWN / MOVE / PLAY_CARD / DISCARD_CARD / END_TURN / UNDO_MOVE / CHAT / RESTART_MATCH`

**下行**：`WELCOME / LOBBY / ROOM / PHASE / HERO_OPTIONS / SPAWN_OPTIONS / MAP / TURN / HAND / STATE / EVENT / CHAT / RESULT / PONG / ERROR`

错误码：`VERSION_MISMATCH / ROOM_NOT_FOUND / ROOM_FULL / TOO_MANY_ROOMS / BAD_PHASE / NOT_YOUR_TURN / HERO_TAKEN / SPAWN_TAKEN / BAD_TARGET / OUT_OF_RANGE / NO_LOS / ILLEGAL_MOVE / CARD_NOT_IN_HAND / CARD_NOT_PLAYABLE / NOT_HOST / BAD_TEAM …`

- `WELCOME` 含 `maps`（可选地图列表，建房下拉用）；`LOBBY` 含房间信息（含地图名 / 观战人数）。
- `CREATE_ROOM` 可带 `mapId` 指定地图；缺省用数据包的默认地图。
- `RESULT` 可选带 `reason`（房主退出 / 掉线超时等非正常结束）。
- **改协议 = 改 `src/server/protocol/types.ts` + `web/js/net.js`，两处必须同步。**

---

## 部署（Supabase + Render + 静态客户端）

推荐拓扑（无需自备服务器）：

```
静态客户端（Render Static Site / Cloudflare Pages）
  ├─ 首页 home/
  └─ ALSF 客户端 web/  ──wss──▶ Render Web Service（ALSF 对局引擎 + /ws）
                                     └─ 战绩/资料 ──▶ Supabase Postgres
Supabase：Auth（登录）+ Postgres（内容/战绩）+ Storage（素材）
```

> **边界**：Supabase 不能托管**有状态的 WS 对局引擎**（只有 Auth / Postgres / 存储 / 无状态 Edge Functions，没有常驻 WS 进程）。实时对局必须跑在 Render（或同类 Web Service）；Supabase 负责账号、数据与素材。

### 1) Supabase

- 新建项目，记下 `SUPABASE_URL`、`SUPABASE_ANON_KEY`、`SUPABASE_SERVICE_ROLE_KEY`、`SUPABASE_JWT_SECRET`。
- Auth：开 Email（或 OAuth）；Site URL / Redirect URLs 填静态客户端域名。
- Postgres：`profiles` / `matches` 等表 + RLS。
- `SERVICE_ROLE_KEY` / `JWT_SECRET` **只放 Render 环境变量**，不要进仓库或前端。

### 2) Render Web Service（对局 / WS）

- 连本仓库：Build `npm ci --include=dev && npm run build`，Start `npm start`，Health `/health`。
- Render 注入 `PORT`；服务端优先读 `PORT`，其次 `ALSF_PORT`，最后 24710。
- **只暴露游戏端口**：Render 只路由 `PORT`；管理端绑 `127.0.0.1:PORT+1`，不对外；若前面还有网关，后端设 `ALSF_HOST=127.0.0.1`。
- WebSocket 与 HTTP 同端口（`/ws`）：`wss://<service>.onrender.com/ws`。
- 环境变量：`NODE_ENV=production`、`SUPABASE_URL`、`SUPABASE_JWT_SECRET`、`SUPABASE_SERVICE_ROLE_KEY`。
- 免费实例会休眠（冷启动 / WS 断），正式用建议付费实例或定时 ping 保活；`render.yaml` 已内置。

### 3) 静态客户端

- 把 `web/`（以及首页 `home/`）发布到 **Static Site**（Render Static / Cloudflare Pages / GitHub Pages）。
- 编辑 `web/js/config.js`，把 WS 指向 Render：
  ```js
  window.__ALSF_WS_URL = 'wss://<your-service>.onrender.com/ws';
  ```
  同源部署（客户端由 Render 直接托管）时留空即可。
- 首页若单独静态发布，游戏入口 `url` / `health` 要改成 Render 的绝对地址。

### 4) 账号（Supabase Auth）

- 客户端用 Supabase 登录，把 `session.access_token` 放进 `JOIN`；
- Render 服务端用 `SUPABASE_JWT_SECRET` 校验，取 `email` / `user_metadata.name` 作为玩家名；无 token 回退访客名（现状）。
- 战绩写 `matches`（服务端 service_role 或客户端 RLS）。
- 当前仓库仍是「访客名可直接玩」版本；Supabase 登录属下一步接入（需项目 URL + anon key）。

### 自建服务器（可选）

- 同机部署：`npm run dev` / `npm start`，客户端与 WS 同源，`config.js` 留空。
- Nginx 反代 WS：
  ```nginx
  location /alsf/ {
    proxy_pass http://127.0.0.1:24710/;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
  }
  ```
- 数据落盘：`data/catalog.json`、`packages/*.zip`；管理端默认只绑 `127.0.0.1`，不对外。

---

## 测试与排障

| 症状 | 排查 |
|---|---|
| 页面卡在「正在进入游戏大厅…」 | 浏览器 F12 看是否有 JS 报错；多半是某个 `web/js/*.js` 语法错误导致模块不执行。改完前端先 Ctrl+F5 硬刷新。 |
| 看不到地图 / 无法开局 | 数据包是否满足 `maps/*.json`；`/health` 与 `/admin/api/catalog` 可确认地图数量。 |
| 改了数据包没生效 | 重新 `node scripts/build-packages.mjs` 并重启服务端；若存在 `data/catalog.json`，它会**覆盖**数据包，需同步更新或删除。 |
| 管理端打不开 | 用 `ALSF_ADMIN_PORT` 对应端口；管理端不在根入口 `/alsf/admin`。 |
| 房主退出后对局没结束 | 仅对「对局进行中」生效；`WAITING` 阶段退出只移交房主。 |

```bat
npm run typecheck
npx vitest run
```

---

## 实施路线

| 阶段 | 内容 | 状态 |
|---|---|---|
| S1 | 协议 v0.2 + 模块重排（删实时骨架） | ✅ |
| S2 | 对局状态机全链路 + 超时兜底 | ✅ |
| S3 | 回合引擎 + 1 格 4 邻移动 | ✅ |
| S4 | 共享牌堆 + 手牌 + 出牌 + 战斗 + 胜负 | ✅ |
| S5 | 道具牌三类 + EffectOp 全算子 | ✅ |
| S6 | 聊天 + 组队 5 模式 + 重开 + 掉线宽限 | ✅ |
| S7 | 管理端（独立端口，无鉴权；内容增删改 + 热更）+ 数据包 per-file | ✅（Supabase 迁移待做） |
| S8 | 观战 / 个人设置 / `.env` 部署准备 / 手机深测 / 上线 | 进行中 |

> 所有后端最终部署 Supabase（Auth + Postgres 存内容与战绩）；实时对局仍走自研 ws。

---

## 开发约定

- **零依赖 / 零构建**：服务端仅 `ws`；客户端原生 ES Module，无打包。
- **协议两处同步**：`src/server/protocol/types.ts` ↔ `web/js/net.js`。
- **内容归数据包**：英雄 / 卡牌 / 地图请在 `packages-src/` 下改，不要把内容写进代码。
- **数据包脚本视为可信代码**：`vm` 不是安全沙箱，只加载可信来源（见「安全边界」）。
- **游戏内 / 外分区**：视觉上必须分明，互不叠压。
- **文案**：除游戏名「全冥星大坐站」外，不要出现「冥」字。
- 改完客户端：静态文件由服务端直读，**硬刷新**即可；改服务端 TS：`tsx watch` 自动重载，生产需重新 build + 重启。
