#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const https = require('https');

// Configuration
const CONFIG = JSON.parse(fs.readFileSync('./config.json', 'utf8'));
const RULES_PROMPT = fs.readFileSync('./rules-prompt.txt', 'utf8');
const TRADES_FILE = './trades.json';

const MISTRAL_API_KEY = process.env.MISTRAL_API_KEY;
const ALPHA_VANTAGE_KEY = process.env.ALPHA_VANTAGE_KEY || 'demo';

// ============================================
// UTILITY: HTTP Request Helper
// ============================================
function makeRequest(options, data = null) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          resolve(body);
        }
      });
    });
    req.on('error', reject);
    if (data) req.write(JSON.stringify(data));
    req.end();
  });
}

// ============================================
// FETCH MARKET DATA
// ============================================
async function fetchMarketData(symbols) {
  console.log(`[FETCH] Fetching market data for: ${symbols.join(', ')}`);

  const marketData = {};

  for (const symbol of symbols) {
    try {
      // Try yfinance via API
      const response = await makeRequest({
        hostname: 'query1.finance.yahoo.com',
        path: `/v10/finance/quoteSummary/${symbol}?modules=price,summaryDetail`,
        method: 'GET',
        headers: { 'User-Agent': 'Mozilla/5.0' }
      });

      if (response?.quoteSummary?.result) {
        const data = response.quoteSummary.result[0];
        const price = data.price?.regularMarketPrice?.raw || null;
        const prevClose = data.price?.regularMarketPreviousClose?.raw || null;
        const fiftyDayAvg = data.summaryDetail?.fiftyDayAverage?.raw || null;
        const twoHundredDayAvg = data.summaryDetail?.twoHundredDayAverage?.raw || null;

        marketData[symbol] = {
          symbol,
          current_price: price,
          previous_close: prevClose,
          change_percent: prevClose ? ((price - prevClose) / prevClose * 100).toFixed(2) : 0,
          fifty_day_ma: fiftyDayAvg,
          two_hundred_day_ma: twoHundredDayAvg,
          timestamp: new Date().toISOString()
        };
      }
    } catch (e) {
      console.warn(`[WARN] Failed to fetch ${symbol}: ${e.message}`);
      marketData[symbol] = {
        symbol,
        current_price: null,
        error: e.message
      };
    }
  }

  return marketData;
}

// ============================================
// FETCH MACRO INDICATORS
// ============================================
async function fetchMacroStatus() {
  console.log('[FETCH] Fetching macro indicators (QQQ, VIX)...');

  const macro = {
    qqq_price: null,
    qqq_50day_ma: null,
    qqq_above_ma: null,
    vix: null,
    vix_below_25: null,
    timestamp: new Date().toISOString()
  };

  try {
    // Fetch QQQ
    const qqq = await makeRequest({
      hostname: 'query1.finance.yahoo.com',
      path: '/v10/finance/quoteSummary/QQQ?modules=price,summaryDetail',
      method: 'GET',
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });

    if (qqq?.quoteSummary?.result) {
      const data = qqq.quoteSummary.result[0];
      macro.qqq_price = data.price?.regularMarketPrice?.raw || null;
      macro.qqq_50day_ma = data.summaryDetail?.fiftyDayAverage?.raw || null;
      if (macro.qqq_price && macro.qqq_50day_ma) {
        macro.qqq_above_ma = macro.qqq_price > macro.qqq_50day_ma;
      }
    }

    // Fetch VIX
    const vix = await makeRequest({
      hostname: 'query1.finance.yahoo.com',
      path: '/v10/finance/quoteSummary/%5EVIX?modules=price',
      method: 'GET',
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });

    if (vix?.quoteSummary?.result) {
      const data = vix.quoteSummary.result[0];
      macro.vix = data.price?.regularMarketPrice?.raw || null;
      if (macro.vix !== null) {
        macro.vix_below_25 = macro.vix < 25;
      }
    }
  } catch (e) {
    console.warn(`[WARN] Failed to fetch macro data: ${e.message}`);
  }

  return macro;
}

