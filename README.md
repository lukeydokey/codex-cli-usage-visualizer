# Codex CLI Usage Visualizer

A lightweight local dashboard for visualizing Codex CLI usage and agent activity from `~/.codex/sessions`.

## Features

- `Live Overview` tab
- Real-time remaining usage cards from latest rate-limit events (1-minute auto refresh)
- Agent channel cards with `더보기/접기` when channels exceed 3
- Click a channel card to open a modal with messages for that channel
- `Detailed Usage` tab
- Session-level and daily token usage trends
- Tool call trends, model usage, and project breakdown
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
