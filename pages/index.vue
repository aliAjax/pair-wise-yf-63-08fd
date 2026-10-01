<script setup lang="ts">
import { computed, ref } from 'vue';
import { storeToRefs } from 'pinia';
import { toTypedSchema } from '@vee-validate/zod';
import { useForm } from 'vee-validate';
import { z } from 'zod';
import { ElMessage, ElMessageBox } from 'element-plus';
import { useTrialStore } from '~/stores/trial';
import type { AgeBand, Arm, AuditEntry, TrialRole } from '~/types/trial';

const { t } = useI18n();
const trial = useTrialStore();
const { participants, audits, pending } = storeToRefs(trial);
const role = ref<TrialRole>('investigator');
const offline = ref(false);
const submitting = ref(false);
const committingId = ref<string | null>(null);

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
const actorName = computed(() => actor.value?.trim() || '未知操作人');

const ageBands: AgeBand[] = ['18-44', '45-64', '65+'];

const stratumRows = computed(() => trial.stratumList.map((stratum) => {
  const enrolled = participants.value.filter((item) => item.site === stratum.site && item.ageBand === stratum.ageBand);
  return {
    ...stratum,
    enrolled: enrolled.length,
    remaining: Math.max(0, stratum.planned - enrolled.length),
    armA: enrolled.filter((item) => item.arm === 'A').length,
    armB: enrolled.filter((item) => item.arm === 'B').length
  };
}));

const totalRemaining = computed(() => stratumRows.value.reduce((sum, row) => sum + row.remaining, 0));

const selectedStratum = computed(() => stratumRows.value.find((row) => row.site === site.value && row.ageBand === ageBand.value));

// 角色边界：药品管理员只见发药编号，治疗组一律隐藏；监察员仅在揭盲后可见治疗组
const visibleArm = (arm?: Arm, status?: string) => {
  if (role.value === 'pharmacist') return '已隐藏';
  if (role.value === 'monitor' && status === 'unblinded') return arm ?? '未知';
  return '已隐藏';
};

// 角色边界：药品管理员不可见揭盲原因；审计记录中的治疗组/配平计数同样脱敏
const redactDetail = (detail: string) => detail
  .replace(/治疗组 [AB]/g, '治疗组已隐藏')
  .replace(/分配组别 [AB]/g, '分配组别已隐藏')
  .replace(/A \d+ \/ B \d+/g, '组配平已隐藏');

const visibleAudits = computed<AuditEntry[]>(() => {
  if (role.value !== 'pharmacist') return audits.value;
  return audits.value
    .filter((entry) => entry.action !== 'unblinded')
    .map((entry) => ({ ...entry, detail: redactDetail(entry.detail) }));
});

const submit = handleSubmit(async (values) => {
  submitting.value = true;
  try {
    const payload = {
      participantNo: values.participantNo as string,
      identityKey: values.identityKey as string,
      site: values.site as string,
      ageBand: values.ageBand as AgeBand,
      actor: values.actor as string
    };
    const result = await trial.randomize(payload, offline.value);
    if (!result.ok) {
      ElMessage.error(result.message);
      return;
    }
    ElMessage.success(result.message);
    resetForm({ values: { participantNo: '', identityKey: '', site: payload.site, ageBand: payload.ageBand, actor: payload.actor } });
  } finally {
    submitting.value = false;
  }
});

// 模拟两名中心管理员在同一层同时提交：中央记录串行放号，容量不足的一方会被拒绝并报出剩余名额
const concurrencyDemo = async () => {
  const stamp = `${Date.now()}`.slice(-6);
  const base = { site: site.value as string, ageBand: ageBand.value as AgeBand, actor: actorName.value };
  ElMessage.info('模拟两名中心管理员同时提交……');
  const results = await Promise.all([
    trial.randomize({ ...base, participantNo: `SIM${stamp}-1`, identityKey: `sim${stamp}-1` }, offline.value),
    trial.randomize({ ...base, participantNo: `SIM${stamp}-2`, identityKey: `sim${stamp}-2` }, offline.value)
  ]);
  results.forEach((result) => {
    if (result.ok) ElMessage.success(result.message);
    else ElMessage.warning(result.message);
  });
};

