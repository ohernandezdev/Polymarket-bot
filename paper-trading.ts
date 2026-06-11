/**
 * Paper Trading Engine — Honest simulated PnL for the copy-trading strategy.
 *
 * The shipped dry-run records `profit = 0` for every smart-money copy, so it can
 * never answer "how much would I make?". This engine fills that gap WITHOUT real
 * money, modelling the real economics of copying the followed (qualified) wallets:
 *
 *   - Start with `capital` virtual USDC.
 *   - Followed wallet BUYs token T @ p   -> open/add a position (size-capped), pay slippage.
 *   - Followed wallet SELLs token T @ p  -> if we hold T, close it @ p (minus slippage).
 *   - Open positions are marked to the LIVE market price each resolver cycle.
 *   - When a market RESOLVES, the position is settled at $1 (win) or $0 (loss).
 *
 * Resolution + live pricing are driven from the bot via markPrice()/settle(),
 * which pull from the Polymarket Gamma API (closed + outcomePrices + clobTokenIds).
 *
 * Risk caps mirror the bot's own CONFIG.capital (per-trade %, total exposure %,
 * min order $) so the result reflects how THIS bot would actually behave.
 */

import { writeFileSync, readFileSync, existsSync } from 'fs';

export interface CopySignal {
  market: string;        // tokenId (precise outcome key)
  conditionId?: string;  // for resolution lookups
  outcome?: string;      // human label
  slug?: string;         // human label
  side: 'BUY' | 'SELL';
  price: number;
  size: number;
  wallet?: string;
}

interface Position {
  market: string;        // tokenId
  conditionId: string;
  outcome: string;
  slug: string;
  shares: number;
  avgEntry: number;      // slippage-adjusted
  lastPrice: number;
  cost: number;          // virtual USDC deployed
  leaderShares: number;  // cumulative shares the LEADER bought to build this — used to
                         // close proportionally when the leader sells only a fraction.
  openedAt: string;
}

interface ClosedTrade {
  market: string;
  slug: string;
  shares: number;
  entry: number;
  exit: number;
  pnl: number;
  reason: 'sold' | 'resolved' | 'resolved-void';
  closedAt: string;
}

export interface PaperConfig {
  capital: number;
  perTradeUsd: number;          // $ per copy (floored to min order upstream)
  maxTotalExposurePct: number;  // e.g. 0.30
  maxPerMarketPct: number;      // per-market concentration cap, e.g. 0.10
  maxRelativeSlippage: number;  // skip if slippage/price exceeds this, e.g. 0.05
  minEntryPrice: number;        // skip BUY copies below this price, e.g. 0.35
  maxEntryPrice: number;        // skip BUY copies above this price, e.g. 0.97
  allowAveraging: boolean;      // if false, a BUY on a market we already hold is skipped
                                // (caps each market at 1× base — kills the oversized losers)
  stopLossPct: number;          // close a position when mark drops this fraction below
                                // entry (0 = disabled). e.g. 0.5 cuts at -50% vs riding to -100%
  minOrderUsd: number;          // e.g. 5
  slippage: number;             // absolute price haircut, e.g. 0.005
  statePath: string;
  historyPath: string;
}

export class PaperPortfolio {
  cfg: PaperConfig;
  startingCapital: number;
  cash: number;
  positions = new Map<string, Position>();
  closed: ClosedTrade[] = [];
  realizedPnL = 0;
  realizedFromSold = 0;
  realizedFromResolved = 0;
  peakEquity: number;
  maxDrawdown = 0;
  wins = 0;
  losses = 0;
  buysCopied = 0;
  sellsCopied = 0;
  resolvedCount = 0;
  skippedNoCash = 0;
  skippedExposure = 0;
  skippedBadPrice = 0;
  skippedSlippage = 0;
  skippedConcentration = 0;
  skippedPriceBand = 0;
  skippedAveraging = 0;
  stoppedOut = 0;
  startMs: number;

  constructor(cfg: PaperConfig, nowMs: number) {
    this.cfg = cfg;
    this.startingCapital = cfg.capital;
    this.cash = cfg.capital;
    this.peakEquity = cfg.capital;
    this.startMs = nowMs;
    this.load();
  }

  private deployed(): number {
    let sum = 0;
    this.positions.forEach(p => { sum += p.shares * p.lastPrice; });
    return sum;
  }

