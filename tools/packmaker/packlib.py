# -*- coding: utf-8 -*-
"""
ALSF 数据包制作器 —— 数据层（纯逻辑，无 GUI 依赖，可单独测试）。

格式权威出处（改格式前先读这几个文件）：
  - alsf/src/server/data/packages.ts   加载器：loadZip/mapHero/mapCard/mapWorld/parseRows
  - alsf/src/server/protocol/types.ts  EffectDef 全集 / TargetKind / GeneralCategory
  - alsf/src/server/game/match.ts      API_PARAMS（steps 的 fn 位置参数表）
  - alsf/packages-src/system/          官方示例包（per-file 目录结构）

数据包结构（zip 内平铺，不带顶层目录；loader 按 'stars/' 'cards/' 'maps/' 前缀找）：
  manifest.json   { id, name, defaultMap }
  stars/*.json    每个人物一个文件（id 写在文件内）
  cards/*.json    每张卡牌一个文件（id 写在文件内）
  maps/*.json     每张地图一个文件（tiles 为 ".~#SH" 字符行）
  js/*.js         可选脚本，manifest 不引用；steps/code 里用 "js:文件名.js" 按文件名引用
"""

import json
import os
import zipfile

# ── 枚举（与管理端 web/admin/admin.js 的显示名保持一致） ──

ATTACK_TYPES = {'FAR': '远', 'NER': '近', 'MAG': '法'}          # packages.ts ATTACK_MAP
CARD_TYPES = {'BSC': '基础牌', 'PSV': '被动牌', 'PLB': '放置牌'}  # packages.ts CARD_TYPE_MAP
GENERAL_CATS = {'atk': '攻击', 'skill1': '技1', 'skill2': '技2', 'ult': '大招', 'heal': '回血'}
TARGETING = {'none': '无', 'self': '自身', 'enemy': '敌人', 'ally': '队友', 'tile': '格子'}
STATUS_KINDS = ['stun', 'disarm', 'silence', 'burn', 'poison',
                'reflect', 'magicVeil', 'thorn', 'fakedeath']
DAMAGE_MODES = ['FAR', 'NER', 'MAG']
REF_OPTIONS = ['self', 'target']
TERRAIN_CHARS = {'plain': '.', 'water': '~', 'wall': '#', 'spawn': 'S', 'heal': 'H'}

# API_PARAMS：照抄 match.ts:755 —— steps 每一步 {fn, ...args} 的位置参数顺序。
# GUI 按这张表为每个 fn 生成参数输入框；不在表内的 fn 会收到整个 args 对象（脚本向）。
API_PARAMS = {
    'damage': ['ref', 'amount', 'mode'],
    'heal': ['ref', 'amount'],
    'shield': ['ref', 'amount'],
    'setHp': ['ref', 'hp'],
    'hp': ['ref'],
    'maxHp': ['ref'],
    'alive': ['ref'],
    'addStatus': ['ref', 'kind', 'turns', 'value'],
    'removeStatus': ['ref', 'kind'],
    'grantMove': ['tiles'],
    'extraTurn': [],
    'drawCards': ['count'],
    'discardRandom': ['ref', 'count'],
    'stealCards': ['from', 'count'],
    'exchangeHands': ['ref'],
    'teleportTo': ['ref', 'x', 'y'],
    'teleportToWall': [],
    'teleportRandomAll': [],
    'sendToSpawn': ['ref'],
    'swapPositions': ['ref'],
    'push': ['ref', 'tiles'],
    'pull': ['ref', 'tiles'],
    'placeTrap': ['damage'],
    'placeRock': [],
    'placeAltar': [],
    'crossTiles': ['blockedByWall'],
    'enemiesInTiles': ['tiles'],
    'enemiesInRadius': ['ref', 'radius'],
    'allies': ['ref'],
    'aliveEnemies': ['ref'],
    'randomInt': ['n'],
    'announce': ['text'],
    'terrainAt': ['ref'],
    'pos': ['ref'],
    'placeTrapAt': ['x', 'y', 'damage'],
    'isWall': ['x', 'y'],
    'inBounds': ['x', 'y'],
}

