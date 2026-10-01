<script setup lang="ts">
import { computed, ref } from 'vue';
import { storeToRefs } from 'pinia';
import { toTypedSchema } from '@vee-validate/zod';
import { useForm } from 'vee-validate';
import { z } from 'zod';
import { ElMessage, ElMessageBox } from 'element-plus';
import { useTrialStore } from '~/stores/trial';
import type { Arm, AuditEntry, TrialRole } from '~/types/trial';

const { t } = useI18n();
const trial = useTrialStore();
const { participants, audits, pending } = storeToRefs(trial);
const role = ref<TrialRole>('investigator');
const offline = ref(false);
const schema = toTypedSchema(z.object({
  participantNo: z.string().min(4, '请输入至少4位受试者编号'),
  identityKey: z.string().min(4, '请输入身份核验标识'),
  site: z.string().min(2, '请选择研究中心'),
  ageBand: z.enum(['18-44', '45-64', '65+']),
  actor: z.string().min(2, '请输入操作人')
}));
const { defineField, handleSubmit, errors, resetForm } = useForm({ validationSchema: schema, initialValues: { participantNo: '', identityKey: '', site: '上海中心', ageBand: '45-64', actor: '研究者张宁' } });
const [participantNo] = defineField('participantNo');
const [identityKey] = defineField('identityKey');
const [site] = defineField('site');
const [ageBand] = defineField('ageBand');
const [actor] = defineField('actor');

const strata = computed(() => trial.stratumRows);
const selectedStratum = computed(() => strata.value.find((row) => row.site === site.value && row.ageBand === ageBand.value));

const roleLabels: Record<TrialRole, string> = { investigator: '研究者', pharmacist: '药品管理员', monitor: '监察员' };

// 角色边界：药品管理员只见发药编号；治疗组仅监察员在已揭盲后可见
const visibleArm = (arm?: Arm, status?: string) => {
  if (role.value === 'monitor' && status === 'unblinded') return arm ?? '未知';
  return '已隐藏';
};
const visibleParticipantNo = (no: string) => (role.value === 'pharmacist' ? '***' : no);

const actionLabels: Record<AuditEntry['action'], string> = {
  randomized: '随机入组',
  unblinded: '紧急揭盲',
  'pending-queued': '离线入队',
  'pending-committed': '确认入库',
  'duplicate-blocked': '重复拦截',
  'capacity-rejected': '容量不足拒绝',
  'locked-rejected': '重算暂停拒绝',
  'rebalance-started': '配平重算开始',
  'rebalance-finished': '配平重算完成',
  'capacity-adjusted': '容量调整',
  'stratum-created': '分层建档'
};

const timelineType = (action: AuditEntry['action']) => {
  if (action === 'unblinded' || action === 'capacity-rejected') return 'danger';
  if (action === 'duplicate-blocked' || action === 'locked-rejected' || action === 'rebalance-started') return 'warning';
  if (action === 'rebalance-finished') return 'success';
  return 'primary';
};

const auditLines = (entry: AuditEntry) => {
  const masked = role.value === 'pharmacist' && entry.participantNo ? entry.detail.split(entry.participantNo).join('***') : entry.detail;
  const lines = [masked];
  if (entry.action === 'unblinded') {
    if (role.value === 'pharmacist') {
      lines.push('揭盲原因与治疗组已按角色边界隐藏');
    } else {
      if (entry.sensitiveReason) lines.push(`揭盲原因：${entry.sensitiveReason}`);
      lines.push(role.value === 'monitor' && entry.sensitiveArm ? `治疗组：${entry.sensitiveArm} 组` : '治疗组：按角色边界隐藏');
    }
  }
  return lines;
};

const submit = handleSubmit((values) => {
  const result = trial.randomize(values, offline.value);
  if (!result.ok) {
    ElMessage.error(result.message);
    return;
  }
  ElMessage.success(result.message);
  resetForm({ values: { participantNo: '', identityKey: '', site: values.site, ageBand: values.ageBand, actor: values.actor } });
});

// 模拟多名中心管理员同时提交同一分层：中央台账逐笔原子校验，超额即拒并报剩余名额
const simulateConcurrent = () => {
  const stamp = Date.now().toString(36).toUpperCase();
  const admins = ['中心管理员·王', '中心管理员·李', '中心管理员·陈'];
  const results = admins.map((name, index) => trial.randomize({
    participantNo: `C${stamp}-${index + 1}`,
    identityKey: `concurrent-${stamp}-${index + 1}`,
    site: site.value ?? '上海中心',
    ageBand: ageBand.value ?? '45-64',
    actor: name
  }));
  const okCount = results.filter((item) => item.ok).length;
  const rejected = results.length - okCount;
  const summary = `并发提交 ${results.length} 笔：成功 ${okCount} 笔、拒绝 ${rejected} 笔`;
  if (rejected > 0) {
    ElMessage.warning(`${summary}；${results.find((item) => !item.ok)?.message ?? ''}`);
  } else {
    ElMessage.success(summary);
  }
};

