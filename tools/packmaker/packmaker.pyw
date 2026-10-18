# -*- coding: utf-8 -*-
"""
ALSF 数据包制作器 —— GUI（tkinter，pythonw 双击启动）。

数据层在 packlib.py（格式权威：src/server/data/packages.ts + protocol/types.ts + match.ts）。
本文件只做界面：顶栏 manifest + 新建/打开/保存/打包ZIP/校验；Notebook 四页
（英雄 / 卡牌 / 地图 / 脚本）；嵌套编辑器（steps 步骤 / effects 修正 / 地图网格笔刷）。

约定：
  - 所有编辑直接改内存 pack 对象；切换列表项 / 保存前会先把当前表单写回；
  - combobox 显示中文标签，存的仍是引擎 token（FAR/atk/physical…）；
  - 「js:文件名.js」引用按文件名（不分目录），与引擎一致。
"""

import os
import sys
import tkinter as tk
from tkinter import ttk, messagebox, filedialog

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import packlib as P  # noqa: E402


# ── 小工具 ──

def inv(d):
    """{'FAR':'远'} → {'远':'FAR'}"""
    return {v: k for k, v in d.items()}


ATTACK_LABEL = inv(P.ATTACK_TYPES)          # 远→FAR
CARD_TYPE_LABEL = inv(P.CARD_TYPES)         # 基础牌→BSC
GENERAL_LABEL = inv(P.GENERAL_CATS)         # 攻击→atk
TARGET_LABEL = inv(P.TARGETING)             # 敌人→enemy
API_LABEL = inv(P.API_LABELS)               # 伤害→damage
OP_LABEL = inv(P.OP_LABELS)                 # 伤害→damage
STATUS_LABEL = {s: s for s in P.STATUS_KINDS}


def label_of(fn_name, table):
    """API/OP 中文名；不在表里返回原名。"""
    return table.get(fn_name, fn_name)


def ask_text(parent, title, label, initial=''):
    """简单输入对话框（prompt_toolkit 风格：无 emoji、直接）。"""
    win = tk.Toplevel(parent)
    win.title(title)
    win.transient(parent)
    win.grab_set()
    win.resizable(False, False)
    ttk.Label(win, text=label).pack(padx=12, pady=(12, 4))
    var = tk.StringVar(value=initial)
    ent = ttk.Entry(win, textvariable=var, width=32)
    ent.pack(padx=12, pady=4)
    ent.select_range(0, tk.END)
    ent.focus_set()
    out = [None]

    def ok():
        out[0] = var.get().strip()
        win.destroy()

    def cancel():
        win.destroy()

    bb = ttk.Frame(win)
    bb.pack(pady=8)
    ttk.Button(bb, text='确定', command=ok).pack(side=tk.LEFT, padx=6)
    ttk.Button(bb, text='取消', command=cancel).pack(side=tk.LEFT, padx=6)
    win.bind('<Return>', lambda e: ok())
    win.bind('<Escape>', lambda e: cancel())
    parent.wait_window(win)
    return out[0]


# ── steps 编辑器（cards/skills 的 steps 数组） ──