# 参数控件类型（GUI 用）：ref=对象下拉 / mode=远近法 / kind=状态下拉 / bool=布尔 / text=文本 / num=数字
PARAM_KIND = {
    'ref': 'ref', 'from': 'ref', 'mode': 'mode', 'kind': 'kind',
    'blockedByWall': 'bool', 'text': 'text',
}

# fn 中文名（下拉显示；没有的用原名）
API_LABELS = {
    'damage': '伤害', 'heal': '回血', 'shield': '护盾', 'setHp': '设HP', 'hp': '查HP',
    'maxHp': '查上限', 'alive': '查存活', 'addStatus': '加状态', 'removeStatus': '去状态',
    'grantMove': '加移动力', 'extraTurn': '额外回合', 'drawCards': '抽牌', 'discardRandom': '随机弃牌',
    'stealCards': '偷牌', 'exchangeHands': '换手牌', 'teleportTo': '传送到坐标', 'teleportToWall': '传到墙边',
    'teleportRandomAll': '全员随机传送', 'sendToSpawn': '送回出生点', 'swapPositions': '交换位置',
    'push': '推', 'pull': '拉', 'placeTrap': '放陷阱', 'placeRock': '放岩石', 'placeAltar': '放祭坛',
    'crossTiles': '十字格子', 'enemiesInTiles': '格子内敌人', 'enemiesInRadius': '范围内敌人',
    'allies': '队友', 'aliveEnemies': '存活敌人', 'randomInt': '随机数', 'announce': '公告',
    'terrainAt': '查地形', 'pos': '查坐标', 'placeTrapAt': '坐标放陷阱', 'isWall': '是墙吗',
    'inBounds': '在界内吗',
}

# EffectDef 全集（types.ts:182-211）——常驻修正（modifiers / 被动牌 effects）编辑器用。
# 管理端 OP_FIELDS 是旧子集，这里补上 ghost/healBonus/burnImmune/place/terrain/foresee。
OP_FIELDS = {
    'damage': [('amount', '数值', 'num'), ('kind', '类型', ['physical', 'magic'])],
    'heal': [('amount', '数值', 'num')],
    'draw': [('count', '张数', 'num')],
    'discard': [('count', '张数', 'num'), ('who', '目标', ['self', 'target'])],
    'steal': [('count', '张数', 'num')],
    'status': [('status', '状态', STATUS_KINDS), ('turns', '回合', 'num'), ('value', '强度', 'num')],
    'shield': [('amount', '数值', 'num')],
    'pierce': [('ratio', '比例', 'num')],
    'splash': [('ratio', '比例', 'num')],
    'lifesteal': [('ratio', '比例', 'num')],
    'push': [('tiles', '格数', 'num')],
    'pull': [('tiles', '格数', 'num')],
    'teleport': [('to', '目标', ['target', 'spawn', 'random'])],
    'swap': [],
    'move': [('tiles', '格数', 'num')],
    'extraTurn': [],
    'place': [('object', '物体', ['trap', 'rock', 'altar']), ('expiresIn', '持续回合', 'num')],
    'terrain': [('to', '地形', ['wall', 'plain']), ('radius', '半径', 'num')],
    'foresee': [],
    'ghost': [],
    'healBonus': [('amount', '数值', 'num')],
    'burnImmune': [],
}
OP_LABELS = {
    'damage': '伤害', 'heal': '回血', 'shield': '护盾', 'status': '状态', 'move': '移动',
    'push': '推', 'pull': '拉', 'pierce': '穿刺', 'splash': '溅射', 'lifesteal': '吸血',
    'draw': '抽牌', 'discard': '弃牌', 'steal': '拿牌', 'teleport': '传送', 'swap': '交换',
    'extraTurn': '额外回合', 'place': '放置物', 'terrain': '改地形', 'foresee': '预见',
    'ghost': '穿墙', 'healBonus': '治疗加成', 'burnImmune': '免疫灼烧',
}

