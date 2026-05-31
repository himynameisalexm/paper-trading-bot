#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// review-agent.js — Daily meta-agent
//
// Runs every weekday at 7:30 AM ET (before the 8:00 AM pre-market scan).
// 1. Integrity check — verifies core risk params haven't drifted
// 2. Performance analysis — closed trades by symbol + setup type
// 3. Signal health — which symbols are generating confidence scores vs dead air
// 4. Mistral review — conservative watchlist swap recommendations
// 5. Apply changes — updates config.json + rules-prompt.txt watchlist line
// 6. Review log — writes review-log.json for the UI to display
//
// Conservative by design:
//   • Core risk params (stop %, target %, min confidence) are READ-ONLY
//   • Max 2 symbol swaps per run
//   • Never removes a symbol with an open position
//   • Never removes NVDA, META, MSFT, BTC
//   • Watchlist stays 10–15 symbols
// ─────────────────────────────────────────────────────────────────────────────

const fs   = require('fs');
const https = require('https');
const { execSync } = require('child_process');

const CONFIG_FILE  = './config.json';
const TRADES_FILE  = './trades.json';
const RULES_FILE   = './rules-prompt.txt';
const REVIEW_LOG   = './review-log.json';
const MISTRAL_API_KEY = process.env.MISTRAL_API_KEY;

// ─── CANDIDATE POOL ───────────────────────────────────────────────────────────
// Symbols the agent MAY add to the watchlist. High-liquidity AI/tech/fintech
// names with strong institutional coverage and 5%+ swing potential.
const CANDIDATE_POOL = [
  'TSLA', 'AMD',  'CRWD', 'PANW', 'AVGO', 'ASML', 'ARM',
  'MSTR', 'APP',  'SNOW', 'DDOG', 'MDB',  'SHOP', 'UBER',
  'SQ',   'PYPL', 'SMCI', 'QCOM', 'RBLX', 'CELH', 'CAVA'
];

// Core symbols — never auto-removed
const CORE_SYMBOLS = new Set(['NVDA', 'META', 'MSFT', 'BTC']);

// ─── HTTP HELPER ──────────────────────────────────────────────────────────────
function makeRequest(options, body = null) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try   { resolve(JSON.parse(raw)); }
        catch { resolve(raw); }
      });
    });
    req.on('error', reject);
    req.setTimeout(55000, () => { req.destroy(new Error('Request timeout')); });
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// ─── RULES INTEGRITY CHECK ────────────────────────────────────────────────────
// Read-only verification — never auto-fixes core risk params
function checkRulesIntegrity(config) {
  const issues  = [];
  const rules   = config.trading_rules || {};
  const safeguards = rules.safeguards || {};

  const expected = {
    stop_loss_percent:   { path: rules.stop_loss_percent   ?? config.stop_loss_percent,   want: 2.5  },
    profit_target_percent: { path: rules.profit_target_percent ?? config.profit_target_percent, want: 5.0  },
    vix_threshold:       { path: rules.vix_threshold       ?? config.vix_threshold,        want: 30   },
    min_reward_risk_ratio: { path: rules.min_reward_risk_ratio ?? config.min_reward_risk_ratio, want: 2.0  },
  };

  for (const [key, { path: val, want }] of Object.entries(expected)) {
    if (val != null && val !== want) {
      issues.push(`config.${key} = ${val}, expected ${want}`);
    }
  }

  const minConf = safeguards.min_confidence ?? rules.min_confidence ?? null;
  if (minConf != null && minConf !== 7.0) {
    issues.push(`min_confidence = ${minConf}, expected 7.0`);
  }

  return issues;
}

