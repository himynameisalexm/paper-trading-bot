#!/usr/bin/env node

const fs = require('fs');
const https = require('https');
const { execSync } = require('child_process');

// ─── CONFIG ────────────────────────────────────────────────────────────────
const CONFIG        = JSON.parse(fs.readFileSync('./config.json', 'utf8'));
const RULES_PROMPT  = fs.readFileSync('./rules-prompt.txt', 'utf8');
const TRADES_FILE   = './trades.json';
const MISTRAL_API_KEY = process.env.MISTRAL_API_KEY;

// ─── SAFEGUARD CONSTANTS (from config) ────────────────────────────────────
const DAILY_LOSS_LIMIT_PCT  = CONFIG.trading_rules?.safeguards?.daily_loss_limit_percent  ?? 5.0;
const EARNINGS_BLACKOUT_DAYS = CONFIG.trading_rules?.safeguards?.earnings_blackout_days   ?? 7;
const MIN_VOLUME_RATIO       = CONFIG.trading_rules?.safeguards?.min_volume_ratio         ?? 1.5;
const NO_ENTRY_OPEN_MIN      = CONFIG.trading_rules?.safeguards?.no_entry_before_minutes  ?? 10;
const NO_ENTRY_CLOSE_MIN     = CONFIG.trading_rules?.safeguards?.no_entry_after_minutes_before_close ?? 30;

// ─── HTTP HELPER ───────────────────────────────────────────────────────────
function makeRequest(options, body = null) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); }
        catch { resolve(raw); }
      });
    });
    req.on('error', reject);
    req.setTimeout(55000, () => { req.destroy(new Error('Request timeout')); });
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// ─── GIT COMMIT & PUSH ──────────────────────────────────────────────────────
function commitAndPushTrades() {
  try {
    // Configure git if running in GitHub Actions
    if (process.env.GITHUB_ACTIONS) {
      execSync('git config user.email "github-actions[bot]@users.noreply.github.com"', { stdio: 'pipe' });
      execSync('git config user.name "github-actions[bot]"', { stdio: 'pipe' });
    }

    // Check if there are changes to commit
    const status = execSync('git status --porcelain trades.json', { encoding: 'utf8' });
    if (!status.trim()) {
      console.log('[GIT] No changes to trades.json — skipping commit');
      return;
    }

    // Stage, commit, and push
    execSync('git add trades.json', { stdio: 'pipe' });
    const timestamp = new Date().toISOString().split('T')[0] + ' ' + new Date().toLocaleTimeString('en-US', { timeZone: 'America/New_York' });
    execSync(`git commit -m "bot: update trades.json (${timestamp})"`, { stdio: 'pipe' });
    execSync('git push origin main', { stdio: 'pipe' });

    console.log('[GIT] ✓ Committed and pushed trades.json to GitHub');
  } catch (e) {
    if (e.message.includes('nothing to commit')) {
      console.log('[GIT] No changes to trades.json — skipping commit');
    } else {
      console.error('[GIT] Error during commit/push:', e.message);
      // Don't fail the bot run if git fails — continue trading
    }
  }
}

// ─── RSI(14) CALCULATOR ────────────────────────────────────────────────────
function computeRSI(closes, period = 14) {
  if (!closes || closes.length < period + 1) return null;
  const recent = closes.slice(-period - 1);
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = recent[i] - recent[i - 1];
    if (diff > 0) gains += diff;
    else losses += Math.abs(diff);
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  return parseFloat((100 - 100 / (1 + avgGain / avgLoss)).toFixed(1));
}

// ─── CRYPTO SYMBOLS ────────────────────────────────────────────────────────
const CRYPTO_SYMBOLS = new Set(['BTC', 'ETH', 'SOL', 'COIN']);

function isCrypto(symbol) {
  return CRYPTO_SYMBOLS.has(symbol);
}

// ─── WEEKEND DETECTION ────────────────────────────────────────────────────
function isWeekend() {
  const etTime = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const day = etTime.getDay(); // 0 = Sunday, 6 = Saturday
  return day === 0 || day === 6;
}

// Returns only the symbols that are tradeable right now
// Weekends: crypto only (stocks market is closed)
// Weekdays: everything
function getActiveSymbols(symbolList) {
  if (isWeekend()) {
    const cryptoOnly = symbolList.filter(s => isCrypto(s));
    console.log(`[WEEKEND] Stock markets closed — scanning crypto only: ${cryptoOnly.join(', ')}`);
    return cryptoOnly;
  }
  return symbolList;
}

// ─── TRADING WINDOW GATE ───────────────────────────────────────────────────
// symbol param: crypto bypasses the stock market open/close window
function isWithinTradingWindow(symbol = null) {
  // Crypto trades 24/7 — no time restriction
  if (symbol && isCrypto(symbol)) {
    console.log(`[GATE] Trading window: OPEN (crypto trades 24/7)`);
    return true;
  }

  // On weekends, no stock entries at all
  if (isWeekend()) {
    console.log(`[GATE] Trading window: CLOSED — weekend, stock markets closed`);
    return false;
  }

  const now = new Date();
  const etTime = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const hour = etTime.getHours();
  const minute = etTime.getMinutes();
  const totalMin = hour * 60 + minute;

  const marketOpen  = 9 * 60 + 30;
  const entryStart  = marketOpen + NO_ENTRY_OPEN_MIN;  // 9:40 AM
  const entryEnd    = 16 * 60 - NO_ENTRY_CLOSE_MIN;    // 3:30 PM

  if (totalMin < entryStart) {
    console.log(`[GATE] Trading window: too early (${etTime.toLocaleTimeString('en-US')} ET). No stock entries before 9:40 AM.`);
    return false;
  }
  if (totalMin > entryEnd) {
    console.log(`[GATE] Trading window: too late (${etTime.toLocaleTimeString('en-US')} ET). No stock entries after 3:30 PM.`);
    return false;
  }
  console.log(`[GATE] Trading window: OPEN (${etTime.toLocaleTimeString('en-US')} ET)`);
  return true;
}

