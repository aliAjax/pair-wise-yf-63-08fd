import { defineStore } from 'pinia';
import type { AgeBand, Arm, AuditEntry, Participant, PendingRandomization, RandomizeInput, StratumRecord } from '~/types/trial';
import { readLocal, writeLocal } from '~/composables/useLocalPersist';

// 中央记录：分层区组余量、受试者登记与安全审计共用同一份状态
const STORAGE_KEY = 'trial-randomization-v2';
const DEFAULT_PLAN = 6; // 每层计划名额
const BLOCK_SIZE = 4; // 区组大小（每个区组内 A/B 配平）
const SITES = ['上海中心', '广州中心', '新加坡中心'] as const;
const AGE_BANDS: AgeBand[] = ['18-44', '45-64', '65+'];

export const stratumKey = (site: string, ageBand: AgeBand) => `${site}·${ageBand}`;
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function buildStrata(): Record<string, StratumRecord> {
  const strata: Record<string, StratumRecord> = {};
  for (const site of SITES) {
    for (const ageBand of AGE_BANDS) {
      const key = stratumKey(site, ageBand);
      strata[key] = { key, site, ageBand, planned: DEFAULT_PLAN, blockSize: BLOCK_SIZE, status: 'open' };
    }
  }
  return strata;
}

const seed: { participants: Participant[]; audits: AuditEntry[]; pending: PendingRandomization[]; strata: Record<string, StratumRecord> } = {
  participants: [
    { id: 'p-1', participantNo: 'S01-001', identityKey: 'demo-a', site: '上海中心', ageBand: '45-64', status: 'randomized', sequence: 1001, arm: 'A', blockNo: 1 },
    { id: 'p-2', participantNo: 'S01-002', identityKey: 'demo-b', site: '上海中心', ageBand: '45-64', status: 'randomized', sequence: 1002, arm: 'B', blockNo: 1 }
  ],
  audits: [
    { id: 'a-1', at: new Date(Date.now() - 3600_000).toISOString(), actor: '系统', action: 'randomized', detail: 'S01-002 完成分层随机，中央随机号 1002，治疗组 B', participantNo: 'S01-002' }
  ],
  pending: [],
  strata: buildStrata()
};

function enrolledIn(participants: Participant[], site: string, ageBand: AgeBand): Participant[] {
  return participants.filter((item) => item.site === site && item.ageBand === ageBand);
}

// 区组配平：A/B 孰少孰先，保持组间均衡
function balanceArm(enrolled: Participant[]): Arm {
  const a = enrolled.filter((item) => item.arm === 'A').length;
  const b = enrolled.filter((item) => item.arm === 'B').length;
  return a <= b ? 'A' : 'B';
}

