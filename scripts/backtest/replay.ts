/**
 * Backtest / Replay Harness — Validate copy-trading profitability on REAL history.
 *
 * Run:
 *   pnpm exec tsx scripts/backtest/replay.ts 0xWALLET_A 0xWALLET_B ...
 *   # or read a newline/comma-separated wallet list from a file:
 *   pnpm exec tsx scripts/backtest/replay.ts --wallets ./wallets.txt
 *   # or auto-discover candidates from the weekly leaderboard, then qualify them:
 *   pnpm exec tsx scripts/backtest/replay.ts --top 25
 *
 * Optional env (mirror the live bot's risk knobs so the EV reflects THIS bot):
 *   BACKTEST_CAPITAL          starting virtual USDC            (default 1000)
 *   BACKTEST_PER_TRADE_USD    $ per copy                       (default max(minOrder, capital*0.02))
 *   BACKTEST_MAX_EXPOSURE_PCT total exposure cap (0..1)        (default 0.30)
 *   BACKTEST_MIN_ORDER_USD    Polymarket min order             (default 5)
 *   BACKTEST_SLIPPAGE         per-share price haircit (abs)    (default 0.005)
 *   BACKTEST_MIN_CLOSED       min CLOSED trades to qualify     (default 30)
 *   BACKTEST_MIN_WINRATE      min realized win rate to qualify (default 0.55)
 *   BACKTEST_MIN_PROFIT_FACTOR min realized PF to qualify      (default 1.5)
 *   BACKTEST_SINCE_DAYS       only replay activity newer than  (default 0 = all available)
 *
 * What it does:
 *   1. Qualifies each input wallet via WalletService.getRealizedStats() (CLOSED-position,
 *      survivorship-bias-free). Wallets with insufficient history are SKIPPED (never
 *      rejected as 0%) per the method's contract.
 *   2. Pulls each qualified wallet's REAL historical TRADE activity (getActivity) and its
 *      REAL settled outcomes (getClosedPositions → curPrice ∈ {0,1}).
 *   3. Replays the merged, time-ordered signal stream through the SAME PaperPortfolio
 *      engine the live bot uses (identical copy sizing, exposure caps, slippage, and
 *      settlement logic) — no synthetic fills, no fabricated prices.
 *   4. Prints EV: total return %, realized PnL, win rate, max drawdown, and a
 *      per-market-category breakdown (categorizeMarket from smart-money-service).
 *
 * This DOES NOT trade. It only reads historical data and runs the in-memory paper engine.
 */

import 'dotenv/config';
import {
  DataApiClient,
  SubgraphClient,
  WalletService,
  RateLimiter,
  createUnifiedCache,
  categorizeMarket,
  type Activity,
  type ClosedPosition,
  type MarketCategory,
} from '../../src/index.js';
// RealizedStats is defined in wallet-service but not re-exported by the barrel,
// so import it directly from the module that owns it (no fabricated re-export).
import type { RealizedStats } from '../../src/services/wallet-service.js';
import { PaperPortfolio, type CopySignal, type PaperConfig } from '../../paper-trading.js';
import { readFileSync } from 'fs';
import os from 'os';

// ===== Config (env-overridable; defaults mirror the live bot's paper engine) =====

function envNum(name: string, def: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return def;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    throw new Error(`[backtest] Invalid ${name}="${raw}": must be a finite number`);
  }
  return n;
}

