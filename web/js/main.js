/*
 * ALSF 主控：屏幕流转 + 消息分发 + 对局交互 + 聊天 + 动画编排。
 * 零构建 ES Module；手机端通过 Pointer Events 操作棋盘。
 */

import { Net, MSG, MODES } from './net.js';
import {
  S, resetMatch, myHero, isMyTurn, reachableTiles, teamColor,
  cardKindLabel, fmtTime,
} from './game.js';
import { initBoard, pickTile, drawSpawnPreview, pickSpawnTile } from './render.js';

const $ = (id) => document.getElementById(id);
const net = new Net('/ws');

const el = {
  screens: {
    join: $('scr-join'), lobby: $('scr-lobby'), room: $('scr-room'), hero: $('scr-hero'),
    spawn: $('scr-spawn'), battle: $('scr-battle'), result: $('scr-result'),
  },
  joinStatus: $('join-status'),
  btnSettings: $('btn-settings'), settingsModal: $('settings-modal'),
  optRender: $('opt-render'), renderNote: $('render-note'), optName: $('opt-name'),
  btnSettingsReset: $('btn-settings-reset'),
  lobbyMe: $('lobby-me'), roomList: $('room-list'), lobbyCount: $('lobby-count'),
  roomName: $('room-name'), roomMap: $('room-map'), roomMode: $('room-mode'), modeHint: $('mode-hint'),
  btnCreate: $('btn-create'),
  roomTitle: $('room-title'), roomModeTag: $('room-mode-tag'), roomHost: $('room-host'),
  teamList: $('team-list'), roomStatus: $('room-status'),
  btnStart: $('btn-start'), btnLeave: $('btn-leave'), btnLobbyBack: $('btn-lobby-back'),
  heroGrid: $('hero-grid'), heroTimer: $('hero-timer'), heroCount: $('hero-count'),
  spawnCanvas: $('spawn-canvas'), spawnTimer: $('spawn-timer'),
  board: $('board'), boardToast: $('board-toast'),
  hpStrip: $('hp-strip'),
  btnAttrs: $('btn-attrs'), attrsModal: $('attrs-modal'), attrsBody: $('attrs-body'),
  pickModal: $('pick-modal'), pickBody: $('pick-body'),
  battleTurn: $('battle-turn'), battleTimer: $('battle-timer'),
  battleMe: $('battle-me'), battleDeck: $('battle-deck'),
  deckCount: $('deck-count'), discardCount: $('discard-count'), discardCard: $('discard-card'),
  btnChat: $('btn-chat'), chatPanel: $('chat-panel'),
  tabAll: $('tab-all'), tabTeam: $('tab-team'), tabLog: $('tab-log'),
  chatList: $('chat-list'), chatForm: $('chat-form'), chatInput: $('chat-input'),
  hand: $('hand'), handHint: $('hand-hint'),
  btnEndTurn: $('btn-endturn'), btnCancel: $('btn-cancel'),
  resultTitle: $('result-title'), resultStandings: $('result-standings'),
  btnRestart: $('btn-restart'), btnResultLobby: $('btn-result-lobby'),
  toast: $('toast'), rotateHint: $('rotate-hint'),
};

let serverOffset = 0;   // Date.now() → 服务器时钟
let toastTimer = 0;
let spawnHover = null;
let lastClientPing = 0;  // 客户端→服务端保活心跳节流
let autoEndLock = false; // 防「移动+出牌后自动结束」重复发送
let lastHandSig = '';    // 手牌渲染签名：内容没变就不重建 DOM，避免入场动画重放导致「闪一下」

// ── 工具 ──

function show(name) {
  for (const [k, node] of Object.entries(el.screens)) node.classList.toggle('active', k === name);
  if (name === 'battle') initBoard(el.board);
  if (name === 'spawn') requestAnimationFrame(renderSpawn);
  if (name !== 'battle') el.chatPanel.classList.remove('open');
}

function toast(text, isErr = false) {
  el.toast.textContent = text;
  el.toast.classList.toggle('err', isErr);
  el.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.toast.hidden = true; }, 2200);
}

function boardToast(text) {
  el.boardToast.textContent = text;
  el.boardToast.hidden = text === '';
}

function send(t, d) { net.send(t, { roomId: S.room?.roomId, ...d }); }

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] ?? c
  ));
}

// ── 进入：名号自动取账号（见文件末尾 bootstrap），不再弹设定界面 ──



net.on('_open', () => { net.hello(); });
net.on('_close', () => {
  if (el.screens.battle.classList.contains('active')) toast('连接断开，正在重连…', true);
});

/** 移动 + 出牌都完成后，自动结束自己的回合（轮到下一位）。 */
function maybeAutoEndTurn() {
  if (autoEndLock) return;
  if (!isMyTurn()) return;
  if (S.turn?.moved === true && S.turn?.played === true) {
    autoEndLock = true;
    net.send(MSG.END_TURN, {});
  }
}

// ── 消息分发 ──

net.on(MSG.WELCOME, (d) => {
  S.me = { id: d.id, name: net.name };
  serverOffset = d.serverTime - Date.now();
  el.joinStatus.textContent = '';
  el.lobbyMe.textContent = `${net.name} · ${d.id}`;
  if (Array.isArray(d.maps)) { S.mapList = d.maps; populateMapSelect(); }
  if (S.room !== null && S.room.roomId !== undefined) {
    // 重连回原房
    send(MSG.JOIN_ROOM, { roomId: S.room.roomId });
  } else {
    show('lobby');
  }
});

net.on(MSG.LOBBY, (d) => {
  S.lobbyRooms = d.rooms ?? [];
  renderLobby();
});

