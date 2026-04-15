#!/usr/bin/env node

const fs = require('fs');
const https = require('https');

// ─── CONFIG ────────────────────────────────────────────────────────────────
const CONFIG        = JSON.parse(fs.readFileSync('./config.json', 'utf8'));
const RULES_PROMPT  = fs.readFileSync('./rules-prompt.txt', 'utf8');
const TRADES_FILE   = './trades.json';
const MISTRAL_API_KEY = process.env.MISTRAL_API_KEY;

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
    req.setTimeout(20000, () => { req.destroy(new Error('Request timeout')); });
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
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
    trades.daily_sessions.unshift({
      date: trades.session.date,
      starting_cash: trades.session.starting_capital || 5000,
      ending_cash: trades.session.current_cash,
      ending_account_value: trades.session.total_account_value,
      realized_pnl: trades.session.realized_pnl,
      trades_closed: trades.session.trades_closed,
      wins: trades.session.wins,
      losses: trades.session.losses,
      win_rate: trades.session.win_rate
    });
    if (trades.daily_sessions.length > 30) trades.daily_sessions.pop();
  }

  const carryForward = trades.session?.current_cash ?? 5000;
  trades.session = {
    date: today,
    starting_capital: carryForward,
    current_cash: carryForward,
    open_positions_value: 0,
    total_account_value: carryForward,
    realized_pnl: 0,
    unrealized_pnl: 0,
    total_pnl: 0,
    trades_closed: 0,
    trades_open: trades.open_positions?.length ?? 0,
    win_rate: 0, wins: 0, losses: 0, break_even: 0
  };

  console.log(`[DAY RESET] New session starts with $${carryForward.toFixed(2)}`);
  return true;
}

// ─── PRE-MARKET SCAN ───────────────────────────────────────────────────────
async function preMarketScan() {
  console.log('\n═══════════════════════════════════════════════');
  console.log('  PRE-MARKET SCAN —', new Date().toISOString());
  console.log('═══════════════════════════════════════════════\n');

  const trades = JSON.parse(fs.readFileSync(TRADES_FILE, 'utf8'));
  handleDayReset(trades);

  const marketData = await fetchMarketData(CONFIG.watchlist);
  const macro = await fetchMacroStatus();

  // Build market summary — real prices only, AI provides analysis only
  let mktSummary = 'LIVE MARKET DATA (use EXACTLY these prices — never invent or guess prices):\n\n';
  for (const sym of CONFIG.watchlist) {
    const d = marketData[sym];
    if (!d?.current_price) { mktSummary += `${sym}: unavailable\n\n`; continue; }
    mktSummary += `${sym}:
  Current price: $${d.current_price.toFixed(2)} (use this exactly as current_price)
  Change vs prev close: ${d.change_pct >= 0 ? '+' : ''}${d.change_pct}%
  RSI(14): ${d.rsi ?? 'N/A'}
  50-day MA: $${d.ma50?.toFixed(2) ?? 'N/A'} → price is ${d.above_ma50 ? 'ABOVE' : 'BELOW'} MA
  200-day MA: $${d.ma200?.toFixed(2) ?? 'N/A'} → price is ${d.above_ma200 ? 'ABOVE' : 'BELOW'} MA
  Volume ratio: ${d.volume_ratio ?? 'N/A'}x vs 10-day avg
  Day range: $${d.day_low?.toFixed(2) ?? '?'} – $${d.day_high?.toFixed(2) ?? '?'}\n\n`;
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
        item.rsi           = real?.rsi           ?? null;
        item.change_pct    = real?.change_pct    ?? null;
        item.volume_ratio  = real?.volume_ratio  ?? null;
        item.last_updated  = new Date().toISOString();
      }
    }
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
  console.log('\n[✓] Pre-market scan complete.\n');
}