// ─── DAILY LOSS LIMIT CHECK ────────────────────────────────────────────────
function isDailyLossLimitHit(session) {
  // Daily loss limit is calculated against the daily trading capital allocation ($5k)
  // not against total account value ($20k)
  const dailyAlloc = session.daily_trading_capital || CONFIG.account?.daily_trading_capital || 5000;
  const dailyUsed = session.daily_trading_used || 0;

  // Current profit/loss on positions entered today
  const positionsPnL = (session.unrealized_pnl || 0) + (session.realized_pnl || 0);
  const totalDailyPnL = -positionsPnL; // negative if loss
  const lossPct = (totalDailyPnL / dailyAlloc) * 100;

  if (lossPct >= DAILY_LOSS_LIMIT_PCT) {
    console.log(`[CIRCUIT BREAKER] Daily loss limit hit on $${dailyAlloc.toFixed(2)} allocation: -$${totalDailyPnL.toFixed(2)} (-${lossPct.toFixed(2)}%) ≥ ${DAILY_LOSS_LIMIT_PCT}%`);
    console.log('[CIRCUIT BREAKER] No new entries for remainder of session.');
    return true;
  }
  console.log(`[GATE] Daily P&L: -$${Math.max(0, totalDailyPnL).toFixed(2)} (-${Math.max(0, lossPct).toFixed(2)}%) on $${dailyAlloc.toFixed(2)} daily allocation — within limit`);
  return false;
}

// ─── FETCH EARNINGS DATE ───────────────────────────────────────────────────
async function fetchEarningsDate(symbol) {
  if (['BTC', 'ETH', 'COIN'].includes(symbol)) return null; // crypto has no earnings
  try {
    const encoded = symbol;
    const res = await makeRequest({
      hostname: 'query1.finance.yahoo.com',
      path: `/v8/finance/chart/${encoded}?events=earnings&interval=1d&range=90d`,
      method: 'GET',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TradingBot/1.0)' }
    });
    const events = res?.chart?.result?.[0]?.events?.earnings;
    if (!events) return null;

    const nowSec = Date.now() / 1000;
    const upcoming = Object.values(events)
      .filter(e => e.date > nowSec)
      .sort((a, b) => a.date - b.date);

    if (upcoming.length === 0) return null;
    return Math.floor((upcoming[0].date - nowSec) / 86400);
  } catch (e) {
    console.warn(`[EARNINGS] ${symbol}: ${e.message}`);
    return null; // unknown → don't block trade
  }
}

// ─── FETCH REDDIT SENTIMENT ────────────────────────────────────────────────
async function fetchRedditSentiment(symbols) {
  console.log('[REDDIT] Fetching sentiment for watchlist...');
  const sentiment = {};

  for (const symbol of symbols) {
    const posts = [];
    try {
      const res = await makeRequest({
        hostname: 'www.reddit.com',
        path: `/search.json?q=${encodeURIComponent(symbol)}&sort=hot&limit=5&t=day`,
        method: 'GET',
        headers: { 'User-Agent': 'TradingBot/1.0 (paper trading research — not for commercial use)' }
      });
      for (const child of res?.data?.children || []) {
        const d = child.data;
        if (d?.title && d.ups > 10) {
          posts.push(`"${d.title.substring(0, 120)}" (${d.ups} upvotes, ${d.num_comments} comments)`);
        }
      }
    } catch (e) {
      // Reddit unavailable — skip gracefully
    }

    sentiment[symbol] = posts.length > 0
      ? posts.slice(0, 3)
      : ['No significant Reddit discussion in last 24h'];

    await new Promise(r => setTimeout(r, 600)); // rate limit buffer
  }

  const total = Object.values(sentiment).flat().filter(s => !s.includes('No significant')).length;
  console.log(`[REDDIT] Found ${total} relevant posts across ${symbols.length} symbols`);
  return sentiment;
}

