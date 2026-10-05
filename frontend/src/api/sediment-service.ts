import { cloneAll, commitAll, listRows } from '@/data/local-store'
import type { EntryRow } from '@/data/types'

// 库区测淤业务服务：成果文件解析、逐行校验、按测次覆盖入库、库容损失归总、
// 发电计划回写、测次导航与打包导出。页面只负责渲染，判断都收在这里。

export const SEDIMENT_KEY = 'sediment'
export const GENERATION_KEY = 'generation'

// 平台上线日：早于此日期的测次只能走「历史补录」入口。
export const PLATFORM_LAUNCH_DATE = '2026-09-01'

// 库容与发电估算常量（万m³、万kWh）。
const DESIGN_CAPACITY = 12000 // 设计总库容
const LOSS_PER_METER = 20 // 每米淤积对应的库容损失：代表宽度 80m × 断面间距 2500m ÷ 10000
const UNIT_DAILY_WATER = 800 // 单台机组日耗水
const UNIT_COUNT_LIMIT = 4 // 装机台数上限
const UNIT_DAILY_ENERGY = 36 // 单机日发电量

// 淤积等级沿用既有划分，新测次只按这套阈值定级，不回改在册结论。
const GRADE_LIGHT_MAX = 0.5
const GRADE_MID_MAX = 1.5

const SECTION_NO_PATTERN = /^[A-Za-z]{1,4}-?\d{1,4}$/
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

export type RejectedRow = {
  line: number
  raw: string
  reason: string
}

export type ImportResult = {
  ok: boolean
  message: string
  imported: number
  missing: number
  overwritten: number
  rejected: RejectedRow[]
}

export type BatchInfo = {
  测次编号: string
  测量日期: string
  断面数: number
  缺测数: number
  库容损失: number
}

export type SedimentSummary = {
  latestBatch: string
  latestDate: string
  totalLoss: number
  availableCapacity: number
  availableUnits: number
  dailyEnergy: number
}

export type CompareRow = {
  断面编号: string
  当前厚度: string
  对照厚度: string
  变化: string
}

function toNumber(value: unknown): number | null {
  const num = Number(String(value ?? '').trim())
  return Number.isFinite(num) ? num : null
}

export function gradeOf(thickness: number): string {
  if (thickness < GRADE_LIGHT_MAX) return '轻度'
  if (thickness <= GRADE_MID_MAX) return '中度'
  return '重度'
}

function lossOf(thickness: number): number {
  return Math.round(thickness * LOSS_PER_METER * 100) / 100
}

function isMissingValue(value: unknown): boolean {
  return String(value ?? '').trim() === '' || String(value ?? '').trim() === '缺测'
}

/** 测次清单：按测量日期升序，相邻测次定位也靠这个顺序。 */
export function listBatches(rows: EntryRow[] = listRows(SEDIMENT_KEY)): BatchInfo[] {
  const byBatch = new Map<string, EntryRow[]>()
  for (const row of rows) {
    const key = String(row['测次编号'] ?? '')
    if (!key) continue
    const list = byBatch.get(key) ?? []
    list.push(row)
    byBatch.set(key, list)
  }
  return [...byBatch.entries()]
    .map(([测次编号, items]) => ({
      测次编号,
      测量日期: String(items[0]['测量日期'] ?? ''),
      断面数: items.length,
      缺测数: items.filter((row) => row.abnormal).length,
      库容损失: items.reduce((sum, row) => sum + (toNumber(row['库容损失']) ?? 0), 0),
    }))
    .sort((a, b) => a.测量日期.localeCompare(b.测量日期) || a.测次编号.localeCompare(b.测次编号))
}

/** 按测量日期定位相邻测次：direction 取 -1 上一次、1 下一次。 */
export function adjacentBatch(current: string, direction: -1 | 1): string | null {
  const batches = listBatches()
  const index = batches.findIndex((item) => item.测次编号 === current)
  if (index < 0) return batches.length ? batches[batches.length - 1].测次编号 : null
  const next = batches[index + direction]
  return next ? next.测次编号 : null
}

