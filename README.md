# Softlight UI State Capture

Zero-cost, heuristic-based agent using Node.js + Playwright to navigate live web apps and capture UI states (including non-URL dialogues and forms).

## Features
- Deterministic heuristics (verb/role matching)
- Captures before/after actions, detects basic modals
- Saves screenshot, HTML, DOM/ARIA snapshots, and metadata per step

## Prerequisites
- Node.js LTS installed (Windows compatible)

## Setup
1. Install dependencies
2. Install browsers

## Usage (PowerShell)
```
# install deps
npm install
# install Playwright browsers
npx playwright install
# run a task
node scripts/run_task.js --task "Create a project in Linear" --start-url "https://linear.app" --out "dataset/linear-create-project"

# run with a manual login pause (hold 30s), then capture
node scripts/run_task.js --task "Filter issues in Linear" --start-url "https://linear.app" --out "dataset/linear-filter" --hold 30000

# reuse cookies (after first run saved cookies via --cookies)
node scripts/run_task.js --task "Create a page in Notion" --start-url "https://www.notion.so" --out "dataset/notion-create-page" --cookies ".\notion.cookies.json"

# allow potentially destructive actions (opt-in)
node scripts/run_task.js --task "Edit settings" --start-url "https://example.com" --out "dataset/settings" --allow-destructive

# bias verb scoring with hints (comma-separated)
node scripts/run_task.js --task "Linear create" --start-url "https://linear.app" --out "dataset/linear-create" --hints "project,create"
```

## Dataset structure
```
dataset/
  <task-slug>/
    metadata.json
    step-001/
      screenshot.png
      page.html
      dom_snapshot.json
      aria_snapshot.json
      action.json
      meta.json
    step-002/
      ...
```

Each dataset folder also includes an `index.html` step viewer that you can open in a browser to click through screenshots and HTML.

## Notes
- Use `--cookies <path>` to reuse an authenticated session.
- Avoid destructive actions by default; pass `--allow-destructive` to enable.
- Use `--hold <ms>` to pause after initial navigation (helpful for manual login before capture loop starts).