// ─── FETCH SYMBOL DATA FROM V8 CHART (single call returns price + history) ──
async function fetchChartData(symbol) {
  const encoded = symbol === 'BTC' ? 'BTC-USD' : symbol === 'ETH' ? 'ETH-USD' : symbol === '^VIX' ? '%5EVIX' : symbol;
  try {
    const res = await makeRequest({
      hostname: 'query1.finance.yahoo.com',
      path: `/v8/finance/chart/${encoded}?interval=1d&range=60d`,
      method: 'GET',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TradingBot/1.0)' }
    });
    const result = res?.chart?.result?.[0];
    if (!result) return null;

    const meta    = result.meta;
    const closes  = (result.indicators?.quote?.[0]?.close || []).filter(c => c != null);
    const volumes = (result.indicators?.quote?.[0]?.volume || []).filter(v => v != null);

    const price     = meta?.regularMarketPrice ?? null;
    const prevClose = meta?.chartPreviousClose  ?? null;
    const chgPct    = price && prevClose ? ((price - prevClose) / prevClose * 100) : 0;

    // Compute MA50 & MA200 from daily closes
    const ma50  = closes.length >= 50  ? closes.slice(-50).reduce((a, b) => a + b, 0) / 50  : closes.length > 0 ? closes.reduce((a,b) => a+b, 0) / closes.length : null;
    const ma200 = closes.length >= 200 ? closes.slice(-200).reduce((a, b) => a + b, 0) / 200 : null;

    // Compute avg volume from last 10 days
    const avgVol   = volumes.length >= 10 ? volumes.slice(-10).reduce((a, b) => a + b, 0) / 10 : null;
    const todayVol = volumes[volumes.length - 1] ?? null;
    const volRatio = todayVol && avgVol ? todayVol / avgVol : null;

    // RSI(14)
    const rsi = computeRSI(closes);

    // Day high/low from meta
    const dayHigh = meta?.regularMarketDayHigh ?? null;
    const dayLow  = meta?.regularMarketDayLow  ?? null;

    return {
      symbol,
      current_price: price,
      prev_close: prevClose,
      change_pct: parseFloat(chgPct.toFixed(2)),
      day_high: dayHigh,
      day_low: dayLow,
      volume: todayVol,
      avg_volume: avgVol ? Math.round(avgVol) : null,
      volume_ratio: volRatio ? parseFloat(volRatio.toFixed(2)) : null,
      ma50:  ma50  ? parseFloat(ma50.toFixed(2))  : null,
      ma200: ma200 ? parseFloat(ma200.toFixed(2)) : null,
      above_ma50:  price && ma50  ? price > ma50  : null,
      above_ma200: price && ma200 ? price > ma200 : null,
      rsi,
      timestamp: new Date().toISOString()
    };
  } catch (e) {
    console.warn(`[CHART] ${symbol}: ${e.message}`);
    return null;
  }
}

// ─── FETCH CURRENT MARKET DATA ─────────────────────────────────────────────
async function fetchMarketData(symbols) {
  console.log(`[FETCH] Market data for: ${symbols.join(', ')}`);
  const result = {};

  for (const symbol of symbols) {
    const data = await fetchChartData(symbol);
    if (data) {
      result[symbol] = data;
      const p = data.current_price;
      console.log(`  ${symbol.padEnd(6)} $${p?.toFixed(2).padStart(10)} | ${data.change_pct >= 0 ? '+' : ''}${data.change_pct}% | RSI ${data.rsi ?? 'n/a'} | Vol ${data.volume_ratio?.toFixed(1) ?? 'n/a'}x | MA50 $${data.ma50?.toFixed(2)}`);
    } else {
      result[symbol] = { symbol, current_price: null, error: 'fetch failed' };
      console.warn(`  ${symbol.padEnd(6)} failed`);
    }
    await new Promise(r => setTimeout(r, 200)); // rate limit buffer
  }
  return result;
}

// ─── FETCH MACRO STATUS ────────────────────────────────────────────────────
async function fetchMacroStatus() {
  console.log('[FETCH] Macro: QQQ + VIX');
  const macro = {
    qqq_price: null, qqq_50day_ma: null, qqq_above_ma: null,
    vix: null, vix_below_25: null,
    timestamp: new Date().toISOString(), gate_pass: null
  };
  try {
    const qqq = await fetchChartData('QQQ');
    if (qqq) {
      macro.qqq_price    = qqq.current_price;
      macro.qqq_50day_ma = qqq.ma50;
      macro.qqq_above_ma = qqq.above_ma50;
    }
    const vix = await fetchChartData('^VIX');
    if (vix) {
      macro.vix          = vix.current_price;
      macro.vix_below_25 = vix.current_price !== null ? vix.current_price < 25 : null;
    }
    macro.gate_pass = macro.qqq_above_ma === true && macro.vix_below_25 === true;
    console.log(`  QQQ $${macro.qqq_price?.toFixed(2)} | MA50 $${macro.qqq_50day_ma?.toFixed(2)} → ${macro.qqq_above_ma ? 'ABOVE ✓' : 'BELOW ✗'}`);
    console.log(`  VIX ${macro.vix?.toFixed(2)} → ${macro.vix_below_25 ? 'OK ✓' : 'HIGH ✗'}`);
    console.log(`  Gate: ${macro.gate_pass ? '✓ PASS' : '✗ FAIL'}`);
  } catch (e) {
    console.warn(`[WARN] Macro: ${e.message}`);
  }
  return macro;
}

