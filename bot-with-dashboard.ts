/**
 * Bot with Dashboard - Wrapper that runs the bot with real-time monitoring UI
 * 
 * This file shows HOW to integrate the dashboard with your bot.
 * It imports the dashboard and hooks into the bot's state/logs.
 * 
 * Run with: npx tsx bot-with-dashboard.ts
 * Then open: http://localhost:5173
 */

import 'dotenv/config';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { ethers } from 'ethers';
import { ConnectionStatus } from '@polymarket/real-time-data-client';
import {
  PolymarketSDK,
  ArbitrageService,
  SwapService,
  type SmartMoneyTrade,
  OnchainService,
} from './src/index.js';
import { getPolygonProvider, POLYGON_RPC_URL } from './src/utils/provider.js';
import { fetchWithTimeout } from './src/utils/fetch-timeout.js';
import { CTFClient } from './src/clients/ctf-client.js';
import { startDashboard, dashboardEmitter } from './src/dashboard/index.js';
import type { BotState, BotConfig, LogLevel, DipArbSignal, SmartMoneySignal } from './src/dashboard/types.js';
import { addSession, createSessionFromState, type TradeRecord } from './src/dashboard/session-history.js';
import { PaperPortfolio } from './paper-trading.js';

// ============================================================================
// CONFIGURATION (same as bot-config.ts)
// ============================================================================

let CONFIG = {
  capital: {
    totalUsd: parseFloat(process.env.CAPITAL_USD || '250'),
    maxPerTradePct: 0.02,  // 🔴 FIXED: Reduced from 3% to 2%
    maxPerMarketPct: 0.10,
    maxTotalExposurePct: 0.30,
    minOrderUsd: 5,
    strategyAllocation: {
      smartMoney: 0.60,
      arbitrage: 0.20,
      dipArb: 0.10,
      directTrades: 0.10,
    },
  },

  risk: {
    // Daily limits
    dailyMaxLossPct: 0.05,  // 🔴 FIXED: Reduced from 8% to 5%
    maxConsecutiveLosses: 6,
    pauseOnBreachMinutes: 60,

    // 🔴 NEW: v3.1 Multi-layer protection
    monthlyMaxLossPct: 0.15,  // 15% monthly limit
    maxDrawdownFromPeak: 0.25,  // 25% drawdown from peak
    totalMaxLossPct: 0.40,  // 40% total loss - permanent halt

    // 🔴 NEW: Dynamic position sizing
    enableDynamicSizing: true,
    minPositionPct: 0.01,  // 1% minimum
    maxPositionPct: 0.05,  // 5% maximum
    lossSizingReduction: 0.20,  // Reduce 20% per loss
    winSizingIncrease: 0.10,  // Increase 10% per win
  },

  smartMoney: {
    enabled: process.env.SMARTMONEY_ENABLED !== 'false',
    topN: parseInt(process.env.SM_TOPN || '40', 10), // scan topN*2 leaderboard candidates
    // LOOSENED for volume (still realized-PnL based, not open-position bias). Env-overridable.
    minWinRate: parseFloat(process.env.SM_MIN_WINRATE || '0.52'),   // was 0.60 — admit more wallets
    minPnl: parseFloat(process.env.SM_MIN_PNL || '100'),            // was 500 — realized $ floor
    minTrades: parseInt(process.env.SM_MIN_CLOSED || '15', 10),     // was 30 — min CLOSED trades to vet

    // Quality filters
    minProfitFactor: parseFloat(process.env.SM_MIN_PF || '1.1'),    // was 1.5 — looser edge bar
    minConsistencyScore: 0.7,  // Recent performance score
    maxSingleTradeExposure: 0.3,  // Max 30% of PnL from one trade
    checkLastNTrades: 10,  // Analyze last 10 trades

    sizeScale: 0.1,
    maxSizePerTrade: 15,  // Up from 10
    maxSlippage: 0.03,
    minTradeSize: 10,  // Up from 5
    delay: 0,  // Q9: no artificial copy delay (only worsens adverse selection)
    customWallets: [
      '0xc2e7800b5af46e6093872b177b7a5e7f0563be51',
      '0x58c3f5d66c95d4c41b093fbdd2520e46b6c9de74',
    ] as string[],
  },

  arbitrage: {
    enabled: process.env.ARBITRAGE_ENABLED === 'true',
    // 🔴 FIXED: Higher profit threshold for gas fees
    profitThreshold: 0.01,  // Up from 0.001 to 1%
    minTradeSize: 20,  // Up from 5 to reduce gas impact
    maxTradeSize: 100,  // Up from 50
    minVolume24h: 5000,
    autoExecute: true,
    enableRebalancer: true,

    // 🔴 NEW: Gas fee accounting
    estimatedGasCostUSD: 0.10,
    minNetProfit: 0.50,
  },

  dipArb: {
    enabled: process.env.DIPARB_ENABLED === 'true',
    coins: ['BTC', 'ETH', 'SOL'] as const,
    shares: 10,
    sumTarget: 0.92,
    autoRotate: true,
    autoExecute: true,
    // 🔴 NEW: Minimum trade value
    minTradeValueUSD: 1.5,  // $1.50 minimum
  },

  onchain: {
    enabled: true,
    autoApprove: true,
    minMatic: 0.5,
  },

  binance: {
    enabled: process.env.TREND_ANALYSIS_ENABLED === 'true',
    symbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'] as const,
    interval: '15m' as const,
    trendThreshold: 2,
  },

  directTrading: {
    enabled: false,
    trendFollowing: true,
    minTrendStrength: 0.02,
    // 🔴 NEW: Stop-loss and take-profit
    stopLossPct: 0.15,
    takeProfitPct: 0.25,
    trailingStopPct: 0.10,
    maxHoldDays: 7,
    minRiskReward: 1.5,
  },

  dryRun: process.env.DRY_RUN !== 'false',
};

// ============================================================================
// STATE
// ============================================================================

const state: BotState = {
  startTime: Date.now(),
  dailyPnL: 0,
  totalPnL: 0,
  consecutiveLosses: 0,
  consecutiveWins: 0,  // 🔴 NEW
  tradesExecuted: 0,
  isPaused: false,
  pauseUntil: 0,

  // 🔴 NEW: v3.1 Risk tracking
  monthlyPnL: 0,
  monthStartTime: Date.now(),
  peakCapital: CONFIG.capital.totalUsd,
  currentCapital: CONFIG.capital.totalUsd,
  currentDrawdown: 0,
  permanentlyHalted: false,
  lastDailyReset: Date.now(),

  smartMoneyTrades: 0,
  arbTrades: 0,
  dipArbTrades: 0,
  directTrades: 0,
  arbProfit: 0,
  followedWallets: [],
  positions: [],
  activeArbMarket: null,
  activeDipArbMarket: null,
  splits: 0,
  merges: 0,
  redeems: 0,
  swaps: 0,
  usdcBalance: 0,
  usdcEBalance: 0,
  maticBalance: 0,
  unrealizedPnL: 0,
  btcTrend: 'neutral',
  ethTrend: 'neutral',
  solTrend: 'neutral',

  dipArb: {
    marketName: null,
    underlying: null,
    duration: null,
    endTime: null,
    upPrice: 0,
    downPrice: 0,
    sum: 0,
    status: 'idle',
    lastSignal: null,
    signals: [],
  },

  arbitrage: {
    status: 'idle',
    marketsScanned: 0,
    opportunitiesFound: 0,
    currentMarket: null,
    lastOpportunity: null,
  },

  smartMoneySignals: [],
  wsConnected: false,
};

// ============================================================================
// RISK-STATE PERSISTENCE (crash-recovery)
// ============================================================================
//
// The risk gate (daily/monthly/total loss, drawdown, consecutive losses,
// permanent halt, pause) lives in-memory. Without persistence a bot that
// permanently halted (or is mid-cooldown) would REARM on restart and resume
// trading — defeating the whole point of the loss limits. We persist the risk
// state to JSON on every recordTrade and on shutdown, and LOAD it on boot.
//
// NO FALLBACK: if the state file exists but is corrupt/unreadable we log ERROR
// and refuse to start. Silently resetting to zeros would re-arm a halted bot,
// which is exactly the forbidden behaviour.

const RISK_STATE_PATH = `${process.env.HOME || '.'}/risk-state.json`;

interface PersistedRiskState {
  dailyPnL: number;
  monthlyPnL: number;
  totalPnL: number;
  peakCapital: number;
  currentCapital: number;
  currentDrawdown: number;
  consecutiveLosses: number;
  consecutiveWins: number;
  tradesExecuted: number;
  isPaused: boolean;
  pauseUntil: number;
  permanentlyHalted: boolean;
  lastDailyReset: number;
  monthStartTime: number;
  smartMoneyTrades: number;
  arbTrades: number;
  dipArbTrades: number;
  directTrades: number;
  arbProfit: number;
  savedAt: number;
}

function saveRiskState(): void {
  const data: PersistedRiskState = {
    dailyPnL: state.dailyPnL,
    monthlyPnL: state.monthlyPnL,
    totalPnL: state.totalPnL,
    peakCapital: state.peakCapital,
    currentCapital: state.currentCapital,
    currentDrawdown: state.currentDrawdown,
    consecutiveLosses: state.consecutiveLosses,
    consecutiveWins: state.consecutiveWins,
    tradesExecuted: state.tradesExecuted,
    isPaused: state.isPaused,
    pauseUntil: state.pauseUntil,
    permanentlyHalted: state.permanentlyHalted,
    lastDailyReset: state.lastDailyReset,
    monthStartTime: state.monthStartTime,
    smartMoneyTrades: state.smartMoneyTrades,
    arbTrades: state.arbTrades,
    dipArbTrades: state.dipArbTrades,
    directTrades: state.directTrades,
    arbProfit: state.arbProfit,
    savedAt: Date.now(),
  };
  // Write failures must NOT be swallowed: surface them so a full disk / bad path
  // is visible rather than silently dropping the risk ledger.
  writeFileSync(RISK_STATE_PATH, JSON.stringify(data, null, 2));
}

/**
 * Load persisted risk state on boot. Throws on a corrupt/unreadable file so the
 * caller (main) refuses to start instead of re-arming a halted bot with zeros.
 */
function loadRiskState(): void {
  if (!existsSync(RISK_STATE_PATH)) {
    log('INFO', 'No prior risk-state file — starting with a fresh risk ledger.');
    return;
  }
  let parsed: PersistedRiskState;
  try {
    parsed = JSON.parse(readFileSync(RISK_STATE_PATH, 'utf8')) as PersistedRiskState;
  } catch (err) {
    // NO FALLBACK: do not reset to zeros — that would re-arm a halted bot.
    throw new Error(
      `Risk-state file ${RISK_STATE_PATH} is corrupt/unreadable: ${(err as Error).message}. ` +
      `Refusing to start. Fix or delete the file manually after review.`
    );
  }
  if (typeof parsed.totalPnL !== 'number' || typeof parsed.permanentlyHalted !== 'boolean') {
    throw new Error(
      `Risk-state file ${RISK_STATE_PATH} is missing required fields (totalPnL/permanentlyHalted). ` +
      `Refusing to start to avoid re-arming a halted bot.`
    );
  }
  state.dailyPnL = parsed.dailyPnL;
  state.monthlyPnL = parsed.monthlyPnL;
  state.totalPnL = parsed.totalPnL;
  state.peakCapital = parsed.peakCapital;
  state.currentCapital = parsed.currentCapital;
  state.currentDrawdown = parsed.currentDrawdown;
  state.consecutiveLosses = parsed.consecutiveLosses;
  state.consecutiveWins = parsed.consecutiveWins;
  state.tradesExecuted = parsed.tradesExecuted;
  state.isPaused = parsed.isPaused;
  state.pauseUntil = parsed.pauseUntil;
  state.permanentlyHalted = parsed.permanentlyHalted;
  state.lastDailyReset = parsed.lastDailyReset;
  state.monthStartTime = parsed.monthStartTime;
  state.smartMoneyTrades = parsed.smartMoneyTrades;
  state.arbTrades = parsed.arbTrades;
  state.dipArbTrades = parsed.dipArbTrades;
  state.directTrades = parsed.directTrades;
  state.arbProfit = parsed.arbProfit;
  log('INFO', `Restored risk ledger from ${RISK_STATE_PATH}`, {
    totalPnL: state.totalPnL,
    permanentlyHalted: state.permanentlyHalted,
    isPaused: state.isPaused,
    consecutiveLosses: state.consecutiveLosses,
  });
  if (state.permanentlyHalted) {
    log('ERROR', '🛑 Restored a PERMANENTLY HALTED risk state — trading stays disabled until the file is cleared.');
  }
}