// ─── INTRADAY EVALUATION ───────────────────────────────────────────────────
async function intradayEvaluation() {
  console.log('\n═══════════════════════════════════════════════');
  console.log('  INTRADAY EVALUATION —', new Date().toISOString());
  console.log('═══════════════════════════════════════════════\n');

  const trades = JSON.parse(fs.readFileSync(TRADES_FILE, 'utf8'));
  handleDayReset(trades);

  const allSymbols = [...new Set([...CONFIG.watchlist, ...trades.open_positions.map(p => p.symbol)])];
  const marketData = await fetchMarketData(allSymbols);
  const macro      = await fetchMacroStatus();

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

  // ── BUILD AI PROMPT ───────────────────────────────────────────────────
  const mktLines = CONFIG.watchlist.map(s => {
    const d = marketData[s];
    return d?.current_price
      ? `${s}: $${d.current_price.toFixed(2)} | RSI ${d.rsi ?? 'N/A'} | ${d.change_pct >= 0 ? '+' : ''}${d.change_pct}% | Vol ${d.volume_ratio?.toFixed(1) ?? 'N/A'}x | MA50 ${d.above_ma50 ? 'ABOVE' : 'BELOW'}`
      : `${s}: unavailable`;
  }).join('\n');

  const posLines = trades.open_positions.length
    ? trades.open_positions.map(pos => {
        const pnl = (pos.current_price - pos.entry_price) * pos.shares;
        const pct = ((pos.current_price - pos.entry_price) / pos.entry_price * 100).toFixed(2);
        const days = ((now - new Date(pos.entry_date)) / 86400000).toFixed(1);
        return `${pos.symbol}: ${pos.shares}sh @ $${pos.entry_price.toFixed(2)} | now $${pos.current_price.toFixed(2)} | P&L $${pnl.toFixed(2)} (${pct}%) | stop $${pos.stop_loss.toFixed(2)} | target $${pos.profit_target.toFixed(2)} | days ${days}`;
      }).join('\n')
    : 'None';

  const prompt = `LIVE MARKET DATA (use exact prices — never guess):
${mktLines}

MACRO GATE:
  QQQ $${macro.qqq_price?.toFixed(2) ?? 'N/A'} vs MA50 $${macro.qqq_50day_ma?.toFixed(2) ?? 'N/A'} → ${macro.qqq_above_ma ? 'ABOVE ✓' : 'BELOW ✗'}
  VIX ${macro.vix?.toFixed(2) ?? 'N/A'} → ${macro.vix_below_25 ? 'OK ✓' : 'HIGH ✗'}
  Gate: ${macro.gate_pass ? '✓ PASS' : '✗ FAIL'}

OPEN POSITIONS (${trades.open_positions.length}/2):
${posLines}

CASH: $${trades.session.current_cash.toFixed(2)} | DATE (ET): ${todayET()}

DECISIONS NEEDED:
1. Close any open positions? (discretionary — stops/targets already enforced)
2. Open any new positions? (only if confidence ≥ 6.5, macro gate allows, cash available)
3. Hold reasoning for any remaining positions

RULES:
- entry_price must equal the EXACT current price shown above
- stop_loss = entry × 0.965, profit_target = entry × 1.07
- Max 2 open positions total (currently ${trades.open_positions.length})
- If no good setups available, explain in holds section

Return ONLY valid JSON in intraday_evaluation format.`;

  let decisions = null;
  try {
    const aiText = await callMistral(prompt);
    decisions = parseAI(aiText);
  } catch (e) {
    console.error('[ERROR] Mistral failed:', e.message);
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

  // ── PROCESS NEW ENTRIES ───────────────────────────────────────────────
  if (decisions?.new_entries?.length) {
    for (const entry of decisions.new_entries) {
      if (trades.open_positions.length >= 2) { console.log(`[SKIP] ${entry.symbol}: max positions`); continue; }
      const real = marketData[entry.symbol];
      const ep   = real?.current_price; // always use real price
      if (!ep) { console.warn(`[SKIP] ${entry.symbol}: no price`); continue; }

      const shares = entry.shares || 10;
      const cost   = ep * shares;
      if (cost > trades.session.current_cash) {
        console.warn(`[SKIP] ${entry.symbol}: need $${cost.toFixed(2)}, have $${trades.session.current_cash.toFixed(2)}`);
        continue;
      }

      const stopL  = parseFloat((ep * 0.965).toFixed(2));
      const targP  = parseFloat((ep * 1.07).toFixed(2));

      trades.open_positions.push({
        id: `trade_${Date.now()}_${entry.symbol}`,
        symbol: entry.symbol,
        entry_price: ep,
        entry_date: now.toISOString(),
        entry_reason: entry.thesis || entry.reasoning || entry.reason,
        thesis: entry.thesis || entry.reasoning,
        shares,
        current_price: ep,
        stop_loss: stopL,
        profit_target: targP,
        confidence: entry.confidence,
        priority: entry.priority,
        rsi_at_entry: real?.rsi ?? null,
        session_date: todayET()
      });

      trades.session.current_cash -= cost;
      trades.session.trades_open   = trades.open_positions.length;

      console.log(`[ENTRY] ${entry.symbol}: ${shares}sh @ $${ep.toFixed(2)} | stop $${stopL} | target $${targP}`);
      console.log(`  Reason: ${(entry.thesis || '').substring(0, 120)}`);
    }
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