export const useTrialStore = defineStore('trial', {
  state: () => readLocal(STORAGE_KEY, seed),
  getters: {
    bySite: (state) => state.participants.reduce<Record<string, number>>((result, participant) => {
      result[participant.site] = (result[participant.site] ?? 0) + 1;
      return result;
    }, {}),
    pendingCount: (state) => state.pending.filter((item) => item.status === 'pending').length,
    stratumList: (state) => Object.values(state.strata)
  },
  actions: {
    persist() {
      writeLocal(STORAGE_KEY, {
        participants: this.participants,
        audits: this.audits,
        pending: this.pending,
        strata: this.strata
      });
    },
    addAudit(action: AuditEntry['action'], detail: string, actor: string, participantNo?: string) {
      this.audits.unshift({ id: crypto.randomUUID(), at: new Date().toISOString(), actor, action, detail, participantNo });
      this.persist();
    },
    stratumOf(site: string, ageBand: AgeBand): StratumRecord {
      const key = stratumKey(site, ageBand);
      if (!this.strata[key]) {
        this.strata[key] = { key, site, ageBand, planned: DEFAULT_PLAN, blockSize: BLOCK_SIZE, status: 'open' };
      }
      return this.strata[key];
    },
    remainingOf(site: string, ageBand: AgeBand): number {
      const stratum = this.stratumOf(site, ageBand);
      return Math.max(0, stratum.planned - enrolledIn(this.participants, site, ageBand).length);
    },
    async randomize(input: RandomizeInput, offline = false): Promise<{ ok: boolean; message: string; arm?: Arm }> {
      const duplicate = this.participants.some((item) => item.identityKey === input.identityKey || item.participantNo === input.participantNo);
      if (duplicate) {
        const remaining = this.remainingOf(input.site, input.ageBand);
        this.addAudit('duplicate-blocked', `拒绝重复入组：${input.participantNo}（该层剩余名额 ${remaining}）`, input.actor, input.participantNo);
        return { ok: false, message: `身份标识或受试者编号已存在，已阻止重复入组（该层剩余名额 ${remaining}）` };
      }
      if (offline) {
        const queued: PendingRandomization = { id: crypto.randomUUID(), payload: input, createdAt: new Date().toISOString(), status: 'pending' };
        this.pending.unshift(queued);
        this.addAudit('pending-queued', `离线提交进入待处理队列：${input.participantNo}`, input.actor, input.participantNo);
        return { ok: true, message: '已加入待提交队列，联网后确认入库' };
      }
      return this.allocate(input);
    },
    // 原子放号：容量校验与登记在同一事务内完成，并发提交不会超排
    async allocate(input: RandomizeInput): Promise<{ ok: boolean; message: string; arm?: Arm }> {
      const stratum = this.stratumOf(input.site, input.ageBand);
      if (stratum.status === 'recalculating') {
        return { ok: false, message: `该层（${stratum.site} · ${stratum.ageBand}）正在重算区组配平，期间暂停放号，请稍后重试` };
      }
      await delay(350); // 模拟中央记录写入的网络延迟（含行锁）
      if (this.stratumOf(input.site, input.ageBand).status === 'recalculating') {
        return { ok: false, message: `该层（${stratum.site} · ${stratum.ageBand}）正在重算区组配平，期间暂停放号，请稍后重试` };
      }
      const enrolled = enrolledIn(this.participants, input.site, input.ageBand);
      const remaining = stratum.planned - enrolled.length;
      if (remaining <= 0) {
        this.addAudit('allocation-blocked', `容量不足拒绝放号：${input.participantNo}，${stratum.site} · ${stratum.ageBand} 计划 ${stratum.planned} 名已满，剩余 0 个名额`, input.actor, input.participantNo);
        return { ok: false, message: `该层（${stratum.site} · ${stratum.ageBand}）计划 ${stratum.planned} 名，已入组 ${enrolled.length} 名，剩余名额 0，本次提交已拒绝` };
      }
      const arm = balanceArm(enrolled);
      const sequence = 1000 + this.participants.length + 1;
      const blockNo = Math.floor(enrolled.length / BLOCK_SIZE) + 1;
      const participant: Participant = { id: crypto.randomUUID(), ...input, status: 'randomized', sequence, arm, blockNo };
      this.participants.unshift(participant);
      this.addAudit('randomized', `${input.participantNo} 完成分层随机，中央随机号 ${sequence}，区组 ${blockNo}，治疗组 ${arm}（发药编号 DY-${sequence}）`, input.actor, input.participantNo);
      return { ok: true, message: `随机成功，中央序列号 ${sequence}（发药编号 DY-${sequence}），该层剩余名额 ${remaining - 1}`, arm };
    },
    async commitPending(id: string, actor: string): Promise<{ ok: boolean; message: string } | undefined> {
      const pending = this.pending.find((item) => item.id === id && item.status === 'pending');
      if (!pending) return undefined;
      const result = await this.allocate(pending.payload);
      if (!result.ok) {
        return { ok: false, message: `待提交记录未入库：${result.message}` };
      }
      pending.status = 'committed';
      this.addAudit('pending-committed', `待提交记录已确认入库：${pending.payload.participantNo}`, actor, pending.payload.participantNo);
      this.persist();
      return { ok: true, message: `待提交记录已确认入库：${pending.payload.participantNo}` };
    },
    // 状态变化后重算所在区组配平；重算期间该层暂停放号
    async recalculateStratum(site: string, ageBand: AgeBand, actor: string) {
      const stratum = this.stratumOf(site, ageBand);
      if (stratum.status === 'recalculating') return;
      stratum.status = 'recalculating';
      this.addAudit('stratum-recalculated', `该层（${site} · ${ageBand}）开始重算区组组别配平，重算期间暂停放号`, actor);
      await delay(1200);
      const enrolled = enrolledIn(this.participants, site, ageBand);
      const armA = enrolled.filter((item) => item.arm === 'A').length;
      const armB = enrolled.filter((item) => item.arm === 'B').length;
      const blockBalance = new Map<number, { A: number; B: number }>();
      enrolled.forEach((item) => {
        const blockNo = item.blockNo ?? 1;
        const bucket = blockBalance.get(blockNo) ?? { A: 0, B: 0 };
        if (item.arm === 'A') bucket.A += 1;
        else if (item.arm === 'B') bucket.B += 1;
        blockBalance.set(blockNo, bucket);
      });
      const unbalanced = [...blockBalance.values()].some((bucket) => bucket.A !== bucket.B);
      stratum.status = 'open';
      this.addAudit('stratum-recalculated', `该层（${site} · ${ageBand}）重算完成：已入组 ${enrolled.length} 名（A ${armA} / B ${armB}），${unbalanced ? '存在区组配平偏差，已记录' : '各区组配平一致'}，恢复放号`, actor);
      this.persist();
    },
    async emergencyUnblind(id: string, reason: string, actor: string) {
      const participant = this.participants.find((item) => item.id === id);
      if (!participant || !reason.trim()) return;
      participant.status = 'unblinded';
      participant.unblindedAt = new Date().toISOString();
      this.addAudit('unblinded', `紧急揭盲：${reason}；分配组别 ${participant.arm ?? '未知'}`, actor, participant.participantNo);
      await this.recalculateStratum(participant.site, participant.ageBand, actor);
    }
  }
});