net.on(MSG.ROOM, (d) => {
  const first = S.room === null || S.room.roomId !== d.roomId;
  S.room = d;
  if (first) resetMatch();
  routePhase(d.phase);
  renderRoom();
});

net.on(MSG.PHASE, (d) => {
  S.phase = d.phase;
  S.endsAt = d.endsAt ?? 0;
  routePhase(d.phase);
});

net.on(MSG.HERO_OPTIONS, (d) => {
  S.heroOptions = d.heroes ?? [];
  S.takenHeroes = d.taken ?? [];
  S.cardList = d.cardList ?? [];
  show('hero');
  renderHeroes();
  renderHeroPanels();
});

net.on(MSG.SPAWN_OPTIONS, (d) => {
  S.spawnOptions = d.spawns ?? [];
  S.takenSpawns = d.taken ?? [];
  show('spawn');
  renderSpawn();
});

net.on(MSG.MAP, (d) => {
  S.map = d.map;
  S.heroes = d.heroes ?? [];
});

net.on(MSG.STATE, (d) => {
  const prev = new Map(S.heroes.map((h) => [h.playerId, h]));
  S.heroes = d.heroes ?? [];
  S.deckCount = d.deckCount ?? 0;
  S.discardCount = d.discardCount ?? 0;
  S.topDiscard = d.topDiscard ?? null;
  S.placed = d.placed ?? [];
  S.endsAt = d.endsAt ?? 0;
  // 动画：位移 / 掉血 / 死亡
  for (const h of S.heroes) {
    const old = prev.get(h.playerId);
    if (old === undefined) continue;
    if ((old.x !== h.x || old.y !== h.y) && h.alive) {
      S.moves.push({ heroId: h.playerId, from: { x: old.x, y: old.y }, to: { x: h.x, y: h.y }, t0: performance.now(), dur: 260 });
    }
    if (h.hp < old.hp && h.alive) {
      S.floats.push({ x: h.x, y: h.y, text: `-${old.hp - h.hp}`, color: '#dc2626', t0: performance.now() });
      S.shakes.push({ heroId: h.playerId, t0: performance.now() });
    }
    if (old.alive && !h.alive) S.deaths.push({ heroId: h.playerId, t0: performance.now() });
  }
  renderBattleHud();
  renderHeroPanels();
  maybeAutoEndTurn();
});

net.on(MSG.TURN, (d) => {
  const wasMine = S.turn !== null && S.turn.currentId === S.me?.id;
  const prevId = S.turn?.currentId ?? '';
  S.turn = d;
  S.endsAt = d.endsAt ?? 0;
  if (d.currentId !== prevId) autoEndLock = false; // 新回合解锁自动结束
  if (d.currentId === S.me?.id && !wasMine) S.turnPulse = performance.now();
  S.selectedUid = null;
  S.targeting = null;
  renderHand();
  renderBattleHud();
  maybeAutoEndTurn();
});

net.on(MSG.HAND, (d) => {
  S.hand = d.cards ?? [];
  renderHand();
});

net.on(MSG.EVENT, (d) => {
  for (const e of d.events ?? []) {
    if (e.kind === 'chat') continue;
    S.logs.push(e);
    if (S.logs.length > 120) S.logs.shift();
  }
  if (S.chatTab === 'log') renderChat();
});

net.on(MSG.CHAT, (d) => {
  const line = { name: d.name, text: d.text, channel: d.channel, team: d.team };
  if (d.channel === 'team') S.chatTeam.push(line); else S.chatAll.push(line);
  if (S.chatAll.length > 120) S.chatAll.shift();
  if (S.chatTeam.length > 120) S.chatTeam.shift();
  if (S.chatTab === (d.channel === 'team' ? 'team' : 'all')) renderChat();
});

net.on(MSG.RESULT, (d) => {
  S.result = d;
  show('result');
  renderResult();
});

net.on(MSG.ERROR, (d) => toast(d.msg ?? '操作被拒绝', true));
net.on(MSG.PONG, () => { /* 服务端心跳回应 */ });
// 客户端必须回应服务端的 MSG.PING，否则服务端判定心跳超时 → 断连 → 重连被当新玩家
net.on(MSG.PING, () => net.send(MSG.PONG, { ts: Date.now() }));

// ── 阶段 → 屏幕 ──

function routePhase(phase) {
  if (S.room === null) return;
  switch (phase) {
    case 'WAITING': show('room'); break;
    case 'HERO_SELECT': show('hero'); break;
    case 'SPAWN_SELECT': show('spawn'); break;
    case 'PLAYING': show('battle'); break;
    case 'FINISHED': show('result'); break;
    default: break;
  }
}

// ── 大厅 ──

/** 当前会话是否只是观战者（在房间内但没有自己的座位）。 */
function isSpectator() {
  return S.room !== null && S.me !== null && !(S.room.players ?? []).some((p) => p.id === S.me.id);
}

/** 用服务端下发的地图列表填充「地图」下拉（建房时可选）。 */
function populateMapSelect() {
  if (el.roomMap === null) return;
  const cur = el.roomMap.value;
  const list = S.mapList ?? [];
  if (list.length === 0) {
    el.roomMap.innerHTML = '<option value="">默认地图</option>';
    return;
  }
  el.roomMap.innerHTML = list.map((m) => {
    const size = m.width && m.height ? `（${m.width}×${m.height}）` : '';
    return `<option value="${esc(m.id)}">${esc(m.name)}${size}</option>`;
  }).join('');
  if (cur !== '' && [...el.roomMap.options].some((o) => o.value === cur)) el.roomMap.value = cur;
}