// ============================================
// CALL MISTRAL AI
// ============================================
async function callMistralAI(userPrompt) {
  console.log('[MISTRAL] Calling Mistral AI...');

  if (!MISTRAL_API_KEY) {
    throw new Error('MISTRAL_API_KEY not set in environment variables');
  }

  const messages = [
    {
      role: 'system',
      content: RULES_PROMPT
    },
    {
      role: 'user',
      content: userPrompt
    }
  ];

  const payload = {
    model: CONFIG.api.mistral.model,
    messages,
    temperature: CONFIG.api.mistral.temperature,
    max_tokens: CONFIG.api.mistral.max_tokens
  };

  try {
    const response = await makeRequest({
      hostname: 'api.mistral.ai',
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${MISTRAL_API_KEY}`,
        'Content-Type': 'application/json'
      }
    }, payload);

    if (response.choices?.[0]?.message?.content) {
      return response.choices[0].message.content;
    } else {
      throw new Error('Invalid Mistral response');
    }
  } catch (e) {
    console.error('[ERROR] Mistral API call failed:', e.message);
    throw e;
  }
}

// ============================================
// PARSE AI RESPONSE TO JSON
// ============================================
function parseAIResponse(text) {
  try {
    // Try to find JSON block in response
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
    return JSON.parse(text);
  } catch (e) {
    console.error('[ERROR] Failed to parse AI response as JSON:', e.message);
    console.error('[DEBUG] Response text:', text.substring(0, 500));
    return null;
  }
}

// ============================================
// PRE-MARKET SCAN
// ============================================
async function preMarketScan() {
  console.log('\n═══════════════════════════════════════');
  console.log('  PRE-MARKET SCAN INITIATED');
  console.log('═══════════════════════════════════════\n');

  const trades = JSON.parse(fs.readFileSync(TRADES_FILE, 'utf8'));

  // Fetch market data
  const marketData = await fetchMarketData(CONFIG.watchlist);
  const macroStatus = await fetchMacroStatus();

  // Build prompt
  let watchlistSummary = 'Current Watchlist Data:\n';
  for (const symbol of CONFIG.watchlist) {
    const data = marketData[symbol];
    if (data && data.current_price) {
      watchlistSummary += `- ${symbol}: $${data.current_price.toFixed(2)}, MA50: $${data.fifty_day_ma?.toFixed(2) || 'N/A'}, Change: ${data.change_percent}%\n`;
    }
  }

  let macroSummary = `\nMacro Status:\n`;
  macroSummary += `- QQQ: $${macroStatus.qqq_price?.toFixed(2) || 'N/A'} (50-day MA: $${macroStatus.qqq_50day_ma?.toFixed(2) || 'N/A'}) → ${macroStatus.qqq_above_ma ? 'ABOVE' : 'BELOW'} MA\n`;
  macroSummary += `- VIX: ${macroStatus.vix?.toFixed(2) || 'N/A'} → ${macroStatus.vix_below_25 ? 'BELOW' : 'ABOVE'} 25\n`;
  macroSummary += `- Gate Status: ${macroStatus.qqq_above_ma && macroStatus.vix_below_25 ? '✓ PASS' : '✗ FAIL'}\n`;

  const userPrompt = `${watchlistSummary}${macroSummary}\n\nPlease generate today's watchlist. For each candidate, provide:
1. Rank/Priority
2. Confidence score (0-10)
3. Current entry target price
4. Stop loss and profit target
5. Trading thesis
6. Technical setup details
7. Whether entry signal is active

Return ONLY valid JSON format as specified in system prompt.`;

  console.log('[PROMPT] Calling Mistral for watchlist generation...');
  const aiResponse = await callMistralAI(userPrompt);
  const analysis = parseAIResponse(aiResponse);

  if (!analysis) {
    console.error('[ERROR] Failed to parse watchlist analysis');
    return;
  }

  // Update macro status
  trades.macro_status = {
    ...macroStatus,
    gate_pass: macroStatus.qqq_above_ma && macroStatus.vix_below_25
  };

  // Update watchlist
  if (analysis.candidates) {
    for (const candidate of analysis.candidates) {
      const watchlistItem = trades.watchlist.find(w => w.symbol === candidate.symbol);
      if (watchlistItem) {
        watchlistItem.current_price = candidate.current_price;
        watchlistItem.confidence = candidate.confidence;
        watchlistItem.entry_signal = candidate.entry_signal;
        watchlistItem.entry_target = candidate.entry_target;
        watchlistItem.priority = candidate.priority;
        watchlistItem.reason = candidate.thesis;
        watchlistItem.last_updated = new Date().toISOString();
      }
    }
  }

  trades.system_status.last_scan = new Date().toISOString();
  trades.system_status.market_status = 'pre-market';

  // Save trades.json
  fs.writeFileSync(TRADES_FILE, JSON.stringify(trades, null, 2));
  console.log(`\n[SAVED] Watchlist updated at ${trades.system_status.last_scan}`);
  console.log(`[GATE] Macro gate: ${trades.macro_status.gate_pass ? '✓ PASS' : '✗ FAIL'}`);
  console.log('[SUCCESS] Pre-market scan complete\n');
}

// ============================================
// INTRADAY EVALUATION
// ============================================
async function intradayEvaluation() {
  console.log('\n═══════════════════════════════════════');
  console.log('  INTRADAY EVALUATION INITIATED');
  console.log('═══════════════════════════════════════\n');

  const trades = JSON.parse(fs.readFileSync(TRADES_FILE, 'utf8'));

  // Fetch current market data
  const allSymbols = [...CONFIG.watchlist, 'QQQ', '^VIX'];
  const marketData = await fetchMarketData(allSymbols);
  const macroStatus = await fetchMacroStatus();

  // Build evaluation prompt
  let portfolioSummary = `Current Portfolio:
- Cash: $${trades.session.current_cash.toFixed(2)}
- Open Positions: ${trades.open_positions.length}
- Total Account Value: $${trades.session.total_account_value.toFixed(2)}
`;

  if (trades.open_positions.length > 0) {
    portfolioSummary += '\nOpen Positions:\n';
    for (const pos of trades.open_positions) {
      const currentPrice = marketData[pos.symbol]?.current_price || pos.current_price;
      const unrealizedPnL = (currentPrice - pos.entry_price) * pos.shares;
      const unrealizedPnLPercent = ((currentPrice - pos.entry_price) / pos.entry_price * 100).toFixed(2);
      portfolioSummary += `- ${pos.symbol}: ${pos.shares} @ $${pos.entry_price.toFixed(2)} → $${currentPrice.toFixed(2)} (${unrealizedPnLPercent}%, $${unrealizedPnL.toFixed(2)})\n`;
      portfolioSummary += `  Stop: $${pos.stop_loss}, Target: $${pos.profit_target}\n`;
    }
  }

  let watchlistData = 'Watchlist Candidates:\n';
  for (const watch of trades.watchlist) {
    const current = marketData[watch.symbol];
    if (current && current.current_price) {
      watchlistData += `- ${watch.symbol}: $${current.current_price.toFixed(2)}, Confidence: ${watch.confidence || 'N/A'}, Entry Target: ${watch.entry_target || 'N/A'}\n`;
    }
  }

  const userPrompt = `${portfolioSummary}\n${watchlistData}\n\nMacro Gate: QQQ Above MA: ${macroStatus.qqq_above_ma}, VIX Below 25: ${macroStatus.vix_below_25}\n\nProvide trading decisions: any positions to close, any new entries to make, or holds. Return ONLY valid JSON format.`;

  console.log('[PROMPT] Calling Mistral for trading decisions...');
  const aiResponse = await callMistralAI(userPrompt);
  const decisions = parseAIResponse(aiResponse);

  if (!decisions) {
    console.error('[ERROR] Failed to parse trading decisions');
    return;
  }

  // Process exits
  if (decisions.position_exits) {
    for (const exit of decisions.position_exits) {
      const posIndex = trades.open_positions.findIndex(p => p.symbol === exit.symbol);
      if (posIndex !== -1) {
        const pos = trades.open_positions[posIndex];
        const closedTrade = {
          symbol: pos.symbol,
          entry_price: pos.entry_price,
          exit_price: exit.exit_price,
          shares: pos.shares,
          realized_pnl: (exit.exit_price - pos.entry_price) * pos.shares,
          realized_pnl_percent: ((exit.exit_price - pos.entry_price) / pos.entry_price * 100).toFixed(2),
          entry_date: pos.entry_date,
          exit_date: new Date().toISOString(),
          entry_reason: pos.entry_reason,
          exit_reason: exit.reason
        };

        trades.closed_trades.push(closedTrade);
        trades.session.realized_pnl += closedTrade.realized_pnl;
        trades.session.current_cash += closedTrade.realized_pnl + (closedTrade.shares * pos.entry_price);
        trades.session.trades_closed += 1;

        if (closedTrade.realized_pnl > 0) trades.session.wins += 1;
        else if (closedTrade.realized_pnl < 0) trades.session.losses += 1;
        else trades.session.break_even += 1;

        trades.open_positions.splice(posIndex, 1);

        console.log(`[EXIT] ${exit.symbol}: $${exit.exit_price.toFixed(2)} → ${closedTrade.realized_pnl > 0 ? '✓' : '✗'} $${closedTrade.realized_pnl.toFixed(2)}`);
      }
    }
  }

  // Process new entries
  if (decisions.new_entries) {
    for (const entry of decisions.new_entries) {
      if (trades.open_positions.length < 2 && trades.session.current_cash >= entry.shares * entry.entry_price) {
        const newPosition = {
          id: `pos_${Date.now()}`,
          symbol: entry.symbol,
          entry_price: entry.entry_price,
          entry_date: new Date().toISOString(),
          entry_reason: entry.thesis,
          shares: entry.shares,
          current_price: entry.entry_price,
          stop_loss: entry.stop_loss,
          profit_target: entry.profit_target,
          confidence: entry.confidence,
          thesis: entry.thesis
        };

        trades.open_positions.push(newPosition);
        trades.session.current_cash -= entry.shares * entry.entry_price;
        trades.session.trades_open += 1;

        console.log(`[ENTRY] ${entry.symbol}: ${entry.shares} @ $${entry.entry_price.toFixed(2)}`);
      }
    }
  }

  // Update macro status
  trades.macro_status = { ...macroStatus, gate_pass: macroStatus.qqq_above_ma && macroStatus.vix_below_25 };

  // Recalculate portfolio
  let openPosValue = 0;
  for (const pos of trades.open_positions) {
    const current = marketData[pos.symbol]?.current_price || pos.current_price;
    pos.current_price = current;
    openPosValue += current * pos.shares;
  }

  trades.session.open_positions_value = openPosValue;
  trades.session.total_account_value = trades.session.current_cash + openPosValue;
  trades.session.total_pnl = trades.session.realized_pnl + (openPosValue - (CONFIG.account.starting_capital - trades.session.current_cash));

  if (trades.session.trades_closed > 0) {
    trades.session.win_rate = (trades.session.wins / trades.session.trades_closed * 100).toFixed(1);
  }

  trades.system_status.last_eval = new Date().toISOString();
  trades.system_status.market_status = 'open';

  // Save
  fs.writeFileSync(TRADES_FILE, JSON.stringify(trades, null, 2));

  console.log(`\n[PORTFOLIO] Cash: $${trades.session.current_cash.toFixed(2)}, Open Positions: ${trades.session.trades_open}, Total Value: $${trades.session.total_account_value.toFixed(2)}`);
  console.log(`[P&L] Realized: $${trades.session.realized_pnl.toFixed(2)}, Unrealized: $${(trades.session.open_positions_value - (CONFIG.account.starting_capital - trades.session.current_cash)).toFixed(2)}`);
  console.log(`[RECORD] Wins: ${trades.session.wins}, Losses: ${trades.session.losses}, Win Rate: ${trades.session.win_rate}%`);
  console.log('[SUCCESS] Intraday evaluation complete\n');
}

// ============================================
// MAIN
// ============================================
async function main() {
  try {
    const mode = process.argv[2] || 'scan';

    if (mode === 'scan') {
      await preMarketScan();
    } else if (mode === 'eval') {
      await intradayEvaluation();
    } else {
      console.error('Usage: node trading-bot.js [scan|eval]');
      process.exit(1);
    }
  } catch (error) {
    console.error('[FATAL ERROR]', error.message);
    process.exit(1);
  }
}

main();