const confirmPending = (id: string) => {
  const result = trial.commitPending(id, actor.value ?? '未知操作人');
  if (result.ok) ElMessage.success(result.message);
  else ElMessage.error(result.message);
};

const changeCapacity = (key: string, value?: number) => {
  if (typeof value !== 'number') return;
  const result = trial.adjustCapacity(key, value, actor.value ?? '监察员');
  if (result.ok) ElMessage.success(result.message);
  else ElMessage.error(result.message);
};

const unblind = async (id: string, participantNumber: string) => {
  try {
    const { value } = await ElMessageBox.prompt(`为 ${participantNumber} 填写紧急揭盲原因`, '紧急揭盲', { inputType: 'textarea', inputValidator: (value) => Boolean(value?.trim()) || '揭盲原因不能为空', confirmButtonText: '确认并审计' });
    trial.emergencyUnblind(id, value, actor.value ?? '研究者');
    ElMessage.warning('已揭盲，审计记录已追加，所在区组开始重算配平并暂停放号');
  } catch {}
};

const counts = computed(() => ({
  total: participants.value.length,
  remaining: trial.totalRemaining,
  unblinded: participants.value.filter((item) => item.status === 'unblinded').length,
  sites: Object.keys(trial.bySite).length,
  pending: trial.pendingCount
}));
</script>

