/**
 * 战斗与效果算子（服务端权威）。
 *
 * 伤害管线：
 *   基础伤害 → 攻方修正（pierce 降效守方减伤 / splash / lifesteal）
 *            → 守方修正（shield 先扣 → magicVeil 法减 → HP）
 *            → 死亡淘汰 → 反伤（thorn 近战 / reflect 全额）
 *
 * 修正来源三类，全部合并：
 *   1. 英雄常驻 modifiers（HeroDef.modifiers）
 *   2. 手牌中的**被动道具牌**（在手中即生效）
 *   3. 英雄身上的 status（thorn / magicVeil / reflect，turns=-1 表示常驻）
 */

import type { EffectDef, StatusKind } from '../protocol/types.js';
import type { CardDef } from '../protocol/types.js';
import type { HeroDef } from './heroes.js';

export interface StatusRt {
  kind: StatusKind;
  /** 剩余回合；-1 = 常驻（被动牌/英雄修正）。 */
  turns: number;
  value: number;
}

/** 合并后的攻/守修正快照。 */
export interface Modifiers {
  pierce: number;      // 0..1 无视守方减伤
  splash: number;      // 0..1 溅射到目标相邻格
  lifesteal: number;   // 0..1 伤害转治疗
  ghost: boolean;      // 穿墙
  healBonus: number;   // 受治疗加成
  burnImmune: boolean;
  thorn: number;       // 受近战反伤
  magicVeil: number;   // 法术减伤
  reflect: number;     // 受击反弹
  moveBonus: number;   // 额外移动格
  foresee: boolean;    // 回合结束额外抽牌
}

export function emptyModifiers(): Modifiers {
  return {
    pierce: 0, splash: 0, lifesteal: 0, ghost: false, healBonus: 0,
    burnImmune: false, thorn: 0, magicVeil: 0, reflect: 0, moveBonus: 0, foresee: false,
  };
}

function applyEffect(m: Modifiers, e: EffectDef): void {
  switch (e.op) {
    case 'pierce': m.pierce = Math.max(m.pierce, e.ratio); break;
    case 'splash': m.splash = Math.max(m.splash, e.ratio); break;
    case 'lifesteal': m.lifesteal = Math.max(m.lifesteal, e.ratio); break;
    case 'ghost': m.ghost = true; break;
    case 'healBonus': m.healBonus += e.amount; break;
    case 'burnImmune': m.burnImmune = true; break;
    case 'move': m.moveBonus += e.tiles; break;
    case 'foresee': m.foresee = true; break;
    case 'status':
      if (e.status === 'thorn') m.thorn = Math.max(m.thorn, e.value ?? 1);
      else if (e.status === 'magicVeil') m.magicVeil = Math.max(m.magicVeil, e.value ?? 1);
      else if (e.status === 'reflect') m.reflect = Math.max(m.reflect, e.value ?? 1);
      break;
    default: break;
  }
}

/**
 * 收集一名角色的修正。
 * @param heroDef   英雄定义（常驻 modifiers）
 * @param statuses  运行时 status 列表
 * @param heldDefs  手中被动道具牌的定义（在手中即生效）
 */
export function collectModifiers(
  heroDef: HeroDef | undefined,
  statuses: readonly StatusRt[],
  heldDefs: readonly CardDef[],
): Modifiers {
  const m = emptyModifiers();
  if (heroDef) for (const e of heroDef.modifiers) applyEffect(m, e);
  for (const s of statuses) {
    if (s.turns === 0) continue;
    if (s.kind === 'thorn') m.thorn = Math.max(m.thorn, s.value);
    else if (s.kind === 'magicVeil') m.magicVeil = Math.max(m.magicVeil, s.value);
    else if (s.kind === 'reflect') m.reflect = Math.max(m.reflect, s.value);
  }
  for (const d of heldDefs) {
    if (d.subtype !== 'passive') continue;
    for (const e of d.effects) applyEffect(m, e);
  }
  return m;
}

export interface DamageResult {
  /** 实际扣到 HP 的量（不含护盾吸收）。 */
  hpLoss: number;
  /** 护盾吸收的量。 */
  absorbed: number;
  /** 是否致死。 */
  lethal: boolean;
  /** 吸血回复量（由调用方应用到攻方）。 */
  healed: number;
}

export interface DamageOpts {
  attackerMods: Modifiers;
  defenderMods: Modifiers;
  defenderShield: number;
  kind: 'physical' | 'magic';
  /** 是否近战（荆棘反伤判定）。 */
  melee: boolean;
}

/**
 * 计算并应用一次伤害到「HP/护盾」上（不改状态，纯函数便于测试）。
 * @returns 扣血结果；调用方负责写回 hp/shield 与致死处理。
 */
export function resolveDamage(amount: number, o: DamageOpts): DamageResult {
  let dmg = Math.max(0, amount);
  // 法术减伤（被 pierce 降效）
  if (o.kind === 'magic' && o.defenderMods.magicVeil > 0) {
    const eff = o.defenderMods.magicVeil * (1 - o.attackerMods.pierce);
    dmg = Math.max(0, dmg - eff);
  }
  // 护盾先扣（pierce 不影响护盾，护盾是硬减伤）
  const absorbed = Math.min(o.defenderShield, dmg);
  dmg -= absorbed;
  const hpLoss = dmg;
  const healed = Math.floor(amount * o.attackerMods.lifesteal);
  return { hpLoss, absorbed, lethal: false, healed };
}

/** 荆棘反伤：近战物理命中时，守方对攻方造成 thorn 点伤害。 */
export function thornDamage(defenderMods: Modifiers, melee: boolean): number {
  if (!melee) return 0;
  return defenderMods.thorn;
}

/** 反弹镜：受击后反弹 reflect 点（不分攻击类型）。 */
export function reflectDamage(defenderMods: Modifiers): number {
  return defenderMods.reflect;
}

/** 治疗量计算（含 healBonus）。 */
export function healAmount(base: number, mods: Modifiers): number {
  return base + mods.healBonus;
}