  /**
   * Deployed capital at COST basis (what we actually paid in). The exposure cap
   * must be enforced on this, NOT on mark-to-market: marking a losing book down
   * would otherwise "free up" room and let the bot over-deploy past the cap.
   */
  private deployedCost(): number {
    let sum = 0;
    this.positions.forEach(p => { sum += p.cost; });
    return sum;
  }

  equity(): number {
    let mtm = 0;
    this.positions.forEach(p => { mtm += p.shares * p.lastPrice; });
    return this.cash + mtm;
  }

  unrealized(): number {
    let u = 0;
    this.positions.forEach(p => { u += p.shares * (p.lastPrice - p.avgEntry); });
    return u;
  }

  /** Open positions the resolver needs to check (tokenId + conditionId). */
  listOpen(): Array<{ tokenId: string; conditionId: string }> {
    const out: Array<{ tokenId: string; conditionId: string }> = [];
    this.positions.forEach(p => out.push({ tokenId: p.market, conditionId: p.conditionId }));
    return out;
  }

  /** Live mark-to-market for an open position (no realization). */
  markPrice(tokenId: string, price: number) {
    const p = this.positions.get(tokenId);
    if (p && price > 0 && price < 1) { p.lastPrice = price; this.updateDrawdown(); }
  }

  /**
   * Stop-loss: if a position's mark has fallen `stopLossPct` below its entry, close
   * it NOW at the mark instead of riding it to a possible $0. Palanca #2 del test —
   * el perdedor promedio (−$6.43) era 2.9× el ganador (+$2.24); cortar la cola de
   * pérdidas grandes ataca esa asimetría. Returns true if it closed the position.
   */
  maybeStopLoss(tokenId: string, markPrice: number): boolean {
    if (!(this.cfg.stopLossPct > 0)) return false;
    const p = this.positions.get(tokenId);
    if (!p || !(markPrice > 0 && markPrice < 1)) return false;
    const drop = (p.avgEntry - markPrice) / p.avgEntry;
    if (drop < this.cfg.stopLossPct) return false;
    const exit = markPrice;
    const proceeds = p.shares * exit;
    const pnl = p.shares * (exit - p.avgEntry);
    this.cash += proceeds;
    this.realizedPnL += pnl;
    this.realizedFromSold += pnl;
    this.losses++;
    this.stoppedOut++;
    this.closed.push({
      market: p.market, slug: p.slug, shares: p.shares,
      entry: p.avgEntry, exit, pnl, reason: 'sold',
      closedAt: new Date().toISOString(),
    });
    this.positions.delete(tokenId);
    this.updateDrawdown();
    return true;
  }

  /** Settle a resolved position. payout = 1 (win) or 0 (loss); void uses last price. */
  settle(tokenId: string, payout: number, reason: 'resolved' | 'resolved-void' = 'resolved') {
    const p = this.positions.get(tokenId);
    if (!p) return;
    const proceeds = p.shares * payout;
    const pnl = p.shares * (payout - p.avgEntry);
    this.cash += proceeds;
    this.realizedPnL += pnl;
    this.realizedFromResolved += pnl;
    this.resolvedCount++;
    if (pnl >= 0) this.wins++; else this.losses++;
    this.closed.push({
      market: p.market, slug: p.slug, shares: p.shares,
      entry: p.avgEntry, exit: payout, pnl, reason,
      closedAt: new Date().toISOString(),
    });
    this.positions.delete(tokenId);
    this.updateDrawdown();
  }