// ─── CALL MISTRAL AI ───────────────────────────────────────────────────────
async function callMistral(prompt) {
  if (!MISTRAL_API_KEY) throw new Error('MISTRAL_API_KEY not set');
  console.log('[MISTRAL] Calling API...');
  const res = await makeRequest({
    hostname: 'api.mistral.ai',
    path: '/v1/chat/completions',
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${MISTRAL_API_KEY}`,
      'Content-Type': 'application/json'
    }
  }, {
    model: CONFIG.api?.mistral?.model || 'mistral-large-latest',
    messages: [
      { role: 'system', content: RULES_PROMPT },
      { role: 'user',   content: prompt }
    ],
    temperature: CONFIG.api?.mistral?.temperature || 0.3,
    max_tokens: CONFIG.api?.mistral?.max_tokens  || 2000
  });

  const content = res?.choices?.[0]?.message?.content;
  if (!content) throw new Error(`Bad Mistral response: ${JSON.stringify(res).substring(0, 200)}`);
  return content;
}

// ─── PARSE AI JSON ─────────────────────────────────────────────────────────
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

// ─── DATE HELPERS ──────────────────────────────────────────────────────────
function todayET() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

// ─── DAY RESET ─────────────────────────────────────────────────────────────
function handleDayReset(trades) {
  const today = todayET();
  if (trades.session?.date === today) return false;

  console.log(`[DAY RESET] ${trades.session?.date ?? 'unknown'} → ${today}`);

  if (!trades.daily_sessions) trades.daily_sessions = [];

  if (trades.session?.date) {
    // Archive yesterday's session summary
    trades.daily_sessions.unshift({
      date: trades.session.date,
      total_account_before_day: trades.session.total_account_value || 20000,
      daily_trading_capital_used: trades.session.daily_trading_used || 0,
      ending_account_value: trades.session.total_account_value,
      realized_pnl: trades.session.realized_pnl,
      unrealized_pnl: trades.session.unrealized_pnl,
      trades_closed: trades.session.trades_closed,
      wins: trades.session.wins,
      losses: trades.session.losses,
      win_rate: trades.session.win_rate
    });
    if (trades.daily_sessions.length > 30) trades.daily_sessions.pop();
  }

  // Get current account values (carry forward from previous session)
  const totalAcct = trades.session?.total_account_value ?? CONFIG.account?.total_account_value ?? 20000;
  const dailyTradeAlloc = CONFIG.account?.daily_trading_capital ?? 5000;

  trades.session = {
    date: today,
    total_account_value: totalAcct,           // Carries across days
    daily_trading_capital: dailyTradeAlloc,   // Resets to $5k each day
    daily_trading_used: 0,                    // Fresh allocation each day
    current_cash: totalAcct,                  // Total cash (not session-locked)
    open_positions_value: 0,
    realized_pnl: 0,
    unrealized_pnl: 0,
    total_pnl: 0,
    trades_closed: 0,
    trades_open: trades.open_positions?.length ?? 0,
    win_rate: 0, wins: 0, losses: 0, break_even: 0
  };

  console.log(`[DAY RESET] New session: Total account $${totalAcct.toFixed(2)} | Daily trading capital reset to $${dailyTradeAlloc.toFixed(2)}`);
  return true;
}

// ─── PRE-MARKET SCAN ───────────────────────────────────────────────────────
async function preMarketScan() {
  console.log('\n═══════════════════════════════════════════════');
  console.log('  PRE-MARKET SCAN —', new Date().toISOString());
  console.log('═══════════════════════════════════════════════\n');

  const trades = JSON.parse(fs.readFileSync(TRADES_FILE, 'utf8'));
  handleDayReset(trades);

  const activeSymbols = getActiveSymbols(CONFIG.watchlist);
  const marketData = await fetchMarketData(activeSymbols);
  const macro      = isWeekend() ? { gate_pass: true, qqq_above_ma: null, vix_below_25: null, weekend: true } : await fetchMacroStatus();
  const reddit     = await fetchRedditSentiment(activeSymbols);

  // Build market summary — real prices only, AI provides analysis only
  let mktSummary = 'LIVE MARKET DATA (use EXACTLY these prices — never invent or guess prices):\n\n';
  for (const sym of CONFIG.watchlist) {
    const d = marketData[sym];
    if (!d?.current_price) { mktSummary += `${sym}: unavailable\n\n`; continue; }
    const earnings = await fetchEarningsDate(sym);
    await new Promise(r => setTimeout(r, 200));
    const earningsStr = earnings !== null ? `${earnings} days away` : 'unknown';

    mktSummary += `${sym}:
  Current price: $${d.current_price.toFixed(2)} (use this exactly as current_price)
  Change vs prev close: ${d.change_pct >= 0 ? '+' : ''}${d.change_pct}%
  RSI(14): ${d.rsi ?? 'N/A'}
  50-day MA: $${d.ma50?.toFixed(2) ?? 'N/A'} → price is ${d.above_ma50 ? 'ABOVE' : 'BELOW'} MA
  200-day MA: $${d.ma200?.toFixed(2) ?? 'N/A'} → price is ${d.above_ma200 ? 'ABOVE' : 'BELOW'} MA
  Volume ratio: ${d.volume_ratio ?? 'N/A'}x vs 10-day avg
  Day range: $${d.day_low?.toFixed(2) ?? '?'} – $${d.day_high?.toFixed(2) ?? '?'}
  Next earnings: ${earningsStr}${earnings !== null && earnings < 7 ? ' ⚠️ EARNINGS BLACKOUT — do not enter' : ''}
  Reddit (24h): ${(reddit[sym] || ['No data']).join(' | ')}\n\n`;
  }

  const macroStr = `MACRO GATE:
  QQQ: $${macro.qqq_price?.toFixed(2) ?? 'N/A'} vs MA50 $${macro.qqq_50day_ma?.toFixed(2) ?? 'N/A'} → ${macro.qqq_above_ma ? 'ABOVE ✓' : 'BELOW ✗'}
  VIX: ${macro.vix?.toFixed(2) ?? 'N/A'} → ${macro.vix_below_25 ? 'BELOW 25 ✓' : 'ABOVE 25 ✗'}
  Gate status: ${macro.gate_pass ? '✓ PASS — full position sizing' : '✗ FAIL — cash unless extraordinary catalyst'}`;

  const openStr = trades.open_positions?.length
    ? '\nOPEN POSITIONS:\n' + trades.open_positions.map(p =>
        `  ${p.symbol}: entry $${p.entry_price.toFixed(2)} | stop $${p.stop_loss.toFixed(2)} | target $${p.profit_target.toFixed(2)}`
      ).join('\n')
    : '\nOPEN POSITIONS: None';

  const prompt = `${mktSummary}${macroStr}${openStr}

DATE (ET): ${todayET()}
CASH AVAILABLE: $${trades.session.current_cash.toFixed(2)}
OPEN POSITIONS: ${trades.open_positions?.length ?? 0}/2 slots used

CRITICAL: In your response, set current_price to EXACTLY the values I listed above.
DO NOT change or hallucinate prices. Only provide analysis, confidence, entry targets, and thesis.

Return ONLY valid JSON in the watchlist_generation format from your instructions.`;

  console.log('[MISTRAL] Pre-market scan prompt sent...');
  let analysis = null;
  try {
    const aiText = await callMistral(prompt);
    analysis = parseAI(aiText);
  } catch (e) {
    console.error('[ERROR] Mistral failed:', e.message);
  }

  trades.macro_status = { ...macro };

  if (analysis?.candidates && Array.isArray(analysis.candidates)) {
    // ALL symbols should appear in candidates per the updated prompt
    let updatedCount = 0;
    for (const c of analysis.candidates) {
      const real = marketData[c.symbol];
      const item = trades.watchlist.find(w => w.symbol === c.symbol);
      if (item) {
        item.current_price = real?.current_price ?? null; // ALWAYS real price
        item.confidence    = c.confidence        ?? null;
        item.entry_signal  = c.entry_signal      ?? false;
        item.entry_target  = c.entry_target      ?? null;
        item.stop_loss     = c.stop_loss         ?? null;
        item.profit_target = c.profit_target     ?? null;
        item.priority      = c.priority          ?? 5;
        item.reason        = c.thesis            ?? c.reason ?? null;
        item.technical_setup = c.technical_setup ?? null;
        item.rsi           = real?.rsi           ?? null;
        item.change_pct    = real?.change_pct    ?? null;
        item.volume_ratio  = real?.volume_ratio  ?? null;
        item.last_updated  = new Date().toISOString();
        updatedCount++;
      }
    }

    // For any symbol NOT returned by AI, still update its price data
    const aiSymbols = new Set(analysis.candidates.map(c => c.symbol));
    for (const item of trades.watchlist) {
      if (!aiSymbols.has(item.symbol)) {
        const real = marketData[item.symbol];
        if (real?.current_price != null) {
          item.current_price = real.current_price;
          item.rsi           = real.rsi;
          item.change_pct    = real.change_pct;
          item.volume_ratio  = real.volume_ratio;
          item.confidence    = null;
          item.entry_signal  = false;
          item.reason        = 'Not rated in today\'s scan';
          item.last_updated  = new Date().toISOString();
        }
      }
    }

    const signalCount = trades.watchlist.filter(w => w.confidence != null).length;
    console.log(`[SCAN] ${updatedCount} symbols rated by AI | ${signalCount} with confidence scores | ${trades.watchlist.filter(w => w.entry_signal).length} entry signals`);
  } else {
    // Fallback: price-only update if AI fails
    console.warn('[WARN] No candidates from AI — refreshing prices only');
    for (const item of trades.watchlist) {
      const real = marketData[item.symbol];
      if (real?.current_price != null) {
        item.current_price = real.current_price;
        item.rsi           = real.rsi;
        item.change_pct    = real.change_pct;
        item.volume_ratio  = real.volume_ratio;
        item.last_updated  = new Date().toISOString();
      }
    }
  }

  trades.system_status.last_scan    = new Date().toISOString();
  trades.system_status.market_status = 'pre-market';

  fs.writeFileSync(TRADES_FILE, JSON.stringify(trades, null, 2));
  commitAndPushTrades();
  console.log('\n[✓] Pre-market scan complete.\n');
}

// ─── INTRADAY EVALUATION ───────────────────────────────────────────────────
async function intradayEvaluation() {
  console.log('\n═══════════════════════════════════════════════');
  console.log('  INTRADAY EVALUATION —', new Date().toISOString());
  console.log('═══════════════════════════════════════════════\n');

  const trades = JSON.parse(fs.readFileSync(TRADES_FILE, 'utf8'));
  handleDayReset(trades);

  const weekend = isWeekend();
  const activeWatchlist = getActiveSymbols(CONFIG.watchlist);
  // Always include open position symbols so we can manage/exit them even on weekends
  const allSymbols = [...new Set([...activeWatchlist, ...trades.open_positions.map(p => p.symbol)])];
  const marketData = await fetchMarketData(allSymbols);
  const macro      = weekend
    ? { gate_pass: true, qqq_above_ma: null, vix_below_25: null, weekend: true, gate_note: 'Weekend — crypto only, macro gate N/A' }
    : await fetchMacroStatus();

  // Update position prices from real data
  for (const pos of trades.open_positions) {
    const real = marketData[pos.symbol];
    if (real?.current_price != null) pos.current_price = real.current_price;
  }

  // ── AUTO-EXITS: stops, targets, max-hold ──────────────────────────────
  const autoExits = [];
  const now = new Date();
  for (const pos of trades.open_positions) {
    const p = pos.current_price;
    if (p <= pos.stop_loss) {
      autoExits.push({ symbol: pos.symbol, price: p, reason: `Stop loss hit at $${p.toFixed(2)} (stop was $${pos.stop_loss.toFixed(2)})` });
    } else if (p >= pos.profit_target) {
      autoExits.push({ symbol: pos.symbol, price: p, reason: `Profit target reached at $${p.toFixed(2)} (target $${pos.profit_target.toFixed(2)})` });
    } else {
      const daysHeld = (now - new Date(pos.entry_date)) / 86400000;
      if (daysHeld >= 2) {
        autoExits.push({ symbol: pos.symbol, price: p, reason: `Max hold reached (${daysHeld.toFixed(1)} days)` });
      }
    }
  }

  function closePosition(sym, exitPrice, reason) {
    const idx = trades.open_positions.findIndex(p => p.symbol === sym);
    if (idx === -1) return;
    const pos = trades.open_positions[idx];
    const pnl    = parseFloat(((exitPrice - pos.entry_price) * pos.shares).toFixed(2));
    const pnlPct = parseFloat(((exitPrice - pos.entry_price) / pos.entry_price * 100).toFixed(2));

    trades.closed_trades.push({
      id: pos.id || `trade_${Date.now()}_${sym}`,
      symbol: sym,
      entry_price: pos.entry_price,
      exit_price: exitPrice,
      shares: pos.shares,
      realized_pnl: pnl,
      realized_pnl_percent: pnlPct,
      entry_date: pos.entry_date,
      exit_date: now.toISOString(),
      entry_reason: pos.entry_reason || pos.thesis,
      exit_reason: reason,
      session_date: todayET()
    });

    trades.session.realized_pnl  += pnl;
    trades.session.current_cash  += pos.entry_price * pos.shares + pnl;
    trades.session.trades_closed += 1;
    if (pnl > 0) trades.session.wins++;
    else if (pnl < 0) trades.session.losses++;
    else trades.session.break_even++;

    trades.open_positions.splice(idx, 1);
    console.log(`[EXIT] ${sym}: $${exitPrice.toFixed(2)} → ${pnl >= 0 ? '✓ WIN' : '✗ LOSS'} $${pnl} (${pnlPct}%)`);
    console.log(`  Reason: ${reason}`);
  }

  for (const ex of autoExits) closePosition(ex.symbol, ex.price, ex.reason);

  // ── TRAIL STOPS: move to break-even once +5% ──────────────────────────
  for (const pos of trades.open_positions) {
    const pnlPct = (pos.current_price - pos.entry_price) / pos.entry_price * 100;
    const beStop = pos.entry_price * 1.005;
    if (pnlPct >= 5 && pos.stop_loss < beStop) {
      console.log(`[TRAIL] ${pos.symbol}: stop $${pos.stop_loss.toFixed(2)} → $${beStop.toFixed(2)} (break-even)`);
      pos.stop_loss = parseFloat(beStop.toFixed(2));
    }
  }

  // ── BUILD AI PROMPT (combined watchlist scoring + position decisions) ──
  let mktSummary = 'LIVE MARKET DATA (use EXACTLY these prices — never invent or guess):\n\n';
  for (const sym of CONFIG.watchlist) {
    const d = marketData[sym];
    if (!d?.current_price) { mktSummary += `${sym}: unavailable\n\n`; continue; }
    mktSummary += `${sym}:
  Price: $${d.current_price.toFixed(2)} | Change: ${d.change_pct >= 0 ? '+' : ''}${d.change_pct}%
  RSI(14): ${d.rsi ?? 'N/A'} | Vol ratio: ${d.volume_ratio?.toFixed(2) ?? 'N/A'}x vs 10-day avg
  MA50: $${d.ma50?.toFixed(2) ?? 'N/A'} (${d.above_ma50 ? 'ABOVE ✓' : 'BELOW ✗'}) | MA200: $${d.ma200?.toFixed(2) ?? 'N/A'} (${d.above_ma200 ? 'ABOVE ✓' : 'BELOW ✗'})
  Day range: $${d.day_low?.toFixed(2) ?? '?'} – $${d.day_high?.toFixed(2) ?? '?'}\n\n`;
  }

  const posLines = trades.open_positions.length
    ? trades.open_positions.map(pos => {
        const pnl = (pos.current_price - pos.entry_price) * pos.shares;
        const pct = ((pos.current_price - pos.entry_price) / pos.entry_price * 100).toFixed(2);
        const days = ((now - new Date(pos.entry_date)) / 86400000).toFixed(1);
        return `  ${pos.symbol}: ${pos.shares}sh @ $${pos.entry_price.toFixed(2)} | now $${pos.current_price.toFixed(2)} | P&L $${pnl.toFixed(2)} (${pct}%) | stop $${pos.stop_loss.toFixed(2)} | target $${pos.profit_target.toFixed(2)} | held ${days} days`;
      }).join('\n')
    : '  None';

  const prompt = `${mktSummary}
MACRO GATE:
  QQQ $${macro.qqq_price?.toFixed(2) ?? 'N/A'} vs MA50 $${macro.qqq_50day_ma?.toFixed(2) ?? 'N/A'} → ${macro.qqq_above_ma ? 'ABOVE ✓' : 'BELOW ✗'}
  VIX ${macro.vix?.toFixed(2) ?? 'N/A'} → ${macro.vix_below_25 ? 'OK ✓' : 'HIGH ✗'}
  Gate: ${macro.gate_pass ? '✓ PASS' : '✗ FAIL'}

OPEN POSITIONS (${trades.open_positions.length}/2):
${posLines}

CASH: $${trades.session.current_cash.toFixed(2)} | DATE/TIME (ET): ${todayET()} ${new Date().toLocaleTimeString('en-US', { timeZone: 'America/New_York' })}
DAILY TRADING CAPITAL: $${(trades.session.daily_trading_capital || 5000).toFixed(2)} | Used today: $${(trades.session.daily_trading_used || 0).toFixed(2)}

TASKS — return BOTH sections:
1. WATCHLIST: Rate EVERY symbol above with a confidence score. All symbols must appear in the watchlist array. At least 3 must have a confidence score (even if entry_signal is false). Be honest — if no setup is there, say so with a clear thesis.
2. POSITIONS: Should any open position be closed early (discretionary)? Any new entries that meet all rules?

RULES:
- entry_price = EXACT current price listed above (never guess)
- stop_loss = entry × 0.965, profit_target = entry × 1.07
- Max 2 open positions (currently ${trades.open_positions.length})
- Min confidence 7.0 to enter — never round up
- Volume ratio ≥ 1.2x required (code enforces this)
- No entries if earnings within 7 days (code enforces this)

Return ONLY valid JSON in hourly_evaluation format.`;

  let decisions = null;
  try {
    const aiText = await callMistral(prompt);
    decisions = parseAI(aiText);
  } catch (e) {
    console.error('[ERROR] Mistral failed:', e.message);
  }

  // ── UPDATE WATCHLIST CONFIDENCE SCORES (every hourly run) ────────────
  if (decisions?.watchlist && Array.isArray(decisions.watchlist)) {
    let scored = 0;
    for (const c of decisions.watchlist) {
      const real = marketData[c.symbol];
      const item = trades.watchlist.find(w => w.symbol === c.symbol);
      if (item) {
        item.current_price   = real?.current_price ?? item.current_price;
        item.confidence      = c.confidence        ?? null;
        item.entry_signal    = c.entry_signal      ?? false;
        item.entry_target    = c.entry_target      ?? null;
        item.stop_loss       = c.stop_loss         ?? null;
        item.profit_target   = c.profit_target     ?? null;
        item.priority        = c.priority          ?? item.priority;
        item.reason          = c.thesis            ?? c.reason ?? item.reason;
        item.technical_setup = c.technical_setup   ?? null;
        item.rsi             = real?.rsi           ?? item.rsi;
        item.change_pct      = real?.change_pct    ?? item.change_pct;
        item.volume_ratio    = real?.volume_ratio  ?? item.volume_ratio;
        item.last_updated    = new Date().toISOString();
        if (c.confidence != null) scored++;
      }
    }
    const signals = trades.watchlist.filter(w => w.entry_signal).length;
    console.log(`[WATCHLIST] ${scored}/${trades.watchlist.length} symbols scored | ${signals} entry signals`);
  }

  // ── PROCESS AI EXITS ──────────────────────────────────────────────────
  if (decisions?.position_exits?.length) {
    for (const ex of decisions.position_exits) {
      const real = marketData[ex.symbol]?.current_price;
      if (real && trades.open_positions.find(p => p.symbol === ex.symbol)) {
        closePosition(ex.symbol, real, ex.reason || 'AI discretionary exit');
      }
    }
  }

  // ── GATE: Daily loss limit ────────────────────────────────────────────
  const lossLimitHit = isDailyLossLimitHit(trades.session);

  // ── PROCESS NEW ENTRIES ───────────────────────────────────────────────
  if (!lossLimitHit && decisions?.new_entries?.length) {
    for (const entry of decisions.new_entries) {
      const sym = entry.symbol;

      // Trading window gate — checked per symbol (crypto is 24/7, stocks are weekday market hours only)
      if (!isWithinTradingWindow(sym)) {
        console.log(`[SKIP] ${sym}: outside trading window`);
        continue;
      }

      // Max positions
      if (trades.open_positions.length >= 2) {
        console.log(`[SKIP] ${sym}: max positions (2/2)`); continue;
      }

      // Real price (never trust AI price)
      const real = marketData[sym];
      const ep   = real?.current_price;
      if (!ep) { console.warn(`[SKIP] ${sym}: no real price data`); continue; }

      // Volume gate (code-enforced)
      const volRatio = real?.volume_ratio;
      if (volRatio !== null && volRatio < MIN_VOLUME_RATIO) {
        console.log(`[SKIP] ${sym}: volume gate failed (${volRatio?.toFixed(2)}x < ${MIN_VOLUME_RATIO}x required)`);
        continue;
      }

      // Earnings blackout (code-enforced)
      const earningsDays = await fetchEarningsDate(sym);
      await new Promise(r => setTimeout(r, 200));
      if (earningsDays !== null && earningsDays < EARNINGS_BLACKOUT_DAYS) {
        console.log(`[SKIP] ${sym}: earnings blackout — ${earningsDays} days away (need >${EARNINGS_BLACKOUT_DAYS})`);
        continue;
      }

      // Confidence gate (min 7.0)
      const confidence = entry.confidence || 0;
      if (confidence < 7.0) {
        console.log(`[SKIP] ${sym}: confidence ${confidence} < 7.0 minimum`);
        continue;
      }

      // Position sizing and capital gates
      const shares = entry.shares || 10;
      const cost   = ep * shares;

      // Check total account cash available
      if (cost > trades.session.current_cash) {
        console.warn(`[SKIP] ${sym}: insufficient account cash ($${trades.session.current_cash.toFixed(2)} < $${cost.toFixed(2)})`);
        continue;
      }

      // Check daily trading capital allocation ($5k per day)
      const dailyTradeCapital = trades.session.daily_trading_capital || CONFIG.account?.daily_trading_capital || 5000;
      const dailyUsed = trades.session.daily_trading_used || 0;
      const dailyRemaining = dailyTradeCapital - dailyUsed;

      if (cost > dailyRemaining) {
        console.warn(`[SKIP] ${sym}: exceeds daily trading capital ($${cost.toFixed(2)} > $${dailyRemaining.toFixed(2)} remaining of $${dailyTradeCapital.toFixed(2)} daily allocation)`);
        continue;
      }

      const stopL = parseFloat((ep * (1 - 0.035)).toFixed(2));
      const targP = parseFloat((ep * (1 + 0.07)).toFixed(2));

      trades.open_positions.push({
        id: `trade_${Date.now()}_${sym}`,
        symbol: sym,
        entry_price: ep,
        entry_date: now.toISOString(),
        entry_reason: entry.thesis || entry.reasoning || entry.reason,
        thesis: entry.thesis || entry.reasoning,
        shares,
        current_price: ep,
        stop_loss: stopL,
        profit_target: targP,
        confidence,
        priority: entry.priority,
        rsi_at_entry: real?.rsi ?? null,
        volume_ratio_at_entry: volRatio ?? null,
        earnings_days_away: earningsDays,
        macro_gate_pass: macro.gate_pass,
        session_date: todayET()
      });

      // Deduct from both total account cash and daily trading allocation
      trades.session.current_cash -= cost;
      trades.session.daily_trading_used = (trades.session.daily_trading_used || 0) + cost;
      trades.session.trades_open   = trades.open_positions.length;

      console.log(`[ENTRY] ${sym}: ${shares}sh @ $${ep.toFixed(2)} | stop $${stopL} | target $${targP} | confidence ${confidence}`);
      console.log(`  Vol: ${volRatio?.toFixed(2)}x | RSI: ${real?.rsi} | Earnings: ${earningsDays ?? 'unknown'} days`);
      console.log(`  Reason: ${(entry.thesis || '').substring(0, 140)}`);
    }
  } else if (lossLimitHit) {
    console.log('[SKIP ALL] Daily loss limit — no new entries');
  } else if (!inTradingWindow) {
    console.log('[SKIP ALL] Outside trading window — no new entries');
  }

  // ── REFRESH WATCHLIST PRICES ──────────────────────────────────────────
  for (const item of trades.watchlist) {
    const real = marketData[item.symbol];
    if (real?.current_price != null) {
      item.current_price = real.current_price;
      item.rsi           = real.rsi;
      item.change_pct    = real.change_pct;
      item.volume_ratio  = real.volume_ratio;
    }
  }

  // ── RECALCULATE PORTFOLIO ─────────────────────────────────────────────
  let openVal = 0, unrealPnl = 0;
  for (const pos of trades.open_positions) {
    openVal  += pos.current_price * pos.shares;
    unrealPnl += (pos.current_price - pos.entry_price) * pos.shares;
  }

  trades.macro_status                  = { ...macro };
  trades.session.open_positions_value  = parseFloat(openVal.toFixed(2));
  trades.session.unrealized_pnl        = parseFloat(unrealPnl.toFixed(2));
  trades.session.total_account_value   = parseFloat((trades.session.current_cash + openVal).toFixed(2));
  trades.session.total_pnl             = parseFloat((trades.session.realized_pnl + unrealPnl).toFixed(2));
  trades.session.trades_open           = trades.open_positions.length;
  if (trades.session.trades_closed > 0) {
    trades.session.win_rate = parseFloat((trades.session.wins / trades.session.trades_closed * 100).toFixed(1));
  }

  trades.system_status.last_eval     = now.toISOString();
  trades.system_status.market_status = 'open';

  fs.writeFileSync(TRADES_FILE, JSON.stringify(trades, null, 2));
  commitAndPushTrades();

  console.log('\n────────────────────────────────────────────────');
  console.log(`  Cash:          $${trades.session.current_cash.toFixed(2)}`);
  console.log(`  Open:          ${trades.open_positions.length} positions ($${openVal.toFixed(2)})`);
  console.log(`  Account value: $${trades.session.total_account_value.toFixed(2)}`);
  console.log(`  Realized P&L:  $${trades.session.realized_pnl.toFixed(2)}`);
  console.log(`  All-time trades: ${trades.closed_trades.length}`);
  console.log('────────────────────────────────────────────────');
  console.log('[✓] Intraday evaluation complete.\n');
}

// ─── MAIN ──────────────────────────────────────────────────────────────────
async function main() {
  const mode = process.argv[2] || 'scan';
  try {
    if      (mode === 'scan') await preMarketScan();
    else if (mode === 'eval') await intradayEvaluation();
    else { console.error('Usage: node trading-bot.js [scan|eval]'); process.exit(1); }
  } catch (err) {
    console.error('\n[FATAL]', err.message, '\n', err.stack);
    process.exit(1);
  }
}

main();
