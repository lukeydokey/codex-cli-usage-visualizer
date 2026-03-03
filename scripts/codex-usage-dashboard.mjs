#!/usr/bin/env node

import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

const DEFAULT_SESSIONS_DIR = path.join(os.homedir(), '.codex', 'sessions')
const DEFAULT_OUTPUT = path.resolve(process.cwd(), 'codex-usage-dashboard.html')
const DEFAULT_DAYS = 14
const DEFAULT_PORT = 4789

function parseArgs(argv) {
  const options = {
    sessionsDir: DEFAULT_SESSIONS_DIR,
    output: DEFAULT_OUTPUT,
    days: DEFAULT_DAYS,
    port: DEFAULT_PORT,
    serve: false,
    json: false,
    help: false,
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]

    if (arg === '--help' || arg === '-h') {
      options.help = true
      continue
    }

    if (arg === '--serve') {
      options.serve = true
      continue
    }

    if (arg === '--json') {
      options.json = true
      continue
    }

    if (arg === '--sessions-dir') {
      const value = argv[index + 1]
      if (!value) {
        throw new Error('--sessions-dir requires a value')
      }
      options.sessionsDir = expandHome(value)
      index += 1
      continue
    }

    if (arg === '--output') {
      const value = argv[index + 1]
      if (!value) {
        throw new Error('--output requires a value')
      }
      options.output = path.resolve(process.cwd(), value)
      index += 1
      continue
    }

    if (arg === '--days') {
      const value = argv[index + 1]
      if (!value) {
        throw new Error('--days requires a value')
      }
      const parsed = Number.parseInt(value, 10)
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error('--days must be a positive integer')
      }
      options.days = parsed
      index += 1
      continue
    }

    if (arg === '--port') {
      const value = argv[index + 1]
      if (!value) {
        throw new Error('--port requires a value')
      }
      const parsed = Number.parseInt(value, 10)
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error('--port must be a positive integer')
      }
      options.port = parsed
      index += 1
      continue
    }

    throw new Error(`Unknown argument: ${arg}`)
  }

  return options
}

function expandHome(value) {
  if (value.startsWith('~/') || value.startsWith('~\\')) {
    return path.join(os.homedir(), value.slice(2))
  }

  if (value === '~') {
    return os.homedir()
  }

  return value
}

function parseDate(value) {
  if (!value) {
    return null
  }

  const parsed = new Date(value)
  if (!Number.isFinite(parsed.getTime())) {
    return null
  }

  return parsed
}

function parseUnixSeconds(value) {
  const seconds = Number(value)
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return null
  }
  return new Date(seconds * 1000)
}