// ============================================================================
// DASHBOARD-AWARE UTILITIES
// ============================================================================

function log(level: LogLevel, message: string, data?: unknown) {
  const timestamp = new Date().toISOString();
  const icons: Record<string, string> = {
    INFO: '📋', WARN: '⚠️', ERROR: '❌', TRADE: '💰', SIGNAL: '🎯',
    ARB: '🔄', WALLET: '👛', CHAIN: '⛓️', SWAP: '💱', BRIDGE: '🌉',
    KLINE: '📊', TREND: '📈',
  };

  // Console output (CLI)
  console.log(`[${timestamp}] ${icons[level] || '•'} ${message}`);
  if (data) console.log(JSON.stringify(data, null, 2));

  // Dashboard output (WebSocket)
  dashboardEmitter.log(level, message, data);
}

function updateDashboard() {
  dashboardEmitter.updateState(state);
}

// 🔴 FIXED: v3.1 Multi-layer risk management
function canTrade(): boolean {
  // Check if permanently halted
  if (state.permanentlyHalted) {
    log('ERROR', '🛑 Trading permanently halted - total loss limit reached');
    return false;
  }

  // Reset daily PnL if new day
  const daysSinceReset = (Date.now() - state.lastDailyReset) / (1000 * 60 * 60 * 24);
  if (daysSinceReset >= 1) {
    log('INFO', `Daily PnL reset. Previous day: $${state.dailyPnL.toFixed(2)}`);
    state.dailyPnL = 0;
    state.lastDailyReset = Date.now();
  }

  // Reset monthly PnL if new month
  const daysSinceMonthStart = (Date.now() - state.monthStartTime) / (1000 * 60 * 60 * 24);
  if (daysSinceMonthStart >= 30) {
    log('INFO', `Monthly PnL reset. Previous month: $${state.monthlyPnL.toFixed(2)}`);
    state.monthlyPnL = 0;
    state.monthStartTime = Date.now();
  }

  // Update current capital and drawdown
  state.currentCapital = CONFIG.capital.totalUsd + state.totalPnL;
  if (state.currentCapital > state.peakCapital) {
    state.peakCapital = state.currentCapital;
  }
  state.currentDrawdown = (state.peakCapital - state.currentCapital) / state.peakCapital;

  // Check temporary pause
  if (state.isPaused && Date.now() < state.pauseUntil) return false;
  if (state.isPaused && Date.now() >= state.pauseUntil) {
    state.isPaused = false;
    log('INFO', 'Bot resumed after cooldown');
    updateDashboard();
  }

  // Layer 1: Daily loss limit
  const dailyLossLimit = CONFIG.capital.totalUsd * CONFIG.risk.dailyMaxLossPct;
  if (state.dailyPnL <= -dailyLossLimit) {
    state.isPaused = true;
    state.pauseUntil = Date.now() + CONFIG.risk.pauseOnBreachMinutes * 60 * 1000;
    log('WARN', `Daily loss limit breached: -$${Math.abs(state.dailyPnL).toFixed(2)} (limit: $${dailyLossLimit.toFixed(2)})`);
    updateDashboard();
    return false;
  }

  // Layer 2: Monthly loss limit
  const monthlyLossLimit = CONFIG.capital.totalUsd * CONFIG.risk.monthlyMaxLossPct;
  if (state.monthlyPnL <= -monthlyLossLimit) {
    log('ERROR', `🛑 Monthly loss limit breached: -$${Math.abs(state.monthlyPnL).toFixed(2)} (limit: $${monthlyLossLimit.toFixed(2)})`);
    state.isPaused = true;
    state.pauseUntil = Date.now() + (30 * 24 * 60 * 60 * 1000);
    updateDashboard();
    return false;
  }

  // Layer 3: Drawdown from peak
  if (state.currentDrawdown >= CONFIG.risk.maxDrawdownFromPeak) {
    log('ERROR', `🛑 Maximum drawdown reached: ${(state.currentDrawdown * 100).toFixed(1)}%`);
    state.isPaused = true;
    state.pauseUntil = Date.now() + (7 * 24 * 60 * 60 * 1000);
    updateDashboard();
    return false;
  }

  // Layer 4: Total loss - PERMANENT HALT
  const totalLossLimit = CONFIG.capital.totalUsd * CONFIG.risk.totalMaxLossPct;
  if (state.totalPnL <= -totalLossLimit) {
    state.permanentlyHalted = true;
    log('ERROR', '💀 TOTAL LOSS LIMIT REACHED - TRADING PERMANENTLY HALTED');
    log('ERROR', `Total loss: -$${Math.abs(state.totalPnL).toFixed(2)} (limit: $${totalLossLimit.toFixed(2)})`);
    updateDashboard();
    return false;
  }

  // Layer 5 (Q3): consecutive-loss circuit breaker.
  if (state.consecutiveLosses >= CONFIG.risk.maxConsecutiveLosses) {
    state.isPaused = true;
    state.pauseUntil = Date.now() + CONFIG.risk.pauseOnBreachMinutes * 60 * 1000;
    log('WARN', `🛑 Consecutive-loss breaker: ${state.consecutiveLosses} losses ≥ ${CONFIG.risk.maxConsecutiveLosses} — pausing ${CONFIG.risk.pauseOnBreachMinutes}m`);
    updateDashboard();
    return false;
  }

  return true;
}

// In-session realized-trade ledger, fed to createSessionFromState on shutdown.
const sessionTrades: TradeRecord[] = [];

/**
 * Apply a REAL realized PnL delta to the risk ledger (daily/monthly/total/peak/
 * drawdown/streak) and persist it. This is the SINGLE source of truth that
 * canTrade() reads from. It does NOT touch the per-strategy trade counters —
 * those are counted when an order/signal fires. `profit` must NEVER be 0/estimate
 * for a realized event (C3); a genuine break-even close is a legitimate 0.
 */
function applyRealizedPnL(profit: number): void {
  state.dailyPnL += profit;
  state.monthlyPnL += profit;
  state.totalPnL += profit;

  // Track consecutive wins/losses (a strictly-negative close is a loss).
  if (profit < 0) {
    state.consecutiveLosses++;
    state.consecutiveWins = 0;
  } else {
    state.consecutiveLosses = 0;
    state.consecutiveWins++;
  }

  // Persist on every realized change so a crash mid-session never loses the loss
  // accounting that drives canTrade() / the permanent halt.
  saveRiskState();
  updateDashboard();
}