class StepsEditor(ttk.Frame):
    """steps = [ {fn, ...args}, ... ]。每步一行：fn 下拉 + 动态参数 + 上移/下移/删除。"""

    def __init__(self, master, steps, on_change=None):
        super().__init__(master)
        self.steps = steps if isinstance(steps, list) else []
        self.on_change = on_change
        self.rows = []
        ttk.Label(self, text='效果步骤（按顺序执行）').pack(anchor=tk.W)
        bar = ttk.Frame(self)
        bar.pack(fill=tk.X, pady=2)
        ttk.Button(bar, text='＋ 添加步骤', command=self._add).pack(side=tk.LEFT)
        self.box = ttk.Frame(self)
        self.box.pack(fill=tk.BOTH, expand=True)
        self.rebuild()

    # -- 数据 --
    def flush(self):
        """把各行控件值写回 self.steps。"""
        for i, row in enumerate(self.rows):
            if i >= len(self.steps):
                break
            self.steps[i] = self._collect(row)

    def get(self):
        self.flush()
        return self.steps

    def _collect(self, row):
        fn = row['fn_var'].get()
        # fn 中文标签反查 token
        fn_token = API_LABEL.get(fn, fn)
        step = {'fn': fn_token}
        params = P.API_PARAMS.get(fn_token, [])
        for pname, ctl in row['ctls'].items():
            if pname not in params:
                continue  # fn 变更后残留的旧参数丢弃
            step[pname] = ctl.get()
        return step

    def _add(self):
        self.flush()
        self.steps.append({'fn': 'damage', 'ref': 'target', 'amount': 2, 'mode': 'NER'})
        self.rebuild()
        self._changed()

    def _del(self, idx):
        self.flush()
        if 0 <= idx < len(self.steps):
            self.steps.pop(idx)
        self.rebuild()
        self._changed()

    def _move(self, idx, delta):
        self.flush()
        j = idx + delta
        if 0 <= j < len(self.steps):
            self.steps[idx], self.steps[j] = self.steps[j], self.steps[idx]
        self.rebuild()
        self._changed()

    def _changed(self):
        if self.on_change:
            self.on_change()

    # -- 渲染 --
    def rebuild(self):
        for r in self.rows:
            r['frame'].destroy()
        self.rows = []
        for idx, step in enumerate(self.steps):
            self.rows.append(self._build_row(idx, step))

    def _build_row(self, idx, step):
        frame = ttk.Frame(self.box, relief=tk.GROOVE, borderwidth=1)
        frame.pack(fill=tk.X, pady=2, padx=1)
        top = ttk.Frame(frame)
        top.pack(fill=tk.X)
        fn_names = [label_of(f, P.API_LABELS) for f in P.API_PARAMS]
        cur_fn = step.get('fn', 'damage')
        fn_var = tk.StringVar(value=label_of(cur_fn, P.API_LABELS))
        cb = ttk.Combobox(top, textvariable=fn_var, values=fn_names,
                          width=10, state='readonly')
        cb.pack(side=tk.LEFT, padx=2)
        ttk.Button(top, text='↑', width=2,
                   command=lambda: self._move(idx, -1)).pack(side=tk.LEFT)
        ttk.Button(top, text='↓', width=2,
                   command=lambda: self._move(idx, 1)).pack(side=tk.LEFT)
        ttk.Button(top, text='－', width=2,
                   command=lambda: self._del(idx)).pack(side=tk.LEFT)
        par = ttk.Frame(frame)
        par.pack(fill=tk.X, padx=20)
        ctls = self._build_params(par, cur_fn, step)
        # fn 变更 → 重建参数控件
        cb.bind('<<ComboboxSelected>>',
                lambda e, i=idx, r={'fn_var': fn_var, 'ctls': ctls, 'frame': frame}:
                self._on_fn_change(i, r))
        return {'frame': frame, 'fn_var': fn_var, 'ctls': ctls}

    def _on_fn_change(self, idx, row):
        self.flush()
        token = API_LABEL.get(row['fn_var'].get(), row['fn_var'].get())
        if idx < len(self.steps):
            new_step = {'fn': token}
            for p in P.API_PARAMS.get(token, []):
                if p in self.steps[idx]:
                    new_step[p] = self.steps[idx][p]
            self.steps[idx] = new_step
        self.rebuild()
        self._changed()

    def _build_params(self, parent, fn, step):
        """按 API_PARAMS[fn] 生成控件；返回 {参数名: 取值器}。"""
        ctls = {}
        params = P.API_PARAMS.get(fn, [])
        if not params:
            ttk.Label(parent, text='（该 fn 收整个 args 对象，脚本向）').pack(anchor=tk.W)
            return ctls
        grid = ttk.Frame(parent)
        grid.pack(fill=tk.X)
        for i, pname in enumerate(params):
            ttk.Label(grid, text=pname).grid(row=i, column=0, sticky=tk.W, padx=2)
            kind = P.PARAM_KIND.get(pname, 'num')
            val = step.get(pname, '')
            if kind == 'ref':
                var = tk.StringVar(value=str(val or 'target'))
                cb = ttk.Combobox(grid, textvariable=var, values=['self', 'target'],
                                  width=8, state='readonly')
                cb.grid(row=i, column=1, sticky=tk.W)
                ctls[pname] = _VarGet(var)
            elif kind == 'mode':
                var = tk.StringVar(value=str(val or 'NER'))
                cb = ttk.Combobox(grid, textvariable=var,
                                  values=list(P.ATTACK_TYPES.keys()),
                                  width=8, state='readonly')
                cb.grid(row=i, column=1, sticky=tk.W)
                ctls[pname] = _VarGet(var)
            elif kind == 'kind':
                var = tk.StringVar(value=str(val or P.STATUS_KINDS[0]))
                cb = ttk.Combobox(grid, textvariable=var, values=P.STATUS_KINDS,
                                  width=10, state='readonly')
                cb.grid(row=i, column=1, sticky=tk.W)
                ctls[pname] = _VarGet(var)
            elif kind == 'bool':
                var = tk.BooleanVar(value=bool(val))
                ttk.Checkbutton(grid, variable=var).grid(row=i, column=1, sticky=tk.W)
                ctls[pname] = _VarGet(var)
            elif kind == 'text':
                var = tk.StringVar(value=str(val))
                ttk.Entry(grid, textvariable=var, width=18).grid(row=i, column=1)
                ctls[pname] = _VarGet(var)
            else:  # num
                var = tk.StringVar(value=str(val if val != '' else 0))
                ttk.Spinbox(grid, textvariable=var, from_=-999, to=999,
                            width=6).grid(row=i, column=1, sticky=tk.W)
                ctls[pname] = _NumGet(var)
        return ctls


class _VarGet:
    def __init__(self, var):
        self.var = var

    def get(self):
        return self.var.get()


class _NumGet:
    def __init__(self, var):
        self.var = var

    def get(self):
        try:
            v = float(self.var.get())
            return int(v) if v == int(v) else v
        except (TypeError, ValueError):
            return 0


# ── effects 编辑器（modifiers / 被动牌 effects） ──

