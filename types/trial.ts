export type TrialRole = 'investigator' | 'pharmacist' | 'monitor';
export type Arm = 'A' | 'B';
export type AgeBand = '18-44' | '45-64' | '65+';
export type AuditAction =
  | 'randomized'
  | 'unblinded'
  | 'pending-queued'
  | 'pending-committed'
  | 'duplicate-blocked'
  | 'capacity-rejected'
  | 'locked-rejected'
  | 'rebalance-started'
  | 'rebalance-finished'
  | 'capacity-adjusted'
  | 'stratum-created';

export interface Participant {
  id: string;
  participantNo: string;
  identityKey: string;
  site: string;
  ageBand: AgeBand;
  status: 'randomized' | 'unblinded';
  sequence: number;
  arm?: Arm;
  unblindedAt?: string;
}

export interface AuditEntry {
  id: string;
  at: string;
  actor: string;
  action: AuditAction;
  detail: string;
  participantNo?: string;
  /** 揭盲原因，按角色边界展示（药品管理员不可见） */
  sensitiveReason?: string;
  /** 治疗组，仅监察员等授权角色可见 */
  sensitiveArm?: Arm;
}

export interface PendingRandomization {
  id: string;
  payload: RandomizeInput;
  createdAt: string;
  status: 'pending' | 'committed';
}

export interface RandomizeInput {
  participantNo: string;
  identityKey: string;
  site: string;
  ageBand: AgeBand;
  actor: string;
}

/** 分层区组台账：容量、区组计划与放号状态的中央记录 */
export interface StratumLedger {
  key: string;
  site: string;
  ageBand: AgeBand;
  /** 计划容量（本层最多可发号数） */
  capacity: number;
  blockSize: number;
  /** 后续放号的区组随机计划（已发号的不在内） */
  armPlan: Arm[];
  /** 配平重算期间锁定，本层暂停放号 */
  locked: boolean;
}

/** 中央记录：余量、登记与审计同源的一份持久化状态 */
export interface TrialState {
  participants: Participant[];
  audits: AuditEntry[];
  pending: PendingRandomization[];
  strata: Record<string, StratumLedger>;
  nextSequence: number;
}