// 🔴 FIXED: Enhanced trade recording with win tracking.
// `profit` MUST be a REAL realized number — never an estimate (C3). `detail`
// carries the market/side/price/wallet for the session summary when known.
// Used by the LIVE realized-close path and by strategy executions that report a
// real realized number (arb fills, dipArb round completion).
function recordTrade(
  profit: number,
  strategy: string,
  detail?: { market?: string; side?: 'BUY' | 'SELL'; size?: number; price?: number; wallet?: string; txHash?: string }
) {
  state.tradesExecuted++;

  if (strategy === 'smartMoney') state.smartMoneyTrades++;
  else if (strategy === 'arbitrage') state.arbTrades++;
  else if (strategy === 'dipArb') state.dipArbTrades++;
  else if (strategy === 'direct') state.directTrades++;

  // Append to the session ledger (only strategies the summary type knows about).
  if (strategy === 'smartMoney' || strategy === 'arbitrage' || strategy === 'dipArb' || strategy === 'direct') {
    sessionTrades.push({
      id: `tr-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      timestamp: new Date().toISOString(),
      strategy,
      market: detail?.market ?? 'unknown',
      side: detail?.side ?? 'BUY',
      size: detail?.size ?? 0,
      price: detail?.price ?? 0,
      profit,
      wallet: detail?.wallet,
      txHash: detail?.txHash,
    });
    if (sessionTrades.length > 5000) sessionTrades.splice(0, sessionTrades.length - 5000);
  }

  // Feed the real realized PnL into the risk ledger (persists + dashboards).
  applyRealizedPnL(profit);
}

// Last cumulative realized PnL we mirrored from the PaperPortfolio into the risk
// ledger, so we only ever record the NEW realized delta (never double-count).
let lastPaperRealized = 0;

/**
 * In DRY-RUN, the "real" PnL is the PaperPortfolio's REALIZED PnL (from sold /
 * resolved positions). C3 requires canTrade()'s daily/monthly/drawdown/total
 * limits to derive from real PnL — so we mirror each newly-realized delta into
 * the risk ledger via recordTrade. Unrealized mark-to-market is NOT recorded
 * (it isn't realized). Called after every resolver pass and paper close.
 */
function syncRiskFromPaper(): void {
  if (!CONFIG.dryRun || !paper) return;
  const realizedNow = paper.realizedPnL;
  const delta = realizedNow - lastPaperRealized;
  if (Math.abs(delta) < 1e-9) return;
  lastPaperRealized = realizedNow;
  // Mirror the realized DELTA (a REAL number) into the risk ledger. We do NOT
  // bump the trade counters here — copies are already counted per signal — we
  // only fold the realized PnL so canTrade()'s limits track the paper truth.
  applyRealizedPnL(delta);
  log('INFO', `[RISK] Synced paper realized Δ$${delta.toFixed(2)} → totalPnL $${state.totalPnL.toFixed(2)}`);
}

/**
 * Position size in USDC for a copy/live order, applying the bot's REAL caps:
 *   - base = capital * maxPerTradePct
 *   - dynamic sizing (v3.1): shrink after losses, grow after wins, clamped to
 *     [minPositionPct, maxPositionPct] of capital
 *   - floored to minOrderUsd
 *   - clamped so total exposure never exceeds maxTotalExposurePct (30%)
 *
 * `currentExposureUsd` is the USDC already deployed in open positions. Returns 0
 * when no compliant size fits under the exposure cap (caller must then skip).
 */
function calculatePositionSize(currentExposureUsd: number): number {
  const capital = CONFIG.capital.totalUsd;

  // Base sizing as a fraction of capital.
  let pct = CONFIG.capital.maxPerTradePct;

  // Dynamic sizing: adjust by streak, then clamp to the configured band.
  if (CONFIG.risk.enableDynamicSizing) {
    if (state.consecutiveLosses > 0) {
      pct *= Math.pow(1 - CONFIG.risk.lossSizingReduction, state.consecutiveLosses);
    } else if (state.consecutiveWins > 0) {
      pct *= Math.pow(1 + CONFIG.risk.winSizingIncrease, state.consecutiveWins);
    }
    pct = Math.min(Math.max(pct, CONFIG.risk.minPositionPct), CONFIG.risk.maxPositionPct);
  }

  let size = capital * pct;

  // 30% total-exposure cap: never deploy past it.
  const exposureCap = capital * CONFIG.capital.maxTotalExposurePct;
  const room = exposureCap - currentExposureUsd;
  if (room <= 0) return 0;
  size = Math.min(size, room);

  // Floor to the venue minimum; if even the minimum won't fit under the cap, skip.
  if (size < CONFIG.capital.minOrderUsd) return 0;
  return size;
}

/**
 * Current USDC exposure across the bot's open positions (live mode). Used to
 * enforce the 30% total-exposure cap before sizing a new live order. In dry-run
 * the PaperPortfolio enforces its own exposure cap, so this is live-only.
 */
function currentLiveExposureUsd(): number {
  let sum = 0;
  for (const p of state.positions) {
    const size = Number((p as any).size) || 0;
    const price = Number((p as any).curPrice) || Number((p as any).avgPrice) || 0;
    if (size > 0 && price > 0) sum += size * price;
  }
  return sum;
}

// ============================================================================
// ============================================================================
// STRATEGIES (simplified versions - copy full implementations from bot-config.ts)
// ============================================================================

let paper: PaperPortfolio | null = null;
let arbService: ArbitrageService | null = null;
let isSmartMoneyInitialized = false;
let isSmartMoneyInitializing = false;
// Watchdog state: the smart-money WebSocket subscription can silently die on a
// reconnect (Polymarket's `leger AddSubscriptions ... connection_id_fk` race —
// the replay fires before the new connection is registered server-side). We
// track the last real copy signal and re-establish the feed when it goes silent.
let smSubscription: { unsubscribe: () => void } | null = null;
let lastSignalAt = Date.now();
let smWatchdogStarted = false;

// Every long-lived interval registers here so the unified shutdown() can clear
// them all (otherwise a SIGTERM/crash leaves pollers firing during teardown).
const timers: NodeJS.Timeout[] = [];
function track(t: NodeJS.Timeout): NodeJS.Timeout { timers.push(t); return t; }

async function setupSmartMoney(sdk: PolymarketSDK) {
  if (CONFIG.smartMoney.enabled) {
    initializeSmartMoney(sdk);
    startSmartMoneyWatchdog(sdk);
  }
}

/**
 * Self-heals the smart-money feed. Polymarket's realtime WS drops periodically;
 * on reconnect the subscription replay can fail server-side (connection_id_fk
 * race), leaving the bot "connected" but receiving ZERO copy signals — which
 * silently invalidates a multi-day run. If no copy signal has arrived for
 * SM_SILENCE_MIN minutes while smart-money is enabled, we re-qualify and
 * re-subscribe on a fresh connection. (Also doubles as periodic re-qualification,
 * which the wallet set otherwise never got after boot.)
 */
function startSmartMoneyWatchdog(sdk: PolymarketSDK) {
  if (smWatchdogStarted) return;
  smWatchdogStarted = true;
  const SILENCE_MS = (parseFloat(process.env.SM_SILENCE_MIN || '12')) * 60 * 1000;
  const CHECK_MS = 3 * 60 * 1000;
  track(setInterval(async () => {
    if (!CONFIG.smartMoney.enabled) return;
    if (isSmartMoneyInitializing) return; // a (re)init is already in flight
    const silentMs = Date.now() - lastSignalAt;
    if (silentMs < SILENCE_MS) return;
    log('WARN', `🐶 Smart-money feed silent ${Math.round(silentMs / 60000)}m (0 copy signals) — re-establishing subscription on a fresh connection (WS resubscribe self-heal).`);
    isSmartMoneyInitialized = false;       // allow initializeSmartMoney to re-run
    lastSignalAt = Date.now();             // avoid re-trigger while re-init runs
    try {
      await initializeSmartMoney(sdk);
    } catch (err) {
      log('ERROR', `Smart-money watchdog re-init failed: ${(err as Error).message}`);
    }
  }, CHECK_MS));
}

async function initializeSmartMoney(sdk: PolymarketSDK) {
  if (isSmartMoneyInitialized || isSmartMoneyInitializing) return;
  isSmartMoneyInitializing = true;

  log('WALLET', 'Setting up Smart Money with quality filtering...');

  const qualified: string[] = [];

  if (CONFIG.smartMoney.customWallets?.length > 0) {
    for (const wallet of CONFIG.smartMoney.customWallets) {
      qualified.push(wallet);
      log('WALLET', `⭐ Custom wallet added: ${wallet.slice(0, 10)}...`);
    }
  }

  try {
    const leaderboard = await sdk.wallets.getLeaderboardByPeriod('week', CONFIG.smartMoney.topN * 2, 'pnl');

    for (const entry of leaderboard) {
      // Check if disabled mid-process to abort early
      if (!CONFIG.smartMoney.enabled && qualified.length === 0) break;

      if (qualified.length >= parseInt(process.env.SM_MAX_FOLLOWED || '25', 10)) break; // more wallets = more copy volume
      if (qualified.includes(entry.address)) continue;

      // C5/S1: qualify on REALIZED/closed history, NOT unrealized open positions.
      // The old path (getWalletProfile.winRate) scored open positions → survivorship
      // bias (a wallet that closed 50 losers but holds 5 green opens read ~100%).
      let stats;
      try {
        stats = await sdk.wallets.getRealizedStats(entry.address, CONFIG.smartMoney.minTrades);
      } catch (err) {
        // No-fallback: surface loudly and EXCLUDE. We never fabricate stats or
        // copy a wallet we could not vet.
        log('ERROR', `Realized-stats fetch failed for ${entry.address.slice(0, 10)}…: ${(err as Error).message}`);
        continue;
      }

      // Not enough CLOSED trades to evaluate → skip (defer, NOT a fabricated fail).
      if (stats.insufficientHistory) continue;

      if (stats.winRate >= CONFIG.smartMoney.minWinRate &&
        stats.realizedPnL >= CONFIG.smartMoney.minPnl &&
        stats.profitFactor >= CONFIG.smartMoney.minProfitFactor) {
        qualified.push(entry.address);
        const pf = stats.profitFactor === Infinity ? '∞' : stats.profitFactor.toFixed(2);
        log('WALLET', `✅ Qualified: ${entry.address.slice(0, 10)}… (realized WR:${(stats.winRate * 100).toFixed(0)}% PF:${pf} rPnL:$${stats.realizedPnL.toFixed(0)} closed:${stats.closedTrades})`);
      }

      await new Promise(r => setTimeout(r, 300));
    }
  } catch (err) {
    // No-fallback: do not silently proceed on a partial/failed qualification.
    log('ERROR', `Leaderboard qualification error: ${(err as Error).message}`);
  }

  state.followedWallets = qualified;
  log('WALLET', `Following ${qualified.length} wallets`);
  updateDashboard();

  if (qualified.length > 0) {
    // Drop any prior subscription before re-subscribing — the watchdog re-runs
    // this function to self-heal a dead feed, and we must not stack subscriptions.
    if (smSubscription) {
      try { smSubscription.unsubscribe(); } catch (e) { log('WARN', `prior smart-money unsubscribe failed: ${(e as Error).message}`); }
      smSubscription = null;
    }
    // Q5: hand the followed set to the subscription as `filterAddresses` so the
    // service itself only delivers trades from wallets we copy. The callback
    // re-checks below as defence-in-depth, but the filter is the primary gate.
    smSubscription = sdk.smartMoney.subscribeSmartMoneyTrades(
      async (trade: SmartMoneyTrade) => {
        // --- SINGLE RISK-GATED ROUTE (C2) -----------------------------------
        // ONE path only. No branch may bypass the followed filter, canTrade(),
        // or the position caps.

        if (!CONFIG.smartMoney.enabled) return;

        // C2/Q5: followed-wallet filter FIRST. We only ever act on qualified
        // smart-money wallets — never the whole market.
        const followed = state.followedWallets.some(
          w => w.toLowerCase() === trade.traderAddress.toLowerCase()
        );
        if (!followed) return;

        // A real followed-wallet trade arrived → the feed is alive. The watchdog
        // reads this to detect a dead subscription (WS resubscribe race) and heal.
        lastSignalAt = Date.now();

        // Dashboard signal feed (after the followed filter, so the feed reflects
        // only wallets we actually copy).
        const signal: SmartMoneySignal = {
          id: `sm-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
          timestamp: new Date().toISOString(),
          wallet: trade.traderAddress,
          market: trade.marketSlug || 'Unknown',
          side: trade.side as 'BUY' | 'SELL',
          size: trade.size,
          price: trade.price,
        };
        state.smartMoneySignals.unshift(signal);
        if (state.smartMoneySignals.length > 50) {
          state.smartMoneySignals = state.smartMoneySignals.slice(0, 50);
        }
        log('SIGNAL', `Copy trade signal from ${trade.traderAddress.slice(0, 10)}...`, {
          market: trade.marketSlug?.slice(0, 50),
          side: trade.side,
          size: trade.size,
          price: trade.price,
        });
        updateDashboard();

        // C2: risk gate. Daily/monthly/drawdown/total-loss + pause + permanent
        // halt all live here. If we can't trade, we stop — no path around it.
        if (!canTrade()) return;

        const label = `${trade.marketSlug || 'mkt'}${trade.outcome ? ':' + trade.outcome : ''}`;

        // Category blocklist (palanca #3 del test 57h): ATP 0/5 −$25, MLB 0/2, LoL 0/1
        // sangraron en seco; CS2/ITF/KBO/Elon fueron netos positivos. Saltamos las
        // categorías que han demostrado pérdida sistemática (env SM_CATEGORY_BLOCKLIST).
        const blocked = (process.env.SM_CATEGORY_BLOCKLIST ?? 'atp,mlb,lol')
          .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
        const catMatch = (trade.marketSlug || '').toLowerCase().match(/^([a-z0-9]+)/);
        const category = catMatch ? catMatch[1] : '';
        if (category && blocked.includes(category)) {
          state.smartMoneySkippedCategory = (state.smartMoneySkippedCategory ?? 0) + 1;
          log('TRADE', `[PAPER] skip:category(${category}) ${label.slice(0, 40)}`);
          return;
        }

        if (CONFIG.dryRun) {
          // DRY-RUN execution → isolated PaperPortfolio. PnL is recorded at
          // SETTLEMENT by runPaperResolver (resolution) / onSignal SELL (close),
          // NOT here — we never pass a fabricated profit (C3). The PaperPortfolio
          // enforces its own per-trade + 30% exposure caps that mirror CONFIG.
          if (!paper) return;
          state.smartMoneyTrades++;
          const action = paper.onSignal({
            market: trade.tokenId || trade.marketSlug || 'unknown', // tokenId = precise outcome key
            conditionId: trade.conditionId,
            outcome: trade.outcome,
            slug: trade.marketSlug,
            side: trade.side as 'BUY' | 'SELL',
            price: trade.price,
            size: trade.size,
            wallet: trade.traderAddress,
          });
          const s = paper.snapshot();
          log('TRADE', `[PAPER] ${trade.side} ${label.slice(0, 40)} @ ${trade.price} → ${action} | Equity $${s.equity.toFixed(2)} (${s.totalPnLPct >= 0 ? '+' : ''}${s.totalPnLPct.toFixed(2)}%)`);
          // A SELL that closes a held position realizes PnL immediately — fold the
          // realized delta into the risk ledger now (BUYs realize nothing yet).
          syncRiskFromPaper();
          updateDashboard();
          return;
        }

        // --- LIVE execution (DORMANT until DRY_RUN is validated) ------------
        // Strictly gated behind !CONFIG.dryRun (we are here only because the
        // dry-run branch above returned). Real, complete copy execution using
        // EXISTING SDK primitives (sdk.tradingService.createMarketOrder). PnL is
        // NOT recorded here for opening BUYs — those are entries; realized PnL is
        // booked when the position closes (the SELL branch below realizes it).
        // A closing SELL of a position we hold books realized PnL immediately.
        await executeLiveCopy(sdk, trade, label);
      },
      { filterAddresses: qualified, minSize: CONFIG.smartMoney.minTradeSize }
    );
    lastSignalAt = Date.now(); // reset the silence timer on (re)subscribe
  }
  isSmartMoneyInitialized = true;
  isSmartMoneyInitializing = false;
}

// In-flight guard: never fire two concurrent live copies for the same token (a
// fast leader can emit multiple fills on one token within a tick).
const liveCopyInFlight = new Set<string>();

