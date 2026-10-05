<template>
  <section class="page" data-module="sediment">
    <header class="page-head">
      <div>
        <h2>库区测淤断面台账</h2>
        <p class="page-desc">测淤成果按测次整批导入，逐行校验断面编号与起点距；库容损失归总后回写发电计划台账。</p>
      </div>
      <div class="page-actions">
        <label class="btn primary upload-btn">
          上传成果文件
          <input type="file" accept=".csv,.txt" @change="onFile" />
        </label>
        <button class="btn" type="button" :disabled="!selectedCode" @click="exportPackage">导出测次归总</button>
      </div>
    </header>

    <div class="stat-row">
      <article class="stat-card">
        <span class="stat-label">库容损失合计（万m³）</span>
        <strong class="stat-value">{{ summary.totalLoss }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">可用库容（万m³）</span>
        <strong class="stat-value">{{ summary.available }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">可用台数（台）</span>
        <strong class="stat-value">{{ summary.units }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">日发电量估算（万kWh）</span>
        <strong class="stat-value">{{ summary.energy }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span class="legend-item">最新测次：{{ summary.campaign || '—' }}（{{ summary.date || '—' }}）</span>
      <span class="legend-item">估算口径：设计库容 {{ designCapacity }} 万m³ − 最新测次库容损失</span>
      <span class="legend-item">早于 {{ platformDate }} 的测次按历史补录回填，缺失取值标注「缺测」</span>
    </p>

    <div class="filter-bar campaign-bar">
      <button class="btn" type="button" :disabled="!previousCampaign" @click="gotoCampaign(-1)">
        上一测次{{ previousCampaign ? `（${previousCampaign.date}）` : '' }}
      </button>
      <label class="filter-item">
        <span>当前测次</span>
        <select v-model="selectedCode">
          <option v-for="item in campaigns" :key="item.code" :value="item.code">
            {{ item.code }} · {{ item.date }} · {{ item.sections }} 断面<template v-if="item.missing"> · 缺测 {{ item.missing }}</template>
          </option>
        </select>
      </label>
      <button class="btn" type="button" :disabled="!nextCampaign" @click="gotoCampaign(1)">
        下一测次{{ nextCampaign ? `（${nextCampaign.date}）` : '' }}
      </button>
    </div>

    <p v-if="importMessage" class="import-message">{{ importMessage }}</p>

    <table v-if="rejectedRows.length" class="data-table rejected-table">
      <thead>
        <tr><th>行号</th><th>原始内容</th><th>剔除缘由</th></tr>
      </thead>
      <tbody>
        <tr v-for="item in rejectedRows" :key="item.line">
          <td>{{ item.line }}</td>
          <td>{{ item.content }}</td>
          <td class="error-text">{{ item.reason }}</td>
        </tr>
      </tbody>
    </table>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>淤积厚度变化</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)" :class="{ 'abnormal-row': row.abnormal }">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ changeText(row) }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 3" class="empty-state">暂无测淤断面数据，可上传测绘队成果文件导入</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>测次 {{ selectedCode || '—' }} 共 {{ rows.length }} 条断面记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import { runAction as applyAction } from '@/api/local-service'
import {
  DESIGN_CAPACITY,
  PLATFORM_ONLINE_DATE,
  adjacentCampaign,
  campaignRows,
  capacitySummary,
  downloadCampaignPackage,
  importSurvey,
  listCampaigns,
  thicknessChanges,
} from '@/api/sediment-service'
import type { CampaignSummary, CapacitySummary, RejectedRow } from '@/api/sediment-service'
import type { EntryRow } from '@/data/types'

const columns = ["测次编号", "测量日期", "断面编号", "起点距", "断面高程", "淤积厚度", "库容损失", "淤积等级", "数据来源"]
const actions = ["确认入库", "归总另存", "归档测次"]
const designCapacity = DESIGN_CAPACITY
const platformDate = PLATFORM_ONLINE_DATE

const campaigns = ref<CampaignSummary[]>([])
const selectedCode = ref('')
const rows = ref<EntryRow[]>([])
const changes = ref<Record<string, number | null>>({})
const summary = ref<CapacitySummary>({ campaign: '', date: '', totalLoss: 0, available: 0, units: 0, energy: 0 })
const rejectedRows = ref<RejectedRow[]>([])
const importMessage = ref('')
const errorMessage = ref('')

const previousCampaign = computed(() => (selectedCode.value ? adjacentCampaign(selectedCode.value, -1) : null))
const nextCampaign = computed(() => (selectedCode.value ? adjacentCampaign(selectedCode.value, 1) : null))

function changeText(row: EntryRow): string {
  const value = changes.value[String(row['断面编号'])]
  if (value === null || value === undefined) return '—'
  return value > 0 ? `+${value}` : String(value)
}

function gotoCampaign(direction: -1 | 1) {
  const target = adjacentCampaign(selectedCode.value, direction)
  if (target) selectedCode.value = target.code
  reload()
}

async function onFile(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  errorMessage.value = ''
  importMessage.value = ''
  rejectedRows.value = []
  const text = await file.text()
  const result = importSurvey(text)
  rejectedRows.value = result.rejected
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  importMessage.value = result.message
  selectedCode.value = result.campaign
  reload()
}

function exportPackage() {
  if (!selectedCode.value) return
  downloadCampaignPackage(selectedCode.value)
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction('sediment', Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function reload() {
  campaigns.value = listCampaigns()
  if (!selectedCode.value || !campaigns.value.some((item) => item.code === selectedCode.value)) {
    selectedCode.value = campaigns.value[campaigns.value.length - 1]?.code ?? ''
  }
  rows.value = selectedCode.value ? campaignRows(selectedCode.value) : []
  changes.value = selectedCode.value ? thicknessChanges(selectedCode.value) : {}
  summary.value = capacitySummary()
}

onMounted(reload)
</script>

<style scoped>
.upload-btn {
  position: relative;
  overflow: hidden;
  display: inline-block;
}
.upload-btn input[type='file'] {
  position: absolute;
  inset: 0;
  opacity: 0;
  cursor: pointer;
}
.campaign-bar {
  align-items: center;
}
.import-message {
  margin: 0 0 10px;
  font-size: 13px;
  color: #067647;
}
.rejected-table {
  margin-bottom: 12px;
}
.abnormal-row td {
  background: #fef3f2;
}
</style>
