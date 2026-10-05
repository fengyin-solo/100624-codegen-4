import { listRows, saveBatch } from '@/data/local-store'
import type { EntryRow } from '@/data/types'

// 库区测淤的专用服务：整批导入、逐行校验、按测次覆盖、库容损失归总并回写发电计划。
// 与 local-service 一样只操作本地数据层，换回后端时页面不用改。

export const SEDIMENT_KEY = 'sediment'
export const GENERATION_KEY = 'generation'

// 平台上线日：早于这一天的测淤测次按历史资料补录，缺失取值单独标注「缺测」。
export const PLATFORM_ONLINE_DATE = '2026-01-01'
// 设计库容（万m³）与机组台数：可用库容、可用台数、日发电量估算都从这里推。
export const DESIGN_CAPACITY = 12800
export const UNIT_TOTAL = 4
// 单断面库容损失折算系数（万m³/m）与单位库容日发电量折算系数（万kWh/万m³）。
const LOSS_FACTOR = 0.8
const ENERGY_FACTOR = 0.018

const SECTION_PATTERN = /^DM-\d{2,}$/
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

export type ParsedRow = {
  campaign: string
  date: string
  section: string
  distance: number
  elevation: number
  thickness: number | null
}

export type RejectedRow = {
  line: number
  content: string
  reason: string
}

export type ImportResult = {
  ok: boolean
  message: string
  campaign: string
  accepted: number
  rejected: RejectedRow[]
  overwritten: boolean
}

export type CampaignSummary = {
  code: string
  date: string
  sections: number
  totalLoss: number
  missing: number
}

export type CapacitySummary = {
  campaign: string
  date: string
  totalLoss: number
  available: number
  units: number
  energy: number
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}

function toNumber(value: unknown): number | null {
  const num = Number(value)
  return Number.isFinite(num) ? num : null
}

// 沿用原有的等级划分：按淤积厚度分级，新的一版导入不改这套口径。
export function gradeOf(thickness: number): string {
  if (thickness < 0.5) return '轻度'
  if (thickness < 1.5) return '中度'
  if (thickness < 3) return '重度'
  return '严重'
}

function availableUnits(available: number): number {
  const ratio = available / DESIGN_CAPACITY
  if (ratio >= 0.8) return UNIT_TOTAL
  if (ratio >= 0.6) return Math.min(UNIT_TOTAL, 3)
  if (ratio >= 0.4) return Math.min(UNIT_TOTAL, 2)
  if (ratio >= 0.2) return Math.min(UNIT_TOTAL, 1)
  return 0
}

function isValidDate(value: string): boolean {
  if (!DATE_PATTERN.test(value)) return false
  const parsed = new Date(`${value}T00:00:00`)
  return !Number.isNaN(parsed.getTime())
}

// 逐行校验成果文件：格式不对或高程缺失的行挑出来交代缘由，其余行照常入库。
export function parseSurvey(text: string): { rows: ParsedRow[]; rejected: RejectedRow[] } {
  const rejected: RejectedRow[] = []
  const rows: ParsedRow[] = []
  const lines = text.split(/\r?\n/)
  let fileCampaign = ''
  let dataStarted = false
  lines.forEach((raw, index) => {
    const line = raw.trim()
    if (line === '') return
    const lineNo = index + 1
    // 表头行：含「断面编号」的首行视为表头跳过，其余行一律按数据处理。
    if (!dataStarted && line.includes('断面编号')) {
      dataStarted = true
      return
    }
    dataStarted = true
    const cells = line.split(',').map((cell) => cell.trim())
    if (cells.length !== 6) {
      rejected.push({ line: lineNo, content: line, reason: `列数不对（${cells.length} 列），应为 6 列：测次编号,测量日期,断面编号,起点距,断面高程,淤积厚度` })
      return
    }
    const [campaign, date, section, distanceText, elevationText, thicknessText] = cells
    if (campaign === '') {
      rejected.push({ line: lineNo, content: line, reason: '测次编号为空' })
      return
    }
    if (fileCampaign === '') fileCampaign = campaign
    if (campaign !== fileCampaign) {
      rejected.push({ line: lineNo, content: line, reason: `测次编号与文件测次「${fileCampaign}」不一致，请按测次拆分文件` })
      return
    }
    if (!isValidDate(date)) {
      rejected.push({ line: lineNo, content: line, reason: `测量日期「${date}」格式不对，应为 YYYY-MM-DD` })
      return
    }
    if (!SECTION_PATTERN.test(section)) {
      rejected.push({ line: lineNo, content: line, reason: `断面编号「${section}」格式不对，应为 DM-加数字（如 DM-03）` })
      return
    }
    const distance = toNumber(distanceText)
    if (distance === null || distance < 0) {
      rejected.push({ line: lineNo, content: line, reason: `起点距「${distanceText}」不是有效数字` })
      return
    }
    if (elevationText === '') {
      rejected.push({ line: lineNo, content: line, reason: '高程缺失，该行不入库' })
      return
    }
    const elevation = toNumber(elevationText)
    if (elevation === null) {
      rejected.push({ line: lineNo, content: line, reason: `断面高程「${elevationText}」不是有效数字` })
      return
    }
    let thickness: number | null = null
    if (thicknessText === '' || thicknessText === '缺测') {
      thickness = null
    } else {
      const parsed = toNumber(thicknessText)
      if (parsed === null || parsed < 0) {
        rejected.push({ line: lineNo, content: line, reason: `淤积厚度「${thicknessText}」不是有效数字` })
        return
      }
      thickness = parsed
    }
    rows.push({ campaign, date, section, distance, elevation, thickness })
  })
  return { rows, rejected }
}