/**
 * REAL live copy execution (C1) — dormant until DRY_RUN is validated.
 *
 * Sizes via the bot's caps (calculatePositionSize + 30% exposure), validates the
 * live mid hasn't drifted from the leader's price, then places a CLOB market
 * order via the existing TradingService. NO FALLBACK: a failed order is logged
 * ERROR and surfaced; we never fabricate a fill or a profit.
 *
 * PnL discipline (C3): an opening BUY is an entry — no profit is recorded until
 * the position settles (booked from real positions at resolution). A SELL that
 * closes a position we hold realizes PnL against its average entry and is
 * recorded immediately with the REAL number.
 */
async function executeLiveCopy(sdk: PolymarketSDK, trade: SmartMoneyTrade, label: string): Promise<void> {
  const tokenId = trade.tokenId;
  if (!tokenId) {
    log('WARN', `Live copy skipped: signal has no tokenId (${label.slice(0, 40)})`);
    return;
  }

  if (liveCopyInFlight.has(tokenId)) {
    log('INFO', `Live copy skipped: order already in flight for ${tokenId.slice(0, 12)}…`);
    return;
  }
  liveCopyInFlight.add(tokenId);
  try {
    // Drift guard: refuse to chase a moved market. Read the live midpoint and
    // abort if it diverged from the leader's executed price beyond the cap.
    const COPY_MAX_DRIFT = parseFloat(process.env.LIVE_COPY_MAX_DRIFT || '0.03');
    const liveMid = await sdk.markets.getMidpoint(tokenId);
    if (!Number.isFinite(liveMid)) {
      log('ERROR', `Live copy aborted: live midpoint for ${tokenId} is not finite (${liveMid})`);
      return;
    }
    const drift = Math.abs(liveMid - trade.price);
    if (drift > COPY_MAX_DRIFT) {
      log('WARN', `Live copy aborted: mid ${liveMid.toFixed(4)} drifted ${drift.toFixed(4)} from leader ${trade.price.toFixed(4)} (max ${COPY_MAX_DRIFT}) on ${label.slice(0, 40)}`);
      return;
    }

    const maxSlippage = CONFIG.smartMoney.maxSlippage;

    if (trade.side === 'BUY') {
      // Size via the bot's caps (per-trade % + dynamic sizing + 30% exposure).
      let amountUsd = calculatePositionSize(currentLiveExposureUsd());
      if (amountUsd <= 0) {
        log('WARN', `Live copy skipped: exposure cap reached (no room under ${(CONFIG.capital.maxTotalExposurePct * 100).toFixed(0)}%) for ${label.slice(0, 40)}`);
        return;
      }
      // Respect the strategy's per-trade ceiling too.
      amountUsd = Math.min(amountUsd, CONFIG.smartMoney.maxSizePerTrade);
      if (amountUsd < CONFIG.capital.minOrderUsd) {
        log('WARN', `Live copy skipped: sized $${amountUsd.toFixed(2)} below min order $${CONFIG.capital.minOrderUsd}`);
        return;
      }

      const limitPrice = Math.min(0.999, trade.price * (1 + maxSlippage));
      // BUY market order: `amount` is USDC notional to spend.
      const res = await sdk.tradingService.createMarketOrder({
        tokenId,
        side: 'BUY',
        amount: amountUsd,
        price: limitPrice,
        orderType: 'FOK',
      });

      if (res.success) {
        state.smartMoneyTrades++;
        log('TRADE', `✅ [LIVE] BUY $${amountUsd.toFixed(2)} ${label.slice(0, 40)} @ ~${trade.price.toFixed(3)} (order ${res.orderId ?? 'n/a'})`);
        // C3: an opening BUY books NO profit. Realized PnL is recorded when this
        // position later closes (a followed-wallet SELL hits the branch below).
        updateDashboard();
      } else {
        log('ERROR', `❌ [LIVE] BUY failed for ${label.slice(0, 40)}: ${res.errorMsg ?? 'unknown error'}`);
      }
    } else {
      // SELL — only meaningful if we actually hold the token. `amount` is SHARES.
      const held = state.positions.find(p => (p as any).asset === tokenId);
      const heldShares = held ? Number((held as any).size) || 0 : 0;
      if (heldShares <= 0) {
        log('INFO', `Live copy SELL ignored: no open position in ${tokenId.slice(0, 12)}… to close`);
        return;
      }
      const limitPrice = Math.max(0.001, trade.price * (1 - maxSlippage));
      const res = await sdk.tradingService.createMarketOrder({
        tokenId,
        side: 'SELL',
        amount: heldShares,
        price: limitPrice,
        orderType: 'FOK',
      });

      if (res.success) {
        // C3: closing SELL realizes PnL against the REAL average entry.
        // recordTrade() increments state.smartMoneyTrades — do NOT double-count.
        const entry = Number((held as any).avgPrice) || 0;
        // Use the ACTUAL fill price from the order, never the leader's price. If the
        // CLOB response didn't expose it, fall back to the contractual limit (worst
        // case for us), which can only UNDER-state our gain — never inflate it.
        const filledShares = (res.filledSize && res.filledSize > 0) ? res.filledSize : heldShares;
        const exit = (res.avgPrice && res.avgPrice > 0) ? res.avgPrice : limitPrice;
        if (res.avgPrice === undefined) {
          log('WARN', `[LIVE] SELL fill price not reported by CLOB — using limit $${limitPrice.toFixed(3)} (conservative). Reconcile from on-chain fill before trusting realized PnL.`);
        }
        const realized = (exit - entry) * filledShares;
        log('TRADE', `✅ [LIVE] SELL ${filledShares.toFixed(2)} ${label.slice(0, 40)} @ ~${exit.toFixed(3)} | realized $${realized.toFixed(2)} (order ${res.orderId ?? 'n/a'})`);
        recordTrade(realized, 'smartMoney', {
          market: trade.marketSlug || tokenId,
          side: 'SELL',
          size: filledShares,
          price: exit,
          wallet: trade.traderAddress,
          txHash: res.transactionHashes?.[0],
        });
      } else {
        log('ERROR', `❌ [LIVE] SELL failed for ${label.slice(0, 40)}: ${res.errorMsg ?? 'unknown error'}`);
      }
    }
  } catch (err) {
    // NO FALLBACK: surface the failure, never fabricate a result.
    log('ERROR', `Live copy execution error for ${label.slice(0, 40)}: ${(err as Error).message}`);
  } finally {
    liveCopyInFlight.delete(tokenId);
  }
}



async function setupArbitrage(_sdk: PolymarketSDK) {
  // Always setup service and listeners
  log('ARB', 'Setting up Arbitrage Service...');

  state.arbitrage.status = 'idle';
  updateDashboard();

  // Create standalone ArbitrageService (not using SDK wrapper)
  arbService = new ArbitrageService({
    privateKey: CONFIG.dryRun ? undefined : process.env.POLYMARKET_PRIVATE_KEY,
    profitThreshold: CONFIG.arbitrage.profitThreshold,
    minTradeSize: CONFIG.arbitrage.minTradeSize,
    maxTradeSize: CONFIG.arbitrage.maxTradeSize,
    autoExecute: !CONFIG.dryRun && CONFIG.arbitrage.autoExecute,
    enableRebalancer: !CONFIG.dryRun && CONFIG.arbitrage.enableRebalancer,
    enableLogging: true,
  });

  arbService.on('opportunity', (opp) => {
    state.activeArbMarket = opp.market?.name || 'scanning';
    state.arbitrage.opportunitiesFound++;
    state.arbitrage.lastOpportunity = {
      timestamp: new Date().toISOString(),
      type: opp.type as 'long' | 'short',
      profitPct: opp.profitPercent / 100,
      market: opp.market?.name || 'Unknown',
    };
    log('ARB', `Opportunity: ${opp.type.toUpperCase()} +${opp.profitPercent.toFixed(2)}%`);

    // C4: an 'opportunity' is NOT a trade. It re-fires on every orderbook tick,
    // so crediting an estimated profit here poisoned totalPnL / peakCapital with
    // phantom gains. We only credit arb PnL from the 'execution' handler below
    // with the REAL realized profit. No simulateTrade / recordTrade here.

    updateDashboard();
  });

  arbService.on('execution', (result) => {
    if (result.success) {
      // C4: this is the ONLY place arb PnL is credited — from the real fill.
      const profit = result.profit || 0;
      state.arbProfit += profit;
      recordTrade(profit, 'arbitrage', { market: state.activeArbMarket || 'arb', price: 0, size: 0 });
      log('TRADE', `Arb trade executed: +$${profit.toFixed(2)} profit`);
    }
  });

  // Scan for arbitrage opportunities ONLY if enabled
  if (CONFIG.arbitrage.enabled) {
    state.arbitrage.status = 'scanning';
    try {
      const results = await arbService.scanMarkets(
        { minVolume24h: CONFIG.arbitrage.minVolume24h },
        CONFIG.arbitrage.profitThreshold
      );
      state.arbitrage.marketsScanned = results.length;
      const opps = results.filter(r => r.arbType !== 'none');

      if (opps.length > 0) {
        state.activeArbMarket = opps[0].market.name;
        state.arbitrage.currentMarket = opps[0].market.name;
        state.arbitrage.status = 'monitoring';
        await arbService.start(opps[0].market);
        log('ARB', `Started monitoring: ${opps[0].market.name}`);
      } else {
        state.arbitrage.status = 'idle';
        log('ARB', 'No arbitrage opportunities found, will keep scanning...');
      }
      updateDashboard();
    } catch (err) {
      state.arbitrage.status = 'idle';
      log('WARN', `Arbitrage scan error: ${(err as Error).message}`);
      updateDashboard();
    }
  }
}