function renderLobby() {
  el.lobbyCount.textContent = `${S.lobbyRooms.length} 个房间`;
  if (S.lobbyRooms.length === 0) {
    el.roomList.innerHTML = '<div class="room-empty">暂无房间，创建一个吧</div>';
    return;
  }
  el.roomList.innerHTML = S.lobbyRooms.map((r) => {
    const phaseName = { WAITING: '等待中', HERO_SELECT: '选英雄', SPAWN_SELECT: '选出生点', PLAYING: '对战中', FINISHED: '已结束' }[r.phase] ?? r.phase;
    const full = r.players >= r.capacity;
    const inProgress = r.phase === 'PLAYING' || r.phase === 'FINISHED';
    const canEnter = inProgress || !full;   // 对局中/已结束 → 可观战（即使人满）
    const go = inProgress ? '观战 →' : full ? '已满' : '进入 →';
    const spect = (r.spectators ?? 0) > 0 ? ` · 观战 ${r.spectators}` : '';
    return `
      <div class="room-card ${canEnter ? 'joinable' : 'full'}" ${canEnter ? `data-join="${esc(r.id)}"` : ''}>
        <div>
          <h4>${esc(r.name)} ${r.permanent ? '<span class="tag">默认</span>' : ''}</h4>
          <div class="meta">${r.mode} · ${r.players}/${r.capacity} 人${spect} · 地图 ${esc(r.mapName ?? '—')} · 房主 ${esc(r.hostName)} · <span class="phase-tag">${phaseName}</span></div>
        </div>
        <span class="room-go">${go}</span>
      </div>`;
  }).join('');
}

el.roomList.addEventListener('click', (e) => {
  const card = e.target instanceof HTMLElement ? e.target.closest('.room-card') : null;
  const id = card?.dataset.join;
  if (id !== undefined) send(MSG.JOIN_ROOM, { roomId: id });
});

for (const opt of MODES) {
  const o = document.createElement('option');
  o.value = opt; o.textContent = opt;
  el.roomMode.append(o);
}
function updateModeHint() {
  const m = el.roomMode.value;
  const shape = { '1v1': '2 队 · 每队 1 人（单挑）', '1v1v1v1': '4 队 · 每队 1 人', '2v2': '2 队 · 每队 2 人', '3v3': '2 队 · 每队 3 人', '4v4': '2 队 · 每队 4 人', '2v2v2v2': '4 队 · 每队 2 人' }[m] ?? '';
  el.modeHint.textContent = shape;
}
el.roomMode.addEventListener('change', updateModeHint);
updateModeHint();

el.btnCreate.addEventListener('click', () => {
  net.send(MSG.CREATE_ROOM, {
    name: el.roomName.value.trim(),
    mode: el.roomMode.value,
    mapId: el.roomMap !== null ? el.roomMap.value : undefined,
  });
});

// ── 房间 / 等待房 ──

function myTeam() {
  if (S.room === null || S.me === null) return -1;
  return S.room.players.find((p) => p.id === S.me.id)?.team ?? -1;
}

function renderRoom() {
  const r = S.room;
  if (r === null) return;
  el.roomTitle.textContent = r.name;
  el.roomModeTag.textContent = r.mode;
  const host = r.players.find((p) => p.id === r.hostId);
  el.roomHost.textContent = host !== undefined ? `房主：${esc(host.name)}` : '';
  const teams = r.mode === '1v1' || r.mode === '2v2' || r.mode === '3v3' || r.mode === '4v4' ? 2 : 4;
  const perTeam = r.players.length > 0 ? Math.ceil(r.capacity / teams) : 2;
  const mine = myTeam();
  let html = '';
  for (let t = 0; t < teams; t++) {
    const members = r.players.filter((p) => p.team === t).sort((a, b) => a.seat - b.seat);
    const seats = [];
    for (let i = 0; i < perTeam; i++) {
      const p = members[i];
      seats.push(p === undefined
        ? '<span class="seat empty">空位</span>'
        : `<span class="seat ${p.host ? 'host' : ''} ${p.connected ? '' : 'off'}">${esc(p.name)}</span>`);
    }
    const canJoin = mine !== t && members.length < perTeam;
    html += `
      <div class="team-row" style="border-color:${teamColor(t)}55">
        <h4><span class="team-dot" style="background:${teamColor(t)}"></span>${t + 1} 队
          ${mine === t ? '<span class="tag">我的队伍</span>' : ''}
          ${canJoin ? `<button class="team-join" data-team="${t}">点击加入</button>` : ''}
        </h4>
        <div class="team-slots">${seats.join('')}</div>
      </div>`;
  }
  el.teamList.innerHTML = html;

  const need = r.capacity;
  const isHost = r.hostId === S.me?.id;
  el.btnStart.hidden = !isHost;
  el.btnStart.disabled = r.players.length !== need;
  el.roomStatus.textContent = r.players.length === need
    ? '人数已齐，房主可以开始对局'
    : `等待玩家加入：${r.players.length}/${need}`;
}

el.teamList.addEventListener('click', (e) => {
  const t = e.target instanceof HTMLElement ? e.target.dataset.team : undefined;
  if (t !== undefined) net.send(MSG.CHOOSE_TEAM, { team: Number(t) });
});
el.btnStart.addEventListener('click', () => net.send(MSG.START_MATCH, {}));
el.btnLeave.addEventListener('click', () => { net.send(MSG.LEAVE_ROOM, {}); S.room = null; show('lobby'); });
el.btnLobbyBack.addEventListener('click', () => { net.send(MSG.LEAVE_ROOM, {}); S.room = null; show('lobby'); });