function campaignsOf(rows: EntryRow[]): CampaignSummary[] {
  const groups = new Map<string, EntryRow[]>()
  for (const row of rows) {
    const code = String(row['测次编号'] ?? '')
    if (code === '') continue
    const list = groups.get(code) ?? []
    list.push(row)
    groups.set(code, list)
  }
  return [...groups.entries()]
    .map(([code, items]) => {
      const dates = items.map((item) => String(item['测量日期'] ?? '')).filter(Boolean).sort()
      const totalLoss = round2(
        items.reduce((sum, item) => sum + (toNumber(item['库容损失']) ?? 0), 0),
      )
      return {
        code,
        date: dates[0] ?? '',
        sections: items.length,
        totalLoss,
        missing: items.filter((item) => item['淤积厚度'] === '缺测').length,
      }
    })
    .sort((a, b) => a.date.localeCompare(b.date) || a.code.localeCompare(b.code))
}

export function listCampaigns(): CampaignSummary[] {
  return campaignsOf(listRows(SEDIMENT_KEY))
}

export function campaignRows(code: string): EntryRow[] {
  return listRows(SEDIMENT_KEY)
    .filter((row) => String(row['测次编号']) === code)
    .sort((a, b) => String(a['断面编号']).localeCompare(String(b['断面编号'])))
}

// 按测量日期定位相邻测次，方便对照淤积厚度变化。
export function adjacentCampaign(code: string, direction: -1 | 1): CampaignSummary | null {
  const campaigns = listCampaigns()
  const index = campaigns.findIndex((item) => item.code === code)
  if (index < 0) return null
  return campaigns[index + direction] ?? null
}

// 当前测次相对上一测次的淤积厚度变化：断面编号 → 差值（米），缺测或上一测次没有该断面时为 null。
export function thicknessChanges(code: string): Record<string, number | null> {
  const previous = adjacentCampaign(code, -1)
  const changes: Record<string, number | null> = {}
  const previousRows = previous ? campaignRows(previous.code) : []
  const previousBySection = new Map(previousRows.map((row) => [String(row['断面编号']), row]))
  for (const row of campaignRows(code)) {
    const section = String(row['断面编号'])
    const current = toNumber(row['淤积厚度'])
    const before = previousBySection.has(section) ? toNumber(previousBySection.get(section)!['淤积厚度']) : null
    changes[section] = current !== null && before !== null ? round2(current - before) : null
  }
  return changes
}

function capacityOf(rows: EntryRow[]): CapacitySummary {
  const campaigns = campaignsOf(rows)
  const latest = campaigns[campaigns.length - 1]
  if (!latest) {
    return {
      campaign: '',
      date: '',
      totalLoss: 0,
      available: DESIGN_CAPACITY,
      units: UNIT_TOTAL,
      energy: round2(DESIGN_CAPACITY * ENERGY_FACTOR),
    }
  }
  const available = round2(DESIGN_CAPACITY - latest.totalLoss)
  return {
    campaign: latest.code,
    date: latest.date,
    totalLoss: latest.totalLoss,
    available,
    units: availableUnits(available),
    energy: round2(available * ENERGY_FACTOR),
  }
}

// 库容损失归总：以最新测次为准，推出可用库容、可用台数与日发电量估算。
export function capacitySummary(): CapacitySummary {
  return capacityOf(listRows(SEDIMENT_KEY))
}

// 估算结果回写发电计划台账：计划日期不早于最新测次测量日期的计划按新测次重算。
function rebuildGenerationRows(summary: CapacitySummary): EntryRow[] {
  return listRows(GENERATION_KEY).map((row) => {
    const planDate = String(row['计划日期'] ?? '')
    if (summary.date !== '' && planDate !== '' && planDate < summary.date) return row
    return {
      ...row,
      '可用库容': String(summary.available),
      '可用台数': String(summary.units),
      '日发电量': String(summary.energy),
    }
  })
}