class EffectsEditor(ttk.Frame):
    """effects = [ {op, ...fields}, ... ]（EffectDef 全集，OP_FIELDS 驱动）。"""

    def __init__(self, master, effects, on_change=None):
        super().__init__(master)
        self.effects = effects if isinstance(effects, list) else []
        self.on_change = on_change
        self.rows = []
        ttk.Label(self, text='常驻修正（ modifiers / 被动牌 effects ）').pack(anchor=tk.W)
        bar = ttk.Frame(self)
        bar.pack(fill=tk.X, pady=2)
        ttk.Button(bar, text='＋ 添加修正', command=self._add).pack(side=tk.LEFT)
        self.box = ttk.Frame(self)
        self.box.pack(fill=tk.BOTH, expand=True)
        self.rebuild()

    def flush(self):
        for i, row in enumerate(self.rows):
            if i < len(self.effects):
                self.effects[i] = self._collect(row)

    def get(self):
        self.flush()
        return self.effects

    def _collect(self, row):
        op = OP_LABEL.get(row['op_var'].get(), row['op_var'].get())
        eff = {'op': op}
        for pname, ctl in row['ctls'].items():
            eff[pname] = ctl.get()
        return eff

    def _add(self):
        self.flush()
        self.effects.append({'op': 'damage', 'amount': 1})
        self.rebuild()
        self._changed()

    def _del(self, idx):
        self.flush()
        if 0 <= idx < len(self.effects):
            self.effects.pop(idx)
        self.rebuild()
        self._changed()

    def _changed(self):
        if self.on_change:
            self.on_change()

    def rebuild(self):
        for r in self.rows:
            r['frame'].destroy()
        self.rows = []
        for idx, eff in enumerate(self.effects):
            self.rows.append(self._build_row(idx, eff))

    def _build_row(self, idx, eff):
        frame = ttk.Frame(self.box, relief=tk.GROOVE, borderwidth=1)
        frame.pack(fill=tk.X, pady=2, padx=1)
        top = ttk.Frame(frame)
        top.pack(fill=tk.X)
        op_names = [label_of(o, P.OP_LABELS) for o in P.OP_FIELDS]
        op_var = tk.StringVar(value=label_of(eff.get('op', 'damage'), P.OP_LABELS))
        cb = ttk.Combobox(top, textvariable=op_var, values=op_names,
                          width=10, state='readonly')
        cb.pack(side=tk.LEFT, padx=2)
        ttk.Button(top, text='－', width=2,
                   command=lambda: self._del(idx)).pack(side=tk.LEFT)
        par = ttk.Frame(frame)
        par.pack(fill=tk.X, padx=20)
        ctls = self._build_fields(par, eff.get('op', 'damage'), eff)
        cb.bind('<<ComboboxSelected>>',
                lambda e, i=idx, r={'op_var': op_var, 'ctls': ctls, 'frame': frame}:
                self._on_op_change(i, r))
        return {'frame': frame, 'op_var': op_var, 'ctls': ctls}

    def _on_op_change(self, idx, row):
        self.flush()
        token = OP_LABEL.get(row['op_var'].get(), row['op_var'].get())
        if idx < len(self.effects):
            new_eff = {'op': token}
            for fname, _lab, _k in P.OP_FIELDS.get(token, []):
                if fname in self.effects[idx]:
                    new_eff[fname] = self.effects[idx][fname]
            self.effects[idx] = new_eff
        self.rebuild()
        self._changed()

    def _build_fields(self, parent, op, eff):
        ctls = {}
        fields = P.OP_FIELDS.get(op, [])
        if not fields:
            ttk.Label(parent, text='（无参数开关型修正）').pack(anchor=tk.W)
            return ctls
        grid = ttk.Frame(parent)
        grid.pack(fill=tk.X)
        for i, (fname, flabel, kind) in enumerate(fields):
            ttk.Label(grid, text=flabel).grid(row=i, column=0, sticky=tk.W, padx=2)
            val = eff.get(fname, '')
            if isinstance(kind, list):  # 下拉
                var = tk.StringVar(value=str(val or kind[0]))
                ttk.Combobox(grid, textvariable=var, values=kind,
                             width=10, state='readonly').grid(row=i, column=1, sticky=tk.W)
                ctls[fname] = _VarGet(var)
            elif kind == 'num':
                var = tk.StringVar(value=str(val if val != '' else 0))
                ttk.Spinbox(grid, textvariable=var, from_=-999, to=999,
                            width=6).grid(row=i, column=1, sticky=tk.W)
                ctls[fname] = _NumGet(var)
            else:
                var = tk.StringVar(value=str(val))
                ttk.Entry(grid, textvariable=var, width=14).grid(row=i, column=1)
                ctls[fname] = _VarGet(var)
        return ctls


# ── 地图编辑器（网格 canvas 笔刷） ──

TERRAIN_COLOR = {
    'plain': '#ffffff', 'water': '#b3d9ff', 'wall': '#5a5a5a',
    'spawn': '#b7e4c7', 'heal': '#ffd6a5',
}
TERRAIN_LABEL = {
    'plain': '空地', 'water': '水', 'wall': '墙', 'spawn': '出生点', 'heal': '回血点',
}


