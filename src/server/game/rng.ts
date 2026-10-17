/**
 * 可播种伪随机数发生器（确定性）。
 *
 * 用途：共享牌堆洗牌、阶段兜底随机分配。
 * 服务端持有种子；**种子不下发给进行中的客户端**（防预测抽牌），
 * 对局结束后可随战绩落库供复盘。
 *
 * 算法：mulberry32 —— 32 位状态、速度快、分布足够好，纯整数运算
 * （不依赖 Math.random，跨进程/跨平台可复现）。
 */

export interface Rng {
  /** [0, 1) 浮点。 */
  next(): number;
  /** [0, n) 整数。 */
  int(n: number): number;
  /** 原地洗牌（Fisher–Yates），返回同一数组。 */
  shuffle<T>(list: T[]): T[];
}

export function createRng(seed: number): Rng {
  // 保证状态为 32 位无符号
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int(n: number): number {
      if (n <= 0) return 0;
      return Math.floor(next() * n) % n;
    },
    shuffle<T>(list: T[]): T[] {
      for (let i = list.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        const a = list[i]!;
        list[i] = list[j]!;
        list[j] = a;
      }
      return list;
    },
  };
}

/** 生成一个随机种子（仅开局调用，之后全走 {@link createRng}）。 */
export function randomSeed(): number {
  return (Math.floor(Math.random() * 0xffffffff) ^ Date.now()) >>> 0;
}