<template>
  <main class="page">
    <header class="hero">
      <div><el-tag type="success">GCP 本地原型</el-tag><h1>{{ t('title') }}</h1><p>{{ t('subtitle') }}</p></div>
      <el-segmented v-model="role" :options="[{ label: '研究者', value: 'investigator' }, { label: '药品管理员', value: 'pharmacist' }, { label: '监察员', value: 'monitor' }]" />
    </header>

    <section style="display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:16px;margin-bottom:20px">
      <div class="stat"><span>已随机入组</span><b>{{ counts.total }}</b></div>
      <div class="stat"><span>剩余总名额</span><b>{{ counts.remaining }}</b></div>
      <div class="stat"><span>紧急揭盲</span><b>{{ counts.unblinded }}</b></div>
      <div class="stat"><span>参与中心</span><b>{{ counts.sites }}</b></div>
      <div class="stat"><span>待提交</span><b>{{ counts.pending }}</b></div>
    </section>

    <el-card shadow="never" style="margin-bottom:20px">
      <template #header>
        <div style="display:flex;justify-content:space-between;align-items:center">
          <b>{{ t('strata') }}</b>
          <el-tag type="success">余量 · 登记 · 审计同源</el-tag>
        </div>
      </template>
      <el-table :data="strata" max-height="300">
        <el-table-column prop="site" label="中心" min-width="100" />
        <el-table-column prop="ageBand" label="年龄层" width="80" />
        <el-table-column label="计划容量" width="150">
          <template #default="{ row }">
            <el-input-number v-if="role === 'monitor'" :model-value="row.capacity" :min="row.issued" :max="60" size="small" style="width:110px" @change="changeCapacity(row.key, $event)" />
            <span v-else>{{ row.capacity }}</span>
          </template>
        </el-table-column>
        <el-table-column prop="issued" label="已发号" width="80" />
        <el-table-column label="剩余名额" width="90">
          <template #default="{ row }"><el-tag :type="row.remaining === 0 ? 'danger' : 'success'">{{ row.remaining }}</el-tag></template>
        </el-table-column>
        <el-table-column label="当前区组" min-width="140">
          <template #default="{ row }">第 {{ row.blockIndex }} 区组 · A{{ row.blockA }}/B{{ row.blockB }}</template>
        </el-table-column>
        <el-table-column label="放号状态" min-width="150">
          <template #default="{ row }"><el-tag :type="row.locked ? 'warning' : 'info'">{{ row.locked ? '配平重算中 · 暂停放号' : '放号中' }}</el-tag></template>
        </el-table-column>
      </el-table>
    </el-card>

    <div class="grid">
      <el-card shadow="never">
        <template #header><b>{{ t('randomize') }}</b><el-switch v-model="offline" active-text="模拟离线" style="float:right" /></template>
        <el-form label-position="top" @submit.prevent="submit">
          <el-form-item label="研究中心" :error="errors.site"><el-select v-model="site" style="width:100%"><el-option label="上海中心" value="上海中心" /><el-option label="广州中心" value="广州中心" /><el-option label="新加坡中心" value="新加坡中心" /></el-select></el-form-item>
          <el-form-item label="受试者编号" :error="errors.participantNo"><el-input v-model="participantNo" placeholder="S01-003" /></el-form-item>
          <el-form-item label="身份核验标识" :error="errors.identityKey"><el-input v-model="identityKey" placeholder="脱敏身份键或筛选号" /></el-form-item>
          <el-form-item label="年龄分层" :error="errors.ageBand"><el-radio-group v-model="ageBand"><el-radio-button value="18-44">18-44</el-radio-button><el-radio-button value="45-64">45-64</el-radio-button><el-radio-button value="65+">65+</el-radio-button></el-radio-group></el-form-item>
          <el-form-item label="操作人" :error="errors.actor"><el-input v-model="actor" /></el-form-item>
          <el-button type="primary" native-type="submit" style="width:100%">执行分层区组随机</el-button>
          <el-button style="width:100%;margin:10px 0 0" @click="simulateConcurrent">模拟并发提交（3 名管理员同层）</el-button>
          <el-alert v-if="selectedStratum" :closable="false" style="margin-top:12px" :type="selectedStratum.locked ? 'warning' : selectedStratum.remaining === 0 ? 'error' : 'info'">
            本层剩余名额 {{ selectedStratum.remaining }}/{{ selectedStratum.capacity }}<template v-if="selectedStratum.locked"> · 配平重算中，暂停放号</template>
          </el-alert>
        </el-form>
      </el-card>

      <el-card shadow="never">
        <template #header><div style="display:flex;justify-content:space-between"><b>{{ t('participants') }}</b><el-tag>{{ roleLabels[role] }} · 角色边界视图</el-tag></div></template>
        <el-table :data="participants" max-height="480">
          <el-table-column label="受试者" min-width="110"><template #default="{ row }">{{ visibleParticipantNo(row.participantNo) }}</template></el-table-column>
          <el-table-column prop="site" label="中心" min-width="100" />
          <el-table-column prop="ageBand" label="年龄层" width="80" />
          <el-table-column prop="sequence" :label="role === 'pharmacist' ? '发药编号' : '随机号'" width="90" />
          <el-table-column label="治疗组" width="90"><template #default="{ row }"><el-tag :type="row.status === 'unblinded' ? 'danger' : 'info'">{{ visibleArm(row.arm, row.status) }}</el-tag></template></el-table-column>
          <el-table-column label="操作" width="90"><template #default="{ row }"><el-button v-if="role === 'investigator' && row.status === 'randomized'" size="small" type="danger" plain @click="unblind(row.id, row.participantNo)">揭盲</el-button></template></el-table-column>
        </el-table>
      </el-card>
    </div>

    <div class="grid" style="margin-top:20px">
      <el-card shadow="never">
        <template #header><b>{{ t('pending') }}</b></template>
        <el-empty v-if="pending.length === 0" description="暂无待提交记录" />
        <el-table v-else :data="pending">
          <el-table-column prop="payload.participantNo" label="受试者" />
          <el-table-column label="分层" min-width="130"><template #default="{ row }">{{ row.payload.site }} / {{ row.payload.ageBand }}</template></el-table-column>
          <el-table-column prop="status" label="状态" />
          <el-table-column label="操作"><template #default="{ row }"><el-button :disabled="row.status !== 'pending'" size="small" type="primary" @click="confirmPending(row.id)">确认入库</el-button></template></el-table-column>
        </el-table>
      </el-card>
      <el-card shadow="never">
        <template #header><b>{{ t('audit') }}</b><el-tag type="warning" style="float:right">仅追加</el-tag></template>
        <el-timeline>
          <el-timeline-item v-for="entry in audits" :key="entry.id" :timestamp="new Date(entry.at).toLocaleString()" :type="timelineType(entry.action)">
            <b>{{ entry.actor }} · {{ actionLabels[entry.action] }}</b>
            <div v-for="(line, index) in auditLines(entry)" :key="index">{{ line }}</div>
          </el-timeline-item>
        </el-timeline>
      </el-card>
    </div>
  </main>
</template>

<style scoped>
@media (max-width: 900px) { section { grid-template-columns: 1fr 1fr !important; } }
</style>