/** 库容损失归总：以最新测次（按测量日期）为准，缺测行不参与合计。 */
export function sedimentSummary(rows: EntryRow[] = listRows(SEDIMENT_KEY)): SedimentSummary {
  const batches = listBatches(rows)
  const latest = batches[batches.length - 1]
  const totalLoss = latest ? Math.round(latest.库容损失 * 100) / 100 : 0
  const availableCapacity = Math.round((DESIGN_CAPACITY - totalLoss) * 100) / 100
  const availableUnits = Math.max(
    0,
    Math.min(UNIT_COUNT_LIMIT, Math.floor(availableCapacity / UNIT_DAILY_WATER)),
  )
  return {
    latestBatch: latest?.测次编号 ?? '—',
    latestDate: latest?.测量日期 ?? '—',
    totalLoss,
    availableCapacity,
    availableUnits,
    dailyEnergy: availableUnits * UNIT_DAILY_ENERGY,
  }
}

/** 淤积厚度对照：当前测次与相邻上一次测次逐断面对比。 */
export function compareWithPrevious(current: string): { previous: string | null; rows: CompareRow[] } {
  const previous = adjacentBatch(current, -1)
  const all = listRows(SEDIMENT_KEY)
  const currentRows = all.filter((row) => String(row['测次编号']) === current)
  const previousRows = all.filter((row) => String(row['测次编号']) === previous)
  const prevBySection = new Map(previousRows.map((row) => [String(row['断面编号']), row]))
  const rows = currentRows.map((row) => {
    const section = String(row['断面编号'])
    const currentThickness = toNumber(row['淤积厚度'])
    const prevRow = prevBySection.get(section)
    const prevThickness = prevRow ? toNumber(prevRow['淤积厚度']) : null
    let delta = '—'
    if (currentThickness !== null && prevThickness !== null) {
      const diff = Math.round((currentThickness - prevThickness) * 100) / 100
      delta = diff > 0 ? `+${diff.toFixed(2)}` : diff.toFixed(2)
    }
    return {
      断面编号: section,
      当前厚度: currentThickness === null ? '缺测' : currentThickness.toFixed(2),
      对照厚度: prevThickness === null ? '缺测' : prevThickness.toFixed(2),
      变化: delta,
    }
  })
  return { previous, rows }
}

/**
 * 解析测绘队成果文件：每行「断面编号,起点距,断面高程,淤积厚度」，逗号/制表符分隔，
 * 首行允许是表头。列数不对的行在这里先退回，字段级校验留给 importSurvey。
 */
export function parseSurveyText(text: string): { lines: string[][]; rejected: RejectedRow[] } {
  const lines: string[][] = []
  const rejected: RejectedRow[] = []
  const rawLines = text.replace(/^﻿/, '').split(/\r?\n/)
  rawLines.forEach((rawLine, index) => {
    const raw = rawLine.trim()
    if (!raw) return
    if (index === 0 && raw.includes('断面编号')) return
    const cells = raw.split(/[,\t]/).map((cell) => cell.trim())
    if (cells.length !== 4) {
      rejected.push({
        line: index + 1,
        raw,
        reason: `该行拆出 ${cells.length} 列，不是约定的 4 列（断面编号,起点距,断面高程,淤积厚度）`,
      })
      return
    }
    lines.push(cells)
  })
  return { lines, rejected }
}

/** 逐行校验：断面编号与起点距必须合规，高程缺失在补录模式下标注缺测、其余情况退回。 */
function validateLine(
  cells: string[],
  line: number,
  raw: string,
  backfill: boolean,
): { row?: Record<string, string>; missing?: boolean; rejected?: RejectedRow } {
  const [断面编号, 起点距, 断面高程, 淤积厚度] = cells
  if (!SECTION_NO_PATTERN.test(断面编号)) {
    return { rejected: { line, raw, reason: `断面编号「${断面编号 || '空'}」格式不对，应为字母加数字（如 DM-01）` } }
  }
  const distance = toNumber(起点距)
  if (distance === null || distance < 0) {
    return { rejected: { line, raw, reason: `起点距「${起点距 || '空'}」不是有效数字或小于 0` } }
  }
  const elevationMissing = isMissingValue(断面高程)
  const thicknessMissing = isMissingValue(淤积厚度)
  if ((elevationMissing || thicknessMissing) && backfill) {
    // 历史补录：缺值的行保留入库、单独标注缺测，不参与库容损失合计。
    return {
      missing: true,
      row: {
        断面编号,
        起点距: distance.toFixed(2),
        断面高程: elevationMissing ? '缺测' : Number(断面高程).toFixed(2),
        淤积厚度: thicknessMissing ? '缺测' : Number(淤积厚度).toFixed(2),
      },
    }
  }
  if (elevationMissing) {
    return { rejected: { line, raw, reason: `断面 ${断面编号} 高程缺失，该行退回，请向测绘队核实后单独补` } }
  }
  const elevation = toNumber(断面高程)
  if (elevation === null) {
    return { rejected: { line, raw, reason: `断面高程「${断面高程}」不是有效数字` } }
  }
  const thickness = toNumber(淤积厚度)
  if (thickness === null || thickness < 0) {
    return { rejected: { line, raw, reason: `淤积厚度「${淤积厚度 || '空'}」缺失或不是有效数字` } }
  }
  return {
    row: {
      断面编号,
      起点距: distance.toFixed(2),
      断面高程: elevation.toFixed(2),
      淤积厚度: thickness.toFixed(2),
    },
  }
}

