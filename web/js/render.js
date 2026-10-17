/*
 * Canvas 棋盘渲染（游戏内）：地形 / 放置物 / 英雄 / 高亮 / 动画。
 * 相机：整图适配容器（地图不大，无需平移）。
 */

import { S, teamColor, terrainChar, isMyTurn, myHero, reachableTiles } from './game.js';

const TILE = 44;         // 逻辑像素
let canvas = null;
let ctx = null;
let dpr = 1;

const TERRAIN_FILL = {
  '.': '#ffffff',
  '~': '#cfe4f7',
  '#': '#7c8794',
  S: '#eaf1fe',
  H: '#e7f8ef',
};

/** 在方形内绘制用户名：**强制单行**，字号自适应缩到不溢出；白字黑描边保证可读。 */
function drawHeroName(ctx, name, cx, cy, fontSize, maxWidth) {
  const text = String(name ?? '').trim() || '?';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  let fs = fontSize;
  ctx.font = `bold ${Math.round(fs)}px sans-serif`;
  let w = ctx.measureText(text).width;
  while (fs > 8 && w > maxWidth) {
    fs -= 1;
    ctx.font = `bold ${Math.round(fs)}px sans-serif`;
    w = ctx.measureText(text).width;
  }
  ctx.lineWidth = Math.max(2, fs * 0.18);
  ctx.strokeStyle = 'rgba(0,0,0,.6)';
  ctx.fillStyle = '#fff';
  ctx.strokeText(text, cx, cy);
  ctx.fillText(text, cx, cy);
}

export function initBoard(el) {
  canvas = el;
  ctx = canvas.getContext('2d');
  resize();
  window.addEventListener('resize', resize);
  requestAnimationFrame(frame);
}

function resize() {
  if (canvas === null) return;
  dpr = Math.min(2, window.devicePixelRatio || 1);
  const r = canvas.getBoundingClientRect();
  canvas.width = Math.max(1, Math.round(r.width * dpr));
  canvas.height = Math.max(1, Math.round(r.height * dpr));
}

/** 画布坐标 → 格子坐标。 */
export function pickTile(clientX, clientY) {
  if (canvas === null || S.map === null) return null;
  const r = canvas.getBoundingClientRect();
  const cw = S.map.width * TILE;
  const ch = S.map.height * TILE;
  const scale = Math.min(r.width / cw, r.height / ch);
  const ox = (r.width - cw * scale) / 2;
  const oy = (r.height - ch * scale) / 2;
  const x = (clientX - r.left - ox) / scale;
  const y = (clientY - r.top - oy) / scale;
  const tx = Math.floor(x / TILE);
  const ty = Math.floor(y / TILE);
  if (tx < 0 || ty < 0 || tx >= S.map.width || ty >= S.map.height) return null;
  return { x: tx, y: ty };
}

/** 逻辑坐标 → 画布像素。 */
function toPx(x, y) {
  if (canvas === null || S.map === null) return { px: 0, py: 0, scale: 1 };
  const r = canvas.getBoundingClientRect();
  const cw = S.map.width * TILE;
  const ch = S.map.height * TILE;
  const scale = Math.min(r.width / cw, r.height / ch);
  const ox = (r.width - cw * scale) / 2;
  const oy = (r.height - ch * scale) / 2;
  return { px: ox + x * TILE * scale, py: oy + y * TILE * scale, scale };
}

function frame(now) {
  if (ctx !== null && canvas !== null) {
    const w = canvas.width;
    const h = canvas.height;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w / dpr, h / dpr);
    draw(now);
  }
  requestAnimationFrame(frame);
}