class MapEditor(ttk.Frame):
    """tiles token 矩阵 ⇄ 字符行。左键画当前笔刷；出生/回血点唯一约束不强制（引擎推导 spawns/heals 时取全部）。"""

    CELL = 26

    def __init__(self, master, map_obj, on_change=None):
        super().__init__(master)
        self.map = map_obj
        self.on_change = on_change
        self.brush = tk.StringVar(value='wall')
        tiles = map_obj.get('tiles', [])
        if tiles and isinstance(tiles[0], list):
            self.tokens = [list(r) for r in tiles]
        else:
            self.tokens = P.rows_to_tiles(tiles or ['.' * 13])
        self.h = len(self.tokens)
        self.w = len(self.tokens[0]) if self.h else 13
        top = ttk.Frame(self)
        top.pack(fill=tk.X)
        ttk.Label(top, text='尺寸').pack(side=tk.LEFT)
        self.w_var = tk.StringVar(value=str(self.w))
        self.h_var = tk.StringVar(value=str(self.h))
        ttk.Spinbox(top, textvariable=self.w_var, from_=5, to=40, width=4,
                    command=self._resize).pack(side=tk.LEFT, padx=2)
        ttk.Label(top, text='×').pack(side=tk.LEFT)
        ttk.Spinbox(top, textvariable=self.h_var, from_=5, to=40, width=4,
                    command=self._resize).pack(side=tk.LEFT, padx=2)
        ttk.Button(top, text='应用尺寸', command=self._resize).pack(side=tk.LEFT, padx=6)
        ttk.Label(top, text='笔刷').pack(side=tk.LEFT, padx=(12, 2))
        for tok in ['plain', 'water', 'wall', 'spawn', 'heal']:
            ttk.Radiobutton(top, text=TERRAIN_LABEL[tok], value=tok,
                            variable=self.brush).pack(side=tk.LEFT)
        self.canvas = tk.Canvas(self, bg='#f0f0f0', highlightthickness=1)
        self.canvas.pack(fill=tk.BOTH, expand=True)
        self.canvas.bind('<Button-1>', self._paint)
        self.canvas.bind('<B1-Motion>', self._paint)
        self.canvas.bind('<Configure>', lambda e: self.redraw())
        self.redraw()

    def flush(self):
        self.map['tiles'] = P.tiles_to_rows(self.tokens)

    def redraw(self):
        c = self.canvas
        c.delete('all')
        for y, row in enumerate(self.tokens):
            for x, tok in enumerate(row):
                x0, y0 = x * self.CELL, y * self.CELL
                c.create_rectangle(x0, y0, x0 + self.CELL, y0 + self.CELL,
                                   fill=TERRAIN_COLOR.get(tok, '#fff'),
                                   outline='#c8c8c8', tags=('cell',))
        for i in range(self.w + 1):  # 网格线
            c.create_line(i * self.CELL, 0, i * self.CELL, self.h * self.CELL,
                          fill='#dcdcdc')
        for j in range(self.h + 1):
            c.create_line(0, j * self.CELL, self.w * self.CELL, j * self.CELL,
                          fill='#dcdcdc')

    def _paint(self, ev):
        x, y = ev.x // self.CELL, ev.y // self.CELL
        if 0 <= x < self.w and 0 <= y < self.h:
            if self.tokens[y][x] != self.brush.get():
                self.tokens[y][x] = self.brush.get()
                self.redraw()
                if self.on_change:
                    self.on_change()

    def _resize(self):
        try:
            nw, nh = int(self.w_var.get()), int(self.h_var.get())
        except ValueError:
            return
        nw = max(5, min(40, nw))
        nh = max(5, min(40, nh))
        for row in self.tokens:
            if len(row) < nw:
                row.extend(['plain'] * (nw - len(row)))
        while len(self.tokens) < nh:
            self.tokens.append(['plain'] * nw)
        self.tokens = [r[:nw] for r in self.tokens[:nh]]
        self.w, self.h = nw, nh
        self.redraw()
        if self.on_change:
            self.on_change()


# ── 内容页基类：列表 + 表单 ──