  /** Feed a copy signal from a FOLLOWED wallet. Returns a short action string. */
  onSignal(sig: CopySignal): string {
    const raw = sig.price;
    if (!(raw > 0.001 && raw < 0.999)) { this.skippedBadPrice++; return 'skip:price'; }
    const slip = this.cfg.slippage;

    const existing = this.positions.get(sig.market);
    if (existing) existing.lastPrice = raw;

    if (sig.side === 'BUY') {
      if (this.cash < this.cfg.minOrderUsd) { this.skippedNoCash++; return 'skip:cash'; }
      // Data-driven guard (2-day paper test): longshots bled the most (entry <0.15
      // → 0% win, biggest $ loss) because the fixed slippage is a HUGE fraction of a
      // tiny price (0.5¢ on 0.006 ≈ +83% entry). Skip copies where slippage dominates.
      if (slip / raw > this.cfg.maxRelativeSlippage) { this.skippedSlippage++; return 'skip:slippage'; }
      // Banda de precio de entrada (palanca #1, datos del test de 8h, n=9):
      //   entry < 0.35 → 3/3 perdedoras, todas a $0 (-100% c/u, -$15 total)
      //   entry ∈ [0.36, 0.99] → 6/6 ganadoras (+$21.18)
      // Los longshots reactivos copiados con slippage+latencia tienen skew negativo:
      // pierdes el 100% cuando resuelven NO. Los favoritos resuelven YES más seguido.
      // El techo recorta el "recoger céntimos frente a la apisonadora" (riesgo 100% por 1-3%).
      if (raw < this.cfg.minEntryPrice || raw > this.cfg.maxEntryPrice) {
        this.skippedPriceBand++;
        return 'skip:priceband';
      }
      // No averaging-up (palanca #1 del test de 57h): las posiciones que se ampliaron
      // a 2-3× base fueron −$35 (más que TODA la pérdida realizada −$29.52). Si ya
      // tenemos la posición, ignoramos copias adicionales → cada mercado capeado a 1×.
      if (existing && !this.cfg.allowAveraging) {
        this.skippedAveraging++;
        return 'skip:already-held';
      }
      const entry = Math.min(0.999, raw + slip); // pay UP — conservative
      const alloc = Math.min(Math.max(this.cfg.perTradeUsd, this.cfg.minOrderUsd), this.cash);
      // Per-market concentration cap (single markets reached ~$15 = 3× base size by
      // averaging up; two such positions lost -$15 each). Enforce maxPerMarketPct.
      const existingCost = existing ? existing.cost : 0;
      if (existingCost + alloc > this.startingCapital * this.cfg.maxPerMarketPct) {
        this.skippedConcentration++;
        return 'skip:concentration';
      }
      if (this.deployedCost() + alloc > this.startingCapital * this.cfg.maxTotalExposurePct) {
        this.skippedExposure++;
        return 'skip:exposure';
      }
      const shares = alloc / entry;
      const leaderShares = sig.size > 0 ? sig.size : 0;
      if (existing) {
        const totalShares = existing.shares + shares;
        existing.avgEntry = (existing.cost + alloc) / totalShares;
        existing.shares = totalShares;
        existing.cost += alloc;
        existing.leaderShares += leaderShares;
      } else {
        this.positions.set(sig.market, {
          market: sig.market,
          conditionId: sig.conditionId || '',
          outcome: sig.outcome || '',
          slug: sig.slug || sig.market.slice(0, 12),
          shares, avgEntry: entry, lastPrice: entry, cost: alloc,
          leaderShares,
          openedAt: new Date().toISOString(),
        });
      }
      this.cash -= alloc;
      this.buysCopied++;
      this.updateDrawdown();
      return `buy:$${alloc.toFixed(2)}@${entry.toFixed(3)}`;
    } else {
      if (!existing) return 'skip:nohold';
      const exit = Math.max(0.001, raw - slip); // sell DOWN — conservative
      // Close PROPORTIONALLY to the fraction the leader is exiting. The leader's
      // sell of `sig.size` shares is relative to the `leaderShares` they accumulated
      // to build this position. Selling 100% of our book on a 10% leader trim (the
      // old behaviour) fabricated realized PnL and broke the mirror. If we never
      // tracked leaderShares (legacy state) or the leader dumps ≥ their whole stack,
      // close fully.
      const frac = existing.leaderShares > 0
        ? Math.min(1, sig.size / existing.leaderShares)
        : 1;
      let sharesToSell = existing.shares * frac;
      // Avoid leaving dust: if the remaining book would be < 1 share, close it out.
      if (existing.shares - sharesToSell < 1) sharesToSell = existing.shares;
      const fullClose = sharesToSell >= existing.shares;
      const proceeds = sharesToSell * exit;
      const pnl = sharesToSell * (exit - existing.avgEntry);
      this.cash += proceeds;
      this.realizedPnL += pnl;
      this.realizedFromSold += pnl;
      this.closed.push({
        market: existing.market, slug: existing.slug, shares: sharesToSell,
        entry: existing.avgEntry, exit, pnl, reason: 'sold',
        closedAt: new Date().toISOString(),
      });
      if (fullClose) {
        if (pnl >= 0) this.wins++; else this.losses++;
        this.positions.delete(sig.market);
      } else {
        // Partial exit: shrink the position, keep avgEntry, scale cost + leaderShares.
        const remainFrac = 1 - sharesToSell / existing.shares;
        existing.shares -= sharesToSell;
        existing.cost *= remainFrac;
        existing.leaderShares = Math.max(0, existing.leaderShares - sig.size);
      }
      this.sellsCopied++;
      this.updateDrawdown();
      return `sell:${fullClose ? 'full' : (frac * 100).toFixed(0) + '%'}:pnl=$${pnl.toFixed(2)}`;
    }
  }