const BACKTEST_CAPITAL = envNum('BACKTEST_CAPITAL', 1000);
const BACKTEST_MIN_ORDER_USD = envNum('BACKTEST_MIN_ORDER_USD', 5);
const BACKTEST_PER_TRADE_USD = envNum(
  'BACKTEST_PER_TRADE_USD',
  Math.max(BACKTEST_MIN_ORDER_USD, BACKTEST_CAPITAL * 0.02)
);
const BACKTEST_MAX_EXPOSURE_PCT = envNum('BACKTEST_MAX_EXPOSURE_PCT', 0.3);
const BACKTEST_SLIPPAGE = envNum('BACKTEST_SLIPPAGE', 0.005);
const BACKTEST_MIN_CLOSED = envNum('BACKTEST_MIN_CLOSED', 30);
const BACKTEST_MIN_WINRATE = envNum('BACKTEST_MIN_WINRATE', 0.55);
const BACKTEST_MIN_PROFIT_FACTOR = envNum('BACKTEST_MIN_PROFIT_FACTOR', 1.5);
const BACKTEST_SINCE_DAYS = envNum('BACKTEST_SINCE_DAYS', 0);

// ===== A timeline event: either a leader copy signal, or a market settlement =====

type TimelineEvent =
  | {
      kind: 'signal';
      ts: number; // ms
      sig: CopySignal;
      tokenId: string;
      title: string;
    }
  | {
      kind: 'settle';
      ts: number; // ms — settlement timestamp from the closed position
      tokenId: string;
      payout: 0 | 1; // resolved outcome (curPrice)
      title: string;
    };

// Per-category accumulator for the EV breakdown.
interface CategoryAgg {
  signals: number;
  settled: number;
  realizedPnL: number; // realized via settlement + active sells, attributed by category
  wins: number;
  losses: number;
}

// ===== Helpers =====

/** Parse wallet addresses from argv and/or a --wallets file. Returns { addresses, topN }. */
function parseArgs(argv: string[]): { addresses: string[]; topN: number } {
  const addresses: string[] = [];
  let topN = 0;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--wallets') {
      const path = argv[++i];
      if (!path) throw new Error('[backtest] --wallets requires a file path');
      const contents = readFileSync(path, 'utf8');
      contents
        .split(/[\s,]+/)
        .map((s) => s.trim())
        .filter((s) => /^0x[0-9a-fA-F]{40}$/.test(s))
        .forEach((s) => addresses.push(s));
    } else if (a === '--top') {
      const n = Number(argv[++i]);
      if (!Number.isInteger(n) || n <= 0) {
        throw new Error('[backtest] --top requires a positive integer');
      }
      topN = n;
    } else if (/^0x[0-9a-fA-F]{40}$/.test(a)) {
      addresses.push(a);
    } else {
      throw new Error(
        `[backtest] Unrecognized argument "${a}". Pass 0x-addresses, --wallets <file>, or --top <N>.`
      );
    }
  }
  return { addresses: [...new Set(addresses.map((a) => a.toLowerCase()))], topN };
}

/**
 * Fetch ALL TRADE activity for a wallet (auto-paginated), oldest-first.
 * Uses the SDK's getAllActivity (real Data API). Optionally time-bounded.
 */
async function fetchAllTradeActivity(
  dataApi: DataApiClient,
  address: string,
  startSec?: number
): Promise<Activity[]> {
  const all = await dataApi.getAllActivity(
    address,
    { type: 'TRADE', start: startSec, sortBy: 'TIMESTAMP', sortDirection: 'ASC' },
    10000
  );
  // getAllActivity does not guarantee global ordering across pages; sort explicitly.
  return all.filter((a) => a.type === 'TRADE').sort((a, b) => a.timestamp - b.timestamp);
}

/**
 * Fetch ALL closed/resolved positions for a wallet (auto-paginated).
 * The closed-positions endpoint caps limit at 50; page until exhausted.
 */
async function fetchAllClosedPositions(
  dataApi: DataApiClient,
  address: string
): Promise<ClosedPosition[]> {
  const all: ClosedPosition[] = [];
  const limit = 50;
  let offset = 0;
  while (all.length < 10000) {
    const page = await dataApi.getClosedPositions(address, {
      limit,
      offset,
      sortBy: 'TIMESTAMP',
      sortDirection: 'DESC',
    });
    if (page.length === 0) break;
    all.push(...page);
    offset += limit;
    if (page.length < limit) break;
  }
  return all;
}

function fmtPct(x: number): string {
  return `${x >= 0 ? '+' : ''}${x.toFixed(2)}%`;
}

