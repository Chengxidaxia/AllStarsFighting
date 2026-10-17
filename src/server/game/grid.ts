/**
 * 方格地图模型：地形、出生点、回血点、4 邻移动、BFS 距离、Bresenham 视线。
 *
 * 坐标约定：x 向右、y 向下；`tiles[y][x]`。
 * 规则（见设计文档 §9）：
 *  - 墙 `wall` 不可进入、**阻挡远程视线**
 *  - 水 `water` 按正常地块（可走、无额外消耗）
 *  - 出生点 `spawn` / 回血点 `heal` 均可通行；回血点与出生点相互独立
 */

export type Terrain = 'plain' | 'water' | 'wall' | 'spawn' | 'heal';

export interface Pos {
  x: number;
  y: number;
}

export interface MapDef {
  id: string;
  name: string;
  width: number;
  height: number;
  /** 行主序：[y][x] */
  tiles: Terrain[][];
  spawns: Pos[];
  heals: Pos[];
}

export function posKey(p: Pos): string {
  return `${p.x},${p.y}`;
}

export function samePos(a: Pos, b: Pos): boolean {
  return a.x === b.x && a.y === b.y;
}

/** 曼哈顿距离（4 邻步数下界）。 */
export function manhattan(a: Pos, b: Pos): number {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

/** 切比雪夫距离（8 邻步数）。 */
export function chebyshev(a: Pos, b: Pos): number {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

export class Grid {
  readonly width: number;
  readonly height: number;

  constructor(readonly map: MapDef) {
    this.width = map.width;
    this.height = map.height;
  }

  inBounds(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.width && y < this.height;
  }

  terrainAt(x: number, y: number): Terrain {
    if (!this.inBounds(x, y)) return 'wall';
    const row = this.map.tiles[y];
    if (row === undefined) return 'wall';
    return row[x] ?? 'wall';
  }

  /** 是否可以站人（非墙、非越界）。水的通行性由调用方决定（当前按正常地块）。 */
  passable(x: number, y: number): boolean {
    const t = this.terrainAt(x, y);
    return t !== 'wall';
  }

  isHeal(x: number, y: number): boolean {
    return this.terrainAt(x, y) === 'heal';
  }

  /** 4 邻（上下左右），已过滤越界。 */
  neighbors4(p: Pos): Pos[] {
    const out: Pos[] = [];
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
  losClear(a: Pos, b: Pos, isBlocked?: (x: number, y: number) => boolean): boolean {
    const blocked = isBlocked ?? ((x: number, y: number) => this.terrainAt(x, y) === 'wall');
    let x0 = a.x;
    let y0 = a.y;
    const x1 = b.x;
    const y1 = b.y;
    const dx = Math.abs(x1 - x0);
    const dy = Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let err = dx - dy;
    // 不检查起点，也不检查终点
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
      if (x0 === x1 && y0 === y1) return true; // 到达终点前未遇障碍
      if (blocked(x0, y0)) return false;
    }
    return true;
  }

  /**
   * 从 from 出发、按 4 邻 BFS 求「可通行且未被其他角色占据」的格子的步数。
   * @param budget 最大步数（含）；返回 Map<"x,y", dist>
   */
  reachable(from: Pos, budget: number, occupied: ReadonlySet<string>): Map<string, number> {
    const result = new Map<string, number>();
    if (budget <= 0) return result;
    const seen = new Set<string>([posKey(from)]);
    let frontier: Pos[] = [from];
    for (let step = 1; step <= budget; step++) {
      const next: Pos[] = [];
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
  distance(from: Pos, to: Pos, occupied?: ReadonlySet<string>): number {
    if (samePos(from, to)) return 0;
    const seen = new Set<string>([posKey(from)]);
    let frontier: Pos[] = [from];
    let step = 0;
    while (frontier.length > 0 && step < 512) {
      step++;
      const next: Pos[] = [];
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
}