class ContentTab(ttk.Frame):
    """左列表（＋/－/复制）右表单。子类实现 form_fields / nested / fill / collect。"""

    item_label = '条目'
    list_header = '列表'

    def __init__(self, master, app):
        super().__init__(master)
        self.app = app
        self.sel = -1
        paned = ttk.PanedWindow(self, orient=tk.HORIZONTAL)
        paned.pack(fill=tk.BOTH, expand=True)
        left = ttk.Frame(paned, width=180)
        paned.add(left, weight=1)
        ttk.Label(left, text=self.list_header).pack(anchor=tk.W)
        self.listbox = tk.Listbox(left, exportselection=False)
        self.listbox.pack(fill=tk.BOTH, expand=True)
        self.listbox.bind('<<ListboxSelect>>', self._on_select)
        bb = ttk.Frame(left)
        bb.pack(fill=tk.X)
        ttk.Button(bb, text='＋', width=3, command=self._add).pack(side=tk.LEFT)
        ttk.Button(bb, text='－', width=3, command=self._del).pack(side=tk.LEFT)
        ttk.Button(bb, text='复制', command=self._dup).pack(side=tk.LEFT, padx=4)
        right = ttk.Frame(paned)
        paned.add(right, weight=3)
        self.canvas = tk.Canvas(right, highlightthickness=0)
        self.scroll = ttk.Scrollbar(right, orient=tk.VERTICAL, command=self.canvas.yview)
        self.form = ttk.Frame(self.canvas)
        self.form.bind('<Configure>',
                       lambda e: self.canvas.configure(scrollregion=self.canvas.bbox('all')))
        self.canvas.create_window((0, 0), window=self.form, anchor=tk.NW)
        self.canvas.configure(yscrollcommand=self.scroll.set)
        self.canvas.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)
        self.scroll.pack(side=tk.RIGHT, fill=tk.Y)
        self.canvas.bind('<Enter>', lambda e: self.canvas.bind_all('<MouseWheel>',
                        lambda ev: self.canvas.yview_scroll(-ev.delta // 120, 'units')))
        self.canvas.bind('<Leave>', lambda e: self.canvas.unbind_all('<MouseWheel>'))
        self.nested = []  # 嵌套编辑器实例（flush 用）
        self.ctls = {}    # 字段名 → 控件/取值器

    # -- 列表 --
    def items(self):
        raise NotImplementedError

    def refresh_list(self):
        self.listbox.delete(0, tk.END)
        for it in self.items():
            self.listbox.insert(tk.END, '%s（%s）' % (it.get('name', ''), it.get('id', '')))
        if self.items():
            self.listbox.select_set(min(max(self.sel, 0), len(self.items()) - 1))
            self.sel = self.listbox.curselection()[0]
        else:
            self.sel = -1
            self._clear_form()
        self._fill()

    def _on_select(self, _ev):
        if not self.listbox.curselection():
            return
        self.flush()
        self.sel = self.listbox.curselection()[0]
        self._fill()

    def _add(self):
        self.flush()
        it = self.new_item()
        used = {str(x.get('id')) for x in self.items()}
        it['id'] = P.unique_id(it.get('id', 'new'), used)
        self.items().append(it)
        self.sel = len(self.items()) - 1
        self.refresh_list()
        self.app.status('新增%s：%s' % (self.item_label, it.get('name', '')))

    def _del(self):
        if self.sel < 0 or self.sel >= len(self.items()):
            return
        it = self.items()[self.sel]
        if not messagebox.askyesno('确认', '删除%s「%s」？' % (self.item_label, it.get('name', ''))):
            return
        self.items().pop(self.sel)
        self.sel = max(-1, self.sel - 1)
        self.refresh_list()
        self.app.status('已删除')

    def _dup(self):
        if self.sel < 0:
            return
        import copy
        self.flush()
        src = self.items()[self.sel]
        clone = copy.deepcopy(src)
        used = {str(x.get('id')) for x in self.items()}
        clone['id'] = P.unique_id(str(src.get('id', 'x')), used)
        clone['name'] = str(src.get('name', '')) + ' 副本'
        self.items().append(clone)
        self.sel = len(self.items()) - 1
        self.refresh_list()

    # -- 表单 --
    def _clear_form(self):
        for w in self.form.winfo_children():
            w.destroy()
        self.ctls = {}
        self.nested = []

    def _fill(self):
        self._clear_form()
        if self.sel < 0 or self.sel >= len(self.items()):
            ttk.Label(self.form, text='（列表为空，点 ＋ 新建）').pack(padx=8, pady=8)
            return
        it = self.items()[self.sel]
        r = 0
        for fname, flabel, kind in self.form_fields():
            ttk.Label(self.form, text=flabel).grid(row=r, column=0, sticky=tk.W,
                                                   padx=6, pady=2)
            val = it.get(fname, '')
            if kind == 'text':
                var = tk.StringVar(value=str(val))
                ttk.Entry(self.form, textvariable=var, width=30).grid(row=r, column=1,
                                                                      sticky=tk.W)
                self.ctls[fname] = _VarGet(var)
            elif kind == 'num':
                var = tk.StringVar(value=str(val if val != '' else 0))
                ttk.Spinbox(self.form, textvariable=var, from_=-999, to=9999,
                            width=8).grid(row=r, column=1, sticky=tk.W)
                self.ctls[fname] = _NumGet(var)
            elif kind == 'longtext':
                t = tk.Text(self.form, width=44, height=4, wrap=tk.WORD)
                t.insert('1.0', str(val))
                t.grid(row=r, column=1, sticky=tk.W)
                self.ctls[fname] = _TextGet(t)
            elif isinstance(kind, list):
                var = tk.StringVar(value=str(val or kind[0]))
                ttk.Combobox(self.form, textvariable=var, values=kind,
                             width=14, state='readonly').grid(row=r, column=1, sticky=tk.W)
                self.ctls[fname] = _VarGet(var)
            r += 1
        # 嵌套编辑器统一放 wrapper（wrapper 内全用 pack，避免与 grid 混用）
        wrap = ttk.Frame(self.form)
        wrap.grid(row=r, column=0, columnspan=2, sticky=tk.EW)
        self.build_nested(it, wrap)

    def flush(self):
        if self.sel < 0 or self.sel >= len(self.items()):
            return
        it = self.items()[self.sel]
        for fname, getter in self.ctls.items():
            it[fname] = getter.get()
        for ed in self.nested:
            ed.flush()
        self.apply_nested(it)

    # 子类实现
    def new_item(self):
        raise NotImplementedError

    def form_fields(self):
        raise NotImplementedError

    def build_nested(self, it, wrap):
        pass

    def apply_nested(self, it):
        pass


class _TextGet:
    def __init__(self, widget):
        self.w = widget

    def get(self):
        return self.w.get('1.0', 'end-1c')


# ── 英雄页 ──

class HeroesTab(ContentTab):
    item_label = '英雄'
    list_header = '英雄列表'

    def items(self):
        return self.app.pack.heroes

    def new_item(self):
        import copy
        return copy.deepcopy(P.new_hero())

    def form_fields(self):
        return [('id', 'ID', 'text'), ('name', '名称', 'text'), ('title', '称号', 'text'),
                ('hp', '生命', 'num'), ('text', '描述', 'longtext')]

    def build_nested(self, it, wrap):
        # 普攻
        atk = it.setdefault('attack', {'type': 'NER', 'damage': 2})
        ttk.Label(wrap, text='普攻').pack(anchor=tk.W, padx=6)
        af = ttk.Frame(wrap)
        af.pack(fill=tk.X, padx=20)
        tv = tk.StringVar(value=atk.get('type', 'NER'))
        ttk.Combobox(af, textvariable=tv, values=list(P.ATTACK_TYPES.keys()),
                     width=6, state='readonly').pack(side=tk.LEFT)
        ttk.Label(af, text='伤害').pack(side=tk.LEFT, padx=(8, 2))
        dv = tk.StringVar(value=str(atk.get('damage', 2)))
        ttk.Spinbox(af, textvariable=dv, from_=0, to=99, width=5).pack(side=tk.LEFT)
        self.ctls['_atk_type'] = _VarGet(tv)
        self.ctls['_atk_dmg'] = _NumGet(dv)
        # modifiers
        ed = EffectsEditor(wrap, it.setdefault('modifiers', []))
        ed.pack(fill=tk.X, padx=4, pady=4)
        self.nested.append(ed)
        # skills 三槽
        skills = it.setdefault('skills', [])
        ttk.Label(wrap, text='技能（技1 / 技2 / 大招）').pack(anchor=tk.W, padx=6, pady=(8, 0))
        for si, (slot, slab) in enumerate(P.SKILL_SLOTS):
            sk = skills[si] if si < len(skills) else {}
            box = ttk.LabelFrame(wrap, text=slab)
            box.pack(fill=tk.X, padx=6, pady=4)
            row1 = ttk.Frame(box)
            row1.pack(fill=tk.X)
            ttk.Label(row1, text='名称').pack(side=tk.LEFT)
            nv = tk.StringVar(value=str(sk.get('name', slab)))
            ttk.Entry(row1, textvariable=nv, width=16).pack(side=tk.LEFT, padx=2)
            ttk.Label(row1, text='目标').pack(side=tk.LEFT, padx=(8, 2))
            tv = tk.StringVar(value=str(sk.get('targeting', 'enemy')))
            ttk.Combobox(row1, textvariable=tv, values=list(P.TARGETING.keys()),
                         width=8, state='readonly').pack(side=tk.LEFT)
            ttk.Label(row1, text='说明').pack(side=tk.LEFT, padx=(8, 2))
            xv = tk.StringVar(value=str(sk.get('text', '')))
            ttk.Entry(row1, textvariable=xv, width=22).pack(side=tk.LEFT)
            st = sk.get('steps', [])
            if not isinstance(st, list):
                st = []
            sed = StepsEditor(box, st)
            sed.pack(fill=tk.X, padx=4, pady=4)
            self.nested.append(sed)
            self.ctls['_skill_%d_name' % si] = _VarGet(nv)
            self.ctls['_skill_%d_tg' % si] = _VarGet(tv)
            self.ctls['_skill_%d_txt' % si] = _VarGet(xv)

    def apply_nested(self, it):
        it['attack'] = {'type': self.ctls['_atk_type'].get(),
                        'damage': self.ctls['_atk_dmg'].get()}
        skills = it.setdefault('skills', [])
        # nested 顺序：modifiers(0)、skill1(1)、skill2(2)、skill3(3)
        while len(skills) < 3:
            skills.append({'name': '', 'targeting': 'enemy', 'steps': []})
        for si in range(3):
            sk = skills[si]
            sk['name'] = self.ctls['_skill_%d_name' % si].get()
            sk['targeting'] = self.ctls['_skill_%d_tg' % si].get()
            sk['text'] = self.ctls['_skill_%d_txt' % si].get()


# ── 卡牌页 ──

class CardsTab(ContentTab):
    item_label = '卡牌'
    list_header = '卡牌列表'

    def items(self):
        return self.app.pack.cards

    def new_item(self):
        import copy
        return copy.deepcopy(P.new_card())

    def form_fields(self):
        return [('id', 'ID', 'text'), ('name', '名称', 'text'),
                ('amount', '份数', 'num'),
                ('type', '类型', list(P.CARD_TYPES.keys())),
                ('category', '类别', list(P.GENERAL_CATS.keys())),
                ('targeting', '目标', list(P.TARGETING.keys())),
                ('text', '牌面说明', 'longtext')]

    def build_nested(self, it, wrap):
        ttk.Label(wrap, text='效果').pack(anchor=tk.W, padx=6)
        st = it.get('steps', [])
        if not isinstance(st, list):
            st = []
        sed = StepsEditor(wrap, st)
        sed.pack(fill=tk.X, padx=4)
        self.nested.append(sed)
        # 被动牌 effects（type=PSV 时用；引擎按 category 处理 heal 等，详见 match.ts）
        eff = it.get('effects', [])
        if isinstance(eff, list) and eff:
            eed = EffectsEditor(wrap, eff)
            eed.pack(fill=tk.X, padx=4)
            self.nested.append(eed)
        ttk.Label(wrap, text='脚本 code（可选，留空走 steps；'
                            '可用 "js:文件名.js" 引用脚本页的文件）').pack(
            anchor=tk.W, padx=6, pady=(8, 0))
        t = tk.Text(wrap, width=44, height=5, wrap=tk.NONE)
        t.insert('1.0', str(it.get('code', '')))
        t.pack(fill=tk.X, padx=6)
        self.ctls['_code'] = _TextGet(t)

    def apply_nested(self, it):
        code = self.ctls['_code'].get().strip()
        if code:
            it['code'] = code
        elif 'code' in it:
            del it['code']


# ── 地图页 ──

class MapsTab(ContentTab):
    item_label = '地图'
    list_header = '地图列表'

    def items(self):
        return self.app.pack.maps

    def new_item(self):
        import copy
        return copy.deepcopy(P.new_map())

    def form_fields(self):
        return [('id', 'ID', 'text'), ('name', '名称', 'text')]

    def build_nested(self, it, wrap):
        ed = MapEditor(wrap, it)
        ed.pack(fill=tk.BOTH, expand=True, padx=4, pady=4)
        self.nested.append(ed)
        ttk.Label(wrap, text='提示：左键画；S=出生点 H=回血点；'
                            '保存为字符行（. ~ # S H）').pack(anchor=tk.W, padx=6)


# ── 脚本页 ──

class ScriptsTab(ttk.Frame):
    def __init__(self, master, app):
        super().__init__(master)
        self.app = app
        self.sel = ''
        paned = ttk.PanedWindow(self, orient=tk.HORIZONTAL)
        paned.pack(fill=tk.BOTH, expand=True)
        left = ttk.Frame(paned, width=170)
        paned.add(left, weight=1)
        ttk.Label(left, text='js 文件（按文件名引用）').pack(anchor=tk.W)
        self.listbox = tk.Listbox(left, exportselection=False)
        self.listbox.pack(fill=tk.BOTH, expand=True)
        self.listbox.bind('<<ListboxSelect>>', self._on_select)
        bb = ttk.Frame(left)
        bb.pack(fill=tk.X)
        ttk.Button(bb, text='＋', width=3, command=self._add).pack(side=tk.LEFT)
        ttk.Button(bb, text='－', width=3, command=self._del).pack(side=tk.LEFT)
        ttk.Button(bb, text='重命名', command=self._rename).pack(side=tk.LEFT, padx=4)
        right = ttk.Frame(paned)
        paned.add(right, weight=3)
        ttk.Label(right, text='文件内容（UTF-8；steps 里用 "js:文件名.js" 引用）').pack(anchor=tk.W)
        self.text = tk.Text(right, wrap=tk.NONE)
        self.text.pack(fill=tk.BOTH, expand=True)
        self.refresh()

    def refresh(self):
        self.listbox.delete(0, tk.END)
        for name in sorted(self.app.pack.scripts):
            self.listbox.insert(tk.END, name)
        if self.sel in self.app.pack.scripts:
            idx = sorted(self.app.pack.scripts).index(self.sel)
            self.listbox.select_set(idx)
        elif self.app.pack.scripts:
            self.sel = sorted(self.app.pack.scripts)[0]
            self.listbox.select_set(0)
            self._load()
        else:
            self.sel = ''
            self.text.delete('1.0', tk.END)

    def _flush(self):
        if self.sel and self.sel in self.app.pack.scripts:
            self.app.pack.scripts[self.sel] = self.text.get('1.0', 'end-1c')

    def _on_select(self, _ev):
        self._flush()
        if self.listbox.curselection():
            self.sel = sorted(self.app.pack.scripts)[self.listbox.curselection()[0]]
            self._load()

    def _load(self):
        self.text.delete('1.0', tk.END)
        self.text.insert('1.0', self.app.pack.scripts.get(self.sel, ''))

    def _add(self):
        self._flush()
        name = ask_text(self, '新建脚本', '文件名（.js）', 'new_script.js')
        if not name:
            return
        if not name.endswith('.js'):
            name += '.js'
        if name in self.app.pack.scripts:
            messagebox.showwarning('重名', '已存在：' + name)
            return
        self.app.pack.scripts[name] = '// ' + name + '\n'
        self.sel = name
        self.refresh()
        self._load()

    def _del(self):
        if not self.sel:
            return
        if not messagebox.askyesno('确认', '删除脚本 %s？' % self.sel):
            return
        del self.app.pack.scripts[self.sel]
        self.sel = ''
        self.refresh()

    def _rename(self):
        if not self.sel:
            return
        name = ask_text(self, '重命名', '新文件名（.js）', self.sel)
        if not name or name == self.sel:
            return
        if not name.endswith('.js'):
            name += '.js'
        if name in self.app.pack.scripts:
            messagebox.showwarning('重名', '已存在：' + name)
            return
        self.app.pack.scripts[name] = self.app.pack.scripts.pop(self.sel)
        self.sel = name
        self.refresh()


# ── 主窗口 ──

class App(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title('ALSF 数据包制作器')
        self.geometry('1020x720')
        self.minsize(860, 600)
        self.pack = P.Pack()
        self.dir = ''
        self._build_top()
        nb = ttk.Notebook(self)
        nb.pack(fill=tk.BOTH, expand=True, padx=4, pady=4)
        self.heroes = HeroesTab(nb, self)
        self.cards = CardsTab(nb, self)
        self.maps = MapsTab(nb, self)
        self.scripts = ScriptsTab(nb, self)
        nb.add(self.heroes, text=' 英雄 ')
        nb.add(self.cards, text=' 卡牌 ')
        nb.add(self.maps, text=' 地图 ')
        nb.add(self.scripts, text=' 脚本 ')
        self.statusbar = ttk.Label(self, text='就绪', relief=tk.SUNKEN, anchor=tk.W)
        self.statusbar.pack(fill=tk.X, side=tk.BOTTOM)
        self.refresh_all()

    def _build_top(self):
        bar = ttk.Frame(self)
        bar.pack(fill=tk.X, padx=4, pady=4)
        ttk.Button(bar, text='新建', command=self._new).pack(side=tk.LEFT)
        ttk.Button(bar, text='打开…', command=self._open).pack(side=tk.LEFT, padx=4)
        ttk.Button(bar, text='保存', command=self._save).pack(side=tk.LEFT)
        ttk.Button(bar, text='打包 ZIP', command=self._zip).pack(side=tk.LEFT, padx=4)
        ttk.Button(bar, text='校验', command=self._validate).pack(side=tk.LEFT)
        mf = ttk.Frame(bar)
        mf.pack(side=tk.LEFT, padx=(24, 0))
        ttk.Label(mf, text='manifest').grid(row=0, column=0, sticky=tk.W)
        ttk.Label(mf, text='id').grid(row=0, column=2, sticky=tk.E)
        self.m_id = tk.StringVar()
        ttk.Entry(mf, textvariable=self.m_id, width=16).grid(row=0, column=3)
        ttk.Label(mf, text='name').grid(row=0, column=4, sticky=tk.E)
        self.m_name = tk.StringVar()
        ttk.Entry(mf, textvariable=self.m_name, width=20).grid(row=0, column=5)
        ttk.Label(mf, text='defaultMap').grid(row=1, column=2, sticky=tk.E)
        self.m_map = tk.StringVar()
        self.m_map_cb = ttk.Combobox(mf, textvariable=self.m_map, width=16)
        self.m_map_cb.grid(row=1, column=3)

    # -- 顶栏 ↔ manifest --
    def sync_manifest(self):
        self.pack.manifest['id'] = self.m_id.get().strip() or 'mypack'
        self.pack.manifest['name'] = self.m_name.get().strip() or '我的数据包'
        self.pack.manifest['defaultMap'] = self.m_map.get().strip()
        self.m_map_cb['values'] = [str(m.get('id', '')) for m in self.pack.maps]

    def refresh_all(self):
        self.m_id.set(self.pack.manifest.get('id', ''))
        self.m_name.set(self.pack.manifest.get('name', ''))
        self.m_map.set(self.pack.manifest.get('defaultMap', ''))
        self.m_map_cb['values'] = [str(m.get('id', '')) for m in self.pack.maps]
        self.heroes.refresh_list()
        self.cards.refresh_list()
        self.maps.refresh_list()
        self.scripts.refresh()

    def flush_all(self):
        self.sync_manifest()
        self.heroes.flush()
        self.cards.flush()
        self.maps.flush()
        self.scripts._flush()

    # -- 动作 --
    def _new(self):
        if not messagebox.askyesno('新建', '放弃当前改动，新建空数据包？'):
            return
        self.pack = P.Pack()
        self.dir = ''
        self.title('ALSF 数据包制作器')
        self.refresh_all()
        self.status('已新建')

    def _open(self):
        d = filedialog.askdirectory(title='选择数据包目录（含 manifest.json）')
        if not d:
            return
        try:
            self.pack = P.load_pack(d)
        except Exception as e:
            messagebox.showerror('打开失败', str(e))
            return
        self.dir = d
        self.title('ALSF 数据包制作器 —— %s' % d)
        self.refresh_all()
        self.status('已打开 %s（英雄 %d / 卡牌 %d / 地图 %d / 脚本 %d）' % (
            d, len(self.pack.heroes), len(self.pack.cards),
            len(self.pack.maps), len(self.pack.scripts)))

    def _save(self):
        self.flush_all()
        if not self.dir:
            d = filedialog.askdirectory(title='保存到目录（数据包源目录）')
            if not d:
                return
            self.dir = d
        try:
            P.save_pack(self.dir, self.pack)
        except Exception as e:
            messagebox.showerror('保存失败', str(e))
            return
        self.title('ALSF 数据包制作器 —— %s' % self.dir)
        self.status('已保存到 %s' % self.dir)

    def _zip(self):
        self.flush_all()
        if not self.dir:
            messagebox.showinfo('先保存', '请先「保存」到目录，再打包 ZIP')
            return
        out = filedialog.asksaveasfilename(
            title='打包为 zip', defaultextension='.zip',
            initialfile='%s.zip' % (self.pack.manifest.get('id', 'pack')),
            filetypes=[('zip', '*.zip'), ('ALSF 包', '*.pack *.alsfpack'), ('所有', '*.*')])
        if not out:
            return
        try:
            n = P.build_zip(self.dir, out)
        except Exception as e:
            messagebox.showerror('打包失败', str(e))
            return
        self.status('已打包 %s（%d 个文件）' % (out, n))
        messagebox.showinfo('完成', '已写入 %s\n共 %d 个文件' % (out, n))

    def _validate(self):
        self.flush_all()
        errs = P.validate(self.pack)
        if errs:
            messagebox.showwarning('校验未通过', '\n'.join('· ' + e for e in errs))
            self.status('校验失败：%d 个问题' % len(errs))
        else:
            messagebox.showinfo('校验通过', '英雄 %d / 卡牌 %d / 地图 %d / 脚本 %d' % (
                len(self.pack.heroes), len(self.pack.cards),
                len(self.pack.maps), len(self.pack.scripts)))
            self.status('校验通过')

    def status(self, text):
        self.statusbar.config(text=text)


def main():
    try:
        app = App()
        app.mainloop()
    except Exception as e:  # pythonw 无控制台，兜底弹框
        import traceback
        messagebox.showerror('运行错误', traceback.format_exc())
        raise


if __name__ == '__main__':
    main()
