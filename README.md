# ALSF · 全冥星大坐站 —— 静态部署版（web 分支）

本分支是**要部署的前端产物**（纯静态、零构建、零服务端依赖），只含 ALSF 网页客户端：
不含合集首页、不含 wario、不含管理端（admin）、不含服务端源码。
源码与构建脚本在 `main` 分支；本分支内容由 `npm run build:web` 生成后拷入。

## 部署

整个目录丢到任意静态托管即可（Cloudflare Pages / GitHub Pages / Render Static / Vercel…）：

- 根目录即站点根，`index.html` 为入口；
- 构建根目录指向仓库根（Build output directory = `/`），无构建命令。

## 运行方式（方案 1 · 房主权威）

- 没有常驻服务端：**打开页面的人就是房主**，对局引擎跑在房主浏览器里；
- 房主进房间后点「复制邀请链接」发给别人，好友打开链接（`?mode=guest&room=xxx`）加入；
- 玩家动作经 **Supabase Realtime Broadcast** 转发；访客本地重放动作做反作弊校验；
- 数据包从 **Supabase Storage 桶**（`datapack`）根目录扫描加载，失败回退内置 `pack/catalog.json`。

## 配置（js/config.local.js）

| 键 | 说明 |
| --- | --- |
| `__SUPABASE_URL` / `__SUPABASE_ANON_KEY` | Supabase 项目地址与 **publishable（anon）key**——公开可露，切勿放 service_role |
| `__ALSF_PACK_BUCKET` | 数据包存储桶名（根目录扫描：每个文件夹=一个包，也识别 `.pack`/`.alsfpack` zip） |
| `__ALSF_MODE` | 部署版固定 `host`（房主权威）；`?mode=ws` 可临时切回 WS 服务端模式 |
| `__ALSF_TRANSPORT` | 留空=自动（Supabase Realtime，失败回退 BroadcastChannel）；`local` 强制本地 |
| `__ALSF_AUTH` | 登录门禁开关：`'on'` 开启（本分支默认已设 `'on'`），`?auth=off` 可临时关闭 |

登录门禁：开启后未登录不能进游戏，需邮箱+密码登录/注册（UI 照仿首页登录注册）。
Supabase 若开启了「Confirm email」，新注册用户要先到收件箱点确认邮件再回来登录。

## 重新生成本分支

```bat
cd alsf
npm run build:web
xcopy /E /Y /I web\index.html web\css web\js web\engine\pack.js web\pack <部署目录>
```

（`js/config.local.js` 由 `scripts/gen-config.ts` 从仓库上一级 `token.env` 生成，
只写 publishable key；`__ALSF_MODE` 需手工改为 `"host"`。）