// ── 选英雄 ──

/** 英雄属性行（选英雄卡片与对局面板共用）：HP / 攻(单字+数字) / 特殊(如有) / 技1 / 技2 / 大，每行一项。 */
function heroAttrLinesHtml(def) {
  const rows = [];
  // 固定槽位：攻击 / 特殊 / 常驻 / 技1 / 技2 / 大；缺项也占位，避免下面内容上移
  rows.push(`<div class="hp-line">${ATTACK_CHAR[def.attack?.type] ?? '?'}${def.attack?.damage ?? '?'}</div>`);
  rows.push(`<div class="hp-line dim">${def.specialText ? `特殊 ${esc(def.specialText)}` : '特殊 —'}</div>`);
  const mods = (def.modifiers ?? []).map(modifierLabel).filter(Boolean);
  rows.push(`<div class="hp-line dim">${mods.length > 0 ? esc(mods.join('·')) : '—'}</div>`);
  // 技能为数组（技1 / 技2 / 大），每项含 name + text（效果详情）
  const skillLabels = ['技1', '技2', '大'];
  const skills = Array.isArray(def.skills) ? def.skills : [];
  skillLabels.forEach((label, i) => {
    const sk = skills[i];
    if (sk === undefined) { rows.push(`<div class="hp-line">${label} —</div>`); return; }
    const detail = sk.text ? ` <span class="hp-skill-detail">${esc(sk.text)}</span>` : '';
    rows.push(`<div class="hp-line"><b>${label}</b> ${esc(sk.name ?? '—')}${detail}</div>`);
  });
  return rows.join('');
}

function renderHeroes() {
  const mine = S.room?.players.find((p) => p.id === S.me?.id);
  void mine;
  el.heroCount.textContent = `${S.heroOptions.length - S.takenHeroes.length} 个可选`;
  el.heroGrid.innerHTML = S.heroOptions.map((h) => {
    const taken = S.takenHeroes.includes(h.id);
    return `
      <div class="hero-card ${taken ? 'taken' : ''}" data-hero="${h.id}">
        <p class="hname">${esc(h.name)}</p>
        <p class="htitle">${esc(h.title ?? '')}</p>
        <div class="hattrs">${heroAttrLinesHtml(h)}</div>
        <p class="htext">${esc(h.text)}</p>
      </div>`;
  }).join('');
}

el.heroGrid.addEventListener('click', (e) => {
  const card = e.target instanceof HTMLElement ? e.target.closest('.hero-card') : null;
  if (card === null) return;
  const id = card.dataset.hero ?? '';
  if (S.takenHeroes.includes(id)) return toast('该英雄已被选择', true);
  net.send(MSG.PICK_HERO, { heroId: id });
  for (const c of el.heroGrid.children) c.classList.remove('picked');
  card.classList.add('picked');
});

// ── 选出生点 ──

function renderSpawn() {
  drawSpawnPreview(el.spawnCanvas, S.map, S.takenSpawns, spawnHover);
}

el.spawnCanvas.addEventListener('pointerdown', (e) => {
  const tile = pickSpawnTile(el.spawnCanvas, S.map, e.clientX, e.clientY);
  if (tile === null) return;
  const idx = S.map.spawns.findIndex((s) => s.x === tile.x && s.y === tile.y);
  if (idx < 0) return toast('只能选择出生点', true);
  if (S.takenSpawns.includes(idx)) return toast('该出生点已被选择', true);
  net.send(MSG.PICK_SPAWN, { spawnIndex: idx });
});
el.spawnCanvas.addEventListener('pointermove', (e) => {
  spawnHover = pickSpawnTile(el.spawnCanvas, S.map, e.clientX, e.clientY);
  renderSpawn();
});

// ── 对战 ──

function renderBattleHud() {
  const me = myHero();
  const turn = S.turn;
  if (turn !== null) {
    const cur = S.heroes.find((h) => h.playerId === turn.currentId);
    el.battleTurn.textContent = `第 ${turn.turnNo} 回合 · ${cur?.name ?? '—'}${turn.currentId === S.me?.id ? '（你）' : ''}`;
    el.battleTurn.classList.toggle('mine', turn.currentId === S.me?.id);
  }
  if (me !== null) {
    el.battleMe.innerHTML = `${esc(me.name)} · <b style="color:${teamColor(me.team)}">${me.team + 1}队</b> · HP ${me.hp}/${me.maxHp}${me.alive ? '' : ' · 已出局'}`;
  } else if (isSpectator()) {
    el.battleMe.textContent = '观战中';
  }
  el.battleDeck.textContent = `牌堆 ${S.deckCount} · 弃牌 ${S.discardCount}`;
  const spect = isSpectator();
  el.btnEndTurn.disabled = !isMyTurn() || spect;
  el.btnEndTurn.textContent = spect ? '观战中' : isMyTurn() ? '结束回合' : '等待他人';
  const hint = spect ? '观战中：可查看战况与聊天'
    : !isMyTurn() ? '等待其他玩家行动…'
    : S.turn?.moved === true && S.turn?.played === true ? '本回合行动已完成，可结束回合'
    : S.turn?.moved === true ? '还可出 1 张牌'
    : S.turn?.played === true ? '已出牌，可结束回合'
    : '可移动 1 格 / 出 1 张牌';
  el.handHint.textContent = hint;
  renderPiles();
}