// ─── PERFORMANCE ANALYSIS BY SYMBOL ──────────────────────────────────────────
function analyzePerformance(trades) {
  const closed = (trades.closed_trades || []).filter(t => (t.shares || 0) > 0); // exclude ghost trades
  const bySymbol = {};

  for (const t of closed) {
    if (!bySymbol[t.symbol]) {
      bySymbol[t.symbol] = { symbol: t.symbol, trades: 0, wins: 0, losses: 0,
                             total_pnl: 0, total_pnl_pct: 0, last_trade_date: null };
    }
    const s = bySymbol[t.symbol];
    s.trades++;
    s.total_pnl     += t.realized_pnl         || 0;
    s.total_pnl_pct += t.realized_pnl_percent  || 0;
    if ((t.realized_pnl || 0) > 0.01)  s.wins++;
    else if ((t.realized_pnl || 0) < -0.01) s.losses++;
    if (!s.last_trade_date || t.exit_date > s.last_trade_date) {
      s.last_trade_date = t.exit_date;
    }
  }

  for (const s of Object.values(bySymbol)) {
    const meaningful = s.wins + s.losses;
    s.win_rate   = meaningful > 0 ? Math.round(s.wins / meaningful * 100) : null;
    s.avg_pnl_pct = s.trades > 0 ? parseFloat((s.total_pnl_pct / s.trades).toFixed(2)) : 0;
  }

  return bySymbol;
}

// ─── WATCHLIST SIGNAL HEALTH ──────────────────────────────────────────────────
function analyzeWatchlistHealth(trades) {
  const watchlist = trades.watchlist || [];
  const now = new Date();
  const health = {};

  for (const item of watchlist) {
    const daysSinceUpdate = item.last_updated
      ? Math.floor((now - new Date(item.last_updated)) / 86400000)
      : 999;

    health[item.symbol] = {
      symbol:             item.symbol,
      current_price:      item.current_price,
      confidence:         item.confidence,
      entry_signal:       item.entry_signal,
      rsi:                item.rsi,
      change_pct:         item.change_pct,
      volume_ratio:       item.volume_ratio,
      last_reason:        (item.reason || '').substring(0, 120),
      days_since_update:  daysSinceUpdate,
      has_price_data:     item.current_price != null,
      is_new:             item.is_new || false
    };
  }

  return health;
}

// ─── CALL MISTRAL ─────────────────────────────────────────────────────────────
async function callMistral(prompt) {
  if (!MISTRAL_API_KEY) throw new Error('MISTRAL_API_KEY not set');

  console.log('[MISTRAL] Sending review prompt...');
  const res = await makeRequest({
    hostname: 'api.mistral.ai',
    path:     '/v1/chat/completions',
    method:   'POST',
    headers:  {
      'Authorization': `Bearer ${MISTRAL_API_KEY}`,
      'Content-Type':  'application/json'
    }
  }, {
    model:       'mistral-large-latest',
    messages:    [{ role: 'user', content: prompt }],
    temperature: 0.2,
    max_tokens:  3000
  });

  const content = res?.choices?.[0]?.message?.content;
  if (!content) throw new Error(`Bad Mistral response: ${JSON.stringify(res).substring(0, 200)}`);
  return content;
}

// ─── PARSE AI JSON ────────────────────────────────────────────────────────────
function parseAI(text) {
  try {
    const stripped = text.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
    const match = stripped.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
  } catch (e) {
    console.error('[PARSE] Failed:', e.message);
    console.error('[PARSE] Snippet:', text.substring(0, 300));
  }
  return null;
}

// ─── UPDATE RULES-PROMPT WATCHLIST LINE ───────────────────────────────────────
function updateRulesPromptWatchlist(newSymbols) {
  let rules = fs.readFileSync(RULES_FILE, 'utf8');
  const symbolList = newSymbols.join(', ');
  const updated = rules.replace(
    /Active symbols \(dynamic[^\n]*\): [^\n]+/,
    `Active symbols (dynamic — updated as insights develop): ${symbolList}`
  );
  if (updated === rules) {
    console.warn('[RULES] Could not find watchlist line to update — check rules-prompt.txt format');
    return;
  }
  fs.writeFileSync(RULES_FILE, updated);
  console.log(`[RULES] Watchlist line updated: ${symbolList}`);
}

