# Codex CLI Usage Visualizer

A lightweight local dashboard for visualizing Codex CLI usage and agent activity from `~/.codex/sessions`.

## Features

- Session-level and daily token usage
- Tool call count trends
- Agent message and reasoning event counts
- Model usage distribution
- Per-project (cwd) usage breakdown
- Recent session activity table

## Requirements

- Node.js 18+

## Run Live Dashboard

```bash
npm run dashboard
```

Open: `http://localhost:4789`

## Build Static Report

```bash
npm run build
```

Output: `codex-usage-dashboard.html`

## Print JSON Metrics

```bash
npm run metrics
```

## CLI Options

```bash
node scripts/codex-usage-dashboard.mjs --help
```