/** 地图左侧两个牌堆：主牌堆（背面）+ 弃牌堆（最新一张）。 */
function renderPiles() {
  if (el.deckCount !== null) el.deckCount.textContent = String(S.deckCount);
  if (el.discardCount !== null) el.discardCount.textContent = String(S.discardCount);
  if (el.discardCard === null) return;
  const t = S.topDiscard;
  el.discardCard.innerHTML = t === null || t === undefined
    ? '<span class="dim">—</span>'
    : `<span class="pname">${esc(t.name)}</span><span class="ptext">${esc(t.text)}</span>`;
}

/* ── 游戏内人物属性面板（矩形框，每人一框、每行一属性，随 STATE 实时刷新） ── */

const ATTACK_CHAR = { ranged: '远', melee: '近', magic: '法' };

function modifierLabel(m) {
  switch (m.op) {
    case 'burnImmune': return '免灼';
    case 'ghost': return '穿墙';
    case 'healBonus': return `治疗+${m.amount ?? ''}`;
    case 'lifesteal': return `吸血${Math.round((m.ratio ?? 0) * 100)}%`;
    case 'foresee': return '预见';
    case 'move': return `迅捷+${m.tiles ?? ''}`;
    case 'thorn': return `荆棘${m.value ?? ''}`;
    case 'reflect': return `反弹${m.value ?? ''}`;
    default:
      if (m.op === 'status' && m.status === 'magicVeil') return `法幕${m.value ?? ''}`;
      return String(m.op ?? '?');
  }
}

function heroDefOf(heroId) {
  return S.heroOptions.find((o) => o.id === heroId) ?? null;
}

function renderHeroPanels() {
  renderHpStrip();
}

/* ── 侧边血量竖排：实时显示场上全部角色血量 ── */

function renderHpStrip() {
  if (el.hpStrip === null) return;
  el.hpStrip.replaceChildren();
  for (const hero of S.heroes) {
    const row = document.createElement('div');
    row.className = 'hps-row' + (hero.playerId === S.me?.id ? ' mine' : '') + (!hero.alive ? ' dead' : '');
    if (S.turn !== null && S.turn.currentId === hero.playerId) row.classList.add('acting');
    row.style.setProperty('--tc', teamColor(hero.team));

    const head = document.createElement('div');
    head.className = 'hps-head';
    const dot = document.createElement('i');
    dot.className = 'hp-dot';
    const nm = document.createElement('span');
    nm.className = 'hps-name';
    nm.textContent = hero.name;
    const num = document.createElement('span');
    num.className = 'hps-num' + (hero.hp / hero.maxHp <= 0.25 ? ' low' : '');
    num.textContent = hero.alive ? `${hero.hp}/${hero.maxHp}` : '淘汰';
    head.append(dot, nm, num);
    row.append(head);

    const bar = document.createElement('div');
    bar.className = 'hps-bar';
    const fill = document.createElement('i');
    fill.className = 'hps-fill';
    const ratio = hero.alive ? Math.max(0, hero.hp / hero.maxHp) : 0;
    fill.style.width = `${Math.round(ratio * 100)}%`;
    fill.style.background = ratio > 0.5 ? 'var(--ok)' : ratio > 0.25 ? 'var(--gold)' : 'var(--danger)';
    bar.append(fill);
    row.append(bar);
    el.hpStrip.append(row);
  }
}

/* ── 顶栏「角色属性」弹出面板：显示所有角色及完整属性 ── */

function renderAttrsModal() {
  if (el.attrsBody === null) return;
  el.attrsBody.replaceChildren();

  const makeBox = (name, cls, team, lines, def) => {
    const box = document.createElement('div');
    box.className = 'hp-box' + cls;
    if (team !== null) box.style.setProperty('--tc', teamColor(team));
    const head = document.createElement('div');
    head.className = 'hp-head';
    const dot = document.createElement('i');
    dot.className = 'hp-dot';
    const nm = document.createElement('span');
    nm.textContent = name;
    head.append(dot, nm);
    box.append(head);
    for (const [text, extra] of lines) {
      const d = document.createElement('div');
      d.className = 'hp-line' + (extra ? ' ' + extra : '');
      d.textContent = text;
      box.append(d);
    }
    if (def !== null) {
      const wrap = document.createElement('div');
      wrap.innerHTML = heroAttrLinesHtml(def);
      box.append(wrap);
    }
    return box;
  };

  const boxes = [];
  if (S.heroes.length > 0) {
    // 对局中：在场角色（含当前 HP）
    for (const hero of S.heroes) {
      const def = heroDefOf(hero.heroId);
      boxes.push(makeBox(
        hero.name,
        (hero.playerId === S.me?.id ? ' mine' : '') + (!hero.alive ? ' dead' : ''),
        hero.team,
        [[`HP ${hero.hp}/${hero.maxHp}`, hero.hp / hero.maxHp <= 0.25 ? 'low' : '']],
        def,
      ));
    }
  } else {
    // 还没进对局：退回展示英雄图鉴（避免弹出「空白面板」）
    for (const def of S.heroOptions) {
      boxes.push(makeBox(def.name, '', null, [], def));
    }
  }

  if (boxes.length === 0) {
    const p = document.createElement('p');
    p.className = 'attrs-empty';
    p.textContent = '进入对局后，这里显示在场角色的完整属性。';
    el.attrsBody.append(p);
    return;
  }
  el.attrsBody.append(...boxes);
}

function openAttrs() {
  if (!el.attrsModal.hidden) return;
  renderAttrsModal();
  el.attrsModal.hidden = false;
  requestAnimationFrame(() => el.attrsModal.classList.add('show'));
}
function closeAttrs() {
  if (el.attrsModal.hidden) return;
  el.attrsModal.classList.remove('show');
  setTimeout(() => { el.attrsModal.hidden = true; }, 260);
}
el.btnAttrs.addEventListener('click', () => {
  if (el.attrsModal.hidden) openAttrs(); else closeAttrs();
});
$('btn-attrs-close').addEventListener('click', closeAttrs);
el.attrsModal.addEventListener('click', (e) => { if (e.target === el.attrsModal) closeAttrs(); });

