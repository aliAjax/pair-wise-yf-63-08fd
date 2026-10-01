import type { Arm } from '~/types/trial';

export const stratumKey = (site: string, ageBand: string): string => `${site}|${ageBand}`;

export function shuffle<T>(list: T[]): T[] {
  const copy = [...list];
  for (let index = copy.length - 1; index > 0; index--) {
    const target = Math.floor(Math.random() * (index + 1));
    [copy[index], copy[target]] = [copy[target]!, copy[index]!];
  }
  return copy;
}

/**
 * 依据已发组别重建剩余名额的区组随机计划：
 * 当前未满区组先按 A/B 配平补齐，后续区组重新随机生成，总长度不超过剩余名额。
 * 已入组受试者的组别不受影响。
 */
export function buildArmPlan(assigned: Arm[], capacity: number, blockSize: number): Arm[] {
  const remaining = capacity - assigned.length;
  if (remaining <= 0) return [];
  const half = blockSize / 2;
  const plan: Arm[] = [];
  const inBlock = assigned.length % blockSize;
  if (inBlock > 0) {
    const current = assigned.slice(assigned.length - inBlock);
    const countA = current.filter((arm) => arm === 'A').length;
    const countB = current.length - countA;
    const fill: Arm[] = [
      ...Array<Arm>(Math.max(0, half - countA)).fill('A'),
      ...Array<Arm>(Math.max(0, half - countB)).fill('B')
    ];
    // 已发组别超出半区时，用较少的一侧补齐本区组剩余槽位
    while (fill.length < blockSize - inBlock) fill.push(countA <= countB ? 'A' : 'B');
    plan.push(...shuffle(fill).slice(0, blockSize - inBlock));
  }
  while (plan.length < remaining) {
    // 末尾不足一个整区组时，按剩余槽位均衡生成
    const slots = Math.min(blockSize, remaining - plan.length);
    const countA = Math.ceil(slots / 2);
    const block: Arm[] = [...Array<Arm>(countA).fill('A'), ...Array<Arm>(slots - countA).fill('B')];
    plan.push(...shuffle(block));
  }
  return plan;
}