function draw(now) {
  if (ctx === null || canvas === null) return;
  const W = canvas.width / dpr;
  const H = canvas.height / dpr;
  ctx.fillStyle = '#eef1f5';
  ctx.fillRect(0, 0, W, H);
  if (S.map === null) {
    ctx.fillStyle = 'rgba(31,35,41,.45)';
    ctx.font = '14px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('地图载入中…', W / 2, H / 2);
    return;
  }

  const { scale } = toPx(0, 0);
  const ts = TILE * scale;
  const reach = isMyTurn() ? reachableTiles() : [];

  // ── 格子 ──
  for (let y = 0; y < S.map.height; y++) {
    for (let x = 0; x < S.map.width; x++) {
      const t = terrainChar(S.map, x, y);
      const { px, py } = toPx(x, y);
      ctx.fillStyle = TERRAIN_FILL[t] ?? TERRAIN_FILL['.'];
      ctx.fillRect(px, py, ts - 1, ts - 1);
      if (t === '~') { // 水：连通波纹（跨格连接，两端对齐）
        ctx.strokeStyle = 'rgba(37,99,235,.5)';
        ctx.lineWidth = 1.2;
        const amp = Math.max(2, ts * 0.06);
        for (let row = 0; row < 2; row++) {
          const baseY = py + ts * (0.36 + row * 0.26);
          ctx.beginPath();
          for (let i = 0; i <= 12; i++) {
            const fx = px + (ts * i) / 12;
            const fy = baseY + Math.sin((i / 12) * Math.PI * 2) * amp;
            if (i === 0) ctx.moveTo(fx, fy); else ctx.lineTo(fx, fy);
          }
          ctx.stroke();
        }
      }
      if (t === '#') { // 墙：砖块纹理（跨格连接）
        ctx.fillStyle = 'rgba(0,0,0,.20)';
        ctx.fillRect(px, py + ts - 3, ts, 3); // 底阴影
        ctx.fillStyle = 'rgba(255,255,255,.18)';
        ctx.fillRect(px, py, ts, 2); // 顶高光
        ctx.strokeStyle = 'rgba(0,0,0,.30)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(px, py + ts / 2); ctx.lineTo(px + ts, py + ts / 2); // 横缝（整行连通）
        ctx.moveTo(px + ts / 2, py); ctx.lineTo(px + ts / 2, py + ts / 2);
        ctx.moveTo(px + ts / 4, py + ts / 2); ctx.lineTo(px + ts / 4, py + ts);
        ctx.moveTo(px + ts * 0.75, py + ts / 2); ctx.lineTo(px + ts * 0.75, py + ts);
        ctx.stroke();
      }
      if (t === 'H') { // 回血点
        ctx.strokeStyle = '#16a34a';
        ctx.lineWidth = 2;
        const c = ts * 0.5;
        ctx.beginPath();
        ctx.moveTo(px + c, py + c - 7); ctx.lineTo(px + c, py + c + 7);
        ctx.moveTo(px + c - 7, py + c); ctx.lineTo(px + c + 7, py + c);
        ctx.stroke();
      }
      if (t === 'S') {
        ctx.strokeStyle = 'rgba(47,109,240,.55)';
        ctx.setLineDash([3, 3]);
        ctx.strokeRect(px + 2.5, py + 2.5, ts - 6, ts - 6);
        ctx.setLineDash([]);
      }
    }
  }

  // ── 可移动高亮 ──
  for (const c of reach) {
    const { px, py } = toPx(c.x, c.y);
    ctx.fillStyle = 'rgba(47,109,240,.16)';
    ctx.fillRect(px + 1, py + 1, ts - 3, ts - 3);
    ctx.strokeStyle = 'rgba(47,109,240,.65)';
    ctx.setLineDash([4, 3]);
    ctx.strokeRect(px + 2, py + 2, ts - 5, ts - 5);
    ctx.setLineDash([]);
  }

  // ── 放置物：小圆角方块，占满格子（与英雄方块同一视觉语言）──
  for (const o of S.placed) {
    const { px, py } = toPx(o.x, o.y);
    const r = Math.max(3, ts * 0.08);
    ctx.beginPath();
    ctx.roundRect(px + 2, py + 2, ts - 4, ts - 4, r);
    if (o.kind === 'rock') {
      ctx.fillStyle = '#6b7280';
      ctx.fill();
    } else if (o.kind === 'altar') {
      ctx.strokeStyle = '#16a34a';
      ctx.lineWidth = 2;
      ctx.stroke();
    } else {
      ctx.fillStyle = 'rgba(220,38,38,.85)';
      ctx.fill();
    }
  }

  // ── 英雄 ──
  for (const hero of S.heroes) {
    if (!hero.alive && !S.deaths.some((d) => d.heroId === hero.playerId && now - d.t0 < 900)) continue;
    // 移动补间
    let hx = hero.x, hy = hero.y;
    const mv = S.moves.find((m) => m.heroId === hero.playerId);
    if (mv !== undefined) {
      const k = Math.min(1, (now - mv.t0) / mv.dur);
      const e = 1 - Math.pow(1 - k, 3);
      hx = mv.from.x + (mv.to.x - mv.from.x) * e;
      hy = mv.from.y + (mv.to.y - mv.from.y) * e;
      if (k >= 1) S.moves = S.moves.filter((m) => m !== mv);
    }
    // 受击抖动
    const sh = S.shakes.find((s) => s.heroId === hero.playerId);
    let ox = 0;
    if (sh !== undefined) {
      const k = (now - sh.t0) / 320;
      if (k >= 1) S.shakes = S.shakes.filter((s) => s !== sh);
      else ox = Math.sin(k * 30) * 5 * (1 - k);
    }
    const { px, py } = toPx(hx, hy);
    const cx = px + ts / 2 + ox;
    const cy = py + ts / 2;
    const dying = !hero.alive;
    const alpha = dying ? Math.max(0, 1 - (now - (S.deaths.find((d) => d.heroId === hero.playerId)?.t0 ?? now)) / 900) : 1;
    ctx.save();
    ctx.globalAlpha = alpha;

    // 身体：占满一格的不圆角方形（队色）
    const sx = px, sy = py, sw = ts, shgt = ts;
    ctx.fillStyle = teamColor(hero.team);
    ctx.fillRect(sx, sy, sw, shgt);
    ctx.lineWidth = hero.playerId === S.me?.id ? 3 : 1.5;
    ctx.strokeStyle = hero.playerId === S.me?.id ? '#d97706' : 'rgba(31,35,41,.35)';
    ctx.strokeRect(sx + 0.75, sy + 0.75, sw - 1.5, shgt - 1.5);

    // 第 1 行：血条（顶在方形内）
    const bh = Math.max(4, Math.round(ts * 0.12));
    const bw = ts - 8, bx = sx + 4, by = sy + 4;
    ctx.fillStyle = 'rgba(31,35,41,.45)';
    ctx.fillRect(bx, by, bw, bh);
    const ratio = Math.max(0, hero.hp / hero.maxHp);
    ctx.fillStyle = ratio > 0.5 ? '#16a34a' : ratio > 0.25 ? '#d97706' : '#dc2626';
    ctx.fillRect(bx, by, bw * ratio, bh);

    // 第 2 行起：用户名（方形内，最多 2 行）
    drawHeroName(ctx, hero.name, sx + sw / 2, sy + by + bh + (shgt - (by + bh)) / 2,
      Math.max(9, Math.round(ts * 0.22)), bw);

    // 状态徽标（右下角）
    if (hero.statuses.length > 0) {
      ctx.font = `${Math.max(8, Math.round(ts * 0.17))}px sans-serif`;
      ctx.strokeStyle = 'rgba(0,0,0,.5)';
      ctx.lineWidth = 2;
      ctx.textAlign = 'right';
      ctx.textBaseline = 'bottom';
      const labels = hero.statuses.map((s) => {
        switch (s.kind) {
          case 'stun': return '定';
          case 'burn': return '灼';
          case 'poison': return '毒';
          case 'shield': return '盾';
          case 'silence': return '默';
          case 'disarm': return '缴';
          default: return '?';
        }
      });
      const txt = labels.join('');
      ctx.strokeText(txt, sx + sw - 3, sy + shgt - 3);
      ctx.fillStyle = '#fff';
      ctx.fillText(txt, sx + sw - 3, sy + shgt - 3);
    }
    ctx.restore();
  }

  // ── 选中目标提示 ──
  if (S.targeting === 'enemy' || S.targeting === 'tile') {
    const { px, py } = toPx(0, 0);
    ctx.strokeStyle = 'rgba(217,119,6,.8)';
    ctx.setLineDash([6, 4]);
    ctx.lineWidth = 2;
    ctx.strokeRect(px + 1, py + 1, S.map.width * ts - 2, S.map.height * ts - 2);
    ctx.setLineDash([]);
  }

  // ── 飘字 ──
  for (const f of S.floats) {
    const k = (now - f.t0) / 900;
    if (k >= 1) { S.floats = S.floats.filter((x) => x !== f); continue; }
    const { px, py } = toPx(f.x, f.y);
    ctx.save();
    ctx.globalAlpha = 1 - k;
    ctx.fillStyle = f.color;
    ctx.font = `bold ${Math.round(ts * 0.3)}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillText(f.text, px + ts / 2, py + ts / 2 - k * 26);
    ctx.restore();
  }

  // ── 回合脉冲 ──
  if (S.turnPulse > 0) {
    const k = (now - S.turnPulse) / 600;
    if (k >= 1) S.turnPulse = 0;
    else {
      const me = myHero();
      if (me !== null) {
        const { px, py } = toPx(me.x, me.y);
        ctx.save();
        ctx.globalAlpha = 1 - k;
        ctx.strokeStyle = '#d97706';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(px + ts / 2, py + ts / 2, ts * (0.4 + k * 0.9), 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }
    }
  }
}

/** 选出生点屏的地图预览（只画地形 + 出生点）。 */
export function drawSpawnPreview(canvasEl, map, taken, hover) {
  const c = canvasEl;
  const g = c.getContext('2d');
  const d = Math.min(2, window.devicePixelRatio || 1);
  const rect = c.getBoundingClientRect();
  c.width = Math.max(1, Math.round(rect.width * d));
  c.height = Math.max(1, Math.round(rect.height * d));
  g.setTransform(d, 0, 0, d, 0, 0);
  const W = rect.width, H = rect.height;
  g.fillStyle = '#171029';
  g.fillRect(0, 0, W, H);
  if (map === null) return;
  const ts = Math.min(W / map.width, H / map.height);
  const ox = (W - map.width * ts) / 2;
  const oy = (H - map.height * ts) / 2;
  for (let y = 0; y < map.height; y++) {
    for (let x = 0; x < map.width; x++) {
      const t = map.tiles[y]?.[x] ?? '.';
      g.fillStyle = TERRAIN_FILL[t] ?? TERRAIN_FILL['.'];
      g.fillRect(ox + x * ts, oy + y * ts, ts - 1, ts - 1);
      if (t === 'S') {
        const idx = map.spawns.findIndex((s) => s.x === x && s.y === y);
        const isTaken = taken.includes(idx);
        g.strokeStyle = isTaken ? 'rgba(220,38,38,.8)' : 'rgba(22,163,74,.9)';
        g.lineWidth = 2;
        g.strokeRect(ox + x * ts + 3, oy + y * ts + 3, ts - 7, ts - 7);
        g.fillStyle = isTaken ? 'rgba(220,38,38,.9)' : 'rgba(22,163,74,.95)';
        g.font = `bold ${Math.round(ts * 0.4)}px sans-serif`;
        g.textAlign = 'center';
        g.textBaseline = 'middle';
        g.fillText(isTaken ? '×' : String(idx + 1), ox + x * ts + ts / 2, oy + y * ts + ts / 2);
      }
      if (t === 'H') {
        g.strokeStyle = '#16a34a';
        g.lineWidth = 2;
        g.beginPath();
        g.moveTo(ox + x * ts + ts / 2, oy + y * ts + ts / 2 - 6);
        g.lineTo(ox + x * ts + ts / 2, oy + y * ts + ts / 2 + 6);
        g.moveTo(ox + x * ts + ts / 2 - 6, oy + y * ts + ts / 2);
        g.lineTo(ox + x * ts + ts / 2 + 6, oy + y * ts + ts / 2);
        g.stroke();
      }
    }
  }
  if (hover !== null && hover !== undefined) {
    g.strokeStyle = '#d97706';
    g.lineWidth = 3;
    g.strokeRect(ox + hover.x * ts + 2, oy + hover.y * ts + 2, ts - 4, ts - 4);
  }
}

export function pickSpawnTile(canvasEl, map, clientX, clientY) {
  if (map === null) return null;
  const rect = canvasEl.getBoundingClientRect();
  const ts = Math.min(rect.width / map.width, rect.height / map.height);
  const ox = (rect.width - map.width * ts) / 2;
  const oy = (rect.height - map.height * ts) / 2;
  const x = Math.floor((clientX - rect.left - ox) / ts);
  const y = Math.floor((clientY - rect.top - oy) / ts);
  if (x < 0 || y < 0 || x >= map.width || y >= map.height) return null;
  return { x, y };
}