function renderHand() {
  const mine = isMyTurn();
  const canDiscard = mine && !(S.turn?.discarded === true) && !(S.turn?.played === true);
  if (isSpectator()) {
    if (lastHandSig !== 'spectator') {
      lastHandSig = 'spectator';
      el.hand.innerHTML = '<div class="dim" style="padding:10px">观战中，无手牌</div>';
    }
    el.btnCancel.hidden = true;
    renderBattleHud();
    return;
  }
  // 签名不变就不重建 DOM（否则每次 TURN 广播都会重放入场动画 → 卡牌闪一下）
  const sig = [
    mine ? 1 : 0, canDiscard ? 1 : 0,
    S.hand.map((c) => [c.uid, c.label, c.text, c.playable ? 1 : 0, c.kind ?? '', c.subtype ?? ''].join('\u0001')).join('\u0002'),
  ].join('\u0003');
  if (sig !== lastHandSig) {
    lastHandSig = sig;
    el.hand.innerHTML = S.hand.map((c) => {
    const sel = S.selectedUid === c.uid;
    const cls = ['card'];
    if (sel) cls.push('selected');
    if (!mine || !c.playable) cls.push('disabled');
    const kl = cardKindLabel(c);
    const kindHtml = kl === '' ? '' : `<p class="ckind">${esc(kl)}</p>`;
    const disAttr = canDiscard ? '' : ' disabled';
    const disTitle = !mine ? '不是你的回合'
      : S.turn?.played ? '本回合已出过牌' : S.turn?.discarded ? '本回合只能弃 1 张' : '弃掉';
    return `
      <div class="${cls.join(' ')}" data-uid="${c.uid}">
        <p class="cname">${esc(c.label)}</p>
        ${kindHtml}
        <p class="ctext">${esc(c.text)}</p>
        ${c.playable ? '' : '<span class="cplay">被动·不可打出</span>'}
        <button class="ghost-btn btn-sm card-discard" data-discard="${c.uid}" title="${disTitle}"${disAttr}>弃</button>
      </div>`;
    }).join('');
  }
  applyHandSelection();
  el.btnCancel.hidden = S.targeting === null;
  renderBattleHud();
}

/** 只切换选中态（不重建 DOM），让 .card 的 transform 过渡生效。 */
function applyHandSelection() {
  for (const node of el.hand.querySelectorAll('.card')) {
    node.classList.toggle('selected', node.dataset.uid === S.selectedUid);
  }
}

el.hand.addEventListener('click', (e) => {
  const btn = e.target instanceof HTMLElement ? e.target.closest('[data-discard]') : null;
  if (btn !== null) {
    if (btn instanceof HTMLButtonElement && btn.disabled) return;
    const uid = btn.dataset.discard;
    if (!isMyTurn()) return toast('还没到你的回合', true);
    if (S.turn?.played === true) return toast('本回合已经出过牌，不能再弃牌', true);
    if (S.turn?.discarded === true) return toast('本回合只能弃 1 张牌', true);
    net.send(MSG.DISCARD_CARD, { uid });
    return;
  }
  const card = e.target instanceof HTMLElement ? e.target.closest('.card') : null;
  if (card === null) return;
  const c = S.hand.find((x) => x.uid === card.dataset.uid);
  if (c === undefined) return;
  if (!isMyTurn()) return toast('还没到你的回合', true);
  if (S.turn?.played === true) return toast('本回合已经出过牌，不能再出牌', true);
  if (!c.playable) return toast('被动牌不能打出，只能弃掉', true);

  // 第一下：选中（卡牌上移）；再点同一张才真正打出
  if (S.selectedUid !== c.uid) {
    S.selectedUid = c.uid;
    S.targeting = null;
    applyHandSelection();
    boardToast('再次点击打出');
    return;
  }

  if (c.ui === 'pickCard') {
    S.selectedUid = c.uid;
    openPickModal();
    return;
  }
  if (c.targeting === 'enemy' || c.targeting === 'tile') {
    S.selectedUid = c.uid;
    S.targeting = c.targeting;
    renderHand();
    boardToast(c.targeting === 'enemy' ? '点击目标英雄' : '点击地图格子');
  } else {
    S.selectedUid = null;
    applyHandSelection();
    flyCard(card);
    net.send(MSG.PLAY_CARD, { uid: c.uid });
  }
});

/* ── 「自选一张牌」面板（数据包 ui: pickCard）── */

function openPickModal() {
  if (el.pickBody === null) return;
  el.pickBody.replaceChildren();
  for (const c of S.cardList) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'pick-item';
    const nm = document.createElement('strong');
    nm.textContent = c.name;
    const tx = document.createElement('span');
    tx.textContent = c.text;
    item.append(nm, tx);
    item.addEventListener('click', () => {
      el.pickModal.hidden = true;
      net.send(MSG.PLAY_CARD, { uid: S.selectedUid, pick: c.id });
      S.selectedUid = null;
      renderHand();
      boardToast('');
    });
    el.pickBody.append(item);
  }
  el.pickModal.hidden = false;
}

$('btn-pick-close').addEventListener('click', () => {
  el.pickModal.hidden = true;
  S.selectedUid = null;
  renderHand();
});