function formatDay(value) {
  const year = value.getFullYear()
  const month = String(value.getMonth() + 1).padStart(2, '0')
  const day = String(value.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function formatNumber(value) {
  return new Intl.NumberFormat('en-US').format(value)
}

function formatCompact(value) {
  if (value >= 1000000) {
    return `${(value / 1000000).toFixed(1)}M`
  }
  if (value >= 1000) {
    return `${(value / 1000).toFixed(1)}K`
  }
  return String(value)
}

function formatPercent(value) {
  if (value == null || !Number.isFinite(value)) {
    return '-'
  }
  return `${value.toFixed(1)}%`
}

function formatDateTime(value) {
  const parsed = parseDate(value)
  return parsed ? parsed.toLocaleString() : '-'
}

function clamp(value, min, max) {
  if (!Number.isFinite(value)) {
    return null
  }
  return Math.min(max, Math.max(min, value))
}

function collectSessionFiles(rootDir) {
  if (!fs.existsSync(rootDir)) {
    return []
  }

  const files = []
  const stack = [rootDir]

  while (stack.length > 0) {
    const current = stack.pop()
    const entries = fs.readdirSync(current, { withFileTypes: true })

    for (const entry of entries) {
      const fullPath = path.join(current, entry.name)
      if (entry.isDirectory()) {
        stack.push(fullPath)
      } else if (entry.isFile() && entry.name.startsWith('rollout-') && entry.name.endsWith('.jsonl')) {
        files.push(fullPath)
      }
    }
  }

  return files.sort()
}

function createEmptySession(filePath) {
  return {
    filePath,
    sessionId: path.basename(filePath, '.jsonl'),
    cwd: '',
    cliVersion: '',
    modelProvider: '',
    model: 'Unknown',
    startedAt: null,
    endedAt: null,
    tokens: {
      input: 0,
      cachedInput: 0,
      output: 0,
      reasoningOutput: 0,
      total: 0,
    },
    toolCalls: 0,
    toolCounts: {},
    agentMessages: 0,
    reasoningEvents: 0,
    phaseCounts: {},
    latestRateLimits: null,
    latestRateLimitsAt: null,
    agentLogs: [],
  }
}

function incrementCount(container, key, amount = 1) {
  if (!Object.prototype.hasOwnProperty.call(container, key)) {
    container[key] = 0
  }
  container[key] += amount
}

function extractAssistantText(content) {
  if (!Array.isArray(content)) {
    return ''
  }

  const chunks = []
  for (const item of content) {
    if (!item || typeof item !== 'object') {
      continue
    }

    if ((item.type === 'output_text' || item.type === 'input_text') && typeof item.text === 'string') {
      chunks.push(item.text)
    }
  }

  return chunks.join('\n').trim()
}

function pushAgentLog(session, entry) {
  const message = typeof entry.message === 'string' ? entry.message.trim() : ''
  if (!message) {
    return
  }

  session.agentLogs.push({
    timestamp: entry.timestamp || null,
    phase: entry.phase || 'unknown',
    source: entry.source || 'agent',
    message,
  })
}

function parseSessionFile(filePath) {
  const session = createEmptySession(filePath)
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/)

  let earliestTimestamp = null
  let latestTimestamp = null

  for (const line of lines) {
    if (!line) {
      continue
    }

    let parsed
    try {
      parsed = JSON.parse(line)
    } catch {
      continue
    }

    const timestamp = parseDate(parsed.timestamp)
    const timestampIso = timestamp ? timestamp.toISOString() : null
    if (timestamp) {
      if (!earliestTimestamp || timestamp < earliestTimestamp) {
        earliestTimestamp = timestamp
      }
      if (!latestTimestamp || timestamp > latestTimestamp) {
        latestTimestamp = timestamp
      }
    }

    if (parsed.type === 'session_meta') {
      const payload = parsed.payload ?? {}
      session.sessionId = payload.id || session.sessionId
      session.cwd = payload.cwd || session.cwd
      session.cliVersion = payload.cli_version || session.cliVersion
      session.modelProvider = payload.model_provider || session.modelProvider

      const startedAt = parseDate(payload.timestamp)
      if (startedAt) {
        session.startedAt = startedAt
      }
      continue
    }

    if (parsed.type === 'event_msg') {
      const payload = parsed.payload ?? {}

      if (payload.type === 'token_count') {
        if (payload.rate_limits && payload.rate_limits.limit_name) {
          session.model = payload.rate_limits.limit_name
        }

        const totalUsage = payload.info && payload.info.total_token_usage
        if (totalUsage && Number.isFinite(totalUsage.total_tokens)) {
          if (totalUsage.total_tokens >= session.tokens.total) {
            session.tokens = {
              input: totalUsage.input_tokens || 0,
              cachedInput: totalUsage.cached_input_tokens || 0,
              output: totalUsage.output_tokens || 0,
              reasoningOutput: totalUsage.reasoning_output_tokens || 0,
              total: totalUsage.total_tokens || 0,
            }
          }
        }

        if (payload.rate_limits) {
          const rateEventTime = timestamp || latestTimestamp || new Date(0)
          if (!session.latestRateLimitsAt || rateEventTime > session.latestRateLimitsAt) {
            session.latestRateLimitsAt = rateEventTime
            session.latestRateLimits = payload.rate_limits
          }
        }
      }

      if (payload.type === 'agent_message') {
        session.agentMessages += 1
        incrementCount(session.phaseCounts, payload.phase || 'unknown')
        pushAgentLog(session, {
          timestamp: timestampIso,
          phase: payload.phase || 'commentary',
          source: 'agent_message',
          message: payload.message,
        })
      }

      if (payload.type === 'agent_reasoning') {
        session.reasoningEvents += 1
      }
      continue
    }

    if (parsed.type === 'response_item') {
      const payload = parsed.payload ?? {}
      if (payload.type === 'function_call') {
        session.toolCalls += 1
        incrementCount(session.toolCounts, payload.name || 'unknown')
        continue
      }

      if (payload.type === 'message' && payload.role === 'assistant' && payload.phase === 'final') {
        const text = extractAssistantText(payload.content)
        if (text) {
          pushAgentLog(session, {
            timestamp: timestampIso,
            phase: 'final',
            source: 'assistant_final',
            message: text,
          })
        }
      }
    }
  }

  if (!session.startedAt) {
    session.startedAt = earliestTimestamp
  }
  session.endedAt = latestTimestamp || session.startedAt

  if (!session.startedAt || !session.endedAt) {
    const fallbackDate = fs.statSync(filePath).mtime
    session.startedAt = session.startedAt || fallbackDate
    session.endedAt = session.endedAt || fallbackDate
  }

  if (session.model === 'Unknown' && session.modelProvider) {
    session.model = `${session.modelProvider} (unspecified model)`
  }

  return session
}

function mapToSortedRows(countMap, keyName) {
  return Object.entries(countMap)
    .map(([key, count]) => ({ [keyName]: key, count }))
    .sort((left, right) => {
      if (right.count !== left.count) {
        return right.count - left.count
      }
      return String(left[keyName]).localeCompare(String(right[keyName]))
    })
}

function buildRateWindow(rateWindow) {
  if (!rateWindow || typeof rateWindow !== 'object') {
    return null
  }

  const usedPercent = clamp(Number(rateWindow.used_percent), 0, 100)
  const remainingPercent = usedPercent == null ? null : clamp(100 - usedPercent, 0, 100)

  return {
    usedPercent,
    remainingPercent,
    windowMinutes: Number.isFinite(Number(rateWindow.window_minutes)) ? Number(rateWindow.window_minutes) : null,
    resetsAt: parseUnixSeconds(rateWindow.resets_at)?.toISOString() || null,
  }
}

function buildLiveUsage(latestSnapshot) {
  if (!latestSnapshot || !latestSnapshot.rateLimits) {
    return {
      available: false,
      lastUpdatedAt: null,
      modelLimitName: null,
      modelLimitId: null,
      primary: null,
      secondary: null,
      credits: null,
      planType: null,
      sessionId: null,
      cwd: null,
    }
  }

  const rateLimits = latestSnapshot.rateLimits
  return {
    available: true,
    lastUpdatedAt: latestSnapshot.timestamp,
    modelLimitName: rateLimits.limit_name || null,
    modelLimitId: rateLimits.limit_id || null,
    primary: buildRateWindow(rateLimits.primary),
    secondary: buildRateWindow(rateLimits.secondary),
    credits: rateLimits.credits || null,
    planType: rateLimits.plan_type || null,
    sessionId: latestSnapshot.sessionId || null,
    cwd: latestSnapshot.cwd || null,
  }
}

function buildMetrics(sessionsDir, days) {
  const files = collectSessionFiles(sessionsDir)
  const sessions = files.map((filePath) => parseSessionFile(filePath))

  const totals = {
    sessions: sessions.length,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
    toolCalls: 0,
    agentMessages: 0,
    reasoningEvents: 0,
  }

  const perDay = new Map()
  const toolUsage = {}
  const modelUsage = {}
  const phaseUsage = {}
  const projectUsage = {}
  const feedItems = []

  let latestRateSnapshot = null

  for (const session of sessions) {
    totals.inputTokens += session.tokens.input
    totals.cachedInputTokens += session.tokens.cachedInput
    totals.outputTokens += session.tokens.output
    totals.reasoningOutputTokens += session.tokens.reasoningOutput
    totals.totalTokens += session.tokens.total
    totals.toolCalls += session.toolCalls
    totals.agentMessages += session.agentMessages
    totals.reasoningEvents += session.reasoningEvents

    incrementCount(modelUsage, session.model)

    for (const [toolName, count] of Object.entries(session.toolCounts)) {
      incrementCount(toolUsage, toolName, count)
    }

    for (const [phaseName, count] of Object.entries(session.phaseCounts)) {
      incrementCount(phaseUsage, phaseName, count)
    }

    if (session.latestRateLimits) {
      const rateTimestamp = session.latestRateLimitsAt ? session.latestRateLimitsAt.toISOString() : session.endedAt.toISOString()
      if (!latestRateSnapshot || parseDate(rateTimestamp) > parseDate(latestRateSnapshot.timestamp)) {
        latestRateSnapshot = {
          timestamp: rateTimestamp,
          rateLimits: session.latestRateLimits,
          sessionId: session.sessionId,
          cwd: session.cwd || '(unknown cwd)',
        }
      }
    }

    for (const log of session.agentLogs) {
      feedItems.push({
        timestamp: log.timestamp || session.startedAt.toISOString(),
        phase: log.phase || 'unknown',
        source: log.source || 'agent',
        message: log.message,
        sessionId: session.sessionId,
        model: session.model,
        cwd: session.cwd || '(unknown cwd)',
      })
    }

    const projectKey = session.cwd || '(unknown cwd)'
    if (!Object.prototype.hasOwnProperty.call(projectUsage, projectKey)) {
      projectUsage[projectKey] = {
        cwd: projectKey,
        sessions: 0,
        tokens: 0,
        toolCalls: 0,
        agentMessages: 0,
      }
    }

    projectUsage[projectKey].sessions += 1
    projectUsage[projectKey].tokens += session.tokens.total
    projectUsage[projectKey].toolCalls += session.toolCalls
    projectUsage[projectKey].agentMessages += session.agentMessages

    const dayKey = formatDay(session.startedAt)
    if (!perDay.has(dayKey)) {
      perDay.set(dayKey, {
        date: dayKey,
        sessions: 0,
        tokens: 0,
        toolCalls: 0,
        agentMessages: 0,
      })
    }

    const dayBucket = perDay.get(dayKey)
    dayBucket.sessions += 1
    dayBucket.tokens += session.tokens.total
    dayBucket.toolCalls += session.toolCalls
    dayBucket.agentMessages += session.agentMessages
  }

  const today = new Date()
  today.setHours(0, 0, 0, 0)

  const daily = []
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const currentDate = new Date(today)
    currentDate.setDate(today.getDate() - offset)
    const key = formatDay(currentDate)
    daily.push(
      perDay.get(key) || {
        date: key,
        sessions: 0,
        tokens: 0,
        toolCalls: 0,
        agentMessages: 0,
      }
    )
  }

  feedItems.sort((left, right) => {
    const leftDate = parseDate(left.timestamp)
    const rightDate = parseDate(right.timestamp)
    const leftTime = leftDate ? leftDate.getTime() : 0
    const rightTime = rightDate ? rightDate.getTime() : 0
    return rightTime - leftTime
  })

  const latestByPhase = {}
  for (const item of feedItems) {
    if (!Object.prototype.hasOwnProperty.call(latestByPhase, item.phase)) {
      latestByPhase[item.phase] = item
    }
  }

  const agentChannels = mapToSortedRows(phaseUsage, 'phase').map((row) => ({
    phase: row.phase,
    count: row.count,
    latestMessage: latestByPhase[row.phase] ? latestByPhase[row.phase].message : '',
    latestAt: latestByPhase[row.phase] ? latestByPhase[row.phase].timestamp : null,
  }))

  const topProjects = Object.values(projectUsage)
    .sort((left, right) => {
      if (right.tokens !== left.tokens) {
        return right.tokens - left.tokens
      }
      return right.sessions - left.sessions
    })
    .slice(0, 10)

  const recentSessions = [...sessions]
    .sort((left, right) => right.startedAt.getTime() - left.startedAt.getTime())
    .slice(0, 20)
    .map((session) => ({
      startedAt: session.startedAt.toISOString(),
      sessionId: session.sessionId,
      model: session.model,
      cwd: session.cwd || '(unknown cwd)',
      tokens: session.tokens.total,
      toolCalls: session.toolCalls,
      agentMessages: session.agentMessages,
      reasoningEvents: session.reasoningEvents,
      filePath: session.filePath,
    }))

  return {
    generatedAt: new Date().toISOString(),
    sessionsDir,
    scannedFiles: files.length,
    days,
    totals,
    cacheHitRatio: totals.inputTokens > 0 ? totals.cachedInputTokens / totals.inputTokens : 0,
    liveUsage: buildLiveUsage(latestRateSnapshot),
    agentFeed: feedItems.slice(0, 120),
    agentChannels,
    daily,
    topTools: mapToSortedRows(toolUsage, 'name').slice(0, 15),
    topModels: mapToSortedRows(modelUsage, 'name'),
    topProjects,
    recentSessions,
  }
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function escapeWithBreaks(value) {
  return escapeHtml(value).replace(/\n/g, '<br />')
}

function shortenPath(value, maxLength = 70) {
  if (!value || value.length <= maxLength) {
    return value || ''
  }
  const prefixLength = Math.floor((maxLength - 3) / 2)
  const suffixLength = maxLength - 3 - prefixLength
  return `${value.slice(0, prefixLength)}...${value.slice(value.length - suffixLength)}`
}

function renderBarRows(rows, valueKey, formatter) {
  const maxValue = Math.max(...rows.map((row) => row[valueKey]), 1)
  return rows
    .map((row) => {
      const width = Math.round((row[valueKey] / maxValue) * 100)
      return `
      <div class="bar-row">
        <div class="bar-label">${escapeHtml(row.date)}</div>
        <div class="bar-track"><div class="bar-fill" style="width:${width}%"></div></div>
        <div class="bar-value">${escapeHtml(formatter(row[valueKey]))}</div>
      </div>`
    })
    .join('')
}

function renderTable(rows, columns, emptyMessage) {
  if (rows.length === 0) {
    return `<div class="empty">${escapeHtml(emptyMessage)}</div>`
  }

  const header = columns.map((column) => `<th>${escapeHtml(column.header)}</th>`).join('')
  const body = rows
    .map((row) => `<tr>${columns.map((column) => `<td>${escapeHtml(column.render(row))}</td>`).join('')}</tr>`)
    .join('')

  return `<table><thead><tr>${header}</tr></thead><tbody>${body}</tbody></table>`
}

function renderRateWindowCard(title, windowData) {
  if (!windowData) {
    return `
    <article class="usage-card">
      <div class="usage-title">${escapeHtml(title)}</div>
      <div class="usage-value">-</div>
      <div class="usage-sub">No data</div>
      <div class="usage-progress"><div class="usage-progress-fill" style="width:0%"></div></div>
    </article>`
  }

  const remaining = windowData.remainingPercent == null ? 0 : windowData.remainingPercent

  return `
  <article class="usage-card">
    <div class="usage-title">${escapeHtml(title)}</div>
    <div class="usage-value">${escapeHtml(formatPercent(windowData.remainingPercent))}<span class="usage-unit">remaining</span></div>
    <div class="usage-sub">Used ${escapeHtml(formatPercent(windowData.usedPercent))} | Window ${escapeHtml(windowData.windowMinutes || '-')} min</div>
    <div class="usage-progress"><div class="usage-progress-fill" style="width:${remaining}%"></div></div>
    <div class="usage-sub">Resets at ${escapeHtml(formatDateTime(windowData.resetsAt))}</div>
  </article>`
}

function renderAgentChannelCards(channels) {
  if (channels.length === 0) {
    return '<div class="empty">No agent channel activity yet.</div>'
  }

  return channels
    .slice(0, 6)
    .map(
      (channel) => `
      <article class="channel-card">
        <div class="channel-head">
          <span class="chip chip-phase">${escapeHtml(channel.phase)}</span>
          <span class="channel-count">${escapeHtml(formatNumber(channel.count))} msgs</span>
        </div>
        <div class="channel-message">${escapeWithBreaks(shortenPath(channel.latestMessage || '', 160))}</div>
        <div class="channel-time">${escapeHtml(formatDateTime(channel.latestAt))}</div>
      </article>`
    )
    .join('')
}

function renderMessageFeed(feedItems) {
  if (feedItems.length === 0) {
    return '<div class="empty">No agent messages found.</div>'
  }

  return `
  <div class="message-feed">
    ${feedItems
      .map(
        (item) => `
        <article class="message-item">
          <div class="message-meta">
            <span class="chip chip-phase">${escapeHtml(item.phase)}</span>
            <span class="chip chip-source">${escapeHtml(item.source)}</span>
            <span class="message-time">${escapeHtml(formatDateTime(item.timestamp))}</span>
          </div>
          <div class="message-text">${escapeWithBreaks(item.message)}</div>
          <div class="message-context">${escapeHtml(item.model)} | ${escapeHtml(shortenPath(item.cwd, 78))}</div>
        </article>`
      )
      .join('')}
  </div>`
}

function renderDashboard(metrics, options) {
  const tokenBars = renderBarRows(metrics.daily, 'tokens', formatCompact)
  const sessionBars = renderBarRows(metrics.daily, 'sessions', formatNumber)
  const toolBars = renderBarRows(metrics.daily, 'toolCalls', formatNumber)

  const topTools = renderTable(
    metrics.topTools,
    [
      { header: 'Tool', render: (row) => row.name },
      { header: 'Calls', render: (row) => formatNumber(row.count) },
    ],
    'No tool calls detected.'
  )

  const topModels = renderTable(
    metrics.topModels,
    [
      { header: 'Model', render: (row) => row.name },
      { header: 'Sessions', render: (row) => formatNumber(row.count) },
    ],
    'No model information available.'
  )

  const topProjects = renderTable(
    metrics.topProjects,
    [
      { header: 'Project (cwd)', render: (row) => shortenPath(row.cwd, 75) },
      { header: 'Sessions', render: (row) => formatNumber(row.sessions) },
      { header: 'Tokens', render: (row) => formatNumber(row.tokens) },
      { header: 'Tool Calls', render: (row) => formatNumber(row.toolCalls) },
      { header: 'Agent Msg', render: (row) => formatNumber(row.agentMessages) },
    ],
    'No project activity detected.'
  )

  const recentSessions = renderTable(
    metrics.recentSessions,
    [
      { header: 'Started', render: (row) => formatDateTime(row.startedAt) },
      { header: 'Model', render: (row) => row.model },
      { header: 'Tokens', render: (row) => formatNumber(row.tokens) },
      { header: 'Tool Calls', render: (row) => formatNumber(row.toolCalls) },
      { header: 'Agent Msg', render: (row) => formatNumber(row.agentMessages) },
      { header: 'Project', render: (row) => shortenPath(row.cwd, 48) },
    ],
    'No sessions detected.'
  )

  const usageSummary = metrics.liveUsage
  const primaryCard = renderRateWindowCard('Primary Window', usageSummary.primary)
  const secondaryCard = renderRateWindowCard('Secondary Window', usageSummary.secondary)
  const refreshBadge = options.autoRefresh ? '<span class="pill">Auto refresh 10s</span>' : '<span class="pill">Static snapshot</span>'

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Codex CLI Usage Visualizer</title>
  <style>
    :root {
      --bg-0: #edf7ff;
      --bg-1: #f9fffd;
      --ink: #0c1425;
      --muted: #54627d;
      --line: #d8e1ee;
      --panel: #ffffff;
      --brand: #0f6ad9;
      --brand-2: #16a086;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: 'IBM Plex Sans', 'Manrope', 'Segoe UI', sans-serif;
      color: var(--ink);
      background: radial-gradient(circle at 0% 0%, #d9ecff 0%, transparent 42%), radial-gradient(circle at 100% 0%, #dbfff2 0%, transparent 45%), linear-gradient(180deg, var(--bg-0), var(--bg-1));
    }
    .container { max-width: 1320px; margin: 0 auto; padding: 20px; }
    .hero { border: 1px solid var(--line); border-radius: 18px; background: linear-gradient(140deg, #fff 0%, #f2f8ff 50%, #eefff8 100%); padding: 20px; margin-bottom: 14px; }
    .hero-top { display: flex; justify-content: space-between; gap: 8px; flex-wrap: wrap; align-items: center; }
    .hero h1 { margin: 0; font-size: 30px; letter-spacing: -0.03em; }
    .pill { border: 1px solid #a9ddcf; background: #e9fff8; color: #0d725f; border-radius: 999px; padding: 3px 10px; font-size: 12px; font-weight: 700; }
    .meta { margin-top: 8px; color: var(--muted); font-size: 13px; line-height: 1.6; }
    .tabs { display: inline-flex; gap: 4px; border: 1px solid var(--line); border-radius: 999px; background: #fff; padding: 4px; margin: 8px 0 14px; }
    .tab-btn { border: 0; background: transparent; color: var(--muted); border-radius: 999px; padding: 8px 14px; font-size: 13px; font-weight: 700; cursor: pointer; }
    .tab-btn.active { color: #fff; background: linear-gradient(90deg, var(--brand), var(--brand-2)); }
    .tab-panel { display: none; }
    .tab-panel.active { display: block; }
    .panel { border: 1px solid var(--line); border-radius: 14px; background: var(--panel); padding: 14px; margin-bottom: 12px; }
    .panel h2, .panel h3 { margin: 0 0 10px; letter-spacing: -0.02em; }
    .mini-grid { display: grid; gap: 10px; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); margin-bottom: 12px; }
    .mini-card { border: 1px solid var(--line); border-radius: 12px; padding: 10px; background: #fafcff; }
    .mini-card-label { color: var(--muted); text-transform: uppercase; letter-spacing: 0.08em; font-size: 11px; font-weight: 700; }
    .mini-card-value { margin-top: 8px; font-size: 28px; font-weight: 800; letter-spacing: -0.02em; word-break: break-word; }
    .usage-grid { display: grid; gap: 10px; grid-template-columns: repeat(auto-fit, minmax(270px, 1fr)); }
    .usage-card { border: 1px solid var(--line); border-radius: 12px; padding: 10px; background: #fbfeff; }
    .usage-title { color: var(--muted); text-transform: uppercase; font-size: 11px; letter-spacing: 0.08em; font-weight: 700; }
    .usage-value { margin-top: 6px; font-size: 26px; font-weight: 800; }
    .usage-unit { margin-left: 4px; color: var(--muted); font-size: 13px; font-weight: 600; }
    .usage-sub { margin-top: 6px; color: var(--muted); font-size: 12px; }
    .usage-progress { margin-top: 8px; height: 10px; border-radius: 999px; background: #e6eef8; overflow: hidden; }
    .usage-progress-fill { height: 100%; border-radius: 999px; background: linear-gradient(90deg, var(--brand), var(--brand-2)); }
    .channel-grid { display: grid; gap: 10px; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); }
    .channel-card { border: 1px solid var(--line); border-radius: 12px; padding: 10px; min-height: 126px; }
    .channel-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; gap: 8px; }
    .channel-count { color: var(--muted); font-size: 12px; font-weight: 700; }
    .channel-message { font-size: 13px; line-height: 1.45; max-height: 65px; overflow: hidden; }
    .channel-time { margin-top: 8px; color: var(--muted); font-size: 12px; }
    .chip { display: inline-flex; border-radius: 999px; font-size: 11px; font-weight: 700; padding: 2px 8px; border: 1px solid #d0deef; background: #eff5ff; color: #2c4a72; }
    .chip-source { background: #effcf8; border-color: #c9ebe1; color: #1d6c58; }
    .message-feed { display: grid; gap: 8px; max-height: 560px; overflow: auto; padding-right: 3px; }
    .message-item { border: 1px solid var(--line); border-radius: 10px; padding: 10px; }
    .message-meta { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-bottom: 6px; }
    .message-time { margin-left: auto; color: var(--muted); font-size: 12px; }
    .message-text { font-size: 13px; line-height: 1.45; word-break: break-word; }
    .message-context { margin-top: 8px; color: var(--muted); font-size: 12px; }
    .split { display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(420px, 1fr)); }
    .bar-row { display: grid; grid-template-columns: 100px 1fr 75px; gap: 10px; align-items: center; margin-bottom: 7px; font-size: 13px; }
    .bar-label { color: var(--muted); }
    .bar-track { width: 100%; height: 10px; border-radius: 999px; background: #e7eef8; overflow: hidden; }
    .bar-fill { height: 100%; border-radius: 999px; background: linear-gradient(90deg, var(--brand), var(--brand-2)); }
    .bar-value { text-align: right; font-weight: 700; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th, td { border-bottom: 1px solid var(--line); padding: 8px 6px; text-align: left; vertical-align: top; }
    th { text-transform: uppercase; font-size: 11px; letter-spacing: 0.06em; color: var(--muted); }
    .empty { color: var(--muted); padding: 8px 0; }
    .footnote { margin-top: 8px; color: var(--muted); font-size: 12px; line-height: 1.5; }
    @media (max-width: 900px) {
      .split { grid-template-columns: 1fr; }
    }
    @media (max-width: 680px) {
      .container { padding: 14px; }
      .hero { padding: 14px; }
      .hero h1 { font-size: 24px; }
      .mini-card-value { font-size: 23px; }
      .usage-value { font-size: 22px; }
      .tabs { width: 100%; }
      .tab-btn { flex: 1 1 50%; }
      .message-time { margin-left: 0; width: 100%; }
    }
  </style>
</head>
<body>
  <div class="container">
    <header class="hero">
      <div class="hero-top">
        <h1>Codex CLI Usage Visualizer</h1>
        ${refreshBadge}
      </div>
      <div class="meta">
        Generated: ${escapeHtml(formatDateTime(metrics.generatedAt))}<br />
        Sessions source: <code>${escapeHtml(metrics.sessionsDir)}</code><br />
        Scanned files: ${escapeHtml(formatNumber(metrics.scannedFiles))}
      </div>
    </header>

    <nav class="tabs" aria-label="dashboard tabs">
      <button class="tab-btn active" data-tab-btn="live" type="button">Live Overview</button>
      <button class="tab-btn" data-tab-btn="details" type="button">Detailed Usage</button>
    </nav>

    <section class="tab-panel active" data-tab-panel="live">
      <section class="panel">
        <h2>Real-time Remaining Usage</h2>
        <div class="mini-grid">
          <article class="mini-card"><div class="mini-card-label">Last Rate Update</div><div class="mini-card-value">${escapeHtml(formatDateTime(usageSummary.lastUpdatedAt))}</div></article>
          <article class="mini-card"><div class="mini-card-label">Limit Name</div><div class="mini-card-value">${escapeHtml(usageSummary.modelLimitName || '-')}</div></article>
          <article class="mini-card"><div class="mini-card-label">Plan Type</div><div class="mini-card-value">${escapeHtml(usageSummary.planType || '-')}</div></article>
          <article class="mini-card"><div class="mini-card-label">Credits</div><div class="mini-card-value">${escapeHtml(usageSummary.credits && usageSummary.credits.unlimited ? 'Unlimited' : usageSummary.credits && usageSummary.credits.has_credits ? 'Enabled' : 'Unknown')}</div></article>
        </div>
        <div class="usage-grid">${primaryCard}${secondaryCard}</div>
        <div class="footnote">Remaining usage is estimated from the latest <code>rate_limits.used_percent</code> event in Codex session logs.</div>
      </section>

      <section class="panel">
        <h3>Agent Channels</h3>
        <div class="channel-grid">${renderAgentChannelCards(metrics.agentChannels)}</div>
      </section>

      <section class="panel">
        <h3>Agent Message Feed</h3>
        ${renderMessageFeed(metrics.agentFeed)}
      </section>
    </section>

    <section class="tab-panel" data-tab-panel="details">
      <section class="mini-grid">
        <article class="mini-card"><div class="mini-card-label">Total Sessions</div><div class="mini-card-value">${escapeHtml(formatNumber(metrics.totals.sessions))}</div></article>
        <article class="mini-card"><div class="mini-card-label">Total Tokens</div><div class="mini-card-value">${escapeHtml(formatNumber(metrics.totals.totalTokens))}</div></article>
        <article class="mini-card"><div class="mini-card-label">Tool Calls</div><div class="mini-card-value">${escapeHtml(formatNumber(metrics.totals.toolCalls))}</div></article>
        <article class="mini-card"><div class="mini-card-label">Agent Messages</div><div class="mini-card-value">${escapeHtml(formatNumber(metrics.totals.agentMessages))}</div></article>
        <article class="mini-card"><div class="mini-card-label">Reasoning Events</div><div class="mini-card-value">${escapeHtml(formatNumber(metrics.totals.reasoningEvents))}</div></article>
        <article class="mini-card"><div class="mini-card-label">Cached Input Ratio</div><div class="mini-card-value">${escapeHtml(formatPercent(metrics.cacheHitRatio * 100))}</div></article>
      </section>

      <section class="split">
        <article class="panel"><h3>Daily Tokens (Last ${escapeHtml(formatNumber(metrics.days))} Days)</h3>${tokenBars}</article>
        <article class="panel"><h3>Daily Sessions (Last ${escapeHtml(formatNumber(metrics.days))} Days)</h3>${sessionBars}</article>
      </section>

      <section class="panel"><h3>Daily Tool Calls (Last ${escapeHtml(formatNumber(metrics.days))} Days)</h3>${toolBars}</section>

      <section class="split">
        <article class="panel"><h3>Top Tools</h3>${topTools}</article>
        <article class="panel"><h3>Model Usage</h3>${topModels}</article>
      </section>

      <section class="split">
        <article class="panel"><h3>Top Projects</h3>${topProjects}</article>
        <article class="panel"><h3>Recent Sessions</h3>${recentSessions}</article>
      </section>
    </section>
  </div>

  <script>
    (function () {
      const storageKey = 'codex-cli-usage-visualizer:active-tab'
      const tabButtons = Array.from(document.querySelectorAll('[data-tab-btn]'))
      const tabPanels = Array.from(document.querySelectorAll('[data-tab-panel]'))

      function activateTab(tabName) {
        tabButtons.forEach((button) => button.classList.toggle('active', button.dataset.tabBtn === tabName))
        tabPanels.forEach((panel) => panel.classList.toggle('active', panel.dataset.tabPanel === tabName))
        try {
          localStorage.setItem(storageKey, tabName)
        } catch {
          // Ignore storage errors
        }
      }

      tabButtons.forEach((button) => {
        button.addEventListener('click', () => activateTab(button.dataset.tabBtn))
      })

      let initialTab = 'live'
      try {
        const savedTab = localStorage.getItem(storageKey)
        if (savedTab && tabButtons.some((button) => button.dataset.tabBtn === savedTab)) {
          initialTab = savedTab
        }
      } catch {
        // Ignore storage errors
      }

      activateTab(initialTab)
      ${options.autoRefresh ? 'setTimeout(() => window.location.reload(), 10000);' : ''}
    })()
  </script>
</body>
</html>`
}

function printHelp() {
  process.stdout.write(`Codex usage dashboard\n\nUsage:\n  node scripts/codex-usage-dashboard.mjs [options]\n\nOptions:\n  --sessions-dir <path>  Path to Codex sessions directory (default: ~/.codex/sessions)\n  --days <number>        Number of days to include (default: 14)\n  --output <path>        Output HTML path\n  --serve                Start local server\n  --port <number>        Server port (default: 4789)\n  --json                 Print JSON metrics\n  --help, -h             Show help\n`)
}

function writeDashboardFile(options) {
  const metrics = buildMetrics(options.sessionsDir, options.days)
  const html = renderDashboard(metrics, { autoRefresh: false })
  fs.writeFileSync(options.output, html, 'utf8')
  process.stdout.write(`Dashboard written: ${options.output}\n`)
}

function startDashboardServer(options) {
  const server = http.createServer((request, response) => {
    const requestUrl = new URL(request.url || '/', `http://localhost:${options.port}`)

    if (requestUrl.pathname === '/metrics.json') {
      const metrics = buildMetrics(options.sessionsDir, options.days)
      response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
      response.end(JSON.stringify(metrics, null, 2))
      return
    }

    if (requestUrl.pathname !== '/' && requestUrl.pathname !== '/index.html') {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      response.end('Not found')
      return
    }

    const metrics = buildMetrics(options.sessionsDir, options.days)
    const html = renderDashboard(metrics, { autoRefresh: true })
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    response.end(html)
  })

  server.listen(options.port, () => {
    process.stdout.write(`Codex dashboard running at http://localhost:${options.port}\n`)
    process.stdout.write('Tip: keep the Live Overview tab open for auto refresh.\n')
  })
}

function main() {
  const options = parseArgs(process.argv.slice(2))

  if (options.help) {
    printHelp()
    return
  }

  if (options.json) {
    const metrics = buildMetrics(options.sessionsDir, options.days)
    process.stdout.write(`${JSON.stringify(metrics, null, 2)}\n`)
    return
  }

  if (options.serve) {
    startDashboardServer(options)
    return
  }

  writeDashboardFile(options)
}

try {
  main()
} catch (error) {
  process.stderr.write(`Error: ${error.message}\n`)
  process.exit(1)
}
