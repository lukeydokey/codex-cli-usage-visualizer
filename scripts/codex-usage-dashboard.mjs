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
  return `${value.toFixed(1)}%`
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
  }
}

function incrementCount(container, key, amount = 1) {
  if (!Object.prototype.hasOwnProperty.call(container, key)) {
    container[key] = 0
  }
  container[key] += amount
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
      }

      if (payload.type === 'agent_message') {
        session.agentMessages += 1
        incrementCount(session.phaseCounts, payload.phase || 'unknown')
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

    const projectKey = session.cwd || '(unknown cwd)'
    if (!Object.prototype.hasOwnProperty.call(projectUsage, projectKey)) {
      projectUsage[projectKey] = {
        cwd: projectKey,
        sessions: 0,
        tokens: 0,
        toolCalls: 0,
      }
    }

    projectUsage[projectKey].sessions += 1
    projectUsage[projectKey].tokens += session.tokens.total
    projectUsage[projectKey].toolCalls += session.toolCalls

    const dayKey = formatDay(session.startedAt)
    if (!perDay.has(dayKey)) {
      perDay.set(dayKey, { date: dayKey, sessions: 0, tokens: 0 })
    }

    const dayBucket = perDay.get(dayKey)
    dayBucket.sessions += 1
    dayBucket.tokens += session.tokens.total
  }

  const today = new Date()
  today.setHours(0, 0, 0, 0)

  const daily = []
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const currentDate = new Date(today)
    currentDate.setDate(today.getDate() - offset)
    const key = formatDay(currentDate)
    daily.push(perDay.get(key) || { date: key, sessions: 0, tokens: 0 })
  }

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
      model: session.model,
      cwd: session.cwd || '(unknown cwd)',
      tokens: session.tokens.total,
      toolCalls: session.toolCalls,
      agentMessages: session.agentMessages,
    }))

  return {
    generatedAt: new Date().toISOString(),
    sessionsDir,
    scannedFiles: files.length,
    days,
    totals,
    cacheHitRatio: totals.inputTokens > 0 ? totals.cachedInputTokens / totals.inputTokens : 0,
    daily,
    topTools: mapToSortedRows(toolUsage, 'name').slice(0, 15),
    topModels: mapToSortedRows(modelUsage, 'name'),
    agentPhases: mapToSortedRows(phaseUsage, 'phase'),
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

function shortenPath(value, maxLength = 70) {
  if (value.length <= maxLength) {
    return value
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

function renderDashboard(metrics, autoRefresh) {
  const tokenBars = renderBarRows(metrics.daily, 'tokens', formatCompact)
  const sessionBars = renderBarRows(metrics.daily, 'sessions', formatNumber)

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
    ],
    'No project activity detected.'
  )

  const agentPhases = renderTable(
    metrics.agentPhases,
    [
      { header: 'Phase', render: (row) => row.phase },
      { header: 'Messages', render: (row) => formatNumber(row.count) },
    ],
    'No agent messages detected.'
  )

  const recentSessions = renderTable(
    metrics.recentSessions,
    [
      { header: 'Started', render: (row) => parseDate(row.startedAt)?.toLocaleString() || '-' },
      { header: 'Model', render: (row) => row.model },
      { header: 'Tokens', render: (row) => formatNumber(row.tokens) },
      { header: 'Tool Calls', render: (row) => formatNumber(row.toolCalls) },
      { header: 'Agent Msg', render: (row) => formatNumber(row.agentMessages) },
      { header: 'Project', render: (row) => shortenPath(row.cwd, 55) },
    ],
    'No sessions detected.'
  )

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Codex Usage Dashboard</title>
  <style>
    :root {
      --bg: #f4f7fb;
      --panel: #ffffff;
      --ink: #0f172a;
      --muted: #475569;
      --line: #d7e0ea;
      --primary: #2563eb;
      --accent: #0f766e;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: 'Segoe UI', 'Helvetica Neue', Arial, sans-serif;
      color: var(--ink);
      background: radial-gradient(circle at 0% 0%, #e0ecff 0%, transparent 40%), radial-gradient(circle at 100% 0%, #e5fff8 0%, transparent 45%), var(--bg);
    }
    .container { max-width: 1280px; margin: 0 auto; padding: 24px; }
    .header { padding: 22px; border: 1px solid var(--line); border-radius: 16px; background: linear-gradient(120deg, #ffffff 0%, #f5f9ff 45%, #ebfff8 100%); margin-bottom: 18px; }
    .header h1 { margin: 0; font-size: 30px; letter-spacing: -0.03em; }
    .meta { margin-top: 10px; color: var(--muted); font-size: 14px; line-height: 1.5; }
    .grid { display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); margin-bottom: 16px; }
    .card { background: var(--panel); border: 1px solid var(--line); border-radius: 14px; padding: 14px; min-height: 106px; }
    .card h2 { margin: 0; color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: 0.08em; }
    .metric { margin-top: 10px; font-size: 31px; font-weight: 800; letter-spacing: -0.02em; }
    .split { display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(400px, 1fr)); }
    .panel { background: var(--panel); border: 1px solid var(--line); border-radius: 14px; padding: 14px; margin-bottom: 14px; }
    .panel h3 { margin: 0 0 10px 0; font-size: 18px; }
    .bar-row { display: grid; grid-template-columns: 100px 1fr 75px; gap: 10px; align-items: center; margin-bottom: 8px; font-size: 13px; }
    .bar-track { height: 10px; border-radius: 999px; background: #e6edf6; overflow: hidden; }
    .bar-fill { height: 100%; border-radius: 999px; background: linear-gradient(90deg, var(--primary) 0%, var(--accent) 100%); }
    .bar-value { text-align: right; font-weight: 700; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th, td { border-bottom: 1px solid var(--line); padding: 8px 6px; text-align: left; }
    th { color: var(--muted); text-transform: uppercase; letter-spacing: 0.06em; font-size: 11px; }
    .empty { color: var(--muted); padding: 10px 0 4px; }
    .footnote { color: var(--muted); font-size: 12px; margin-top: 8px; }
    @media (max-width: 680px) {
      .container { padding: 14px; }
      .header h1 { font-size: 24px; }
      .metric { font-size: 26px; }
      .bar-row { grid-template-columns: 82px 1fr 62px; }
      .split { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <div class="container">
    <section class="header">
      <h1>Codex Usage Dashboard${autoRefresh ? ' (auto refresh: 10s)' : ''}</h1>
      <div class="meta">
        Generated: ${escapeHtml(new Date(metrics.generatedAt).toLocaleString())}<br />
        Sessions dir: <code>${escapeHtml(metrics.sessionsDir)}</code><br />
        Scanned files: ${formatNumber(metrics.scannedFiles)}
      </div>
    </section>

    <section class="grid">
      <article class="card"><h2>Total Sessions</h2><div class="metric">${formatNumber(metrics.totals.sessions)}</div></article>
      <article class="card"><h2>Total Tokens</h2><div class="metric">${formatNumber(metrics.totals.totalTokens)}</div></article>
      <article class="card"><h2>Tool Calls</h2><div class="metric">${formatNumber(metrics.totals.toolCalls)}</div></article>
      <article class="card"><h2>Agent Messages</h2><div class="metric">${formatNumber(metrics.totals.agentMessages)}</div></article>
      <article class="card"><h2>Reasoning Events</h2><div class="metric">${formatNumber(metrics.totals.reasoningEvents)}</div></article>
      <article class="card"><h2>Cached Input Ratio</h2><div class="metric">${formatPercent(metrics.cacheHitRatio * 100)}</div></article>
    </section>

    <section class="split">
      <article class="panel"><h3>Daily Tokens (Last ${formatNumber(metrics.days)} Days)</h3>${tokenBars}</article>
      <article class="panel"><h3>Daily Sessions (Last ${formatNumber(metrics.days)} Days)</h3>${sessionBars}</article>
    </section>

    <section class="split">
      <article class="panel"><h3>Top Tools</h3>${topTools}</article>
      <article class="panel"><h3>Model Usage</h3>${topModels}</article>
    </section>

    <section class="split">
      <article class="panel"><h3>Agent Activity by Phase</h3>${agentPhases}</article>
      <article class="panel"><h3>Top Projects</h3>${topProjects}</article>
    </section>

    <section class="panel">
      <h3>Recent Sessions</h3>
      ${recentSessions}
      <div class="footnote">Agent activity is based on session events: function_call, agent_message, agent_reasoning.</div>
    </section>
  </div>
  ${autoRefresh ? '<script>setTimeout(() => location.reload(), 10000);</script>' : ''}
</body>
</html>`
}

function printHelp() {
  process.stdout.write(`Codex usage dashboard\n\nUsage:\n  node scripts/codex-usage-dashboard.mjs [options]\n\nOptions:\n  --sessions-dir <path>  Path to Codex sessions directory (default: ~/.codex/sessions)\n  --days <number>        Number of days to include (default: 14)\n  --output <path>        Output HTML path\n  --serve                Start local server\n  --port <number>        Server port (default: 4789)\n  --json                 Print JSON metrics\n  --help, -h             Show help\n`)
}

function writeDashboardFile(options) {
  const metrics = buildMetrics(options.sessionsDir, options.days)
  const html = renderDashboard(metrics, false)
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
    const html = renderDashboard(metrics, true)
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    response.end(html)
  })

  server.listen(options.port, () => {
    process.stdout.write(`Codex dashboard running at http://localhost:${options.port}\n`)
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