# 技能三槽位（skills 数组顺序 → 引擎 skill1/skill2/ult）
SKILL_SLOTS = [('skill1', '技1'), ('skill2', '技2'), ('ult', '大招')]


# ── 新条目模板（照管理端「＋ 新增」的默认值） ──

def new_card():
    return {
        'id': 'new_card', 'amount': 1, 'name': '新卡牌',
        'kind': 'general', 'category': 'atk', 'targeting': 'enemy',
        'steps': [{'fn': 'damage', 'ref': 'target', 'amount': 2, 'mode': 'NER'}],
        'text': '效果说明',
    }


def new_hero():
    return {
        'id': 'new_hero', 'name': '新英雄', 'hp': 6,
        'attack': {'type': 'NER', 'damage': 2},
        'modifiers': [],
        'skills': [
            {'name': '技能1', 'targeting': 'enemy',
             'steps': [{'fn': 'damage', 'ref': 'target', 'amount': 2, 'mode': 'NER'}], 'text': ''},
            {'name': '技能2', 'targeting': 'self',
             'steps': [{'fn': 'shield', 'ref': 'self', 'amount': 2}], 'text': ''},
            {'name': '大招', 'targeting': 'enemy',
             'steps': [{'fn': 'damage', 'ref': 'target', 'amount': 4, 'mode': 'MAG'}], 'text': ''},
        ],
        'text': '',
    }


def new_map(w=13, h=11):
    return {
        'id': 'new_map', 'name': '新地图',
        'tiles': ['.' * w for _ in range(h)],
        '_w': w, '_h': h,
    }


# ── 地图：字符行 ⇄ token 矩阵 ──

def rows_to_tiles(rows):
    """['..~', '..#'] → [['plain','plain','water'], ...]（GUI 编辑用）。"""
    out = []
    for r in rows:
        out.append({'.': 'plain', '~': 'water', '#': 'wall', 'S': 'spawn', 'H': 'heal'}.get(c, 'plain')
                   for c in r)
    return [list(r) for r in out]


def tiles_to_rows(tiles):
    """token 矩阵 → 字符行（保存用，packages.ts parseRows 吃这个）。"""
    rev = {v: k for k, v in TERRAIN_CHARS.items()}
    return [''.join(rev.get(t, '.') for t in row) for row in tiles]


def empty_tiles(w, h):
    return [['plain'] * w for _ in range(h)]


# ── 包读写 ──

class Pack:
    """内存中的数据包。scripts: {js文件名: 内容}。"""

    def __init__(self):
        self.manifest = {'id': 'mypack', 'name': '我的数据包', 'defaultMap': ''}
        self.heroes = []
        self.cards = []
        self.maps = []
        self.scripts = {}


def _read_json(path):
    with open(path, 'r', encoding='utf-8') as f:
        return json.load(f)


def _write_json(path, obj):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(obj, f, ensure_ascii=False, indent=2)
        f.write('\n')