/**
 * 按测次导入成果文件。同一测次重复导入按测量日期覆盖旧版而不是叠加；
 * 断面台账与发电计划回写在同一次提交里落库，任何一步失败整套回滚。
 */
export function importSurvey(input: {
  测次编号: string
  测量日期: string
  backfill: boolean
  text: string
}): ImportResult {
  const 测次编号 = input.测次编号.trim()
  const 测量日期 = input.测量日期.trim()
  if (!测次编号) {
    return { ok: false, message: '测次编号不能为空', imported: 0, missing: 0, overwritten: 0, rejected: [] }
  }
  if (!DATE_PATTERN.test(测量日期)) {
    return { ok: false, message: '测量日期应为 YYYY-MM-DD 格式', imported: 0, missing: 0, overwritten: 0, rejected: [] }
  }
  if (测量日期 < PLATFORM_LAUNCH_DATE && !input.backfill) {
    return {
      ok: false,
      message: `测量日期早于平台上线日 ${PLATFORM_LAUNCH_DATE}，请勾选「历史补录」再导入`,
      imported: 0,
      missing: 0,
      overwritten: 0,
      rejected: [],
    }
  }

  const { lines, rejected } = parseSurveyText(input.text)
  const accepted: { row: Record<string, string>; missing: boolean }[] = []
  const seen = new Set<string>()
  lines.forEach((cells, index) => {
    const line = index + 1
    const raw = cells.join(',')
    const result = validateLine(cells, line, raw, input.backfill)
    if (result.rejected) {
      rejected.push(result.rejected)
      return
    }
    const section = result.row!['断面编号']
    if (seen.has(section)) {
      rejected.push({ line, raw, reason: `断面 ${section} 在本文件里重复出现，该行退回` })
      return
    }
    seen.add(section)
    accepted.push({ row: result.row!, missing: Boolean(result.missing) })
  })
  rejected.sort((a, b) => a.line - b.line)

  if (accepted.length === 0) {
    return {
      ok: false,
      message: '没有可入库的行：' + (rejected[0]?.reason ?? '成果文件为空'),
      imported: 0,
      missing: 0,
      overwritten: 0,
      rejected,
    }
  }

  // 在整库拷贝上改，改完一次性提交；任何异常都落在提交前，等于自动回滚。
  const state = cloneAll()
  const existing = state[SEDIMENT_KEY] ?? []
  const kept = existing.filter((row) => String(row['测次编号']) !== 测次编号)
  const overwritten = existing.length - kept.length

  let nextId = Math.max(0, ...Object.values(state).flat().map((row) => Number(row.id) || 0)) + 1
  const newRows: EntryRow[] = accepted.map(({ row, missing }) => {
    const thickness = toNumber(row['淤积厚度'])
    return {
      id: nextId++,
      status: '待校核',
      pending: true,
      abnormal: missing,
      ...row,
      测次编号,
      测量日期,
      库容损失: thickness === null ? '0.00' : lossOf(thickness).toFixed(2),
      淤积等级: thickness === null ? '待定' : gradeOf(thickness),
      登记方式: input.backfill ? '补录' : '导入',
    }
  })
  state[SEDIMENT_KEY] = [...kept, ...newRows]

  // 库容损失回写发电计划：只动待编制/已下达的计划，执行中与已完成的在册结论不改写。
  const summary = sedimentSummary(state[SEDIMENT_KEY])
  state[GENERATION_KEY] = (state[GENERATION_KEY] ?? []).map((row) => {
    if (row.status !== '待编制' && row.status !== '已下达') return row
    return {
      ...row,
      日发电量: summary.dailyEnergy.toFixed(2),
      可用库容: summary.availableCapacity.toFixed(2),
      可用台数: summary.availableUnits,
      依据测次: summary.latestBatch,
    }
  })

  try {
    commitAll(state)
  } catch (error) {
    return {
      ok: false,
      message: `落库失败，已整套回滚：${error instanceof Error ? error.message : String(error)}`,
      imported: 0,
      missing: 0,
      overwritten: 0,
      rejected,
    }
  }

  const missingCount = accepted.filter((item) => item.missing).length
  const parts = [
    `测次 ${测次编号} 入库 ${accepted.length} 行`,
    overwritten > 0 ? `按测量日期覆盖旧版 ${overwritten} 行` : '新增测次',
    missingCount > 0 ? `其中 ${missingCount} 行缺测已单独标注` : '',
    rejected.length > 0 ? `退回 ${rejected.length} 行` : '',
    `已按新测次重算可用库容并回写发电计划`,
  ].filter(Boolean)
  return { ok: true, message: parts.join('；'), imported: accepted.length, missing: missingCount, overwritten, rejected }
}