  private updateDrawdown() {
    const eq = this.equity();
    if (eq > this.peakEquity) this.peakEquity = eq;
    const dd = this.peakEquity > 0 ? (this.peakEquity - eq) / this.peakEquity : 0;
    if (dd > this.maxDrawdown) this.maxDrawdown = dd;
  }

  snapshot() {
    const eq = this.equity();
    const totalPnl = eq - this.startingCapital;
    const totalTrades = this.wins + this.losses;
    return {
      startingCapital: this.startingCapital,
      equity: eq,
      cash: this.cash,
      openPositions: this.positions.size,
      deployed: this.deployed(),
      utilizationPct: (this.deployed() / this.startingCapital) * 100,
      realizedPnL: this.realizedPnL,
      realizedFromSold: this.realizedFromSold,
      realizedFromResolved: this.realizedFromResolved,
      unrealizedPnL: this.unrealized(),
      totalPnL: totalPnl,
      totalPnLPct: (totalPnl / this.startingCapital) * 100,
      winRate: totalTrades > 0 ? (this.wins / totalTrades) * 100 : 0,
      wins: this.wins,
      losses: this.losses,
      closedTrades: totalTrades,
      resolvedCount: this.resolvedCount,
      buysCopied: this.buysCopied,
      sellsCopied: this.sellsCopied,
      maxDrawdownPct: this.maxDrawdown * 100,
      skipped: {
        noCash: this.skippedNoCash, exposure: this.skippedExposure, badPrice: this.skippedBadPrice,
        slippage: this.skippedSlippage, concentration: this.skippedConcentration,
        priceBand: this.skippedPriceBand, averaging: this.skippedAveraging,
      },
      stoppedOut: this.stoppedOut,
    };
  }

  report(runtimeMin: number): string {
    const s = this.snapshot();
    const L: string[] = [];
    L.push('═'.repeat(70));
    L.push('              📄 PAPER TRADING (copy smart-money) — SIMULATION');
    L.push('═'.repeat(70));
    L.push(`  Runtime:          ${(runtimeMin / 60).toFixed(1)} h`);
    L.push(`  Starting capital: $${s.startingCapital.toFixed(2)}`);
    L.push(`  Equity now:       $${s.equity.toFixed(2)}  (${s.totalPnLPct >= 0 ? '+' : ''}${s.totalPnLPct.toFixed(2)}%)`);
    L.push('─'.repeat(70));
    L.push(`  Realized PnL:     $${s.realizedPnL.toFixed(2)}   (sold $${s.realizedFromSold.toFixed(2)} / resolved $${s.realizedFromResolved.toFixed(2)})`);
    L.push(`  Unrealized PnL:   $${s.unrealizedPnL.toFixed(2)}   (${s.openPositions} open)`);
    L.push(`  Cash:             $${s.cash.toFixed(2)}   Deployed: $${s.deployed.toFixed(2)}  (util ${s.utilizationPct.toFixed(0)}%)`);
    L.push('─'.repeat(70));
    L.push(`  Closed trades:    ${s.closedTrades}  (W:${s.wins} L:${s.losses})  Win rate: ${s.winRate.toFixed(1)}%  | resolved: ${s.resolvedCount}`);
    L.push(`  Copies: BUY ${s.buysCopied} / SELL ${s.sellsCopied}`);
    L.push(`  Max drawdown:     ${s.maxDrawdownPct.toFixed(2)}%`);
    L.push(`  Skipped cash/exposure/price/slippage/concentration/priceBand/averaging: ${s.skipped.noCash}/${s.skipped.exposure}/${s.skipped.badPrice}/${s.skipped.slippage}/${s.skipped.concentration}/${s.skipped.priceBand}/${s.skipped.averaging}`);
    L.push(`  Stop-loss cierres: ${s.stoppedOut}  | averaging ${this.cfg.allowAveraging ? 'ON' : 'OFF'}  | stopLoss ${this.cfg.stopLossPct > 0 ? (this.cfg.stopLossPct * 100).toFixed(0) + '%' : 'OFF'}`);
    L.push(`  Banda de entrada: [${this.cfg.minEntryPrice.toFixed(2)} – ${this.cfg.maxEntryPrice.toFixed(2)}]`);
    L.push(`  Assumptions: slippage ${(this.cfg.slippage * 100).toFixed(2)}¢/share, $${this.cfg.perTradeUsd}/copy, max exposure ${(this.cfg.maxTotalExposurePct * 100).toFixed(0)}%`);
    L.push('═'.repeat(70));
    return L.join('\n');
  }

