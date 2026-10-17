/**
 * 英雄定义类型（内容不再硬编码——全部来自数据包 packages/*.zip）。
 *
 * 英雄属性（用户定案）：
 *  - HP / 攻击类型 + 伤害（远 ranged = 中心连线无障碍；近 melee = 周围 8 格单体；法 magic = 不限条件）
 *  - 特殊属性（数据包 hooks：onTurnStart / onDamaged / onDeath，JavaScript 沙箱执行）
 *  - 技能1 / 技能2 / 大招（触发牌打出即激活对应技能；行为用 steps(fn 调用) 或 code(JS) 定义）
 */

import type { AttackType, CardDef, EffectDef } from '../protocol/types.js';

export interface SkillDef {
  name: string;
  targeting: CardDef['targeting'];
  effects: EffectDef[];
  text: string;
}

/** 特殊属性：展示文本 + 行为钩子（JavaScript 沙箱，可调 api.*）。 */
export interface HeroSpecial {
  text: string;
  /** 每个自己回合开始时执行（含水里回血 / HP 低触发假死等）。 */
  onTurnStart?: string;
  /** 受到伤害时执行；修改 ctx.amount（=0 免除）或 ctx.cancel()。 */
  onDamaged?: string;
  /** 被淘汰时执行；调用 api.setHp(self, n) 且 n>0 可免死。 */
  onDeath?: string;
}

export interface HeroDef {
  id: string;
  name: string;
  title: string;
  maxHp: number;
  attack: { type: AttackType; damage: number };
  /** 常驻特殊属性（op 修正，如穿墙/吸血）。 */
  modifiers: CardDef['effects'];
  /** 数据包特殊属性（钩子式）。 */
  special?: HeroSpecial;
  skill1: SkillDef;
  skill2: SkillDef;
  ult: SkillDef;
  text: string;
}