el.btnCancel.addEventListener('click', () => {
  S.selectedUid = null;
  S.targeting = null;
  el.pickModal.hidden = true;
  renderHand();
  boardToast('');
});

el.btnEndTurn.addEventListener('click', () => {
  if (!isMyTurn()) return;
  net.send(MSG.END_TURN, {});
});

el.board.addEventListener('pointerdown', (e) => {
  const tile = pickTile(e.clientX, e.clientY);
  if (tile === null) return;
  if (S.targeting === 'tile') {
    net.send(MSG.PLAY_CARD, { uid: S.selectedUid, x: tile.x, y: tile.y });
    S.selectedUid = null; S.targeting = null; renderHand(); boardToast('');
    return;
  }
  if (S.targeting === 'enemy') {
    const target = S.heroes.find((h) => h.alive && h.x === tile.x && h.y === tile.y);
    if (target === undefined) return toast('那里没有目标', true);
    net.send(MSG.PLAY_CARD, { uid: S.selectedUid, targetId: target.playerId });
    S.selectedUid = null; S.targeting = null; renderHand(); boardToast('');
    return;
  }
  if (!isMyTurn()) return;
  const mo = S.turn?.moveOrigin ?? null;
  if (mo !== null && mo.x === tile.x && mo.y === tile.y) {
    net.send(MSG.UNDO_MOVE, {});
    return;
  }
  const ok = reachableTiles().some((t) => t.x === tile.x && t.y === tile.y);
  if (!ok) return toast('本回合只能移动到相邻的空地', true);
  net.send(MSG.MOVE, { x: tile.x, y: tile.y });
});

function flyCard(node) {
  node.classList.remove('fly');
  void node.offsetWidth;
  node.classList.add('fly');
}

// ── 聊天（对战屏 + 等候房共用同一份聊天状态） ──

const rchat = {
  list: $('rchat-list'),
  form: $('rchat-form'),
  input: $('rchat-input'),
  tabAll: $('rtab-all'), tabTeam: $('rtab-team'), tabLog: $('rtab-log'),
};

function currentChannel() {
  return S.chatTab === 'team' ? 'team' : 'all';
}

/** 把当前频道的消息渲染到指定列表元素（两个聊天面板都调用）。 */
function renderChatInto(listEl) {
  if (listEl === null) return;
  const lines = S.chatTab === 'team' ? S.chatTeam : S.chatTab === 'log' ? S.logs : S.chatAll;
  listEl.innerHTML = lines.map((l) => {
    if (S.chatTab === 'log') {
      return `<div class="chat-msg log"><span class="who">[战报]</span>${esc(l.text)}</div>`;
    }
    return `<div class="chat-msg ${l.channel === 'team' ? 'team' : ''}"><span class="who">${esc(l.name)}</span>${esc(l.text)}</div>`;
  }).join('') || '<div class="chat-msg log">还没有消息</div>';
  listEl.scrollTop = listEl.scrollHeight;
}

function renderChat() {
  renderChatInto(el.chatList);
  renderChatInto(rchat.list);
}

function setChatTab(key) {
  S.chatTab = key;
  for (const t of [el.tabAll, el.tabTeam, el.tabLog, rchat.tabAll, rchat.tabTeam, rchat.tabLog]) t.classList.remove('active');
  const active = key === 'all' ? [el.tabAll, rchat.tabAll]
    : key === 'team' ? [el.tabTeam, rchat.tabTeam]
    : [el.tabLog, rchat.tabLog];
  active.forEach((t) => t.classList.add('active'));
  el.chatInput.disabled = key === 'log';
  rchat.input.disabled = key === 'log';
  renderChat();
}

for (const [tab, key] of [[el.tabAll, 'all'], [el.tabTeam, 'team'], [el.tabLog, 'log']]) {
  tab.addEventListener('click', () => setChatTab(key));
}
for (const [tab, key] of [[rchat.tabAll, 'all'], [rchat.tabTeam, 'team'], [rchat.tabLog, 'log']]) {
  tab.addEventListener('click', () => setChatTab(key));
}

function sendChat() {
  const text = el.chatInput.value.trim() || rchat.input.value.trim();
  if (text === '') return;
  net.send(MSG.CHAT, { channel: currentChannel(), text });
  el.chatInput.value = '';
  rchat.input.value = '';
}

el.chatForm.addEventListener('submit', (e) => { e.preventDefault(); sendChat(); });
rchat.form.addEventListener('submit', (e) => { e.preventDefault(); sendChat(); });

el.btnChat.addEventListener('click', () => el.chatPanel.classList.toggle('open'));

// ── 结算 ──

function renderResult() {
  const r = S.result;
  if (r === null) return;
  if (isSpectator()) {
    el.resultTitle.textContent = '观战结束';
    el.resultTitle.style.color = 'var(--dim)';
    el.resultStandings.innerHTML = r.standings.map((s) => `
      <div class="standing-row ${r.winners.includes(s.team) ? 'win' : ''}">
        <span class="place">${s.place}</span>
        <span class="team-dot" style="background:${teamColor(s.team)}"></span>
        <span>${esc(s.name)}（${esc(s.heroName)}）</span>
        <span class="kills">击杀 ${s.kills}</span>
      </div>`).join('');
    el.btnRestart.hidden = true;
    return;
  }
  const me = S.room?.players.find((p) => p.id === S.me?.id);
  const myTeam = me?.team ?? -1;
  const win = r.winners.includes(myTeam);
  if (typeof r.reason === 'string' && r.reason !== '') {
    // 房主退出 / 掉线超时等非正常结束
    el.resultTitle.textContent = r.reason;
    el.resultTitle.style.color = 'var(--danger)';
  } else {
    el.resultTitle.textContent = r.winners.length === 0 ? '平局！' : win ? '胜利！' : '惜败…';
    el.resultTitle.style.color = r.winners.length === 0 ? 'var(--gold)' : win ? 'var(--ok)' : 'var(--danger)';
  }
  el.resultStandings.innerHTML = r.standings.map((s) => `
    <div class="standing-row ${r.winners.includes(s.team) ? 'win' : ''}">
      <span class="place">${s.place}</span>
      <span class="team-dot" style="background:${teamColor(s.team)}"></span>
      <span>${esc(s.name)}（${esc(s.heroName)}）</span>
      <span class="kills">击杀 ${s.kills}</span>
    </div>`).join('');
  el.btnRestart.hidden = !(S.room !== null && S.room.hostId === S.me?.id);
}