  save() {
    const posArr: Position[] = [];
    this.positions.forEach(p => posArr.push(p));
    const data = {
      startingCapital: this.startingCapital, cash: this.cash,
      realizedPnL: this.realizedPnL, realizedFromSold: this.realizedFromSold,
      realizedFromResolved: this.realizedFromResolved, resolvedCount: this.resolvedCount,
      peakEquity: this.peakEquity, maxDrawdown: this.maxDrawdown,
      wins: this.wins, losses: this.losses,
      buysCopied: this.buysCopied, sellsCopied: this.sellsCopied,
      skippedNoCash: this.skippedNoCash, skippedExposure: this.skippedExposure, skippedBadPrice: this.skippedBadPrice,
      skippedSlippage: this.skippedSlippage, skippedConcentration: this.skippedConcentration,
      skippedPriceBand: this.skippedPriceBand, skippedAveraging: this.skippedAveraging,
      stoppedOut: this.stoppedOut,
      startMs: this.startMs, positions: posArr, closed: this.closed.slice(-800),
    };
    try { writeFileSync(this.cfg.statePath, JSON.stringify(data, null, 2)); } catch { /* non-fatal */ }
  }

  appendHistory(runtimeMin: number) {
    const s = this.snapshot();
    const row = [
      new Date().toISOString(), runtimeMin.toFixed(0), s.equity.toFixed(2),
      s.realizedPnL.toFixed(2), s.unrealizedPnL.toFixed(2), s.totalPnLPct.toFixed(2),
      s.openPositions, s.closedTrades, s.winRate.toFixed(1), s.maxDrawdownPct.toFixed(2),
    ].join(',');
    try {
      if (!existsSync(this.cfg.historyPath)) {
        writeFileSync(this.cfg.historyPath, 'ts,runtime_min,equity,realized,unrealized,pnl_pct,open,closed,winrate,max_dd\n');
      }
      const prev = readFileSync(this.cfg.historyPath, 'utf8');
      writeFileSync(this.cfg.historyPath, prev + row + '\n');
    } catch { /* non-fatal */ }
  }

  load() {
    try {
      if (!existsSync(this.cfg.statePath)) return;
      const d = JSON.parse(readFileSync(this.cfg.statePath, 'utf8'));
      this.startingCapital = d.startingCapital ?? this.startingCapital;
      this.cash = d.cash ?? this.cash;
      this.realizedPnL = d.realizedPnL ?? 0;
      this.realizedFromSold = d.realizedFromSold ?? 0;
      this.realizedFromResolved = d.realizedFromResolved ?? 0;
      this.resolvedCount = d.resolvedCount ?? 0;
      this.peakEquity = d.peakEquity ?? this.startingCapital;
      this.maxDrawdown = d.maxDrawdown ?? 0;
      this.wins = d.wins ?? 0;
      this.losses = d.losses ?? 0;
      this.buysCopied = d.buysCopied ?? 0;
      this.sellsCopied = d.sellsCopied ?? 0;
      this.skippedNoCash = d.skippedNoCash ?? 0;
      this.skippedExposure = d.skippedExposure ?? 0;
      this.skippedBadPrice = d.skippedBadPrice ?? 0;
      this.skippedSlippage = d.skippedSlippage ?? 0;
      this.skippedConcentration = d.skippedConcentration ?? 0;
      this.skippedPriceBand = d.skippedPriceBand ?? 0;
      this.skippedAveraging = d.skippedAveraging ?? 0;
      this.stoppedOut = d.stoppedOut ?? 0;
      this.startMs = d.startMs ?? this.startMs;
      this.closed = d.closed ?? [];
      this.positions = new Map((d.positions ?? []).map((p: Position) => {
        // Legacy state predates leaderShares — default to our own shares so a later
        // average-up doesn't produce NaN and a leader SELL closes fully (safe).
        if (typeof p.leaderShares !== 'number' || !isFinite(p.leaderShares)) {
          p.leaderShares = p.shares;
        }
        return [p.market, p];
      }));
    } catch { /* start fresh on parse error */ }
  }
}