async function setupDipArb(sdk: PolymarketSDK) {
  // Always setup listeners provided by this function
  log('ARB', 'Setting up DipArb Service...');

  // Configure the DipArb service
  sdk.dipArb.updateConfig({
    shares: CONFIG.dipArb.shares,
    sumTarget: CONFIG.dipArb.sumTarget,
    autoExecute: !CONFIG.dryRun,
    debug: true,
  });

  // Event handlers - listen to orderbookUpdate for live orderbook data
  sdk.dipArb.on('orderbookUpdate', (update: {
    upPrice: number;
    downPrice: number;
    sum: number;
  }) => {
    state.dipArb.upPrice = update.upPrice;
    state.dipArb.downPrice = update.downPrice;
    state.dipArb.sum = update.sum;
    updateDashboard();
  });

  // Listen to 'started' event to sync market details immediately
  sdk.dipArb.on('started', (market: any) => {
    log('ARB', `DipArb Service Started Monitoring: ${market.name}`);
    state.activeDipArbMarket = market.name;
    state.dipArb.marketName = market.name;
    state.dipArb.underlying = market.underlying || 'ETH';
    state.dipArb.duration = `${market.durationMinutes}m`;
    state.dipArb.endTime = market.endTime ? new Date(market.endTime).getTime() : null;
    state.dipArb.status = 'active'; // Force status update
    updateDashboard();

    // Also notify dashboard specifically about status change
    dashboardEmitter.updateStrategyStatus('dipArb', 'active', market.name);
  });

  // Listen to newRound for round changes
  sdk.dipArb.on('newRound', (round: { roundId: string; priceToBeat: number }) => {
    log('ARB', `New round: ${round.roundId}, Price to Beat: ${round.priceToBeat}`);
    updateDashboard();
  });

  // Signal handler - extract data from DipArbLeg1Signal or DipArbLeg2Signal
  sdk.dipArb.on('signal', (s: {
    type: 'leg1' | 'leg2';
    dipSide?: string;
    hedgeSide?: string;
    currentPrice: number;
    source?: string;
    dropPercent?: number;
  }) => {
    const side = s.dipSide || s.hedgeSide || 'UP';
    const signal: DipArbSignal = {
      id: `da-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      timestamp: new Date().toISOString(),
      type: s.type as DipArbSignal['type'],
      side: side as 'UP' | 'DOWN',
      price: s.currentPrice || 0,
      change: s.dropPercent ? -s.dropPercent * 100 : 0,
    };
    state.dipArb.lastSignal = signal;
    state.dipArb.signals.unshift(signal);
    if (state.dipArb.signals.length > 20) {
      state.dipArb.signals = state.dipArb.signals.slice(0, 20);
    }
    log('SIGNAL', `DipArb: ${s.type} ${side} @ ${s.currentPrice?.toFixed(3)}`);

    // NO SIMULATION on signal anymore - signals are not trades!
    // We only want to track actual executions (which will fire the 'execution' event)

    updateDashboard();
  });

  // Per-leg execution: LOG ONLY. C3 — a single leg is not a realized result, so
  // we must NOT record PnL here (recording 0 every leg poisoned the streak and
  // tradesExecuted). Realized PnL is booked once per round on 'roundComplete'.
  sdk.dipArb.on('execution', (r: any) => {
    if (r.success) {
      const price = r.price ? r.price.toFixed(3) : '??';
      const shares = r.shares ? r.shares.toFixed(1) : '??';
      const market = state.activeDipArbMarket || 'unknown-market';

      switch (r.leg) {
        case 'leg1':
          log('TRADE', `OPEN ${r.side} | ${shares} shares @ $${price} | ${market}`);
          break;
        case 'leg2':
          log('TRADE', `HEDGE ${r.side} | ${shares} shares @ $${price} | Locked Profit`);
          break;
        case 'exit':
          log('TRADE', `CLOSE ${r.side} (Timeout Exit) | ${shares} shares @ $${price}`);
          break;
        case 'merge':
          log('TRADE', `REDEEM | Merged positions for $1.00 payout | ${market}`);
          break;
        default:
          log('TRADE', `DipArb ${r.leg}: ${r.side} @ ${price}`);
      }
    } else {
      log('WARN', `DipArb Execution Failed (${r.leg}): ${r.error || 'Unknown error'}`);
    }
  });

  // C3: book the REAL realized PnL once per closed round. `profit` is per-share
  // (1 - actualTotalCost) and `leg1.shares` is the round size, so realized =
  // profit × shares. Only 'completed' rounds have a locked, real number — we
  // never fabricate one for 'expired'/'partial' rounds.
  sdk.dipArb.on('roundComplete', (round: any) => {
    if (round.status !== 'completed') {
      log('WARN', `DipArb round ${round.roundId} ended ${round.status} (no realized PnL recorded).`);
      return;
    }
    const perShare = typeof round.profit === 'number' ? round.profit : null;
    const shares = Number(round.leg1?.shares) || Number(round.leg2?.shares) || 0;
    if (perShare === null || shares <= 0) {
      log('ERROR', `DipArb round ${round.roundId} completed but profit/shares missing — refusing to record a fabricated PnL.`);
      return;
    }
    const realized = perShare * shares;
    log('TRADE', `DipArb round ${round.roundId} realized $${realized.toFixed(2)} (${(perShare * 100).toFixed(2)}%/share × ${shares})`);
    recordTrade(realized, 'dipArb', {
      market: state.activeDipArbMarket || 'dipArb',
      side: 'BUY',
      size: shares,
      price: Number(round.leg1?.price) || 0,
    });
  });

  sdk.dipArb.on('rotate', (e: { newMarket: string }) => {
    state.activeDipArbMarket = e.newMarket;
    state.dipArb.marketName = e.newMarket;
    log('ARB', `DipArb rotated to ${e.newMarket}`);
    updateDashboard();
  });

  // Enable auto-rotate if configured
  if (CONFIG.dipArb.autoRotate) {
    sdk.dipArb.enableAutoRotate({
      enabled: true,
      underlyings: ['ETH', 'BTC', 'SOL'],
      duration: '15m',
      settleStrategy: 'redeem',
      redeemWaitMinutes: 5,
    });
  }

  // Find and start monitoring a market
  if (CONFIG.dipArb.enabled) {
    try {
      const market = await sdk.dipArb.findAndStart({ coin: 'ETH', preferDuration: '15m' });
      if (market) {
        state.activeDipArbMarket = market.name;
        state.dipArb.marketName = market.name;
        state.dipArb.underlying = market.underlying || 'ETH';
        state.dipArb.duration = `${market.durationMinutes}m`;
        // endTime is a Date object, convert to timestamp
        state.dipArb.endTime = market.endTime ? new Date(market.endTime).getTime() : null;
        state.dipArb.status = 'active'; // Force status update
        log('ARB', `DipArb started: ${market.name}`);
      } else {
        log('WARN', 'No DipArb markets found');
      }
      updateDashboard();
    } catch (err) {
      log('WARN', `DipArb setup error: ${(err as Error).message}`);
    }
  }
}

let swapService: SwapService | null = null;

async function updateBalances() {
  if (CONFIG.dryRun) {
    // SIMULATION: the displayed USDC.e balance MUST be the paper engine's real
    // equity (mark-to-market), NOT a fictional 10k base. Sizing/exposure caps run
    // on CONFIG.capital.totalUsd; showing 10k made every dashboard $/% incoherent.
    state.usdcEBalance = paper ? paper.equity() : CONFIG.capital.totalUsd;
    state.maticBalance = 100;
    updateDashboard();
    return;
  }

  if (!swapService) return;
  try {
    const balances = await swapService.getBalances();
    let changed = false;

    // Parse balances from TokenBalance array
    for (const b of balances) {
      if (b.symbol === 'MATIC') {
        const val = parseFloat(b.balance);
        if (state.maticBalance !== val) { state.maticBalance = val; changed = true; }
      }
      if (b.symbol === 'USDC') {
        const val = parseFloat(b.balance);
        if (state.usdcBalance !== val) { state.usdcBalance = val; changed = true; }
      }
      if (b.symbol === 'USDC_E') {
        const val = parseFloat(b.balance);
        if (state.usdcEBalance !== val) { state.usdcEBalance = val; changed = true; }
      }
    }

    if (changed) {
      updateDashboard();
      // Optional: Log only on significant changes or debug
      // log('SWAP', 'Balances updated');
    }
  } catch (err) {
    // Silent fail on interval to avoid log spam
  }
}

async function setupSwap() {
  log('SWAP', 'Setting up Wallet & Balance Monitor...');

  try {
    if (!process.env.POLYMARKET_PRIVATE_KEY) return;

    // Create SwapService with signer. Use the shared StaticJsonRpcProvider so we
    // don't trigger the eth_chainId network-detection probe (NETWORK_ERROR spam).
    const provider = getPolygonProvider();
    const signer = new ethers.Wallet(process.env.POLYMARKET_PRIVATE_KEY, provider);
    swapService = new SwapService(signer);

    // Initial fetch
    await updateBalances();

    log('SWAP', 'Balances:', {
      matic: state.maticBalance.toFixed(4),
      usdce: `$${state.usdcEBalance.toFixed(2)}`,
    });

    // Check for low USDC.e (Bridged) balance
    if (!CONFIG.dryRun && state.usdcEBalance < 5) {
      log('WARN', `⚠️ Low USDC.e balance ($${state.usdcEBalance.toFixed(2)}). Bot requires USDC.e (Bridged USDC) on Polygon.`);
      log('WARN', `ℹ️ Please deposit USDC.e or swap your Native USDC to USDC.e manually.`);
    }

    // Poll balances every 30 seconds
    track(setInterval(updateBalances, 30000));

    updateDashboard();
  } catch (err) {
    log('WARN', `Balance setup error: ${(err as Error).message}`);
  }
}

async function setupOnchain() {
  if (!CONFIG.onchain.enabled || CONFIG.dryRun) return;
  log('CHAIN', 'Checking on-chain approvals...');

  try {
    if (!process.env.POLYMARKET_PRIVATE_KEY) return;

    const onchain = new OnchainService({
      privateKey: process.env.POLYMARKET_PRIVATE_KEY,
      rpcUrl: POLYGON_RPC_URL,
    });

    if (CONFIG.onchain.autoApprove) {
      log('CHAIN', 'Auto-approving Proxy and Exchange...');
      const result = await onchain.approveAll();

      if (result.allApproved) {
        log('CHAIN', '✅ All approvals ready');
      } else {
        log('WARN', `Approval status: ${result.summary}`);
        // Log individual failures
        result.erc20Approvals.forEach(r => {
          if (!r.success) log('WARN', `❌ ERC20 Approval failed: ${r.contract} - ${r.error}`);
        });
        result.erc1155Approvals.forEach(r => {
          if (!r.success) log('WARN', `❌ ERC1155 Approval failed: ${r.contract} - ${r.error}`);
        });
      }
    } else {
      const status = await onchain.checkAllowances();
      if (!status.tradingReady) {
        log('WARN', 'Missing approvals:', status.issues);
        log('WARN', 'Enable onchain.autoApprove=true to fix automatically');
      } else {
        log('CHAIN', '✅ Approvals verified');
      }
    }
  } catch (err) {
    log('WARN', `Onchain setup error: ${(err as Error).message}`);
  }
}

async function setupBinanceAnalysis(sdk: PolymarketSDK) {
  if (!CONFIG.binance.enabled) return;
  log('KLINE', 'Setting up Binance K-line analysis...');

  async function analyzeTrend(symbol: 'BTCUSDT' | 'ETHUSDT' | 'SOLUSDT'): Promise<'up' | 'down' | 'neutral'> {
    try {
      const klines = await sdk.binance.getKLines(symbol, CONFIG.binance.interval, { limit: 20 });
      if (klines.length < 10) return 'neutral';

      const recent = klines.slice(-5);
      const older = klines.slice(-10, -5);

      const recentAvg = recent.reduce((s, k) => s + k.close, 0) / recent.length;
      const olderAvg = older.reduce((s, k) => s + k.close, 0) / older.length;

      const change = (recentAvg - olderAvg) / olderAvg;

      if (change > CONFIG.binance.trendThreshold / 100) return 'up';
      if (change < -CONFIG.binance.trendThreshold / 100) return 'down';
      return 'neutral';
    } catch {
      return 'neutral';
    }
  }

  async function updateTrends() {
    state.btcTrend = await analyzeTrend('BTCUSDT');
    state.ethTrend = await analyzeTrend('ETHUSDT');
    state.solTrend = await analyzeTrend('SOLUSDT');
    log('TREND', `BTC:${state.btcTrend} ETH:${state.ethTrend} SOL:${state.solTrend}`);
    updateDashboard();
  }

  // Q8: this was registered TWICE — a duplicate setInterval doubled the Binance
  // API load and the TREND log spam. One initial run + one interval.
  await updateTrends();
  track(setInterval(updateTrends, 5 * 60 * 1000));
}

async function setupDirectTrading(sdk: PolymarketSDK) {
  log('INFO', 'Direct trading setup complete - waiting for toggle');

  if (CONFIG.directTrading.enabled) {
    if (CONFIG.dryRun) {
      log('INFO', 'Direct trading enabled (simulation mode)');
    } else {
      log('INFO', 'Direct trading enabled - will place orders based on trend analysis');
    }
  }

  async function checkTrendTrades() {
    if (!CONFIG.directTrading.enabled) return;
    if (!canTrade()) return;

    try {
      const trendingMarkets = await sdk.gammaApi.getTrendingMarkets(5);

      for (const market of trendingMarkets) {
        if (!market.conditionId) continue;

        try {
          const fullMarket = await sdk.getMarket(market.conditionId);
          const yesToken = fullMarket.tokens.find(t => t.outcome === 'Yes');
          const noToken = fullMarket.tokens.find(t => t.outcome === 'No');

          if (!yesToken || !noToken) continue;

          const isCryptoMarket = /btc|bitcoin|eth|ethereum|sol|solana/i.test(market.question || '');

          if (isCryptoMarket && CONFIG.directTrading.trendFollowing) {
            let trend: 'up' | 'down' | 'neutral' = 'neutral';
            if (/btc|bitcoin/i.test(market.question || '')) trend = state.btcTrend;
            else if (/eth|ethereum/i.test(market.question || '')) trend = state.ethTrend;
            else if (/sol|solana/i.test(market.question || '')) trend = state.solTrend;

            if (trend !== 'neutral') {
              // Strategy: 
              // UP -> Expect YES to win -> Buy YES
              // DOWN -> Expect YES to lose -> Buy NO
              const targetToken = trend === 'up' ? yesToken : noToken;
              const side = 'BUY'; // We always BUY the outcome we believe in
              const price = targetToken.price;

              if (CONFIG.dryRun) {
                // DRY-RUN: route the paper estimate to the isolated PaperPortfolio
                // (never recordTrade with a fabricated 0). The BUY opens a paper
                // position that the resolver settles with a REAL price later.
                if (paper) {
                  const action = paper.onSignal({
                    market: targetToken.tokenId,
                    conditionId: market.conditionId,
                    outcome: targetToken.outcome,
                    slug: market.question?.slice(0, 60),
                    side: 'BUY',
                    price,
                    size: Math.max(CONFIG.capital.minOrderUsd, CONFIG.capital.totalUsd * CONFIG.capital.maxPerTradePct) / Math.max(price, 0.001),
                    wallet: 'direct',
                  });
                  state.directTrades = (state.directTrades ?? 0) + 1;
                  log('TRADE', `[PAPER] DIRECT BUY ${targetToken.outcome} ${market.question?.slice(0, 40)} @ ${price.toFixed(3)} → ${action}`);
                  updateDashboard();
                }
              } else {
                // LIVE (DORMANT until DRY_RUN validated): size via the bot's caps
                // (per-trade % + dynamic + 30% exposure), NOT a fixed $5.
                let amountUsdc = calculatePositionSize(currentLiveExposureUsd());
                if (amountUsdc <= 0) {
                  log('WARN', `Direct trade skipped: exposure cap reached for ${market.question?.slice(0, 30)}...`);
                  continue;
                }

                log('SIGNAL', `Executing Trend Trade: ${trend.toUpperCase()} on ${market.question?.slice(0, 30)}...`);

                sdk.tradingService.createMarketOrder({
                  tokenId: targetToken.tokenId,
                  side: 'BUY',
                  amount: amountUsdc,
                  price: Math.min(0.999, price * (1 + CONFIG.directTrading.minTrendStrength)),
                  orderType: 'FOK',
                }).then(res => {
                  if (res.success) {
                    state.directTrades = (state.directTrades ?? 0) + 1;
                    // C3: opening BUY is an entry — NO profit booked here. Realized
                    // PnL is recorded when the position closes/resolves.
                    log('TRADE', `✅ Direct Trade: Bought $${amountUsdc.toFixed(2)} of ${targetToken.outcome} @ ~${price.toFixed(2)} (order ${res.orderId ?? 'n/a'})`);
                    updateDashboard();
                  } else {
                    log('ERROR', `❌ Direct Trade failed: ${res.errorMsg ?? 'unknown error'}`);
                  }
                }).catch((err: unknown) => {
                  log('ERROR', `❌ Direct Trade error: ${(err as Error).message}`);
                });
              }
            }
          }
        } catch { /* skip */ }
      }
    } catch (err) {
      log('WARN', `Direct trading error: ${(err as Error).message}`);
    }
  }

  // Check every 5 minutes
  track(setInterval(checkTrendTrades, 5 * 60 * 1000));
  // Initial check after 10 seconds (let trends stabilize)
  track(setTimeout(checkTrendTrades, 10000));
}

async function setupPortfolioManager(sdk: PolymarketSDK) {
  log('INFO', 'Starting Portfolio Manager...');

  // Initial Sync
  try {
    const positions = await sdk.wallets.getWalletPositions(sdk.tradingService.getAddress());
    state.positions = positions;
    log('WALLET', `Synced ${positions.length} existing positions.`);
    updateDashboard();
  } catch (err: any) {
    log('WARN', `Portfolio Sync failed: ${err.message}`);
  }

  // Re-entrancy guard: an RPC stall must not let a second sync stack on the
  // first (which would double the API load and race on state.positions).
  let portfolioSyncRunning = false;

  // Periodic Position Sync (Every 30s)
  track(setInterval(async () => {
    if (portfolioSyncRunning) return;
    portfolioSyncRunning = true;
    try {
      const positions = await sdk.wallets.getWalletPositions(sdk.tradingService.getAddress());

      // Enrich positions with market data (to check if won or lost)
      const enrichedPositions = await Promise.all(positions.map(async (pos: any) => {
        try {
          // Use cached market data if available
          const market = await sdk.markets.getMarket(pos.conditionId);
          if (market) {
            pos.marketClosed = market.closed;

            // Enrich with current price for PnL
            // Try to find the token in the market outcomes
            const token = market.tokens.find((t: any) => t.tokenId === pos.asset);

            if (token) {
              pos.isWinner = token.winner || false;
              // Store current price for frontend
              pos.curPrice = token.price || 0;
            }

            // If market is closed but winner info is missing/false, assume lost unless proven otherwise
            if (market.closed && !pos.isWinner) {
              // Double check if ANY token won (if market resolved)
            }
          }
        } catch (e) {
          // Ignore market fetch errors, keep basic pos data
        }
        return pos;
      }));

      // Calculate Unrealized PnL
      let unrealized = 0;
      for (const p of enrichedPositions) {
        const entry = Number(p.avgPrice) || 0;
        const current = Number(p.curPrice) || Number(p.msg_price) || 0;
        const size = Number(p.size) || 0;

        if (current > 0 && size > 0) {
          unrealized += (current - entry) * size;
        }
      }
      state.unrealizedPnL = unrealized;

      // Update Total PnL display to include Unrealized? 
      // User requested "P&L total is still not updating".
      // Usually Total = Realized + Unrealized.
      // But we keep them separate in state, let frontend decide how to show.

      state.positions = enrichedPositions;
      updateDashboard();
    } catch (err: any) {
      log('WARN', `Portfolio sync error: ${err.message}`);
    } finally {
      portfolioSyncRunning = false;
    }
  }, 30 * 1000));
}

// Re-entrancy guard: a slow Gamma API call must not let a second resolver pass
// stack on top of the first.
let paperResolverRunning = false;

// Paper-trading resolver: live mark-to-market + settle resolved positions via Gamma API.
// Per-token streak of consecutive resolver passes the price has been pinned at an
// extreme. A sustained pin = a decided outcome → settle (bridges Gamma's close lag).
const pinnedCycles = new Map<string, number>();
const PIN_CYCLES_TO_SETTLE = parseInt(process.env.PIN_CYCLES || '3', 10);

async function runPaperResolver() {
  if (!paper) return;
  if (paperResolverRunning) return;
  paperResolverRunning = true;
  try {
    const open = paper.listOpen();
    for (const { tokenId, conditionId } of open) {
      if (!conditionId) continue;
      try {
        const r = await fetchWithTimeout(`https://gamma-api.polymarket.com/markets?condition_ids=${conditionId}`);
        const arr = await r.json();
        let mk = Array.isArray(arr) ? arr[0] : null;
        if (!mk) {
          // A RESOLVED market drops out of Gamma's default (active-only) query, so
          // the plain fetch returns []. Re-query explicitly for the closed market
          // so we can SETTLE it. This was the silent gap: once a position's market
          // resolved it disappeared here and was skipped forever → never realized.
          const rc = await fetchWithTimeout(`https://gamma-api.polymarket.com/markets?condition_ids=${conditionId}&closed=true`);
          const arrc = await rc.json();
          mk = Array.isArray(arrc) ? arrc[0] : null;
          if (!mk) continue; // genuinely not indexed this cycle; retry next pass
        }
        let tokenIds: string[] = [];
        let prices: string[] = [];
        try { tokenIds = JSON.parse(mk.clobTokenIds); } catch { /* ignore */ }
        try { prices = JSON.parse(mk.outcomePrices); } catch { /* ignore */ }
        const idx = tokenIds.indexOf(tokenId);
        if (idx < 0) continue;
        const px = parseFloat(prices[idx]);
        if (mk.closed) {
          const clean = prices.length === 2 &&
            ((prices[0] === '1' && prices[1] === '0') || (prices[0] === '0' && prices[1] === '1'));
          if (clean) {
            paper.settle(tokenId, px, 'resolved'); // px is exactly 1 (win) or 0 (loss)
            log('TRADE', `[PAPER] ⚖️ RESOLVED ${(mk.slug || tokenId).slice(0, 40)} → ${px >= 0.5 ? 'WON $1' : 'LOST $0'}/share`);
          } else {
            // NO FALLBACK: a closed-but-not-cleanly-resolved market must NOT be
            // settled at a fabricated price (0.5 / lastTradePrice). Leave the
            // position OPEN and log ERROR with the conditionId for manual review.
            // It will be re-checked next cycle and settled once it resolves to 1/0.
            log('ERROR', `[PAPER] Market closed but NOT cleanly resolved (1/0) — leaving position OPEN for manual review. condition=${conditionId} token=${tokenId.slice(0, 16)}… slug=${mk.slug || 'n/a'} prices=${JSON.stringify(prices)}`);
          }
        } else {
          // Not formally `closed` in Gamma yet — its flag trails the real event end
          // by hours (UMA finalization), so decided positions sit unrealized and
          // jam the exposure cap. Mark to live price, and SETTLE once the price has
          // been pinned at an extreme (≥0.99 / ≤0.01) for PIN_CYCLES_TO_SETTLE
          // consecutive resolver passes (~6 min) — a concluded outcome, settled at
          // its REAL pinned payout (1 or 0), never a fabricated mid.
          if (px > 0 && px < 1) {
            paper.markPrice(tokenId, px);
            // Stop-loss: cut a position that has fallen too far below entry instead
            // of riding it to $0. If it triggers, the position is gone — skip the
            // rest of this token's pass.
            if (paper.maybeStopLoss(tokenId, px)) {
              log('TRADE', `[PAPER] 🛑 STOP-LOSS ${(mk.slug || tokenId).slice(0, 40)} @ ${px.toFixed(3)}`);
              pinnedCycles.delete(tokenId);
              await new Promise(res => setTimeout(res, 150));
              continue;
            }
          }
          const pinned = px >= 0.99 || px <= 0.01;
          if (pinned) {
            const n = (pinnedCycles.get(tokenId) || 0) + 1;
            pinnedCycles.set(tokenId, n);
            if (n >= PIN_CYCLES_TO_SETTLE) {
              const payout = px >= 0.99 ? 1 : 0;
              paper.settle(tokenId, payout, 'resolved');
              pinnedCycles.delete(tokenId);
              log('TRADE', `[PAPER] ⚖️ SETTLED (price pinned ${px.toFixed(3)} ×${n} cycles) ${(mk.slug || tokenId).slice(0, 36)} → ${payout ? 'WON $1' : 'LOST $0'}/share`);
            }
          } else {
            pinnedCycles.delete(tokenId); // un-pinned → reset the streak
          }
        }
      } catch (err) {
        // Surface (do not swallow) per-position resolver failures; retried next cycle.
        log('WARN', `[PAPER] resolver check failed for ${conditionId.slice(0, 18)}…: ${(err as Error).message}`);
      }
      await new Promise(res => setTimeout(res, 150)); // gentle on the API
    }
    // Purge orphaned pin streaks: a token settled via the `closed` path or closed by
    // a leader SELL leaves listOpen() and would never be revisited to clear its entry,
    // so pinnedCycles would grow unbounded. Keep only still-open tokens.
    const openTokens = new Set(paper.listOpen().map(o => o.tokenId));
    for (const k of pinnedCycles.keys()) {
      if (!openTokens.has(k)) pinnedCycles.delete(k);
    }
    paper.save();
    // Fold any newly-realized (resolved/sold) paper PnL into the risk ledger so
    // canTrade()'s limits track the real dry-run result (C3).
    syncRiskFromPaper();
    updateDashboard();
  } finally {
    paperResolverRunning = false;
  }
}

