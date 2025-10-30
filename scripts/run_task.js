#!/usr/bin/env node
// Zero-cost heuristic runner per plan: Node.js + Playwright only.
// Deterministic actions; no paid APIs, no LLMs, no heavy CV.

import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function parseArgs() {
  const args = process.argv.slice(2);
  const out = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      const key = a.replace(/^--/, '');
      const val = args[i + 1] && !args[i + 1].startsWith('--') ? args[++i] : true;
      out[key] = val;
    }
  }
  return out;
}

function slugify(text) { return String(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, ''); }

async function ensureDir(dir) { await fs.promises.mkdir(dir, { recursive: true }); }

function hashString(s) { return crypto.createHash('sha1').update(s).digest('hex'); }

function nowIso() { return new Date().toISOString(); }

async function saveJSON(p, obj) { await fs.promises.writeFile(p, JSON.stringify(obj, null, 2), 'utf-8'); }

async function domSnapshot(page) {
  return await page.evaluate(() => {
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return r.width > 0 && r.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    };
    const nodes = Array.from(document.querySelectorAll('button, a, input, textarea, select, [role]'))
      .filter(visible)
      .slice(0, 400)
      .map(n => ({
        tag: n.tagName,
        role: n.getAttribute('role'),
        id: n.id,
        classes: n.className,
        name: n.getAttribute('name'),
        type: n.getAttribute('type'),
        ariaLabel: n.getAttribute('aria-label'),
        text: (n.innerText || '').trim().slice(0, 120),
        bbox: n.getBoundingClientRect().toJSON(),
      }));
    const dialogs = Array.from(document.querySelectorAll('[role="dialog"], [aria-modal="true"], .modal, [data-modal]')).map(d => ({
      tag: d.tagName,
      id: d.id,
      classes: d.className,
      text: (d.innerText || '').trim().slice(0, 200)
    }));
    return { nodes, dialogs, title: document.title };
  });
}

function fingerprintSnapshot(snap) {
  const parts = [snap.title, ...snap.nodes.map(n => n.role + '|' + (n.text || n.ariaLabel || n.id || n.classes)).slice(0, 100)];
  return hashString(parts.join('\n'));
}

const VERBS = ['create','new','add','filter','edit','settings','save','submit','next','continue','done','apply'];
const DANGEROUS = ['delete','remove','archive','reset'];

function scoreNode(n, allowDestructive, hints) {
  const hay = (n.text || n.ariaLabel || '').toLowerCase();
  if (!allowDestructive && DANGEROUS.some(v => hay.includes(v))) return -1;
  let score = 0;
  for (const v of VERBS) if (hay.includes(v)) score += 2;
  // hints boost
  if (hints && hints.length) {
    for (const h of hints) if (hay.includes(h)) score += 3;
  }
  if (n.role === 'button' || n.tag === 'BUTTON') score += 1;
  if (/primary|cta|confirm|submit/i.test(n.classes)) score += 1;
  return score;
}

async function proposeAction(page, allowDestructive, hints) {
  const snap = await domSnapshot(page);
  // Prefer dialogs if present
  if (snap.dialogs && snap.dialogs.length > 0) {
    // pick a button-like element inside the dialog
    const handle = await page.$('[role="dialog"], [aria-modal="true"], .modal, [data-modal]');
    if (handle) {
      const buttons = await handle.$$('button, [role="button"], a');
      for (const b of buttons) {
        const text = (await b.innerText().catch(() => '')) || '';
        const cls = (await b.getAttribute('class').catch(() => '')) || '';
  const cand = { tag: 'BUTTON', role: 'button', text, classes: cls };
  if (scoreNode(cand, allowDestructive, hints) > 0) return { type: 'click', locator: b, label: text };
      }
      if (buttons[0]) return { type: 'click', locator: buttons[0], label: 'dialog-first-button' };
    }
  }
  // Otherwise choose best-scoring visible control
  const handles = await page.$$('button, [role="button"], a, input, [aria-expanded]');
  let best = null, bestScore = -1;
  for (const h of handles) {
    const box = await h.boundingBox();
    if (!box || box.width < 2 || box.height < 2) continue;
    const text = (await h.innerText().catch(() => '')) || '';
    const aria = (await h.getAttribute('aria-label').catch(() => '')) || '';
    const cls = (await h.getAttribute('class').catch(() => '')) || '';
  const cand = { tag: 'BUTTON', role: 'button', text: text || aria, classes: cls };
  const s = scoreNode(cand, allowDestructive, hints);
    if (s > bestScore) { best = h; bestScore = s; }
  }
  if (best && bestScore > 0) return { type: 'click', locator: best, label: 'best-verb-match' };

  // Fallback: open a menu/toggle if available
  const menu = await page.$('[aria-expanded], [role="menu"], [data-state]');
  if (menu) return { type: 'click', locator: menu, label: 'fallback-menu' };

  return null;
}