const commit = async (id: string) => {
  committingId.value = id;
  try {
    const result = await trial.commitPending(id, actorName.value);
    if (!result) return;
    if (result.ok) ElMessage.success(result.message);
    else ElMessage.error(result.message);
  } finally {
    committingId.value = null;
  }
};

const recalc = async (stratumSite: string, stratumAgeBand: AgeBand) => {
  await trial.recalculateStratum(stratumSite, stratumAgeBand, actorName.value);
  ElMessage.success(`${stratumSite} · ${stratumAgeBand} 区组配平重算完成，已恢复放号`);
};

const unblind = async (id: string, participantNumber: string) => {
  try {
    const { value } = await ElMessageBox.prompt(`为 ${participantNumber} 填写紧急揭盲原因`, '紧急揭盲', { inputType: 'textarea', inputValidator: (value) => Boolean(value?.trim()) || '揭盲原因不能为空', confirmButtonText: '确认并审计' });
    await trial.emergencyUnblind(id, value, actorName.value);
    ElMessage.warning('已揭盲，所在区组配平重算期间暂停放号，重算完成后自动恢复');
  } catch {}
};

const counts = computed(() => ({
  total: participants.value.length,
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

    <section style="display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:16px;margin-bottom:20px">
      <div class="stat"><span>已随机入组</span><b>{{ counts.total }}</b></div>
      <div class="stat"><span>紧急揭盲</span><b>{{ counts.unblinded }}</b></div>
      <div class="stat"><span>参与中心</span><b>{{ counts.sites }}</b></div>
      <div class="stat"><span>待提交</span><b>{{ counts.pending }}</b></div>
    </section>

    <el-card shadow="never" style="margin-bottom:20px">
      <template #header>
        <b>分层区组余量（中央记录）</b>
        <el-tag type="info" style="float:right">总剩余 {{ totalRemaining }} 个名额</el-tag>
      </template>
      <el-table :data="stratumRows" size="small" max-height="340">
        <el-table-column label="层（中心 · 年龄）" min-width="170">
          <template #default="{ row }">{{ row.site }} · {{ row.ageBand }}</template>
        </el-table-column>
        <el-table-column prop="planned" label="计划名额" width="90" />
        <el-table-column prop="enrolled" label="已入组" width="80" />
        <el-table-column label="剩余名额" width="90">
          <template #default="{ row }">
            <el-tag :type="row.remaining === 0 ? 'danger' : row.remaining <= 2 ? 'warning' : 'success'">{{ row.remaining }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column v-if="role !== 'pharmacist'" label="组配平（A/B）" width="110">
          <template #default="{ row }">{{ row.armA }} / {{ row.armB }}</template>
        </el-table-column>
        <el-table-column label="区组数" width="80">
          <template #default="{ row }">{{ Math.ceil(row.enrolled / row.blockSize) }}</template>
        </el-table-column>
        <el-table-column label="状态" width="170">
          <template #default="{ row }">
            <el-tag :type="row.status === 'recalculating' ? 'warning' : 'success'">
              {{ row.status === 'recalculating' ? '重算配平中 · 暂停放号' : '开放放号' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="120">
          <template #default="{ row }">
            <el-button size="small" :loading="row.status === 'recalculating'" @click="recalc(row.site, row.ageBand)">重算配平</el-button>
          </template>
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
          <el-form-item label="年龄分层" :error="errors.ageBand">
            <el-radio-group v-model="ageBand">
              <el-radio-button v-for="band in ageBands" :key="band" :value="band">{{ band }}</el-radio-button>
            </el-radio-group>
          </el-form-item>
          <el-alert
            v-if="selectedStratum"
            :title="`该层剩余名额 ${selectedStratum.remaining} / 计划 ${selectedStratum.planned}，状态：${selectedStratum.status === 'recalculating' ? '重算配平中，暂停放号' : '开放放号'}`"
            :type="selectedStratum.status === 'recalculating' ? 'warning' : selectedStratum.remaining === 0 ? 'error' : 'info'"
            :closable="false"
            style="margin-bottom:14px"
          />
          <el-form-item label="操作人" :error="errors.actor"><el-input v-model="actor" /></el-form-item>
          <el-button type="primary" native-type="submit" :loading="submitting" :disabled="selectedStratum?.status === 'recalculating'" style="width:100%">执行分层区组随机</el-button>
          <el-button @click="concurrencyDemo" :disabled="submitting || selectedStratum?.status === 'recalculating'" style="width:100%;margin-top:8px">模拟两名中心管理员同时提交</el-button>
        </el-form>
      </el-card>

      <el-card shadow="never">
        <template #header><div style="display:flex;justify-content:space-between"><b>{{ t('participants') }}</b><el-tag>{{ role }}</el-tag></div></template>
        <el-table :data="participants" max-height="480">
          <el-table-column prop="participantNo" label="受试者" min-width="110" />
          <el-table-column prop="site" label="中心" min-width="110" />
          <el-table-column prop="ageBand" label="年龄层" width="90" />
          <el-table-column v-if="role !== 'pharmacist'" prop="sequence" label="随机号" width="90" />
          <el-table-column v-else label="发药编号" width="110">
            <template #default="{ row }"><el-tag type="success">DY-{{ row.sequence }}</el-tag></template>
          </el-table-column>
          <el-table-column label="治疗组" width="100">
            <template #default="{ row }"><el-tag :type="row.status === 'unblinded' ? 'danger' : 'info'">{{ visibleArm(row.arm, row.status) }}</el-tag></template>
          </el-table-column>
          <el-table-column label="状态" width="90">
            <template #default="{ row }">
              <el-tag :type="row.status === 'unblinded' ? 'danger' : 'primary'">{{ row.status === 'unblinded' ? '已揭盲' : '随机入组' }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="操作" width="100">
            <template #default="{ row }"><el-button v-if="role === 'investigator'" size="small" type="danger" plain @click="unblind(row.id, row.participantNo)">揭盲</el-button></template>
          </el-table-column>
        </el-table>
      </el-card>
    </div>

    <div class="grid" style="margin-top:20px">
      <el-card shadow="never">
        <template #header><b>{{ t('pending') }}</b></template>
        <el-empty v-if="pending.length === 0" description="暂无待提交记录" />
        <el-table v-else :data="pending">
          <el-table-column prop="payload.participantNo" label="受试者" />
          <el-table-column label="状态" width="100">
            <template #default="{ row }">
              <el-tag :type="row.status === 'committed' ? 'success' : 'warning'">{{ row.status === 'committed' ? '已入库' : '待提交' }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="操作" width="110">
            <template #default="{ row }">
              <el-button :loading="committingId === row.id" :disabled="row.status !== 'pending'" size="small" type="primary" @click="commit(row.id)">确认入库</el-button>
            </template>
          </el-table-column>
        </el-table>
      </el-card>
      <el-card shadow="never">
        <template #header><b>{{ t('audit') }}</b><el-tag type="warning" style="float:right">仅追加</el-tag></template>
        <el-timeline>
          <el-timeline-item v-for="entry in visibleAudits" :key="entry.id" :timestamp="new Date(entry.at).toLocaleString()" :type="entry.action === 'unblinded' ? 'danger' : entry.action === 'duplicate-blocked' || entry.action === 'allocation-blocked' ? 'warning' : entry.action === 'stratum-recalculated' ? 'success' : 'primary'">
            <b>{{ entry.actor }} · {{ entry.action }}</b><div>{{ entry.detail }}</div>
          </el-timeline-item>
        </el-timeline>
      </el-card>
    </div>
  </main>
</template>

<style scoped>
@media (max-width: 900px) { section { grid-template-columns: 1fr 1fr !important; } }
</style>