/** 手动重算：以最新测次为准回写发电计划，同样整套提交、失败回滚。 */
export function resyncGeneration(): { ok: boolean; message: string } {
  const state = cloneAll()
  const summary = sedimentSummary(state[SEDIMENT_KEY] ?? [])
  if (summary.latestBatch === '—') {
    return { ok: false, message: '还没有测淤成果，无法回写发电计划' }
  }
  let touched = 0
  state[GENERATION_KEY] = (state[GENERATION_KEY] ?? []).map((row) => {
    if (row.status !== '待编制' && row.status !== '已下达') return row
    touched += 1
    return {
      ...row,
      日发电量: summary.dailyEnergy.toFixed(2),
      可用库容: summary.availableCapacity.toFixed(2),
      可用台数: summary.availableUnits,
      依据测次: summary.latestBatch,
    }
  })
  try {
    commitAll(state)
  } catch (error) {
    return { ok: false, message: `落库失败，已整套回滚：${error instanceof Error ? error.message : String(error)}` }
  }
  return {
    ok: true,
    message: `已按测次 ${summary.latestBatch} 重算：可用库容 ${summary.availableCapacity} 万m³、可用台数 ${summary.availableUnits} 台、估算日发电量 ${summary.dailyEnergy} 万kWh，回写 ${touched} 条发电计划`,
  }
}

/** 按测次归总另存：断面成果与库容损失打包成一份文件，数据与页面列表同源。 */
export function exportBatch(测次编号: string): { filename: string; content: string } {
  const rows = listRows(SEDIMENT_KEY).filter((row) => String(row['测次编号']) === 测次编号)
  const summary = sedimentSummary()
  const batch = listBatches().find((item) => item.测次编号 === 测次编号)
  const lines: string[] = []
  lines.push('测淤成果归总')
  lines.push(['测次编号', 测次编号].join(','))
  lines.push(['测量日期', batch?.测量日期 ?? ''].join(','))
  lines.push(['断面数', rows.length].join(','))
  lines.push(['缺测断面', rows.filter((row) => row.abnormal).length].join(','))
  lines.push(['本测次库容损失(万m³)', (batch?.库容损失 ?? 0).toFixed(2)].join(','))
  lines.push(['最新测次', summary.latestBatch].join(','))
  lines.push(['累计库容损失(万m³)', summary.totalLoss.toFixed(2)].join(','))
  lines.push(['可用库容(万m³)', summary.availableCapacity.toFixed(2)].join(','))
  lines.push(['可用台数(台)', summary.availableUnits].join(','))
  lines.push(['估算日发电量(万kWh)', summary.dailyEnergy.toFixed(2)].join(','))
  lines.push('')
  lines.push('断面明细')
  lines.push(['断面编号', '测量日期', '起点距', '断面高程', '淤积厚度', '库容损失(万m³)', '淤积等级', '登记方式', '当前状态'].join(','))
  for (const row of rows) {
    lines.push(
      [
        row['断面编号'],
        row['测量日期'],
        row['起点距'],
        row['断面高程'],
        row['淤积厚度'],
        row['库容损失'],
        row['淤积等级'],
        row['登记方式'] ?? '导入',
        row.status,
      ].join(','),
    )
  }
  return { filename: `测淤成果-${测次编号}-归总.csv`, content: `﻿${lines.join('\n')}` }
}

export function downloadBatch(测次编号: string): void {
  const { filename, content } = exportBatch(测次编号)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}