async function main() {
  console.clear();
  console.log('╔════════════════════════════════════════════════════════════════════╗');
  console.log('║          POLYMARKET BOT v3.0 + DASHBOARD                           ║');
  console.log('╚════════════════════════════════════════════════════════════════════╝\n');

  // Start Dashboard Server
  startDashboard(3001);
  console.log('\n🌐 Dashboard: http://localhost:3001\n');

  // Crash-recovery: restore the persisted risk ledger BEFORE any trading wiring.
  // Throws (and aborts startup) on a corrupt file — NO silent reset to zeros.
  loadRiskState();
  updateDashboard();

  // Q2: a missing private key is only FATAL for LIVE trading. In dry-run the SDK
  // falls back to a dummy read-only key internally, so we must NOT process.exit —
  // gate the hard exit on !CONFIG.dryRun. (We still warn loudly: balance/onchain
  // setup that needs a real key is already self-skipping when it's absent.)
  if (!process.env.POLYMARKET_PRIVATE_KEY) {
    if (!CONFIG.dryRun) {
      log('ERROR', 'POLYMARKET_PRIVATE_KEY not found — required for LIVE trading. Aborting.');
      process.exit(1);
    }
    log('WARN', 'POLYMARKET_PRIVATE_KEY not set — running DRY-RUN with read-only SDK access (no wallet balances / on-chain ops).');
  }

  // Send config to dashboard
  const dashboardConfig: BotConfig = {
    capital: CONFIG.capital,
    risk: CONFIG.risk,
    smartMoney: {
      enabled: CONFIG.smartMoney.enabled,
      topN: CONFIG.smartMoney.topN,
      minWinRate: CONFIG.smartMoney.minWinRate,
      minPnl: CONFIG.smartMoney.minPnl,
      minTrades: CONFIG.smartMoney.minTrades,
      customWallets: CONFIG.smartMoney.customWallets,
    },
    arbitrage: {
      enabled: CONFIG.arbitrage.enabled,
      profitThreshold: CONFIG.arbitrage.profitThreshold,
      autoExecute: CONFIG.arbitrage.autoExecute,
    },
    dipArb: {
      enabled: CONFIG.dipArb.enabled,
      coins: CONFIG.dipArb.coins,
    },
    directTrading: {
      enabled: CONFIG.directTrading.enabled,
    },
    binance: {
      enabled: CONFIG.binance.enabled,
    },
    dryRun: CONFIG.dryRun,
  };
  dashboardEmitter.updateConfig(dashboardConfig);
  dashboardEmitter.updateState(state);

  log('INFO', 'Configuration', {
    binance: CONFIG.binance.enabled,
  });

  // Handle Dashboard Commands
  dashboardEmitter.on('command', async (cmd: { command: string; payload: any }) => {
    if (cmd.command === 'toggleDryRun') {
      // `enabled` is the NEW desired value of dryRun. enabled=false ⇒ go LIVE.
      const enable = cmd.payload.enabled;
      const wantDryRun = !!enable;
      const wantLive = !wantDryRun;
      const emitCurrentConfig = (dryRun: boolean) => dashboardEmitter.updateConfig({
        capital: CONFIG.capital, risk: CONFIG.risk,
        smartMoney: { ...CONFIG.smartMoney }, arbitrage: { ...CONFIG.arbitrage },
        dipArb: { ...CONFIG.dipArb }, directTrading: { ...CONFIG.directTrading },
        binance: { ...CONFIG.binance }, dryRun,
      });
      if (CONFIG.dryRun !== wantDryRun) {
        // SAFETY GATE: switching to LIVE from the dashboard must NOT be possible by
        // accident. Require a real signing key AND an explicit out-of-band opt-in.
        // Without both we refuse and stay in dry-run — no path to silent real orders.
        if (wantLive) {
          const hasKey = !!(process.env.POLYMARKET_PRIVATE_KEY && process.env.POLYMARKET_PRIVATE_KEY.length >= 64);
          const optedIn = process.env.ALLOW_LIVE_TOGGLE === 'true';
          if (!hasKey || !optedIn) {
            log('ERROR', `🚫 LIVE toggle REFUSED — ${!hasKey ? 'no POLYMARKET_PRIVATE_KEY' : 'ALLOW_LIVE_TOGGLE != true'}. Staying in DRY RUN.`);
            emitCurrentConfig(true); // force the dashboard back to DRY RUN
            return;
          }
        }
        log('WARN', `Switching to ${wantLive ? '🔴 LIVE' : '🧪 DRY RUN'} mode... (Requested by user)`);
        CONFIG.dryRun = wantDryRun;

        // Ensure a paper wallet exists when entering dry-run.
        if (CONFIG.dryRun && !state.paper) {
          state.paper = {
            balance: CONFIG.capital.totalUsd,
            initialBalance: CONFIG.capital.totalUsd,
            pnl: 0,
            trades: 0,
            totalVolume: 0,
          };
        }

        // Re-configure services for the new mode.
        // 1. Arbitrage Service (re-create to update signer/sim mode).
        if (arbService) {
          await arbService.stop();
          await setupArbitrage(sdk);
        }
        // 2. DipArb (live = autoExecute true, if its config is enabled).
        sdk.dipArb.updateConfig({ autoExecute: !CONFIG.dryRun });

        emitCurrentConfig(CONFIG.dryRun);
        log('WARN', `⚠️ BOT MODE CHANGED TO: ${CONFIG.dryRun ? '🧪 DRY RUN' : '🔴 LIVE'}`);
      }
    }
  });

  // Initialize Paper Wallet if Dry Run
  if (CONFIG.dryRun) {
    state.paper = {
      balance: CONFIG.capital.totalUsd,
      initialBalance: CONFIG.capital.totalUsd,
      pnl: 0,
      trades: 0,
      totalVolume: 0,
    };
    log('INFO', `📝 Paper Trading Activated: Simulating trades with $${CONFIG.capital.totalUsd} initial capital`);

    // Real PnL paper-trading engine (copy-trading), using the bot's own risk limits.
    const home = process.env.HOME || '.';
    const perTradeUsd = parseFloat(process.env.PAPER_PER_TRADE_USD || '') ||
      Math.max(CONFIG.capital.minOrderUsd, CONFIG.capital.totalUsd * CONFIG.capital.maxPerTradePct);
    const maxExpPct = parseFloat(process.env.PAPER_MAX_EXPOSURE_PCT || '') || CONFIG.capital.maxTotalExposurePct;
    paper = new PaperPortfolio({
      capital: CONFIG.capital.totalUsd,
      perTradeUsd,
      maxTotalExposurePct: maxExpPct,
      maxPerMarketPct: CONFIG.capital.maxPerMarketPct,
      maxRelativeSlippage: parseFloat(process.env.PAPER_MAX_REL_SLIPPAGE || '0.05'),
      minEntryPrice: parseFloat(process.env.PAPER_MIN_ENTRY || '0.35'),
      maxEntryPrice: parseFloat(process.env.PAPER_MAX_ENTRY || '0.97'),
      allowAveraging: process.env.PAPER_ALLOW_AVERAGING === 'true', // default OFF (no averaging-up)
      stopLossPct: parseFloat(process.env.PAPER_STOP_LOSS_PCT || '0.5'), // cut at -50% vs riding to -100%
      minOrderUsd: CONFIG.capital.minOrderUsd,
      slippage: parseFloat(process.env.PAPER_SLIPPAGE || '0.005'),
      statePath: `${home}/paper-state.json`,
      historyPath: `${home}/paper-history.csv`,
    }, Date.now());
    // Seed the sync baseline to the paper's ALREADY-realized PnL (it may have
    // loaded prior state). The persisted risk ledger already reflects that
    // history, so we must only fold FUTURE realized deltas — not replay the past.
    lastPaperRealized = paper.realizedPnL;
    log('INFO', `📄 Paper PnL engine ready ($${perTradeUsd.toFixed(2)}/copy, max exposure ${(maxExpPct * 100).toFixed(0)}%, slippage ${(paper.cfg.slippage * 100).toFixed(2)}¢, live-price + resolution settlement ON)`);
    updateDashboard();
  }

  const sdk = await PolymarketSDK.create({
    privateKey: process.env.POLYMARKET_PRIVATE_KEY,
  });

  log('INFO', `Wallet: ${sdk.tradingService.getAddress()}`);

  // ---- WS observability -------------------------------------------------
  // Drive the dashboard ACTIVE/badge from REAL WebSocket health, not just
  // isPaused. The realtime feed is the bot's lifeblood (copy/dipArb signals);
  // if it silently drops, the dashboard must show it. We track state.wsConnected
  // off the realtime service's own disconnected/statusChange/connected events.
  state.wsConnected = sdk.realtime.isConnected?.() ?? false;
  sdk.realtime.on('connected', () => {
    state.wsConnected = true;
    log('INFO', '🔌 Realtime WebSocket connected');
    updateDashboard();
  });
  sdk.realtime.on('disconnected', () => {
    state.wsConnected = false;
    log('ERROR', '🔌 Realtime WebSocket DISCONNECTED — signal feed is down until it reconnects');
    updateDashboard();
  });
  sdk.realtime.on('reconnecting', (info: { count: number }) => {
    log('WARN', `🔌 Realtime WebSocket reconnecting (replaying ${info?.count ?? 0} subscriptions)…`);
    updateDashboard();
  });
  sdk.realtime.on('statusChange', (status: ConnectionStatus) => {
    state.wsConnected = status === ConnectionStatus.CONNECTED;
    log('INFO', `🔌 Realtime WebSocket status: ${status}`);
    updateDashboard();
  });

  // Setup all services
  await setupOnchain(); // MUST BE FIRST (Approvals)
  await setupSwap();
  await setupBinanceAnalysis(sdk);
  await setupSmartMoney(sdk);
  await setupArbitrage(sdk);
  await setupDipArb(sdk);

  // Periodic state update
  track(setInterval(() => {
    updateDashboard();
  }, 5000));

  // Setup Direct Trading
  await setupDirectTrading(sdk);

  // Setup Portfolio Manager (Persistence)
  await setupPortfolioManager(sdk);

  // Listen for commands from dashboard
  dashboardEmitter.on('command', async ({ command, payload }: { command: string; payload: any }) => {
    if (command === 'closePosition') {
      const { tokenId, size } = payload;
      log('TRADE', `Closing position: ${tokenId} (${size} shares)`);

      if (CONFIG.dryRun) {
        log('TRADE', `[SIMULATION] Would sell ${size} shares of ${tokenId}`);
        return;
      }

      try {
        // Realized PnL of this manual close = (real exit price − avg entry) × size.
        // We read the freshest REAL price the portfolio sync enriched onto the
        // position (curPrice). NO FALLBACK to a fabricated price: if we have no
        // real price we record 0 only when entry is also unknown, and otherwise
        // surface the gap rather than inventing a number.
        const position = state.positions.find(p => p.asset === tokenId);
        const entryPrice = position ? Number(position.avgPrice) || 0 : 0;
        const markPrice = position
          ? (Number((position as any).curPrice) || Number(position.msg_price) || 0)
          : 0;

        const res = await sdk.tradingService.createMarketOrder({
          tokenId,
          side: 'SELL',
          amount: size,
        });

        if (res.success) {
          // Prefer the REAL fill price/size from the order; fall back to the fresh
          // pre-trade mark (curPrice), never a fabricated number.
          const exitPrice = (res.avgPrice && res.avgPrice > 0) ? res.avgPrice : markPrice;
          const filledSize = (res.filledSize && res.filledSize > 0) ? res.filledSize : size;
          log('TRADE', `✅ Position closed: ${filledSize.toFixed(2)} shares sold @ ${exitPrice > 0 ? exitPrice.toFixed(3) : 'n/a'}`);
          if (exitPrice > 0 && entryPrice > 0) {
            const realized = (exitPrice - entryPrice) * filledSize;
            recordTrade(realized, 'direct', {
              market: tokenId,
              side: 'SELL',
              size: filledSize,
              price: exitPrice,
              txHash: res.transactionHashes?.[0],
            });
            log('INFO', `Realized PnL: $${realized.toFixed(2)} (exit ${exitPrice.toFixed(3)} vs entry ${entryPrice.toFixed(3)})`);
          } else {
            log('ERROR', `Position closed but realized PnL could not be computed (exit=${exitPrice}, entry=${entryPrice}) — NOT recording a fabricated number. token=${tokenId}`);
          }
        } else {
          log('ERROR', `❌ Close failed: ${res.errorMsg}`);
        }
      } catch (err: any) {
        log('WARN', `❌ Close error: ${err.message}`);
      }
    }

    if (command === 'toggleStrategy') {
      const { strategy, enabled } = payload;
      const strategyName = strategy as keyof typeof CONFIG;

      if (CONFIG[strategyName] && typeof (CONFIG[strategyName] as any).enabled !== 'undefined') {
        (CONFIG[strategyName] as any).enabled = enabled;
        log('INFO', `⚙️ Strategy ${strategy} ${enabled ? 'ENABLED' : 'DISABLED'}`);

        // Actively Start/Stop Services based on toggle
        try {
          if (strategy === 'dipArb') {
            if (enabled) {
              if (sdk.dipArb.isActive()) {
                log('WARN', `DipArb is already running.`);
              } else {
                log('INFO', `Starting DipArb Service (Scanning for markets)...`);
                await sdk.dipArb.findAndStart();
              }
            } else {
              log('INFO', `Stopping DipArb Service...`);
              await sdk.dipArb.stop();
            }
          } else if (strategy === 'arbitrage') {
            if (enabled) {
              if (arbService) {
                // Update config
                arbService.updateConfig({
                  profitThreshold: CONFIG.arbitrage.profitThreshold,
                  autoExecute: CONFIG.arbitrage.autoExecute,
                });

                if (arbService.isActive()) {
                  log('WARN', `Arbitrage Service is already running.`);
                } else {
                  log('INFO', `Starting Arbitrage Service...`);

                  // Try to scan and start a market if possible
                  try {
                    const results = await arbService.scanMarkets({ minVolume24h: 1000 }, CONFIG.arbitrage.profitThreshold);
                    const best = results.find(r => r.arbType !== 'none') || results[0]; // Pick best or just first to monitor

                    if (best) {
                      await arbService.start(best.market);
                      state.activeArbMarket = best.market.name;
                      state.arbitrage.status = 'monitoring';
                      log('ARB', `Auto-started monitoring: ${best.market.name}`);
                      updateDashboard();
                    } else {
                      state.arbitrage.status = 'idle';
                      log('WARN', 'Arbitrage Service started but no markets found. Will keep scanning in background if configured.');
                      updateDashboard();
                    }
                  } catch (e) {
                    state.arbitrage.status = 'idle';
                    log('WARN', `Arbitrage auto-start failed: ${(e as Error).message}`);
                    updateDashboard();
                  }
                }
              } else {
                log('ERROR', 'Arbitrage Service not initialized. Restart bot.');
              }
            } else {
              log('INFO', `Stopping Arbitrage Service...`);
              if (arbService) {
                await arbService.stop();
                state.arbitrage.status = 'idle';
                updateDashboard();
              }
            }
          } else if (strategy === 'smartMoney') {
            if (enabled) {
              log('INFO', `Initializing Smart Money...`);
              // Call the lazy initializer we created
              initializeSmartMoney(sdk);
            } else {
              log('INFO', `Smart Money monitoring disabled.`);
            }
          } else if (strategy === 'directTrading') {
            if (enabled) {
              log('INFO', `Triggering Direct Trading analysis...`);
              // We can't easily reach the inner function checkTrendTrades from here because it's scoped inside setupDirectTrading.
              // However, checkTrendTrades runs on an interval and checks the config flag. 
              // By enabling the flag, the NEXT interval will pick it up.
              // To be immediate, we'd need to expose it, but simplified "Wait for next cycle" is acceptable or we can just log.
              log('INFO', `Direct Trading will run on next cycle (within 5 min).`);
            }
          }
        } catch (err: any) {
          log('WARN', `Failed to toggle service: ${err.message}`);
        }

        // Broadcast updated config to dashboard
        const dashboardConfig: BotConfig = {
          // ... (rest of config mapping)
          capital: CONFIG.capital,
          risk: CONFIG.risk,
          smartMoney: {
            enabled: CONFIG.smartMoney.enabled,
            topN: CONFIG.smartMoney.topN,
            minWinRate: CONFIG.smartMoney.minWinRate,
            minPnl: CONFIG.smartMoney.minPnl,
            minTrades: CONFIG.smartMoney.minTrades,
            customWallets: CONFIG.smartMoney.customWallets,
          },
          arbitrage: {
            enabled: CONFIG.arbitrage.enabled,
            profitThreshold: CONFIG.arbitrage.profitThreshold,
            autoExecute: CONFIG.arbitrage.autoExecute,
          },
          dipArb: {
            enabled: CONFIG.dipArb.enabled,
            coins: CONFIG.dipArb.coins,
          },
          directTrading: {
            enabled: CONFIG.directTrading.enabled,
          },
          binance: {
            enabled: CONFIG.binance.enabled,
          },
          dryRun: CONFIG.dryRun,
        };
        dashboardEmitter.updateConfig(dashboardConfig);
      } else {
        log('WARN', `Unknown strategy: ${strategy}`);
      }
    }

    if (command === 'redeemPosition') {
      const { conditionId } = payload;
      log('CHAIN', `Redeem requested for: ${conditionId}`);

      if (CONFIG.dryRun) {
        log('CHAIN', `[SIMULATION] Would redeem position ${conditionId}`);
        return;
      }

      try {
        // Create CTFClient instance for on-chain redemption
        const ctfClient = new CTFClient({
          privateKey: process.env.POLYMARKET_PRIVATE_KEY!,
        });

        // 1. Fetch market details to get Token IDs (required for Polymarket CLOB redemption)
        // We use the Gamma API (via sdk.markets or sdk.gammaApi)
        log('CHAIN', `Fetching market details for condition ${conditionId}...`);
        const market = await sdk.markets.getMarket(conditionId);

        if (!market || !market.tokens || market.tokens.length < 2) {
          log('WARN', `❌ Redeem failed: Valid market not found for condition ${conditionId}`);
          return;
        }

        const tokenIds = {
          yesTokenId: market.tokens[0].tokenId,
          noTokenId: market.tokens[1].tokenId,
        };

        log('CHAIN', `Found market: ${market.question} (Tokens: ${tokenIds.yesTokenId.slice(0, 10)}... / ${tokenIds.noTokenId.slice(0, 10)}...)`);

        // 2. Redeem using Polymarket Token IDs
        const result = await ctfClient.redeemByTokenIds(conditionId, tokenIds);

        if (result.success) {
          log('CHAIN', `✅ Redeemed! ${result.tokensRedeemed} tokens → ${result.usdcReceived} USDC`);
          log('CHAIN', `   Tx: ${result.txHash}`);
        } else {
          log('WARN', `❌ Redeem failed`);
        }
      } catch (err: any) {
        log('WARN', `❌ Redeem error: ${err.message}`);
      }
    }
  });

  // ---- Unified shutdown -------------------------------------------------
  // Single teardown path for SIGINT, SIGTERM, uncaughtException and
  // unhandledRejection. Flush the paper portfolio, the risk ledger, persist the
  // session summary, stop services and clear ALL tracked timers. `shuttingDown`
  // guards against re-entry when several signals fire at once.
  let shuttingDown = false;
  async function shutdown(reason: string, exitCode = 0): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n\nShutting down (${reason})...`);

    // Stop all tracked pollers first so nothing fires mid-teardown.
    for (const t of timers) clearInterval(t);

    // Flush paper portfolio (state + final report).
    if (paper) {
      try {
        paper.save();
        console.log('\n' + paper.report(Math.round((Date.now() - state.startTime) / 1000 / 60)));
      } catch (err) {
        log('ERROR', `Paper save failed on shutdown: ${(err as Error).message}`);
      }
    }

    // Persist the risk ledger so a halted/paused bot stays that way on restart.
    try {
      saveRiskState();
    } catch (err) {
      log('ERROR', `Risk-state save failed on shutdown: ${(err as Error).message}`);
    }

    // Persist this run's session summary (wires addSession/createSessionFromState).
    try {
      const summary = createSessionFromState(state.startTime, state, CONFIG, sessionTrades);
      addSession(summary);
      log('INFO', `Session summary saved (PnL $${summary.totalPnL.toFixed(2)}, ${summary.totalTrades} trades).`);
    } catch (err) {
      log('ERROR', `Session summary save failed on shutdown: ${(err as Error).message}`);
    }

    // Stop services.
    try { if (arbService) await arbService.stop(); } catch (err) { log('ERROR', `arbService.stop failed: ${(err as Error).message}`); }
    try { await sdk.dipArb.stop(); } catch (err) { log('ERROR', `dipArb.stop failed: ${(err as Error).message}`); }
    try { sdk.stop(); } catch (err) { log('ERROR', `sdk.stop failed: ${(err as Error).message}`); }

    process.exit(exitCode);
  }

  process.on('SIGINT', () => { void shutdown('SIGINT'); });
  process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
  process.on('uncaughtException', (err) => {
    log('ERROR', `uncaughtException: ${err?.message}`, err?.stack);
    void shutdown('uncaughtException', 1);
  });
  process.on('unhandledRejection', (reason) => {
    const msg = reason instanceof Error ? reason.message : String(reason);
    log('ERROR', `unhandledRejection: ${msg}`);
    void shutdown('unhandledRejection', 1);
  });

  log('INFO', '🚀 Bot + Dashboard running! Press Ctrl+C to stop.\n');

  // Status Display Loop
  function displayStatus() {
    const runtime = Math.round((Date.now() - state.startTime) / 1000 / 60);

    // WS health drives the badge alongside isPaused: a dropped feed is NOT ACTIVE
    // even if the bot is otherwise unpaused.
    const statusBadge = state.permanentlyHalted ? '💀 HALTED'
      : state.isPaused ? '⏸️ PAUSED'
        : !state.wsConnected ? '🔌 WS DOWN'
          : '▶️ ACTIVE';

    console.log('\n' + '═'.repeat(70));
    console.log('              POLYMARKET BOT v3.0 STATUS');
    console.log('═'.repeat(70));
    console.log(`  Runtime:        ${runtime} minutes`);
    console.log(`  Mode:           ${CONFIG.dryRun ? '🧪 DRY RUN' : '🔴 LIVE'}`);
    console.log(`  Status:         ${statusBadge}`);
    console.log(`  WS Feed:        ${state.wsConnected ? '🟢 connected' : '🔴 disconnected'}`);
    console.log('─'.repeat(70));
    console.log('  BALANCES:');
    console.log(`    MATIC:        ${state.maticBalance.toFixed(4)}`);
    console.log(`    USDC:         $${state.usdcBalance.toFixed(2)}`);
    console.log(`    USDC.e:       $${state.usdcEBalance.toFixed(2)}`);
    console.log('─'.repeat(70));
    console.log('  STRATEGIES:');
    console.log(`    Smart Money:  ${state.smartMoneyTrades} trades | ${state.followedWallets.length} wallets`);
    console.log(`    Arbitrage:    ${state.arbTrades} trades`);
    console.log(`    DipArb:       ${state.dipArbTrades} trades`);
    console.log('═'.repeat(70) + '\n');

    // Paper-trading PnL report (the real answer to "how much would I make?")
    if (paper) {
      console.log(paper.report(runtime));
      paper.save();
      paper.appendHistory(runtime);
    }
  }

  track(setInterval(displayStatus, 60000));
  displayStatus(); // Initial call

  // Paper-trading resolver loop (mark-to-market + settle resolved markets)
  if (paper) {
    track(setInterval(runPaperResolver, 120000));
    track(setTimeout(runPaperResolver, 20000));
  }
}

main().catch((err) => {
  console.error('Fatal:', err.message);
  console.error(err);
  process.exit(1);
});