async function writeDatasetIndex(outRoot) {
  const entries = (await fs.promises.readdir(outRoot)).filter(n => /^step-\d{3}/.test(n)).sort();
  const links = entries.map(s => `<li><a href="./${s}/screenshot.png" target="view">${s}</a> - <a href="./${s}/page.html" target="view">HTML</a></li>`).join('\n');
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Dataset viewer</title><style>body{font-family:system-ui;margin:16px}nav{position:fixed;left:0;top:0;bottom:0;width:260px;overflow:auto;padding:12px;background:#fafafa;border-right:1px solid #ddd}main{margin-left:280px;padding:16px}img{max-width:100%;border:1px solid #ccc}</style></head><body><nav><h3>Steps</h3><ol>${links}</ol></nav><main><h2>Viewer</h2><iframe name="view" style="width:100%;height:80vh;border:1px solid #ddd"></iframe></main></body></html>`;
  await fs.promises.writeFile(path.join(outRoot, 'index.html'), html, 'utf-8');
}

async function capture(outDir, page, reason, lastFingerprint) {
  const snap = await domSnapshot(page);
  const fp = fingerprintSnapshot(snap);
  if (fp === lastFingerprint) return { skipped: true, fingerprint: fp };

  const steps = (await fs.promises.readdir(outDir).catch(() => [])).filter(n => /^step-\d{3}/.test(n)).length + 1;
  const stepDir = path.join(outDir, `step-${String(steps).padStart(3,'0')}`);
  await ensureDir(stepDir);

  await page.screenshot({ path: path.join(stepDir, 'screenshot.png'), fullPage: true });
  const html = await page.content();
  await fs.promises.writeFile(path.join(stepDir, 'page.html'), html, 'utf-8');
  await saveJSON(path.join(stepDir, 'dom_snapshot.json'), snap.nodes);
  await saveJSON(path.join(stepDir, 'aria_snapshot.json'), { dialogs: snap.dialogs, title: snap.title });
  await saveJSON(path.join(stepDir, 'meta.json'), { reason, timestamp: nowIso(), fingerprint: fp, url: page.url(), title: snap.title });

  return { skipped: false, fingerprint: fp, stepDir };
}

async function fillSomeInputs(page) {
  // Best-effort: fill up to 3 visible inputs with safe values
  const inputs = await page.$$('input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]), textarea');
  let filled = 0;
  for (const el of inputs) {
    const box = await el.boundingBox();
    if (!box || box.width < 2 || box.height < 2) continue;
    const type = (await el.getAttribute('type')) || 'text';
    try {
      if (type === 'email') {
        await el.fill('test@example.com');
      } else if (type === 'number') {
        await el.fill('123');
      } else {
        await el.fill('Test');
      }
      filled++;
      if (filled >= 3) break;
    } catch (_) {}
  }
  return filled;
}

async function main() {
  const args = parseArgs();
  const task = args.task || 'demo task';
  const startUrl = args['start-url'] || 'https://example.com';
  const outRoot = args.out || path.join(__dirname, '..', 'dataset', slugify(task));
  const maxSteps = parseInt(args['max-steps'] || '10', 10);
  const allowDestructive = !!args['allow-destructive'];
  const cookiesPath = args.cookies;
  const holdMs = parseInt(args['hold'] || '0', 10);
  const hints = (args['hints'] ? String(args['hints']).toLowerCase().split(',').map(s => s.trim()).filter(Boolean) : []);

  await ensureDir(outRoot);
  await saveJSON(path.join(outRoot, 'metadata.json'), { task, start_url: startUrl, created_at: nowIso(), settings: { maxSteps, allowDestructive } });

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  if (cookiesPath && fs.existsSync(cookiesPath)) {
    const storage = JSON.parse(await fs.promises.readFile(cookiesPath, 'utf-8'));
    await context.addCookies(storage.cookies || []);
  }
  const page = await context.newPage();

  // Install a lightweight mutation observer to detect significant DOM changes
  await page.addInitScript(() => {
    (function () {
      const state = { added: 0, removed: 0, lastSpikeAt: 0 };
      const obs = new MutationObserver(muts => {
        for (const m of muts) {
          state.added += (m.addedNodes?.length || 0);
          state.removed += (m.removedNodes?.length || 0);
        }
        // mark spike time to allow sampling shortly after big changes
        if ((state.added + state.removed) >= 30) state.lastSpikeAt = Date.now();
      });
      obs.observe(document.documentElement, { childList: true, subtree: true });
      // expose on window
      window.__MAS_OBS__ = state;
    })();
  });

  let lastFP = '';
  await page.goto(startUrl, { waitUntil: 'domcontentloaded' });
  if (holdMs > 0) await page.waitForTimeout(holdMs);
  ({ fingerprint: lastFP } = await capture(outRoot, page, 'initial', lastFP));

  for (let i = 0; i < maxSteps; i++) {
    const action = await proposeAction(page, allowDestructive, hints);
    if (!action) break;

    try {
      const pre = await capture(outRoot, page, `before:${action.label}`, lastFP);
      if (!pre.skipped) await saveJSON(path.join(pre.stepDir, 'action.json'), { type: action.type, label: action.label, phase: 'before' });
      await action.locator.click({ timeout: 4000 });
      await page.waitForTimeout(600);
      // If a mutation spike occurred, slightly delay and capture again
      const spike = await page.evaluate(() => (window.__MAS_OBS__?.lastSpikeAt || 0));
      if (spike && Date.now() - spike < 1500) {
        await page.waitForTimeout(400);
      }
  const postPreFill = await capture(outRoot, page, `after:${action.label}`, lastFP);
  if (!postPreFill.skipped) await saveJSON(path.join(postPreFill.stepDir, 'action.json'), { type: action.type, label: action.label, phase: 'after-preFill' });
  // attempt to fill some inputs if present
  await fillSomeInputs(page);
  const res = await capture(outRoot, page, `after:${action.label}:postFill`, lastFP);
  if (!res.skipped) await saveJSON(path.join(res.stepDir, 'action.json'), { type: 'fill', label: 'auto-fill', phase: 'after-postFill' });
      if (!res.skipped) lastFP = res.fingerprint;
    } catch (e) {
      // ignore and continue to next step
    }
  }

  // Optionally save cookies for reuse
  if (cookiesPath) {
    const cookies = await context.cookies();
    await saveJSON(cookiesPath, { cookies });
  }

  // Write dataset index viewer
  await writeDatasetIndex(outRoot);

  await browser.close();
}

main().catch(err => { console.error(err); process.exit(1); });
