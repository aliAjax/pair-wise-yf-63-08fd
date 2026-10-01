import { defineStore } from 'pinia';
import type { Arm, AuditEntry, Participant, PendingRandomization, RandomizeInput, StratumLedger, TrialState } from '~/types/trial';
import { readLocal, writeLocal } from '~/composables/useLocalPersist';
import { buildArmPlan, stratumKey } from '~/utils/blockRandom';

const STORAGE_KEY = 'trial-randomization-v1';
const BLOCK_SIZE = 4;
const DEFAULT_CAPACITY = 6;
const REBALANCE_DELAY = 1500;
const SITES = ['上海中心', '广州中心', '新加坡中心'];
const AGE_BANDS: Participant['ageBand'][] = ['18-44', '45-64', '65+'];

export interface StratumRow extends StratumLedger {
  issued: number;
  remaining: number;
  blockIndex: number;
  blockA: number;
  blockB: number;
}

interface RandomizeResult {
  ok: boolean;
  message: string;
  arm?: Arm;
}

function assignedArms(participants: Participant[], key: string): Arm[] {
  return participants
    .filter((item) => stratumKey(item.site, item.ageBand) === key)
    .sort((a, b) => a.sequence - b.sequence)
    .map((item) => item.arm ?? 'A');
}

function buildStrata(participants: Participant[]): Record<string, StratumLedger> {
  const strata: Record<string, StratumLedger> = {};
  for (const site of SITES) {
    for (const ageBand of AGE_BANDS) {
      const key = stratumKey(site, ageBand);
      const assigned = assignedArms(participants, key);
      // 演示计划：上海中心 45-64 已入 2 例、计划 4 例，便于观察余量递减与超额拒绝
      const capacity = Math.max(key === stratumKey('上海中心', '45-64') ? 4 : DEFAULT_CAPACITY, assigned.length);
      strata[key] = { key, site, ageBand, capacity, blockSize: BLOCK_SIZE, armPlan: buildArmPlan(assigned, capacity, BLOCK_SIZE), locked: false };
    }
  }
  return strata;
}

/** 兼容旧版持久化数据：补齐分层台账，已入组受试者照旧保留 */
function migrate(state: Partial<TrialState>): TrialState {
  const participants = state.participants ?? [];
  const strata = state.strata && Object.keys(state.strata).length > 0 ? state.strata : buildStrata(participants);
  for (const ledger of Object.values(strata)) {
    // 页面刷新视为重算中断：恢复放号，并按中央登记重建区组计划
    ledger.locked = false;
    ledger.blockSize = ledger.blockSize || BLOCK_SIZE;
    const assigned = assignedArms(participants, ledger.key);
    if (ledger.capacity < assigned.length) ledger.capacity = assigned.length;
    if (!Array.isArray(ledger.armPlan) || ledger.armPlan.length !== ledger.capacity - assigned.length) {
      ledger.armPlan = buildArmPlan(assigned, ledger.capacity, ledger.blockSize);
    }
  }
  const maxSequence = participants.reduce((max, item) => Math.max(max, item.sequence), 1000);
  return {
    participants,
    audits: state.audits ?? [],
    pending: state.pending ?? [],
    strata,
    nextSequence: typeof state.nextSequence === 'number' && state.nextSequence > maxSequence ? state.nextSequence : maxSequence + 1
  };
}

const seed: TrialState = migrate({
  participants: [
    { id: 'p-1', participantNo: 'S01-001', identityKey: 'demo-a', site: '上海中心', ageBand: '45-64', status: 'randomized', sequence: 1001, arm: 'A' },
    { id: 'p-2', participantNo: 'S01-002', identityKey: 'demo-b', site: '上海中心', ageBand: '45-64', status: 'randomized', sequence: 1002, arm: 'B' }
  ],
  audits: [
    { id: 'a-1', at: new Date(Date.now() - 3600_000).toISOString(), actor: '系统', action: 'randomized', detail: 'S01-002 完成分层随机，中央随机号 1002', participantNo: 'S01-002' }
  ],
  pending: []
});