// ─── GIT COMMIT & PUSH ────────────────────────────────────────────────────────
function commitChanges(files, message) {
  try {
    if (process.env.GITHUB_ACTIONS) {
      execSync('git config user.email "github-actions[bot]@users.noreply.github.com"', { stdio: 'pipe' });
      execSync('git config user.name "github-actions[bot]"', { stdio: 'pipe' });
    }

    // Pull to avoid conflicts with the intraday bot
    try { execSync('git pull --rebase origin main', { stdio: 'pipe' }); } catch {}

    for (const f of files) {
      try { execSync(`git add "${f}"`, { stdio: 'pipe' }); } catch {}
    }

    const status = execSync('git status --porcelain', { encoding: 'utf8' });
    if (!status.trim()) {
      console.log('[GIT] Nothing changed — skipping commit');
      return;
    }

    execSync(`git commit -m "${message.replace(/"/g, "'")}"`, { stdio: 'pipe' });
    execSync('git push origin main', { stdio: 'pipe' });
    console.log('[GIT] ✓ Committed and pushed');
  } catch (e) {
    console.error('[GIT] Error:', e.message);
  }
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log('\n═══════════════════════════════════════════════════════');
  console.log('  DAILY REVIEW AGENT —', new Date().toISOString());
  console.log('═══════════════════════════════════════════════════════\n');

  const trades = JSON.parse(fs.readFileSync(TRADES_FILE, 'utf8'));
  const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));

  const currentWatchlist = config.watchlist || [];
  const openSymbols      = new Set((trades.open_positions || []).map(p => p.symbol));

  // ── 1. RULES INTEGRITY CHECK ──────────────────────────────────────────────
  console.log('[CHECK] Running rules integrity check...');
  const ruleIssues = checkRulesIntegrity(config);
  if (ruleIssues.length === 0) {
    console.log('[CHECK] ✓ All core risk params correct');
  } else {
    console.warn('[CHECK] ⚠ Issues found (manual review needed — not auto-fixed):');
    ruleIssues.forEach(i => console.warn(`  - ${i}`));
  }

  // ── 2. PERFORMANCE & SIGNAL ANALYSIS ─────────────────────────────────────
  console.log('[ANALYSIS] Computing performance by symbol...');
  const perfBySymbol   = analyzePerformance(trades);
  const signalHealth   = analyzeWatchlistHealth(trades);

  const perfSummary = currentWatchlist.map(sym => {
    const s = signalHealth[sym] || {};
    const p = perfBySymbol[sym];
    const priceStr   = s.has_price_data ? `$${(s.current_price||0).toFixed(2)}` : 'NO DATA';
    const confStr    = s.confidence != null ? s.confidence.toFixed(1) : 'no score';
    const perfStr    = p ? `${p.trades}T ${p.wins}W/${p.losses}L avg${p.avg_pnl_pct>=0?'+':''}${p.avg_pnl_pct}%` : 'no trades';
    const signalStr  = s.entry_signal ? '🟢 SIGNAL' : 'no signal';
    console.log(`  ${sym.padEnd(6)} | ${priceStr.padEnd(12)} | conf ${confStr.padEnd(6)} | ${signalStr} | ${perfStr}`);
    return { sym, priceStr, confStr, perfStr, has_price_data: s.has_price_data };
  });

  // Identify health concerns
  const noDataSymbols   = currentWatchlist.filter(s => signalHealth[s] && !signalHealth[s].has_price_data && !signalHealth[s].is_new);
  const zeroConfSymbols = currentWatchlist.filter(s => signalHealth[s] && signalHealth[s].confidence == null && !signalHealth[s].is_new);
  console.log(`\n[HEALTH] No price data: ${noDataSymbols.length > 0 ? noDataSymbols.join(', ') : 'none'}`);
  console.log(`[HEALTH] No confidence score: ${zeroConfSymbols.length > 0 ? zeroConfSymbols.join(', ') : 'none'}`);

  // ── 3. BUILD MISTRAL PROMPT ───────────────────────────────────────────────
  const watchlistLines = currentWatchlist.map(sym => {
    const s = signalHealth[sym] || {};
    const p = perfBySymbol[sym];
    return [
      `  ${sym}:`,
      `    price=${s.has_price_data ? '$'+s.current_price.toFixed(2) : '⚠ unavailable'}`,
      `    confidence=${s.confidence != null ? s.confidence.toFixed(1) : 'N/A'}`,
      `    rsi=${s.rsi ?? 'N/A'} | vol_ratio=${s.volume_ratio?.toFixed(2) ?? 'N/A'}x | change=${s.change_pct != null ? (s.change_pct>=0?'+':'')+s.change_pct+'%' : 'N/A'}`,
      `    entry_signal=${s.entry_signal ? 'YES' : 'no'}`,
      `    last_thesis="${s.last_reason || 'none'}"`,
      `    trade_history=${p ? `${p.trades} trades, ${p.wins}W/${p.losses}L, avg ${p.avg_pnl_pct>=0?'+':''}${p.avg_pnl_pct}% per trade` : 'no closed trades yet'}`,
      `    data_age=${s.days_since_update <= 1 ? 'fresh' : s.days_since_update + ' days old'}`,
    ].join('\n');
  }).join('\n\n');

  const candidates = CANDIDATE_POOL.filter(s => !currentWatchlist.includes(s)).join(', ');

  const prompt = `You are a trading bot watchlist optimizer. Today is ${new Date().toISOString().split('T')[0]}.
This is a paper trading bot focused on the AI/tech/fintech sector. It scans for momentum breakouts, oversold bounces, and crypto continuations. Stop loss: 2.5%, profit target: 5%, max hold: 3 days.

CURRENT WATCHLIST (${currentWatchlist.length} symbols):

${watchlistLines}

CANDIDATE POOL (symbols you may ADD — not currently watched):
${candidates}

PROTECTED — never remove: NVDA, META, MSFT, BTC
PROTECTED — open position: ${[...openSymbols].join(', ') || 'none'}

YOUR TASK:
Analyze each symbol for its fitness in this bot's strategy. Look for:
1. Symbols with consistently unavailable price data (Yahoo Finance fetch failures) — strong removal candidate
2. Symbols generating no confidence scores or entry signals over multiple scans
3. Symbols with poor trade history (multiple losses, zero wins, small sample)
4. Candidates from the pool that better fit the bot's setup types (momentum breakouts, AI/tech sector leaders)

Be conservative. Only recommend changes when there is a clear reason. 0 changes is a valid answer.
When adding a symbol, prioritise: high institutional coverage, strong liquidity, clear AI/tech/fintech thesis, high volatility (5%+ daily range common), active options market.

CONSTRAINTS:
- Recommend at most 2 REMOVE + 2 ADD changes (must be paired or solo removes)
- If the watchlist is working well → return "changes": []
- Never remove NVDA, META, MSFT, BTC
- Never remove a symbol with an open position
- Keep watchlist size 10–15 symbols
- Only pick ADD symbols from the candidate pool listed above

Return ONLY valid JSON — no preamble, no explanation outside the JSON:
{
  "assessment": "2-3 sentence overall assessment of watchlist quality and current market fit",
  "market_regime_note": "one sentence: current AI/tech sector momentum and what it means for setup frequency",
  "changes": [
    { "action": "REMOVE", "symbol": "HOOD", "reason": "brief 1-line reason" },
    { "action": "ADD",    "symbol": "CRWD", "reason": "brief 1-line reason" }
  ],
  "symbol_notes": {
    "NVDA": "one line momentum/health note",
    "PLTR": "one line"
  },
  "flags": ["any warnings the human operator should know about — API issues, stale data, etc."]
}`;

  // ── 4. CALL MISTRAL ───────────────────────────────────────────────────────
  let review = null;
  try {
    const aiText = await callMistral(prompt);
    review = parseAI(aiText);
    if (review) {
      console.log(`\n[REVIEW] ${review.assessment}`);
      if (review.market_regime_note) console.log(`[REGIME] ${review.market_regime_note}`);
      if (review.changes?.length > 0) {
        console.log('[CHANGES]');
        review.changes.forEach(c => console.log(`  ${c.action.padEnd(6)} ${c.symbol} — ${c.reason}`));
      } else {
        console.log('[CHANGES] No changes recommended');
      }
      if (review.flags?.length > 0) {
        console.warn('[FLAGS]');
        review.flags.forEach(f => console.warn(`  ⚑ ${f}`));
      }
    }
  } catch (e) {
    console.error('[ERROR] Mistral failed:', e.message);
  }

  // ── 5. APPLY CHANGES ──────────────────────────────────────────────────────
  const changedFiles   = [];
  const appliedChanges = [];
  let   newWatchlist   = [...currentWatchlist];

  if (review?.changes?.length > 0) {
    for (const change of review.changes) {
      const sym = (change.symbol || '').toUpperCase().trim();
      if (!sym) continue;

      if (change.action === 'REMOVE') {
        if (CORE_SYMBOLS.has(sym))          { console.log(`[SKIP REMOVE] ${sym}: core symbol — protected`); continue; }
        if (openSymbols.has(sym))           { console.log(`[SKIP REMOVE] ${sym}: open position — protected`); continue; }
        if (!newWatchlist.includes(sym))    { console.log(`[SKIP REMOVE] ${sym}: not in watchlist`); continue; }
        if (newWatchlist.length <= 10)      { console.log(`[SKIP REMOVE] ${sym}: watchlist at minimum (10)`); continue; }

        newWatchlist = newWatchlist.filter(s => s !== sym);
        appliedChanges.push({ ...change, symbol: sym });
        console.log(`[WATCHLIST] ✕ Removed: ${sym} — ${change.reason}`);

      } else if (change.action === 'ADD') {
        if (newWatchlist.includes(sym))                            { console.log(`[SKIP ADD] ${sym}: already in watchlist`); continue; }
        if (newWatchlist.length >= 15)                             { console.log(`[SKIP ADD] ${sym}: watchlist at maximum (15)`); continue; }
        if (!CANDIDATE_POOL.includes(sym))                         { console.log(`[SKIP ADD] ${sym}: not in approved candidate pool`); continue; }

        newWatchlist.push(sym);
        appliedChanges.push({ ...change, symbol: sym });
        console.log(`[WATCHLIST] ✦ Added: ${sym} — ${change.reason}`);
      }
    }

    const changed = newWatchlist.length !== currentWatchlist.length ||
                    newWatchlist.some((s, i) => s !== currentWatchlist[i]);

    if (changed) {
      config.watchlist = newWatchlist;
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
      changedFiles.push('config.json');
      updateRulesPromptWatchlist(newWatchlist);
      changedFiles.push('rules-prompt.txt');
    }
  }

  // ── 6. WRITE REVIEW LOG ───────────────────────────────────────────────────
  let reviewLog = [];
  try {
    if (fs.existsSync(REVIEW_LOG)) reviewLog = JSON.parse(fs.readFileSync(REVIEW_LOG, 'utf8'));
    if (!Array.isArray(reviewLog)) reviewLog = [];
  } catch { reviewLog = []; }

  reviewLog.unshift({
    date:              new Date().toISOString().split('T')[0],
    timestamp:         new Date().toISOString(),
    rule_issues:       ruleIssues,
    assessment:        review?.assessment        ?? 'AI review unavailable',
    market_regime_note: review?.market_regime_note ?? null,
    flags:             review?.flags             ?? [],
    changes_applied:   appliedChanges,
    watchlist_after:   newWatchlist,
    symbol_notes:      review?.symbol_notes      ?? {},
    data_health: {
      no_price_data:      noDataSymbols,
      no_confidence_score: zeroConfSymbols,
    },
    performance_snapshot: Object.fromEntries(
      Object.values(perfBySymbol).map(s => [s.symbol, {
        trades: s.trades, wins: s.wins, losses: s.losses,
        win_rate: s.win_rate, avg_pnl_pct: s.avg_pnl_pct
      }])
    )
  });

  if (reviewLog.length > 30) reviewLog = reviewLog.slice(0, 30);
  fs.writeFileSync(REVIEW_LOG, JSON.stringify(reviewLog, null, 2));
  changedFiles.push('review-log.json');

  // ── 7. COMMIT ─────────────────────────────────────────────────────────────
  const today     = new Date().toISOString().split('T')[0];
  const changeSuf = appliedChanges.length > 0
    ? `(${appliedChanges.map(c => `${c.action} ${c.symbol}`).join(', ')})`
    : '(no changes)';
  commitChanges(changedFiles, `review: daily watchlist review ${today} ${changeSuf}`);

  console.log('\n─────────────────────────────────────────────────────────');
  console.log(`  Rule issues:      ${ruleIssues.length}`);
  console.log(`  Changes applied:  ${appliedChanges.length}`);
  console.log(`  Watchlist after:  ${newWatchlist.join(', ')}`);
  console.log('[✓] Daily review complete.\n');
}

main().catch(err => {
  console.error('\n[FATAL]', err.message, '\n', err.stack);
  process.exit(1);
});
