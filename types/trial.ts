export type TrialRole = 'investigator' | 'pharmacist' | 'monitor';
export type AgeBand = '18-44' | '45-64' | '65+';
export type Arm = 'A' | 'B';
export type StratumStatus = 'open' | 'recalculating';
export type AuditAction =
  | 'randomized'
  | 'unblinded'
  | 'pending-queued'
  | 'pending-committed'
  | 'duplicate-blocked'
  | 'allocation-blocked'
  | 'stratum-recalculated';

export interface Participant {
  id: string;
  participantNo: string;
  identityKey: string;
  site: string;
  ageBand: AgeBand;
  status: 'randomized' | 'unblinded';
  sequence: number;
  arm?: Arm;
  blockNo?: number;
  unblindedAt?: string;
}

export interface StratumRecord {
  key: string;
  site: string;
  ageBand: AgeBand;
  planned: number;
  blockSize: number;
  status: StratumStatus;
}

export interface AuditEntry {
  id: string;
  at: string;
  actor: string;
  action: AuditAction;
  detail: string;
  participantNo?: string;
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