export const useTrialStore = defineStore('trial', {
  state: (): TrialState => migrate(readLocal(STORAGE_KEY, seed)),
  getters: {
    bySite: (state) => state.participants.reduce<Record<string, number>>((result, participant) => {
      result[participant.site] = (result[participant.site] ?? 0) + 1;
      return result;
    }, {}),
    pendingCount: (state) => state.pending.filter((item) => item.status === 'pending').length,
    stratumRows(state): StratumRow[] {
      return Object.values(state.strata)
        .map((ledger) => {
          const members = state.participants
            .filter((item) => stratumKey(item.site, item.ageBand) === ledger.key)
            .sort((a, b) => a.sequence - b.sequence);
          const inBlock = members.length % ledger.blockSize;
          const currentBlock = members.slice(members.length - inBlock);
          return {
            ...ledger,
            issued: members.length,
            remaining: Math.max(0, ledger.capacity - members.length),
            blockIndex: Math.floor(members.length / ledger.blockSize) + 1,
            blockA: currentBlock.filter((item) => item.arm === 'A').length,
            blockB: currentBlock.filter((item) => item.arm === 'B').length
          };
        })
        .sort((a, b) => a.site.localeCompare(b.site, 'zh') || a.ageBand.localeCompare(b.ageBand));
    },
    totalRemaining(): number {
      return this.stratumRows.reduce((sum, row) => sum + row.remaining, 0);
    }
  },
  actions: {
    persist() {
      writeLocal(STORAGE_KEY, {
        participants: this.participants,
        audits: this.audits,
        pending: this.pending,
        strata: this.strata,
        nextSequence: this.nextSequence
      });
    },
    addAudit(action: AuditEntry['action'], detail: string, actor: string, participantNo?: string, sensitive?: { reason?: string; arm?: Arm }) {
      this.audits.unshift({
        id: crypto.randomUUID(),
        at: new Date().toISOString(),
        actor,
        action,
        detail,
        participantNo,
        sensitiveReason: sensitive?.reason,
        sensitiveArm: sensitive?.arm
      });
      this.persist();
    },
    ensureStratum(site: string, ageBand: Participant['ageBand'], actor: string): StratumLedger {
      const key = stratumKey(site, ageBand);
      let ledger = this.strata[key];
      if (!ledger) {
        ledger = { key, site, ageBand, capacity: DEFAULT_CAPACITY, blockSize: BLOCK_SIZE, armPlan: buildArmPlan([], DEFAULT_CAPACITY, BLOCK_SIZE), locked: false };
        this.strata[key] = ledger;
        this.addAudit('stratum-created', `新分层 ${site}/${ageBand} 登记中央台账，计划容量 ${DEFAULT_CAPACITY}、区组长度 ${BLOCK_SIZE}`, actor);
      }
      return ledger;
    },
    randomize(input: RandomizeInput, offline = false): RandomizeResult {
      if (this.participants.some((item) => item.identityKey === input.identityKey || item.participantNo === input.participantNo)) {
        this.addAudit('duplicate-blocked', `拒绝重复入组：${input.participantNo}`, input.actor, input.participantNo);
        return { ok: false, message: '身份标识或受试者编号已存在，已阻止重复入组' };
      }
      if (offline) {
        const queued: PendingRandomization = { id: crypto.randomUUID(), payload: input, createdAt: new Date().toISOString(), status: 'pending' };
        this.pending.unshift(queued);
        this.addAudit('pending-queued', `离线提交进入待处理队列：${input.participantNo}`, input.actor, input.participantNo);
        return { ok: true, message: '已加入待提交队列，联网后确认入库' };
      }
      return this.commitRandomization(input);
    },
    commitRandomization(input: RandomizeInput): RandomizeResult {
      const ledger = this.ensureStratum(input.site, input.ageBand, input.actor);
      const issued = this.participants.filter((item) => stratumKey(item.site, item.ageBand) === ledger.key).length;
      const remaining = Math.max(0, ledger.capacity - issued);
      // 余量检查与发号在同一同步动作内完成：并发提交逐笔原子校验，不会穿透容量
      if (ledger.locked) {
        this.addAudit('locked-rejected', `拒绝放号：${input.site}/${input.ageBand} 正在重算组别配平（剩余名额 ${remaining}）`, input.actor, input.participantNo);
        return { ok: false, message: `该分层正在重算组别配平，暂停放号（剩余名额 ${remaining}），请稍后重试` };
      }
      if (remaining <= 0) {
        this.addAudit('capacity-rejected', `拒绝放号：${input.site}/${input.ageBand} 计划容量 ${ledger.capacity} 已发完（剩余名额 0）`, input.actor, input.participantNo);
        return { ok: false, message: `该分层名额已满：计划容量 ${ledger.capacity}，剩余名额 0，入组被拒绝` };
      }
      const arm = ledger.armPlan.shift() ?? (issued % 2 === 0 ? 'A' : 'B');
      const sequence = this.nextSequence++;
      const participant: Participant = { id: crypto.randomUUID(), ...input, status: 'randomized', sequence, arm };
      this.participants.unshift(participant);
      this.addAudit('randomized', `${input.participantNo} 完成分层区组随机，中央随机号 ${sequence}，本层剩余名额 ${remaining - 1}`, input.actor, input.participantNo);
      return { ok: true, message: `随机成功，中央随机号 ${sequence}，本层剩余名额 ${remaining - 1}`, arm };
    },
    commitPending(id: string, actor: string): RandomizeResult {
      const pending = this.pending.find((item) => item.id === id && item.status === 'pending');
      if (!pending) return { ok: false, message: '记录不存在或已入库' };
      const result = this.commitRandomization(pending.payload);
      if (!result.ok) return result;
      pending.status = 'committed';
      this.addAudit('pending-committed', `待提交记录已确认入库：${pending.payload.participantNo}`, actor, pending.payload.participantNo);
      this.persist();
      return result;
    },
    emergencyUnblind(id: string, reason: string, actor: string) {
      const participant = this.participants.find((item) => item.id === id);
      if (!participant || participant.status !== 'randomized' || !reason.trim()) return;
      participant.status = 'unblinded';
      participant.unblindedAt = new Date().toISOString();
      this.addAudit('unblinded', `紧急揭盲已登记：${participant.participantNo}（原因与治疗组按角色边界保管）`, actor, participant.participantNo, { reason: reason.trim(), arm: participant.arm });
      // 状态变化触发所在区组配平重算，重算期间本层暂停放号
      void this.rebalanceStratum(stratumKey(participant.site, participant.ageBand), actor, `受试者 ${participant.participantNo} 状态变更为已揭盲`);
    },
    async rebalanceStratum(key: string, actor: string, trigger: string) {
      const ledger = this.strata[key];
      if (!ledger || ledger.locked) return;
      ledger.locked = true;
      this.addAudit('rebalance-started', `${ledger.site}/${ledger.ageBand} ${trigger}，开始重算区组配平，本层暂停放号`, actor);
      await new Promise((resolve) => setTimeout(resolve, REBALANCE_DELAY));
      const assigned = assignedArms(this.participants, key);
      ledger.armPlan = buildArmPlan(assigned, ledger.capacity, ledger.blockSize);
      ledger.locked = false;
      const armA = assigned.filter((arm) => arm === 'A').length;
      this.addAudit('rebalance-finished', `${ledger.site}/${ledger.ageBand} 配平重算完成：已发 A组 ${armA} 例、B组 ${assigned.length - armA} 例，剩余名额 ${Math.max(0, ledger.capacity - assigned.length)}，恢复放号`, actor);
    },
    adjustCapacity(key: string, capacity: number, actor: string): RandomizeResult {
      const ledger = this.strata[key];
      if (!ledger) return { ok: false, message: '分层不存在' };
      if (ledger.locked) return { ok: false, message: '该分层正在重算配平，请稍后再调整容量' };
      const assigned = assignedArms(this.participants, key);
      if (!Number.isInteger(capacity) || capacity < assigned.length) {
        return { ok: false, message: `容量不能低于已发号数 ${assigned.length}（已入组的照旧保留）` };
      }
      ledger.capacity = capacity;
      ledger.armPlan = buildArmPlan(assigned, capacity, ledger.blockSize);
      this.addAudit('capacity-adjusted', `${ledger.site}/${ledger.ageBand} 计划容量调整为 ${capacity}，剩余名额 ${capacity - assigned.length}`, actor);
      return { ok: true, message: `容量已调整为 ${capacity}，剩余名额 ${capacity - assigned.length}` };
    }
  }
});
