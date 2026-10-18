# ALSF 数据包制作器（packmaker）

可视化制作 ALSF 数据包（英雄 / 卡牌 / 地图 / 脚本）的 tkinter 桌面小工具。
**零第三方依赖**（只用 Python 标准库 tkinter），双击 `启动制作器.bat` 即用（pythonw，无控制台窗口）。

## 用法

| 操作 | 说明 |
|---|---|
| 新建 | 建空数据包（manifest + 空列表） |
| 打开… | 读一个数据包**目录**（`manifest.json` + `stars/ cards/ maps/ js/`），也吃 zip 解压后的目录 |
| 保存 | 写回目录：`manifest.json` + 每条目一个 `stars|cards|maps/<id>.json` + `js/*.js` |
| 打包 ZIP | 先把当前包存到目录，再打成一个 zip（zip 内路径相对包根平铺，引擎直接吃） |
| 校验 | id 非空 / 不重复、至少 1 英雄 1 地图、defaultMap 存在于地图列表 |

四页 Notebook：**英雄 / 卡牌 / 地图 / 脚本**。

- **英雄**：id / 名称 / 称号 / 生命 / 描述 + 普攻（远近法 + 伤害）+ modifiers 修正编辑器 +
  技能三槽（技1 / 技2 / 大招，各带名称 / 目标 / steps 步骤编辑器）。
- **卡牌**：id / 名称 / 份数 / 类型（BSC/PSV/PLB）/ 类别（atk/skill1/skill2/ult/heal）/
  目标 / 牌面说明 + steps 步骤编辑器 +（PSV 的 effects）+ 可选 `code` 脚本框
  （可写 `"js:文件名.js"` 引用「脚本」页的文件）。
- **地图**：id / 名称 + 网格画布（左键画；空地 / 水 / 墙 / 出生点 / 回血点五种笔刷，
  尺寸 5–40 可调）。保存为引擎的字符行 `. ~ # S H`。
- **脚本**：js 文件增删改 + 重命名，内容按文件名被 `js:` 引用。

steps 每一步 = `{fn, ...参数}`：fn 下拉（中文），参数控件按 `match.ts` 的
`API_PARAMS` 位置参数表动态生成（ref→self/target 下拉、mode→远近法、kind→状态、
num→数字、bool→勾选、text→文本）。effects 每条 = `{op, ...字段}`，op 下拉 +
字段按 `types.ts` 的 `EffectDef` 全集（OP_FIELDS）动态生成。

## 目录

```
packmaker/
├── packlib.py       数据层（纯逻辑，无 GUI 依赖）：加载/保存/zip/校验/枚举/API_PARAMS
├── packmaker.pyw    GUI（tkinter）
├── 启动制作器.bat    GBK + CRLF 启动器（pythonw）
└── README.md
```

## 格式权威（改格式前先读这些）

| 内容 | 权威出处 |
|---|---|
| 目录结构 / zip 内布局 / per-file 合并顺序 | `alsf/src/server/data/packages.ts` |
| EffectDef 全集 / TargetKind / GeneralCategory | `alsf/src/server/protocol/types.ts` |
| steps 的 fn 位置参数表（API_PARAMS） | `alsf/src/server/game/match.ts` |
| 官方示例（照抄不会错） | `alsf/packages-src/system/` |

## 做出来的包怎么用

1. **本地**：把目录（或 zip）放进 `alsf/datapacks/`，重启服务端即加载（文件夹包改完刷新即生效）；
2. **部署版**：上传到 Supabase 存储桶 `datapacks` 根目录（`node scripts/upload-pack.mjs`），
   或打包成 `.pack` / `.alsfpack` 上传（IDM 会拦 `.zip`，故推荐改名）；
3. **管理端**：`datapacks/_admin/` 是管理端保存生成的覆盖包，**不要与制作器混编辑同一个目录**。

## 已知边界

- 地图出生点 / 回血点不强制数量与不重复（引擎按 `S`/`H` 字符自动推导 `spawns`/`heals`，
  重复由对局分配逻辑处理）；
- 旧格式「manifest 内联 `heroes[]/cards[]`」只读兼容，保存一律转 per-file；
- `js:` 按**文件名**解析（不分目录），重名文件以脚本页列表为准。