def load_pack(root):
    """读数据包目录 → Pack。兼容两种组织：per-file 目录 + manifest 内联数组（照 loadZip 合并顺序）。"""
    mpath = os.path.join(root, 'manifest.json')
    if not os.path.isfile(mpath):
        raise FileNotFoundError('目录下没有 manifest.json：' + root)
    pack = Pack()
    pack.manifest = _read_json(mpath)
    if not isinstance(pack.manifest.get('id'), str):
        raise ValueError('manifest.json 缺少 id')

    def scan(sub, key):
        d = os.path.join(root, sub)
        out = []
        if os.path.isdir(d):
            for fn in sorted(os.listdir(d)):
                if fn.endswith('.json'):
                    try:
                        obj = _read_json(os.path.join(d, fn))
                    except Exception as e:
                        raise ValueError('%s/%s 解析失败：%s' % (sub, fn, e))
                    if isinstance(obj, list):
                        out.extend(obj)
                    elif isinstance(obj, dict):
                        out.append(obj)
        return out

    # manifest 内联在前、目录文件在后（与 packages.ts loadZip 的顺序一致）
    pack.heroes = list(pack.manifest.get('heroes') or []) + scan('stars', 'heroes')
    pack.cards = list(pack.manifest.get('cards') or []) + scan('cards', 'cards')
    pack.maps = list(pack.manifest.get('maps') or []) + scan('maps', 'maps')

    # js 脚本：任意子目录，按文件名索引（loader 同规则）
    for dirpath, _dirs, files in os.walk(root):
        for fn in files:
            if fn.endswith('.js'):
                p = os.path.join(dirpath, fn)
                try:
                    with open(p, 'r', encoding='utf-8') as f:
                        pack.scripts[fn] = f.read()
                except Exception:
                    pass
    return pack


def save_pack(root, pack):
    """写数据包目录（覆盖写，不删除多余文件）。"""
    os.makedirs(root, exist_ok=True)
    _write_json(os.path.join(root, 'manifest.json'), {
        'id': pack.manifest.get('id', ''),
        'name': pack.manifest.get('name', ''),
        'defaultMap': pack.manifest.get('defaultMap', ''),
    })
    for hero in pack.heroes:
        _write_json(os.path.join(root, 'stars', str(hero.get('id', 'x')) + '.json'), hero)
    for card in pack.cards:
        _write_json(os.path.join(root, 'cards', str(card.get('id', 'x')) + '.json'), card)
    for m in pack.maps:
        # tiles 统一存字符行（编辑器内部是 token 矩阵，这里转换）
        out = dict(m)
        tiles = out.get('tiles')
        if isinstance(tiles, list) and tiles and isinstance(tiles[0], list):
            out['tiles'] = tiles_to_rows(tiles)
        _write_json(os.path.join(root, 'maps', str(m.get('id', 'x')) + '.json'), out)
    for name, body in pack.scripts.items():
        _write_text(os.path.join(root, 'js', name), body)


def _write_text(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w', encoding='utf-8') as f:
        f.write(text)


def build_zip(root, out_path):
    """打包目录 → zip。zip 内路径相对包根平铺（manifest.json 在根，loader 直接吃）。
    返回写入的文件数。"""
    n = 0
    with zipfile.ZipFile(out_path, 'w', zipfile.ZIP_DEFLATED) as zf:
        for dirpath, _dirs, files in os.walk(root):
            for fn in sorted(files):
                p = os.path.join(dirpath, fn)
                arc = os.path.relpath(p, root).replace(os.sep, '/')
                zf.write(p, arc)
                n += 1
    return n


# ── 校验（照管理端 findDupIds + 引擎硬性要求） ──

def validate(pack):
    """返回错误列表（空 = 通过）。"""
    errs = []
    for key, label, items in (('heroes', '英雄', pack.heroes),
                              ('cards', '卡牌', pack.cards),
                              ('maps', '地图', pack.maps)):
        seen = set()
        for it in items:
            idv = str(it.get('id', '')).strip()
            if idv == '':
                errs.append('%s存在空 id' % label)
            elif idv in seen:
                errs.append('%s id 重复：%s' % (label, idv))
            else:
                seen.add(idv)
    if not pack.heroes:
        errs.append('至少需要 1 个英雄')
    if not pack.maps:
        errs.append('至少需要 1 张地图')
    dm = pack.manifest.get('defaultMap', '')
    if dm and not any(str(m.get('id')) == dm for m in pack.maps):
        errs.append('defaultMap「%s」不在地图列表里' % dm)
    return errs


def unique_id(base, used):
    """base 被占用时追加 _2/_3…（照管理端 uniqueId）。"""
    if base not in used:
        return base
    i = 2
    while '%s_%d' % (base, i) in used:
        i += 1
    return '%s_%d' % (base, i)