// 整批导入：同一测次重复导入按测量日期覆盖旧版而不是叠加；
// 已归档断面的等级结论沿用旧版不改写；断面台账与发电计划成套落库，失败整套回滚。
export function importSurvey(text: string): ImportResult {
  const { rows, rejected } = parseSurvey(text)
  if (rows.length === 0) {
    return { ok: false, message: '没有可入库的有效行，未改动台账', campaign: '', accepted: 0, rejected, overwritten: false }
  }
  const code = rows[0].campaign
  const date = rows.map((row) => row.date).sort()[0]
  const existing = listRows(SEDIMENT_KEY)
  const archivedBySection = new Map(
    existing
      .filter((row) => String(row['测次编号']) === code && row.status === '已归档')
      .map((row) => [String(row['断面编号']), row]),
  )
  const overwritten = existing.some((row) => String(row['测次编号']) === code)
  const kept = existing.filter((row) => String(row['测次编号']) !== code)
  let nextId = existing.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
  const imported: EntryRow[] = rows.map((row) => {
    const previous = archivedBySection.get(row.section)
    const missing = row.thickness === null
    const entry: EntryRow = {
      id: nextId++,
      status: previous ? String(previous.status) : '待入库',
      pending: previous ? Boolean(previous.pending) : true,
      abnormal: missing,
      '测次编号': code,
      '测量日期': row.date,
      '断面编号': row.section,
      '起点距': row.distance,
      '断面高程': row.elevation,
      '淤积厚度': missing ? '缺测' : (row.thickness as number),
      '库容损失': missing ? '缺测' : round2((row.thickness as number) * LOSS_FACTOR),
      '淤积等级': previous
        ? String(previous['淤积等级'])
        : missing
          ? '缺测'
          : gradeOf(row.thickness as number),
      '数据来源': row.date < PLATFORM_ONLINE_DATE ? '历史补录' : '测量导入',
    }
    return entry
  })
  const nextSediment = [...kept, ...imported]
  const summary = capacityOf(nextSediment)
  const nextGeneration = rebuildGenerationRows(summary)
  try {
    saveBatch({ [SEDIMENT_KEY]: nextSediment, [GENERATION_KEY]: nextGeneration })
  } catch (error) {
    return {
      ok: false,
      message: `落库失败，已整套回滚，未写入任何记录：${error instanceof Error ? error.message : String(error)}`,
      campaign: code,
      accepted: 0,
      rejected,
      overwritten,
    }
  }
  const action = overwritten ? `已按测量日期 ${date} 覆盖旧版` : '新测次入库'
  return {
    ok: true,
    message: `测次 ${code} ${action}：入库 ${imported.length} 行，剔除 ${rejected.length} 行；可用库容 ${summary.available} 万m³、可用台数 ${summary.units} 台已同步发电计划`,
    campaign: code,
    accepted: imported.length,
    rejected,
    overwritten,
  }
}

// 按测次归总另存：断面成果与库容损失打包成一份文件，明细与页面列表同一份数据。
export function exportCampaignPackage(code: string): { filename: string; content: string } {
  const rows = campaignRows(code)
  const campaigns = listCampaigns()
  const campaign = campaigns.find((item) => item.code === code)
  const latest = capacitySummary()
  const totalLoss = campaign?.totalLoss ?? 0
  const available = round2(DESIGN_CAPACITY - totalLoss)
  const lines: string[] = []
  lines.push('测次归总')
  lines.push(`测次编号,${code}`)
  lines.push(`测量日期,${campaign?.date ?? ''}`)
  lines.push(`断面数,${rows.length}`)
  lines.push(`缺测断面,${campaign?.missing ?? 0}`)
  lines.push(`库容损失合计(万m³),${totalLoss}`)
  lines.push(`可用库容(万m³),${available}`)
  lines.push(`可用台数,${availableUnits(available)}`)
  lines.push(`日发电量估算(万kWh),${round2(available * ENERGY_FACTOR)}`)
  lines.push(`当前发电计划同步测次,${latest.campaign || '—'}`)
  lines.push('')
  lines.push('断面成果明细')
  lines.push('测次编号,测量日期,断面编号,起点距,断面高程,淤积厚度,库容损失,淤积等级,数据来源,台账状态')
  for (const row of rows) {
    lines.push(
      [
        row['测次编号'],
        row['测量日期'],
        row['断面编号'],
        row['起点距'],
        row['断面高程'],
        row['淤积厚度'],
        row['库容损失'],
        row['淤积等级'],
        row['数据来源'],
        row.status,
      ].join(','),
    )
  }
  return { filename: `测次${code}-断面成果与库容损失归总.csv`, content: `﻿${lines.join('\n')}` }
}

export function downloadCampaignPackage(code: string): void {
  const { filename, content } = exportCampaignPackage(code)
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
