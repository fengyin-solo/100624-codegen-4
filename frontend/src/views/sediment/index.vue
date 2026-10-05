<template>
  <section class="page" data-module="sediment">
    <header class="page-head">
      <div>
        <h2>库区测淤台账</h2>
        <p class="page-desc">测淤成果按测次整批导入、逐行校验、按测量日期覆盖归总，库容损失同步回写发电计划。</p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" :disabled="!selectedBatch" @click="exportCurrent">导出本测次成果包</button>
        <button class="btn" type="button" @click="resync">重算并回写发电计划</button>
      </div>
    </header>

    <div class="stat-row">
      <article class="stat-card">
        <span class="stat-label">最新测次</span>
        <strong class="stat-value">{{ summary.latestBatch }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">累计库容损失(万m³)</span>
        <strong class="stat-value">{{ summary.totalLoss.toFixed(2) }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">可用库容(万m³)</span>
        <strong class="stat-value">{{ summary.availableCapacity.toFixed(2) }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">可用台数(台)</span>
        <strong class="stat-value">{{ summary.availableUnits }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">估算日发电量(万kWh)</span>
        <strong class="stat-value">{{ summary.dailyEnergy.toFixed(2) }}</strong>
      </article>
    </div>

    <section class="panel">
      <h3>成果文件导入</h3>
      <form class="filter-bar" @submit.prevent="runImport">
        <label class="filter-item">
          <span>测次编号</span>
          <input v-model="importForm.测次编号" placeholder="如 CS-2026-10" />
        </label>
        <label class="filter-item">
          <span>测量日期</span>
          <input v-model="importForm.测量日期" type="date" />
        </label>
        <label class="filter-item">
          <span>成果文件（断面编号,起点距,断面高程,淤积厚度）</span>
          <input type="file" accept=".csv,.txt" @change="onFile" />
        </label>
        <label class="filter-item checkbox-item">
          <input v-model="importForm.backfill" type="checkbox" />
          <span>历史补录（上线前测次，缺值行标注缺测入库）</span>
        </label>
        <button class="btn primary" type="submit">校验并入库</button>
      </form>
      <p v-if="willOverwrite" class="hint-text">测次 {{ importForm.测次编号 }} 已在册，导入将按测量日期覆盖旧版，不会叠加。</p>
      <p v-if="importMessage" class="hint-text">{{ importMessage }}</p>
      <div v-if="rejectedRows.length" class="rejected-box">
        <strong>退回 {{ rejectedRows.length }} 行（其余行已照常入库）：</strong>
        <ul>
          <li v-for="item in rejectedRows" :key="item.line">第 {{ item.line }} 行：{{ item.reason }}（原文：{{ item.raw }}）</li>
        </ul>
      </div>
    </section>

    <section class="panel">
      <h3>测次对照</h3>
      <div class="batch-nav">
        <button class="btn" type="button" :disabled="!prevBatch" @click="gotoBatch(-1)">上一测次</button>
        <select v-model="selectedBatch" @change="onBatchChange">
          <option v-for="item in batches" :key="item.测次编号" :value="item.测次编号">
            {{ item.测次编号 }}（{{ item.测量日期 }}，{{ item.断面数 }} 断面{{ item.缺测数 ? `，缺测 ${item.缺测数}` : '' }}）
          </option>
        </select>
        <button class="btn" type="button" :disabled="!nextBatch" @click="gotoBatch(1)">下一测次</button>
      </div>
      <table v-if="comparison.rows.length" class="data-table">
        <thead>
          <tr>
            <th>断面编号</th>
            <th>本测次淤积厚度(m)</th>
            <th>{{ comparison.previous ?? '相邻测次' }} 淤积厚度(m)</th>
            <th>变化(m)</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in comparison.rows" :key="item.断面编号">
            <td>{{ item.断面编号 }}</td>
            <td>{{ item.当前厚度 }}</td>
            <td>{{ item.对照厚度 }}</td>
            <td>{{ item.变化 }}</td>
          </tr>
        </tbody>
      </table>
      <p v-else class="hint-text">当前测次暂无断面数据</p>
    </section>

    <section class="panel">
      <h3>待办清单</h3>
      <ul class="todo-list">
        <li v-if="todos.缺测.length">缺测断面待补齐：{{ todos.缺测.map((row) => `${row.测次编号}/${row.断面编号}`).join('、') }}</li>
        <li v-if="todos.待校核">待校核断面 {{ todos.待校核 }} 条</li>
        <li v-if="todos.待归档">已汇总待归档断面 {{ todos.待归档 }} 条</li>
        <li v-if="!todos.缺测.length && !todos.待校核 && !todos.待归档">现场台账与待办一致，暂无待办</li>
      </ul>
    </section>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>登记方式</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)" :class="{ 'row-abnormal': row.abnormal }">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row['登记方式'] ?? '导入' }}</td>
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
          <td :colspan="columns.length + 3" class="empty-state">暂无测淤断面数据，请先导入成果文件</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条测淤断面记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'

import { listEntries, moduleMeta, runAction as applyAction } from '@/api/local-service'
import {
  PLATFORM_LAUNCH_DATE,
  SEDIMENT_KEY,
  adjacentBatch,
  compareWithPrevious,
  downloadBatch,
  importSurvey,
  listBatches,
  resyncGeneration,
  sedimentSummary,
} from '@/api/sediment-service'
import type { RejectedRow, SedimentSummary } from '@/api/sediment-service'
import { listRows } from '@/data/local-store'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('sediment')
const columns = meta.fields
const actions = meta.actions
const filterFields = columns.slice(0, 3)

const rows = ref<EntryRow[]>([])
const ledgerRows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const batches = ref(listBatches())
const selectedBatch = ref('')
const summary = ref<SedimentSummary>(sedimentSummary())
const rejectedRows = ref<RejectedRow[]>([])
const importMessage = ref('')
const importForm = reactive({ 测次编号: '', 测量日期: '', backfill: false, text: '', filename: '' })

const prevBatch = computed(() => (selectedBatch.value ? adjacentBatch(selectedBatch.value, -1) : null))
const nextBatch = computed(() => (selectedBatch.value ? adjacentBatch(selectedBatch.value, 1) : null))
const comparison = computed(() =>
  selectedBatch.value ? compareWithPrevious(selectedBatch.value) : { previous: null, rows: [] },
)
const willOverwrite = computed(
  () =>
    importForm.测次编号.trim() !== '' &&
    batches.value.some((item) => item.测次编号 === importForm.测次编号.trim()),
)
const todos = computed(() => ({
  缺测: ledgerRows.value.filter((row) => row.abnormal),
  待校核: ledgerRows.value.filter((row) => String(row.status) === '待校核').length,
  待归档: ledgerRows.value.filter((row) => String(row.status) === '已汇总').length,
}))

function onFile(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  importForm.filename = file.name
  const reader = new FileReader()
  reader.onload = () => {
    importForm.text = String(reader.result ?? '')
  }
  reader.readAsText(file)
}

function runImport() {
  errorMessage.value = ''
  rejectedRows.value = []
  importMessage.value = ''
  if (!importForm.text) {
    errorMessage.value = '请先选择测绘队给的成果文件'
    return
  }
  const result = importSurvey({
    测次编号: importForm.测次编号,
    测量日期: importForm.测量日期,
    backfill: importForm.backfill,
    text: importForm.text,
  })
  rejectedRows.value = result.rejected
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  importMessage.value = result.message
  selectedBatch.value = importForm.测次编号.trim()
  onBatchChange()
}

function gotoBatch(direction: -1 | 1) {
  const target = adjacentBatch(selectedBatch.value, direction)
  if (target) {
    selectedBatch.value = target
    onBatchChange()
  }
}

function onBatchChange() {
  filters.value = selectedBatch.value ? { 测次编号: selectedBatch.value } : {}
  reload()
}

function exportCurrent() {
  if (!selectedBatch.value) return
  downloadBatch(selectedBatch.value)
}

function resync() {
  errorMessage.value = ''
  const result = resyncGeneration()
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  importMessage.value = result.message
  reload()
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function resetFilters() {
  filters.value = selectedBatch.value ? { 测次编号: selectedBatch.value } : {}
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    ledgerRows.value = listRows(SEDIMENT_KEY)
    batches.value = listBatches()
    summary.value = sedimentSummary()
    if (!selectedBatch.value && batches.value.length) {
      selectedBatch.value = batches.value[batches.value.length - 1].测次编号
      filters.value = { 测次编号: selectedBatch.value }
    }
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '测淤断面列表读取失败'
  }
}

onMounted(() => {
  if (!importForm.测量日期) {
    importForm.测量日期 = PLATFORM_LAUNCH_DATE
  }
  reload()
})
</script>

<style scoped>
.panel {
  background: #fff;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 12px 14px;
  margin-bottom: 12px;
}
.panel h3 {
  margin: 0 0 10px;
  font-size: 14px;
}
.checkbox-item {
  display: flex;
  align-items: center;
  gap: 6px;
}
.hint-text {
  color: var(--muted);
  font-size: 12px;
  margin: 8px 0 0;
}
.rejected-box {
  margin-top: 10px;
  border: 1px solid #f0c36d;
  background: #fff8e6;
  border-radius: 6px;
  padding: 8px 12px;
  font-size: 12px;
}
.rejected-box ul {
  margin: 6px 0 0;
  padding-left: 18px;
}
.batch-nav {
  display: flex;
  gap: 10px;
  align-items: center;
  margin-bottom: 10px;
}
.todo-list {
  margin: 0;
  padding-left: 18px;
  font-size: 13px;
}
.row-abnormal td {
  background: #fef3f2;
}
</style>