el.btnRestart.addEventListener('click', () => { net.send(MSG.RESTART_MATCH, {}); resetMatch(); });
el.btnResultLobby.addEventListener('click', () => { net.send(MSG.LEAVE_ROOM, {}); S.room = null; resetMatch(); show('lobby'); });

// ── 定时器 ──

setInterval(() => {
  const now = Date.now() + serverOffset;
  const left = S.endsAt - now;
  const text = left > 0 ? fmtTime(left) : '';
  if (el.screens.battle.classList.contains('active')) {
    el.battleTimer.textContent = text;
  } else if (el.screens.hero.classList.contains('active')) {
    el.heroTimer.textContent = text ? `剩余 ${text}` : '';
  } else if (el.screens.spawn.classList.contains('active')) {
    el.spawnTimer.textContent = text ? `剩余 ${text}` : '';
  }
  // 心跳（客户端→服务端保活，5s 一次足够；服务端另有 15s 心跳会要求本端回 PONG）
  if (now - lastClientPing >= 5000) { net.send(MSG.PING, { ts: Date.now() }); lastClientPing = now; }
  // 横屏提示（仅对战屏 + 竖屏窄屏）
  const portrait = window.matchMedia('(orientation: portrait)').matches;
  el.rotateHint.hidden = !(el.screens.battle.classList.contains('active') && portrait && window.innerWidth < 860);
}, 500);

// ── 个人设置（渲染方式 / 昵称，存 localStorage） ──

const RENDER_KEY = 'alsf_render';
const NAME_KEY = 'alsf_name';

function currentRenderMode() {
  try { return localStorage.getItem(RENDER_KEY) === 'webgl' ? 'webgl' : 'canvas'; } catch { return 'canvas'; }
}

function renderNote() {
  if (el.renderNote === null) return;
  el.renderNote.textContent = currentRenderMode() === 'webgl'
    ? 'WebGL 为实验项：当前版本仍用 Canvas2D 绘制（画面一致），后续接入后自动切换。'
    : 'Canvas2D：通用兼容，手机/桌面均可用（默认）。';
}

function openSettings() {
  if (el.settingsModal === null) return;
  if (el.optRender !== null) el.optRender.value = currentRenderMode();
  if (el.optName !== null) {
    try { el.optName.value = localStorage.getItem(NAME_KEY) || (S.me?.name ?? ''); } catch { /* */ }
  }
  renderNote();
  el.settingsModal.hidden = false;
}
function closeSettings() {
  if (el.settingsModal === null) return;
  el.settingsModal.hidden = true;
}

if (el.btnSettings !== null) el.btnSettings.addEventListener('click', openSettings);
if ($('btn-settings-close') !== null) $('btn-settings-close').addEventListener('click', closeSettings);
if (el.settingsModal !== null) el.settingsModal.addEventListener('click', (e) => { if (e.target === el.settingsModal) closeSettings(); });
if (el.optRender !== null) el.optRender.addEventListener('change', () => {
  try { localStorage.setItem(RENDER_KEY, el.optRender.value === 'webgl' ? 'webgl' : 'canvas'); } catch { /* */ }
  renderNote();
});
if (el.optName !== null) el.optName.addEventListener('input', () => {
  try { localStorage.setItem(NAME_KEY, el.optName.value.trim()); } catch { /* */ }
});
if (el.btnSettingsReset !== null) el.btnSettingsReset.addEventListener('click', () => {
  try { localStorage.removeItem(RENDER_KEY); localStorage.removeItem(NAME_KEY); } catch { /* */ }
  if (el.optRender !== null) el.optRender.value = 'canvas';
  if (el.optName !== null) el.optName.value = '';
  renderNote();
  toast('已清除本地设置');
});

// ── 自动进入：取账号名号直接连，不再弹名号设定界面 ──
// 根站(/alsf/ 经网关)一定有 /api/me；直连游戏端口时没有，回退到本地缓存或访客名。
(async () => {
  let name = '';
  try {
    const res = await fetch('/api/me', { credentials: 'same-origin' });
    if (res.ok) {
      const d = await res.json().catch(() => null);
      if (d && typeof d.user === 'string' && d.user) name = d.user;
    }
  } catch { /* 独立部署：无根站接口 */ }
  if (!name) {
    try { name = localStorage.getItem('alsf_name') || ''; } catch { /* */ }
  }
  if (!name) name = '星海' + Math.floor(100 + Math.random() * 900);
  try { localStorage.setItem('alsf_name', name); } catch { /* */ }
  el.joinStatus.textContent = '正在进入游戏大厅…';
  net.connect(name); // _open 事件触发后会自动 hello()
})();

// E2E 钩子
window.__alsf = {
  S, net, MSG, send: (t, d) => net.send(t, d),
  show, toast, myHero, isMyTurn,
};
