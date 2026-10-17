/*
 * ALSF 管理端逻辑（无登录，独立端口部署）：
 *   - 左侧列表 + 右侧可视化表单（卡牌 / 英雄 / 地图）
 *   - 效果（effects）可视化编辑：op 下拉 + 按类型生成参数输入框
 *   - 地图网格可视化：点击格子循环地形（. → ~ → #），出生点/回血点着色
 *   - JSON 视图兜底（复杂字段可手改）
 * 纯原生 JS，零构建。
 */

(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const el = {
    list: $('item-list'), form: $('form-view'), jsonView: $('json-view'),
    jsonEditor: $('json-editor'), title: $('editor-title'), status: $('status'),
    tabs: document.querySelectorAll('.tab'),
  };

  let catalog = null;   // { maps, heroes, cards }
  let tab = 'cards';    // cards | heroes | maps
  let selected = -1;
  let jsonMode = false;
  let mapStringRows = true; // 地图 tiles 行是否为字符串（保持原格式写回）

  // ── 枚举（与 src/server/game/cards.ts 保持一致） ──

  const TARGETING = { self: '自身', enemy: '敌人', ally: '队友', tile: '格子', none: '无' };
  const ATTACK_TYPES = { ranged: '远', melee: '近', magic: '法' };
  const CARD_KINDS = { general: '常规', item: '道具' };
  const CARD_CATS = { atk: '攻击', skill1: '技1', skill2: '技2', ult: '大招', heal: '回血' };
  const STATUSES = ['burn', 'poison', 'stun', 'silence', 'disarm', 'magicVeil', 'thorn', 'reflect'];

  /** op → 参数字段定义。未知 op 走 JSON 兜底。 */
  const OP_FIELDS = {
    damage: [['amount', '数值', 'number'], ['kind', '类型', ['physical', 'magic']]],
    heal: [['amount', '数值', 'number']],
    shield: [['amount', '数值', 'number']],
    status: [['status', '状态', STATUSES], ['turns', '回合', 'number'], ['value', '强度', 'number']],
    move: [['tiles', '格数', 'number']],
    push: [['tiles', '格数', 'number']],
    pull: [['tiles', '格数', 'number']],
    pierce: [['ratio', '比例', 'number']],
    splash: [['ratio', '比例', 'number']],
    lifesteal: [['ratio', '比例', 'number']],
    draw: [['count', '张数', 'number']],
    discard: [['count', '张数', 'number'], ['who', '目标', ['target', 'self']]],
    steal: [['count', '张数', 'number']],
    teleport: [['to', '目标', ['target', 'self']]],
    swap: [], extraTurn: [], foresee: [],
  };
  const OPS = Object.keys(OP_FIELDS);

  /** op → 中文名（下拉与行标签用）。 */
  const OP_LABELS = {
    damage: '伤害', heal: '回血', shield: '护盾', status: '状态', move: '移动',
    push: '推', pull: '拉', pierce: '穿刺', splash: '溅射', lifesteal: '吸血',
    draw: '抽牌', discard: '弃牌', steal: '拿牌', teleport: '传送', swap: '交换',
    extraTurn: '额外回合', foresee: '预见',
  };

  /** 按 op 生成一条带默认参数的效果。 */
  function defaultEffect(op) {
    const fx = { op };
    for (const [key, , kind] of (OP_FIELDS[op] ?? [])) {
      if (Array.isArray(kind)) fx[key] = kind[0];
      else if (kind === 'number') fx[key] = 1;
      else fx[key] = '';
    }
    return fx;
  }

  function setStatus(msg, ok) {
    el.status.textContent = msg;
    el.status.className = 'status ' + (ok ? 'ok' : 'err');
  }

  async function api(endpoint, opts = {}) {
    const res = await fetch('/admin/api' + endpoint, {
      ...opts,
      headers: { 'Content-Type': 'application/json' },
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.msg ?? ('HTTP ' + res.status));
    return body;
  }

  // ── 数据载入 ──

  async function load() {
    catalog = await api('/catalog');
    selected = 0;
    renderList();
    renderEditor();
  }

  function items() { return catalog[tab]; }

  function keyOf(item) { return item.id ?? '?'; }
  function titleOf(item) { return (item.name ?? '?') + '（' + keyOf(item) + '）'; }

  // ── 列表 ──

  function badgeOf(it) {
    if (tab === 'cards') {
      const b1 = CARD_KINDS[it.kind] ?? it.kind ?? '?';
      const b2 = CARD_CATS[it.category] ?? '';
      return `<span class="b">${escapeHtml(String(b1))}</span>` + (b2 ? `<span class="b accent">${escapeHtml(String(b2))}</span>` : '');
    }
    if (tab === 'heroes') {
      const a = it.attack ?? {};
      return `<span class="b accent">HP ${escapeHtml(String(it.maxHp ?? '?'))}</span><span class="b">${escapeHtml(String(ATTACK_TYPES[a.type] ?? a.type ?? '?'))}${escapeHtml(String(a.damage ?? ''))}</span>`;
    }
    return `<span class="b">${escapeHtml(String(it.width ?? '?'))}×${escapeHtml(String(it.height ?? '?'))}</span>`;
  }

  function renderList() {
    el.list.innerHTML = items().map((it, i) =>
      `<div class="item${i === selected ? ' active' : ''}" data-i="${i}">
         <span class="grow">${escapeHtml(String(it.name ?? it.id ?? '?'))}</span>${badgeOf(it)}
       </div>`).join('');
  }

  el.list.addEventListener('click', (e) => {
    const t = e.target instanceof HTMLElement ? e.target.closest('.item') : null;
    if (t === null) return;
    selected = Number(t.dataset.i);
    jsonMode = false;
    $('btn-json').textContent = 'JSON 视图';
    renderList();
    renderEditor();
  });

  for (const t of el.tabs) {
    t.addEventListener('click', () => {
      tab = t.dataset.tab;
      selected = 0;
      jsonMode = false;
      $('btn-json').textContent = 'JSON 视图';
      for (const x of el.tabs) x.classList.toggle('active', x === t);
      renderList();
      renderEditor();
    });
  }

  // ── 表单构建工具 ──

  function h(tag, attrs = {}, children = []) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k === 'style') node.style.cssText = v;
      else node.setAttribute(k, v);
    }
    for (const c of children) if (c !== null) node.append(c);
    return node;
  }

  function field(label, input) {
    return h('label', { class: 'field' }, [h('span', { text: label }), input]);
  }

  function textInput(value, oninput, attrs = {}) {
    const i = h('input', { type: 'text', ...attrs });
    i.value = value ?? '';
    i.addEventListener('input', () => oninput(i.value));
    return i;
  }

  function numInput(value, oninput, attrs = {}) {
    const i = h('input', { type: 'number', step: 'any', ...attrs });
    i.value = value ?? 0;
    i.addEventListener('input', () => oninput(Number(i.value)));
    return i;
  }

  function selectInput(options, value, onchange) {
    const entries = Array.isArray(options) ? options.map((o) => [o, o]) : Object.entries(options);
    const s = h('select');
    for (const [v, label] of entries) s.append(h('option', { value: v, text: label }));
    const raw = String(value ?? '');
    if ([...s.options].some((o) => o.value === raw)) s.value = raw;
    else s.append(h('option', { value: raw, text: raw })), s.value = raw;
    s.addEventListener('change', () => onchange(s.value));
    return s;
  }

  function textArea(value, oninput, rows = 3) {
    const t = h('textarea', { rows: String(rows) });
    t.value = value ?? '';
    t.addEventListener('input', () => oninput(t.value));
    return t;
  }

  // ── 效果编辑器（可视化） ──

  function effectsEditor(effects, label = '效果') {
    const box = h('div');
    if (label !== '') box.append(h('span', { text: label, style: 'font-size:12.5px;color:var(--dim)' }));

    const renderRows = () => {
      for (const old of box.querySelectorAll('.fx, .btn')) old.remove();
      effects.forEach((fx, idx) => {
        const row = h('div', { class: 'fx' });
        const fr = h('div', { class: 'fxrow' });
        fr.append(h('span', { class: 'op-name', text: (OP_LABELS[fx.op] ?? fx.op) ?? '?' }));

        if (OP_FIELDS[fx.op] !== undefined) {
          for (const [key, lab, kind] of OP_FIELDS[fx.op]) {
            let input;
            if (Array.isArray(kind)) {
              input = selectInput(kind, fx[key], (v) => { fx[key] = v; onChange(); });
            } else if (kind === 'number') {
              input = numInput(fx[key], (v) => { fx[key] = v; onChange(); });
            } else {
              input = textInput(fx[key], (v) => { fx[key] = v; onChange(); });
            }
            fr.append(field(lab, input));
          }
        } else {
          const raw = textArea(JSON.stringify(fx, null, 2), (v) => {
            try {
              effects[idx] = JSON.parse(v);
              onChange();
              setStatus('', true);
            } catch { setStatus('效果 JSON 解析失败（未应用）', false); }
          }, 4);
          raw.className = 'fx-raw';
          fr.append(field('JSON（自定义效果）', raw));
        }

        const del = h('button', { class: 'btn danger del', type: 'button', text: '删除' });
        del.addEventListener('click', () => { effects.splice(idx, 1); renderList(); renderFormAgain(); });
        fr.append(del);
        row.append(fr);
        box.append(row);
      });
      // 加一条效果：先选 op，再按该 op 生成默认参数（不再固定为 damage）
      const addRow = h('div', { class: 'fxrow fx-add' });
      const opSel = h('select');
      for (const op of OPS) opSel.append(h('option', { value: op, text: `${OP_LABELS[op] ?? op}（${op}）` }));
      const add = h('button', { class: 'btn', type: 'button', text: '＋ 加一条效果' });
      add.addEventListener('click', () => {
        effects.push(defaultEffect(opSel.value));
        renderList();
        renderFormAgain();
      });
      addRow.append(opSel, add);
      box.append(addRow);
    };
    renderRows();
    return box;
  }

  // ── 三类编辑器 ──

  function renderCardForm(item) {
    const f = h('div');
    const top = h('div', { class: 'row' });
    top.append(
      field('ID（引用键，可修改）', textInput(item.id, (v) => { item.id = v; onChange(); })),
      field('名称', textInput(item.name, (v) => { item.name = v; onChange(); })),
      field('类型', selectInput(CARD_KINDS, item.kind, (v) => { item.kind = v; onChange(); })),
      field('归类', selectInput(CARD_CATS, item.category, (v) => { item.category = v; onChange(); })),
      field('目标', selectInput(TARGETING, item.targeting, (v) => { item.targeting = v; onChange(); })),
      field('牌堆张数', numInput(item.count, (v) => { item.count = v; onChange(); })),
    );
    f.append(top);
    if (item.subtype !== undefined) {
      f.append(field('subtype', textInput(item.subtype, (v) => { item.subtype = v; onChange(); })));
    }
    f.append(field('效果说明（游戏内展示）', textArea(item.text, (v) => { item.text = v; onChange(); }, 2)));
    f.append(effectsEditor(item.effects));
    return f;
  }

  function renderHeroForm(item) {
    const f = h('div');
    const top = h('div', { class: 'row' });
    top.append(
      field('ID（引用键，可修改）', textInput(item.id, (v) => { item.id = v; onChange(); })),
      field('名称', textInput(item.name, (v) => { item.name = v; onChange(); })),
      field('称号', textInput(item.title, (v) => { item.title = v; onChange(); })),
      field('HP', numInput(item.maxHp, (v) => { item.maxHp = v; onChange(); })),
    );
    f.append(top);

    const atkBox = h('div', { class: 'skill' });
    atkBox.append(h('h4', { text: '基础攻击' }));
    const atkRow = h('div', { class: 'row' });
    atkRow.append(
      field('类型', selectInput(ATTACK_TYPES, item.attack.type, (v) => { item.attack.type = v; onChange(); })),
      field('伤害', numInput(item.attack.damage, (v) => { item.attack.damage = v; onChange(); })),
    );
    atkBox.append(atkRow);
    f.append(atkBox);

    if (item.modifiers !== undefined) {
      const m = h('div', { class: 'skill' });
      m.append(h('h4', { text: '常驻特殊属性（modifiers）' }));
      m.append(effectsEditor(item.modifiers, ''));
      f.append(m);
    }

    const skills = h('div', { class: 'skills' });
    for (const [key, zh] of [['skill1', '技能1（牌堆「技1」触发）'], ['skill2', '技能2（牌堆「技2」触发）'], ['ult', '大招（牌堆「大」触发）']]) {
      const sk = item[key] ?? (item[key] = { name: '', targeting: 'enemy', effects: [], text: '' });
      const box = h('div', { class: 'skill' });
      box.append(h('h4', { text: zh }));
      const r = h('div', { class: 'row' });
      r.append(
        field('名称', textInput(sk.name, (v) => { sk.name = v; onChange(); })),
        field('目标', selectInput(TARGETING, sk.targeting, (v) => { sk.targeting = v; onChange(); })),
      );
      box.append(r);
      box.append(field('说明', textArea(sk.text, (v) => { sk.text = v; onChange(); }, 2)));
      box.append(effectsEditor(sk.effects));
      skills.append(box);
    }
    f.append(skills);
    f.append(field('英雄简介', textArea(item.text, (v) => { item.text = v; onChange(); }, 2)));
    return f;
  }

  // ── 地图：网格可视化 ──

  function rowOf(tiles, y) {
    const r = tiles[y];
    return typeof r === 'string' ? r.split('') : (r ?? []);
  }
  // 地形 token（与服务端 Terrain 一致）：plain / water / wall / spawn / heal

  function renderMapGrid(item) {
    const wrap = h('div');
    const legend = h('div', { class: 'legend' });
    legend.innerHTML =
      '<span><i style="background:#fff"></i>空地（点击变水）</span>' +
      '<span><i style="background:#cfe4f7"></i>水（点击变墙）</span>' +
      '<span><i style="background:#7c8794"></i>墙（点击变空地）</span>' +
      '<span><i style="background:#eaf1fe;border-color:#2f6df0"></i>出生点</span>' +
      '<span><i style="background:#e7f8ef;border-color:#16a34a"></i>回血点</span>';
    wrap.append(legend);

    const grid = h('div', {
      class: 'map-grid',
      style: `grid-template-columns:repeat(${item.width},30px)`,
    });
    for (let y = 0; y < item.height; y++) {
      const row = rowOf(item.tiles, y);
      for (let x = 0; x < item.width; x++) {
        const ch = row[x] ?? 'plain';
        const cell = h('div', { class: 'cell' });
        const spawnIdx = (item.spawns ?? []).findIndex((s) => s.x === x && s.y === y);
        const isHealToken = ch === 'heal';
        if (ch === 'spawn') { cell.classList.add('spawn'); cell.textContent = String(Math.max(0, spawnIdx) + 1); }
        else if (isHealToken) { cell.classList.add('heal'); cell.textContent = '＋'; }
        else if (ch === 'water') cell.classList.add('water');
        else if (ch === 'wall') cell.classList.add('wall');
        cell.title = `(${x},${y}) = ${ch}`;
        cell.addEventListener('click', () => {
          if (ch === 'spawn' || isHealToken) { setStatus('出生点/回血点格子请在 JSON 视图中调整', false); return; }
          const next = ch === 'plain' ? 'water' : ch === 'water' ? 'wall' : 'plain';
          const r = rowOf(item.tiles, y);
          r[x] = next;
          item.tiles[y] = mapStringRows ? r.join('') : r;
          onChange();
          renderFormAgain();
        });
        grid.append(cell);
      }
    }
    wrap.append(grid);
    return wrap;
  }

  function renderMapForm(item) {
    mapStringRows = Array.isArray(item.tiles) && typeof item.tiles[0] === 'string';
    const f = h('div');
    const top = h('div', { class: 'row' });
    top.append(
      field('ID（引用键，可修改）', textInput(item.id, (v) => { item.id = v; onChange(); })),
      field('名称', textInput(item.name, (v) => { item.name = v; onChange(); })),
      field('宽', numInput(item.width, (v) => { item.width = v; onChange(); renderFormAgain(); })),
      field('高', numInput(item.height, (v) => { item.height = v; onChange(); renderFormAgain(); })),
    );
    f.append(top);
    f.append(renderMapGrid(item));
    f.append(field('出生点 spawns（[{x,y},…]）', textArea(JSON.stringify(item.spawns ?? []), (v) => {
      try { item.spawns = JSON.parse(v); onChange(); setStatus('', true); }
      catch { setStatus('spawns JSON 解析失败（未应用）', false); }
    }, 2)));
    f.append(field('回血点 heals（[{x,y},…]）', textArea(JSON.stringify(item.heals ?? []), (v) => {
      try { item.heals = JSON.parse(v); onChange(); renderFormAgain(); setStatus('', true); }
      catch { setStatus('heals JSON 解析失败（未应用）', false); }
    }, 2)));
    return f;
  }

  // ── 编辑器渲染 ──

  function renderEditor() {
    const item = items()[selected];
    if (item === undefined) { el.title.textContent = '—'; el.form.replaceChildren(); return; }
    el.title.textContent = titleOf(item);
    el.jsonView.hidden = true;
    el.form.hidden = false;
    renderFormInto(item);
  }

  function renderFormInto(item) {
    el.form.replaceChildren();
    if (tab === 'cards') el.form.append(renderCardForm(item));
    else if (tab === 'heroes') el.form.append(renderHeroForm(item));
    else el.form.append(renderMapForm(item));
  }

  /** 结构变化（增删效果/格子/行列）后整表重绘。 */
  function renderFormAgain() {
    if (jsonMode) { renderEditor(); syncJson(); return; }
    const item = items()[selected];
    if (item !== undefined) renderFormInto(item);
  }

  /** 表单小改动：只刷新左侧徽标 + 同步 JSON 视图。 */
  function onChange() {
    renderList();
    if (jsonMode) syncJson();
  }

  // ── JSON 视图 ──

  function showJson() {
    const item = items()[selected];
    if (item === undefined) return;
    el.form.hidden = true;
    el.jsonView.hidden = false;
    syncJson();
  }

  function syncJson() {
    const item = items()[selected];
    if (item !== undefined) el.jsonEditor.value = JSON.stringify(item, null, 2);
  }

  $('btn-json').addEventListener('click', () => {
    jsonMode = !jsonMode;
    $('btn-json').textContent = jsonMode ? '返回表单' : 'JSON 视图';
    if (jsonMode) showJson();
    else renderEditor();
  });

  $('btn-json-apply').addEventListener('click', () => {
    try {
      const obj = JSON.parse(el.jsonEditor.value);
      const id = String(obj.id ?? '').trim();
      if (id === '') { setStatus('id 不能为空', false); return; }
      if (items().some((x, i) => i !== selected && x.id === id)) {
        setStatus('id 与已有条目重复：' + id, false);
        return;
      }
      items()[selected] = obj;
      setStatus('已应用到表单（记得「保存全部」）', true);
      jsonMode = false;
      $('btn-json').textContent = 'JSON 视图';
      renderList();
      renderEditor();
    } catch (err) {
      setStatus('JSON 解析失败：' + err.message, false);
    }
  });

  // ── 增 / 删 / 保存 / 重载 ──

  /** 生成不重复的新 id（基础名被占用时追加 _2/_3…），之后仍可在表单里改。 */
  function uniqueId(base) {
    const used = new Set(items().map((x) => x.id));
    if (!used.has(base)) return base;
    let i = 2;
    while (used.has(base + '_' + i)) i++;
    return base + '_' + i;
  }

  $('btn-add').addEventListener('click', () => {
    const tpl = tab === 'cards'
      ? { id: uniqueId('new_card'), name: '新卡牌', kind: 'general', category: 'atk', targeting: 'enemy', effects: [{ op: 'damage', amount: 1, kind: 'physical' }], text: '效果说明', count: 1 }
      : tab === 'heroes'
        ? { id: uniqueId('new_hero'), name: '新英雄', title: '', maxHp: 5, attack: { type: 'melee', damage: 2 }, modifiers: [], skill1: { name: '技能1', targeting: 'enemy', effects: [{ op: 'damage', amount: 2, kind: 'physical' }], text: '' }, skill2: { name: '技能2', targeting: 'self', effects: [{ op: 'heal', amount: 2 }], text: '' }, ult: { name: '大招', targeting: 'enemy', effects: [{ op: 'damage', amount: 4, kind: 'magic' }], text: '' }, text: '' }
        : { id: uniqueId('new_map'), name: '新地图', width: 11, height: 9, tiles: buildEmptyTiles(11, 9), spawns: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 8 }, { x: 10, y: 8 }], heals: [{ x: 5, y: 4 }] };
    items().push(tpl);
    selected = items().length - 1;
    jsonMode = false;
    $('btn-json').textContent = 'JSON 视图';
    renderList();
    renderEditor();
  });

  function buildEmptyTiles(w, hgt) {
    const rows = [];
    for (let y = 0; y < hgt; y++) rows.push(new Array(w).fill('plain'));
    return rows; // 新地图默认数组行，网格编辑会保持该格式
  }

  $('btn-del').addEventListener('click', () => {
    if (selected < 0 || selected >= items().length) return;
    if (items().length <= 1) { setStatus(tab === 'maps' ? '至少保留 1 张地图' : '至少保留 1 个英雄', false); return; }
    if (!window.confirm('删除「' + titleOf(items()[selected]) + '」？')) return;
    items().splice(selected, 1);
    selected = Math.max(0, selected - 1);
    renderList();
    renderEditor();
  });

  /** 校验各分类内 id 非空且不重复。返回错误信息或 null。 */
  function findDupIds(c) {
    for (const [key, label] of [['cards', '卡牌'], ['heroes', '英雄'], ['maps', '地图']]) {
      const seen = new Set();
      for (const it of c[key] ?? []) {
        const id = String(it.id ?? '').trim();
        if (id === '') return `${label}存在空 id`;
        if (seen.has(id)) return `${label} id 重复：${id}`;
        seen.add(id);
      }
    }
    return null;
  }

  $('btn-save').addEventListener('click', async () => {
    const btn = $('btn-save');
    btn.disabled = true;
    const dup = findDupIds(catalog);
    if (dup !== null) { setStatus(dup, false); btn.disabled = false; return; }
    setStatus('保存中…', true);
    try {
      const r = await api('/catalog', { method: 'PUT', body: JSON.stringify(catalog) });
      setStatus(r.msg ?? '已保存', true);
    } catch (err) {
      setStatus('保存失败：' + err.message, false);
    } finally {
      btn.disabled = false;
    }
  });

  $('btn-reload').addEventListener('click', async () => {
    try {
      catalog = await api('/catalog');
      selected = 0;
      setStatus('已重新载入服务端当前内容', true);
      renderList();
      renderEditor();
    } catch (err) {
      setStatus(err.message, false);
    }
  });

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] ?? c));
  }

  load().catch((err) => setStatus('载入失败：' + err.message, false));
})();