function fmtUsd(x: number): string {
  return `${x >= 0 ? '+' : '-'}$${Math.abs(x).toFixed(2)}`;
}

const CATEGORY_ORDER: MarketCategory[] = [
  'crypto',
  'politics',
  'sports',
  'economics',
  'entertainment',
  'science',
  'other',
];

// ===== Main =====

async function main(): Promise<void> {
  const { addresses, topN } = parseArgs(process.argv.slice(2));

  const cache = createUnifiedCache();
  const rateLimiter = new RateLimiter();
  const dataApi = new DataApiClient(rateLimiter, cache);
  const subgraph = new SubgraphClient(rateLimiter, cache);
  const walletService = new WalletService(dataApi, subgraph, cache);

  // Build the candidate set: explicit addresses + (optionally) leaderboard top-N.
  const candidates = new Set<string>(addresses);
  if (topN > 0) {
    const board = await walletService.fetchLeaderboardByPeriod('week', topN, 'pnl', 'OVERALL', 0);
    for (const e of board.entries) {
      if (e.address) candidates.add(e.address.toLowerCase());
    }
  }

  if (candidates.size === 0) {
    console.error(
      'No wallets provided.\n' +
        'Usage: pnpm exec tsx scripts/backtest/replay.ts <0xADDR...> [--wallets file] [--top N]'
    );
    process.exit(1);
  }

  console.log('═'.repeat(72));
  console.log('              🔁 COPY-TRADING BACKTEST / REPLAY (real history)');
  console.log('═'.repeat(72));
  console.log(`  Candidates:       ${candidates.size}`);
  console.log(`  Starting capital: $${BACKTEST_CAPITAL.toFixed(2)}`);
  console.log(
    `  Per copy:         $${BACKTEST_PER_TRADE_USD.toFixed(2)}   max exposure ${(
      BACKTEST_MAX_EXPOSURE_PCT * 100
    ).toFixed(0)}%   min order $${BACKTEST_MIN_ORDER_USD}`
  );
  console.log(
    `  Slippage:         ${(BACKTEST_SLIPPAGE * 100).toFixed(2)}¢/share   ` +
      `qualify: ≥${BACKTEST_MIN_CLOSED} closed, winRate ≥${(BACKTEST_MIN_WINRATE * 100).toFixed(
        0
      )}%, PF ≥${BACKTEST_MIN_PROFIT_FACTOR}`
  );
  if (BACKTEST_SINCE_DAYS > 0) {
    console.log(`  History window:   last ${BACKTEST_SINCE_DAYS} day(s) of activity`);
  } else {
    console.log('  History window:   all available (capped by Data API offset limit)');
  }
  console.log('─'.repeat(72));

  // ---- 1) Qualify wallets on REALIZED (closed-position) stats ----------------
  const qualified: string[] = [];
  for (const addr of candidates) {
    let stats: RealizedStats;
    try {
      stats = await walletService.getRealizedStats(addr, BACKTEST_MIN_CLOSED);
    } catch (err) {
      // NO FALLBACK: surface the failure for this wallet and stop the whole run,
      // rather than silently backtesting on a partial/empty candidate set.
      console.error(`  ✖ ${addr}  realized-stats fetch FAILED:`, err);
      throw err;
    }

    if (stats.insufficientHistory) {
      console.log(
        `  • ${addr}  SKIP (insufficient history: ${stats.closedTrades}/${BACKTEST_MIN_CLOSED} closed)`
      );
      continue;
    }

    const pfStr = stats.profitFactor === Infinity ? '∞' : stats.profitFactor.toFixed(2);
    const passes =
      stats.winRate >= BACKTEST_MIN_WINRATE && stats.profitFactor >= BACKTEST_MIN_PROFIT_FACTOR;
    if (!passes) {
      console.log(
        `  • ${addr}  reject (winRate ${(stats.winRate * 100).toFixed(0)}%, PF ${pfStr}, ` +
          `realized ${fmtUsd(stats.realizedPnL)} over ${stats.closedTrades})`
      );
      continue;
    }

    console.log(
      `  ✓ ${addr}  QUALIFY (winRate ${(stats.winRate * 100).toFixed(0)}%, PF ${pfStr}, ` +
        `realized ${fmtUsd(stats.realizedPnL)} over ${stats.closedTrades})`
    );
    qualified.push(addr);
  }

  if (qualified.length === 0) {
    console.log('─'.repeat(72));
    console.log('No wallets qualified. Nothing to replay.');
    process.exit(0);
  }

  console.log('─'.repeat(72));
  console.log(`  Qualified wallets to replay: ${qualified.length}`);

  // ---- 2) Pull REAL history (activity + settlements) for each wallet ---------
  const startSec =
    BACKTEST_SINCE_DAYS > 0
      ? Math.floor(Date.now() / 1000) - BACKTEST_SINCE_DAYS * 24 * 60 * 60
      : undefined;

  const events: TimelineEvent[] = [];
  // tokenId -> settlement (curPrice + ts + title). One settlement per resolved token.
  const settlements = new Map<string, { payout: 0 | 1; ts: number; title: string }>();
  // tokenId -> human title (best-effort, for category attribution).
  const titleByToken = new Map<string, string>();

  for (const addr of qualified) {
    const [activity, closed] = await Promise.all([
      fetchAllTradeActivity(dataApi, addr, startSec),
      fetchAllClosedPositions(dataApi, addr),
    ]);

    // Record settlements (curPrice is the resolved payout: 0 or 1). If multiple
    // wallets traded the same token, the settlement is the same on-chain truth —
    // keep the EARLIEST resolution timestamp we observe so we settle promptly.
    for (const c of closed) {
      if (!c.asset) continue;
      // Only treat as a SETTLEMENT when the price is actually pinned at an extreme
      // (resolved 1/0). A `curPrice` in between means the position was EXITED before
      // resolution — settling that at 0/1 via a >=0.5 threshold fabricates outcomes
      // and biases PnL. Skip non-resolved closes (mirrors the live resolver's rule).
      const resolvedWin = c.curPrice >= 0.98;
      const resolvedLoss = c.curPrice <= 0.02;
      if (!resolvedWin && !resolvedLoss) continue;
      const payout: 0 | 1 = resolvedWin ? 1 : 0;
      const prev = settlements.get(c.asset);
      if (!prev || c.timestamp < prev.ts) {
        settlements.set(c.asset, { payout, ts: c.timestamp, title: c.title || c.asset });
      }
      if (c.title) titleByToken.set(c.asset, c.title);
    }

    // Convert each TRADE into a copy signal event.
    for (const a of activity) {
      if (!a.asset) continue;
      if (a.title) titleByToken.set(a.asset, a.title);
      events.push({
        kind: 'signal',
        ts: a.timestamp,
        tokenId: a.asset,
        title: a.title || a.slug || a.asset,
        sig: {
          market: a.asset,
          conditionId: a.conditionId,
          outcome: a.outcome,
          slug: a.slug || a.title,
          side: a.side,
          price: a.price,
          size: a.size,
          wallet: addr,
        },
      });
    }
  }

  // Emit a settlement event per resolved token (only those we have a record for).
  for (const [tokenId, s] of settlements) {
    events.push({
      kind: 'settle',
      ts: s.ts,
      tokenId,
      payout: s.payout,
      title: s.title,
    });
  }

  if (events.length === 0) {
    console.log('─'.repeat(72));
    console.log('No historical activity found for the qualified wallets. Nothing to replay.');
    process.exit(0);
  }

  // ---- 3) Replay the merged, time-ordered stream through PaperPortfolio ------
  // Sort by timestamp; on ties process SIGNALS before SETTLEMENTS so a buy that
  // lands in the same second as resolution is still opened then settled (not lost).
  events.sort((a, b) => {
    if (a.ts !== b.ts) return a.ts - b.ts;
    if (a.kind === b.kind) return 0;
    return a.kind === 'signal' ? -1 : 1;
  });

  // In-memory paper config — identical knobs to the live bot's paper engine, but
  // pointed at a fresh, non-existent scratch path so the engine starts from a clean
  // ledger every run (load() returns early when the state file does not exist). We
  // never persist or read these back — the backtest is a pure in-memory replay.
  const scratchBase = `${os.tmpdir()}/poly-backtest-${process.pid}-${Date.now()}`;
  const cfg: PaperConfig = {
    capital: BACKTEST_CAPITAL,
    perTradeUsd: BACKTEST_PER_TRADE_USD,
    maxTotalExposurePct: BACKTEST_MAX_EXPOSURE_PCT,
    maxPerMarketPct: parseFloat(process.env.BACKTEST_MAX_PER_MARKET_PCT || '0.10'),
    maxRelativeSlippage: parseFloat(process.env.BACKTEST_MAX_REL_SLIPPAGE || '0.05'),
    minEntryPrice: parseFloat(process.env.BACKTEST_MIN_ENTRY || '0.35'),
    maxEntryPrice: parseFloat(process.env.BACKTEST_MAX_ENTRY || '0.97'),
    allowAveraging: process.env.BACKTEST_ALLOW_AVERAGING === 'true',
    stopLossPct: parseFloat(process.env.BACKTEST_STOP_LOSS_PCT || '0.5'),
    minOrderUsd: BACKTEST_MIN_ORDER_USD,
    slippage: BACKTEST_SLIPPAGE,
    statePath: `${scratchBase}.state.json`,
    historyPath: `${scratchBase}.history.csv`,
  };
  const firstTs = events[0].ts;
  const lastTs = events[events.length - 1].ts;
  const paper = new PaperPortfolio(cfg, firstTs);

  // Category accumulators. We attribute realized PnL per market category by
  // diffing the engine's closed-trade ledger after each settlement/sell.
  const byCategory = new Map<MarketCategory, CategoryAgg>();
  const getAgg = (cat: MarketCategory): CategoryAgg => {
    let agg = byCategory.get(cat);
    if (!agg) {
      agg = { signals: 0, settled: 0, realizedPnL: 0, wins: 0, losses: 0 };
      byCategory.set(cat, agg);
    }
    return agg;
  };

  // Track how many closed trades the engine had, so each new closed trade can be
  // attributed to the category of the token that produced it.
  let lastClosedLen = 0;
  // tokenId -> category, resolved once per token from its title.
  const catByToken = new Map<string, MarketCategory>();
  const categoryFor = (tokenId: string, title: string): MarketCategory => {
    let cat = catByToken.get(tokenId);
    if (!cat) {
      cat = categorizeMarket(title || titleByToken.get(tokenId) || '');
      catByToken.set(tokenId, cat);
    }
    return cat;
  };

  // Drain newly-closed trades from the engine ledger and attribute them. The
  // engine's ClosedTrade.market is the tokenId, so we map it back to a category.
  const drainClosed = () => {
    for (let i = lastClosedLen; i < paper.closed.length; i++) {
      const ct = paper.closed[i];
      const cat = categoryFor(ct.market, ct.slug);
      const agg = getAgg(cat);
      agg.realizedPnL += ct.pnl;
      if (ct.pnl >= 0) agg.wins++;
      else agg.losses++;
      if (ct.reason !== 'sold') agg.settled++;
    }
    lastClosedLen = paper.closed.length;
  };

  for (const ev of events) {
    if (ev.kind === 'signal') {
      const cat = categoryFor(ev.tokenId, ev.title);
      getAgg(cat).signals++;
      paper.onSignal(ev.sig);
      // A SELL realizes immediately — fold its PnL into the right category.
      drainClosed();
    } else {
      // Settlement: pay $1 (win) or $0 (loss) on any position we still hold.
      paper.settle(ev.tokenId, ev.payout, 'resolved');
      drainClosed();
    }
  }

  // Any positions still open at the end of history never resolved within our
  // data window. They remain marked-to-last-trade (engine equity already reflects
  // their unrealized MTM). We report them separately rather than force-settling.

  // ---- 4) Print EV report ----------------------------------------------------
  const snap = paper.snapshot();
  const spanDays = (lastTs - firstTs) / (1000 * 60 * 60 * 24);

  console.log('═'.repeat(72));
  console.log('                          📊 BACKTEST RESULTS');
  console.log('═'.repeat(72));
  console.log(
    `  History span:     ${spanDays.toFixed(1)} days  ` +
      `(${new Date(firstTs).toISOString().slice(0, 10)} → ${new Date(lastTs)
        .toISOString()
        .slice(0, 10)})`
  );
  console.log(`  Copy signals:     ${events.filter((e) => e.kind === 'signal').length}`);
  console.log(`  Settlements:      ${settlements.size}`);
  console.log('─'.repeat(72));
  console.log(`  Starting capital: $${snap.startingCapital.toFixed(2)}`);
  console.log(`  Ending equity:    $${snap.equity.toFixed(2)}   (${fmtPct(snap.totalPnLPct)})`);
  console.log(`  Total return:     ${fmtPct(snap.totalPnLPct)}   (${fmtUsd(snap.totalPnL)})`);
  console.log('─'.repeat(72));
  console.log(
    `  Realized PnL:     ${fmtUsd(snap.realizedPnL)}   ` +
      `(sold ${fmtUsd(snap.realizedFromSold)} / resolved ${fmtUsd(snap.realizedFromResolved)})`
  );
  console.log(`  Unrealized PnL:   ${fmtUsd(snap.unrealizedPnL)}   (${snap.openPositions} still open)`);
  console.log(`  Cash:             $${snap.cash.toFixed(2)}   Deployed: $${snap.deployed.toFixed(2)}`);
  console.log('─'.repeat(72));
  console.log(
    `  Closed trades:    ${snap.closedTrades}  (W:${snap.wins} L:${snap.losses})  ` +
      `Win rate: ${snap.winRate.toFixed(1)}%   resolved: ${snap.resolvedCount}`
  );
  console.log(`  Copies:           BUY ${snap.buysCopied} / SELL ${snap.sellsCopied}`);
  console.log(`  Max drawdown:     ${snap.maxDrawdownPct.toFixed(2)}%`);
  console.log(
    `  Skipped:          cash ${snap.skipped.noCash} / exposure ${snap.skipped.exposure} / ` +
      `price ${snap.skipped.badPrice}`
  );
  console.log('─'.repeat(72));
  console.log('  Per-category breakdown (realized PnL attributed by market category):');
  console.log(
    `    ${'CATEGORY'.padEnd(14)}${'SIGNALS'.padStart(9)}${'SETTLED'.padStart(9)}` +
      `${'W/L'.padStart(9)}${'REALIZED'.padStart(14)}`
  );
  for (const cat of CATEGORY_ORDER) {
    const agg = byCategory.get(cat);
    if (!agg || (agg.signals === 0 && agg.realizedPnL === 0)) continue;
    console.log(
      `    ${cat.padEnd(14)}${String(agg.signals).padStart(9)}${String(agg.settled).padStart(9)}` +
        `${`${agg.wins}/${agg.losses}`.padStart(9)}${fmtUsd(agg.realizedPnL).padStart(14)}`
    );
  }
  console.log('═'.repeat(72));
  console.log(
    '  Assumptions: conservative slippage (pay-up on buy, sell-down), settlement at $1/$0\n' +
      '  from the leaders\' OWN resolved closed-positions (real on-chain outcomes). Positions\n' +
      '  that never resolved within the data window are left open (marked to last trade).'
  );
  console.log('═'.repeat(72));
}

main().catch((err) => {
  console.error('[backtest] FATAL:', err);
  process.exit(1);
});
