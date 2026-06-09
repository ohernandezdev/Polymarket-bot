/**
 * Wallet Qualification — Realized-History Unit Tests
 *
 * These tests pin the survivorship-bias-free qualification contract implemented
 * by {@link WalletService.getRealizedStats}. Qualification MUST score on the
 * REALIZED record (the `closed-positions` endpoint, field `realizedPnl`), never
 * on OPEN-position `cashPnl`, which is unrealized and frequently reverses.
 *
 * Regression coverage:
 *   (C5) A wallet whose OPEN positions look like "winners" but whose CLOSED
 *        record is a string of losers must NOT qualify. Open winners are
 *        invisible to the realized scorer by construction.
 *   (insufficient history) A wallet below `minClosedTrades` is "cannot evaluate",
 *        NOT a fabricated 0% / 0x failure. `insufficientHistory` is true and the
 *        sparse metrics MUST NOT be read as a verdict.
 *   (genuine pass) A wallet with enough CLOSED trades and real realized profit
 *        DOES qualify.
 *
 * The tests mock only DataApiClient.getClosedPositions and import the REAL
 * WalletService.getRealizedStats — they do not reimplement the scoring math.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WalletService, type RealizedStats } from './wallet-service.js';
import type {
  DataApiClient,
  ClosedPosition,
  Position,
  ClosedPositionsParams,
} from '../clients/data-api.js';
import type { SubgraphClient } from '../clients/subgraph.js';
import type { UnifiedCache } from '../core/unified-cache.js';

const WALLET = '0x1111111111111111111111111111111111111111';

// The closed-positions endpoint caps `limit` at 50; fetchAllClosedPositions
// pages with this size. Keep the test's mental model identical to the code's.
const CLOSED_POSITIONS_PAGE_SIZE = 50;

/**
 * Build a deterministic CLOSED/resolved position. Only the fields the realized
 * scorer reads (`realizedPnl`) carry signal; the rest are realistic filler so
 * the object satisfies the real ClosedPosition shape.
 */
function closedPosition(realizedPnl: number, index: number): ClosedPosition {
  const isWin = realizedPnl > 0;
  return {
    proxyWallet: WALLET,
    asset: `asset-${index}`,
    conditionId: `0xcond${index}`,
    avgPrice: isWin ? 0.4 : 0.6,
    totalBought: 100,
    realizedPnl,
    curPrice: isWin ? 1 : 0, // settlement price: resolved YES (1) or NO (0)
    timestamp: 1_700_000_000 + index, // strictly increasing, deterministic
    title: `Resolved market ${index}`,
    outcome: isWin ? 'Yes' : 'No',
    outcomeIndex: isWin ? 0 : 1,
  };
}

/**
 * Build an OPEN position with unrealized cashPnl. These exist ONLY to prove
 * they are NOT consulted by realized qualification. If getRealizedStats ever
 * regressed to reading open positions, scenario (a) would flip to qualify.
 */
function openWinner(cashPnl: number, index: number): Position {
  return {
    proxyWallet: WALLET,
    asset: `open-asset-${index}`,
    conditionId: `0xopen${index}`,
    size: 100,
    avgPrice: 0.3,
    initialValue: 30,
    currentValue: 30 + cashPnl,
    cashPnl, // UNREALIZED — looks like a winner, may reverse before resolving
    percentPnl: (cashPnl / 30) * 100,
    totalBought: 100,
    realizedPnl: 0, // nothing realized yet — position is still open
    curPrice: 0.6,
    redeemable: false,
    title: `Open market ${index}`,
    outcome: 'Yes',
    outcomeIndex: 0,
  } as Position;
}

/**
 * Wire a WalletService whose DataApiClient returns the given CLOSED positions,
 * paginated exactly like the live API (page size 50, DESC by timestamp), and
 * the given OPEN positions for getPositions().
 *
 * Returns the service plus the getClosedPositions spy so tests can assert the
 * pagination contract.
 */
function makeService(opts: {
  closed: ClosedPosition[];
  open?: Position[];
}): {
  service: WalletService;
  getClosedPositions: ReturnType<typeof vi.fn>;
  getPositions: ReturnType<typeof vi.fn>;
} {
  const { closed, open = [] } = opts;

  const getClosedPositions = vi.fn(
    async (
      _address: string,
      params?: ClosedPositionsParams
    ): Promise<ClosedPosition[]> => {
      const limit = params?.limit ?? CLOSED_POSITIONS_PAGE_SIZE;
      const offset = params?.offset ?? 0;
      return closed.slice(offset, offset + limit);
    }
  );

  const getPositions = vi.fn(async (): Promise<Position[]> => open);

  const dataApi = {
    getClosedPositions,
    getPositions,
  } as unknown as DataApiClient;

  // subgraph and cache are never exercised by getRealizedStats. Casting through
  // unknown keeps the test self-contained without standing up real clients; if
  // the method ever started touching them, these undefined stubs would throw
  // loudly rather than silently passing.
  const subgraph = {} as unknown as SubgraphClient;
  const cache = {} as unknown as UnifiedCache;

  const service = new WalletService(dataApi, subgraph, cache);
  return { service, getClosedPositions, getPositions };
}

describe('Wallet qualification — realized history (getRealizedStats)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('(a/C5) does NOT qualify a wallet with 50 CLOSED losers + 5 OPEN winners', async () => {
    // 50 resolved losers: every closed trade lost $10 realized.
    const closed = Array.from({ length: 50 }, (_, i) => closedPosition(-10, i));
    // 5 fat OPEN "winners" — unrealized cashPnl that the BUGGY scorer would
    // have counted. The realized scorer must ignore these entirely.
    const open = Array.from({ length: 5 }, (_, i) => openWinner(500, i));

    const { service, getPositions } = makeService({ closed, open });

    const stats: RealizedStats = await service.getRealizedStats(WALLET, 30);

    // There IS enough closed history to judge (50 >= 30), so this is a real,
    // non-fabricated FAIL — not "insufficient history".
    expect(stats.insufficientHistory).toBe(false);
    expect(stats.closedTrades).toBe(50);

    // The verdict: realized record is all losses.
    expect(stats.winningTrades).toBe(0);
    expect(stats.losingTrades).toBe(50);
    expect(stats.winRate).toBe(0);
    expect(stats.grossProfit).toBe(0);
    expect(stats.grossLoss).toBe(500); // 50 * 10
    expect(stats.realizedPnL).toBe(-500);
    // No wins, only losses => profitFactor is a genuine 0 (not a fake sentinel).
    expect(stats.profitFactor).toBe(0);

    // The C5 guarantee: the 5 OPEN winners did not leak into the realized score.
    // getRealizedStats must not consult open positions at all.
    expect(getPositions).not.toHaveBeenCalled();
  });

  it('(b) does NOT fabricate a verdict below the min-closed-trades threshold', async () => {
    // Only 5 closed trades, all profitable, but min is 30 => cannot evaluate.
    const closed = Array.from({ length: 5 }, (_, i) => closedPosition(25, i));

    const { service } = makeService({ closed });

    const stats = await service.getRealizedStats(WALLET, 30);

    // "Cannot evaluate" — NOT a pass, NOT a fabricated 0% fail.
    expect(stats.insufficientHistory).toBe(true);
    expect(stats.qualified).toBe(false);
    expect(stats.closedTrades).toBe(5);
    expect(stats.minClosedTrades).toBe(30);

    // The sparse metrics describe the tiny sample but MUST NOT be read as a
    // verdict. They are NOT fabricated to 0 — they reflect the real 5 trades.
    expect(stats.winningTrades).toBe(5);
    expect(stats.winRate).toBe(1); // 5/5 — real, but meaningless at this sample
    expect(stats.realizedPnL).toBe(125); // 5 * 25 — not zeroed out

    // Crucially: insufficient history is the reason for not qualifying, and
    // qualified strictly mirrors !insufficientHistory.
    expect(stats.qualified).toBe(!stats.insufficientHistory);
  });

  it('(c) qualifies a genuinely profitable wallet (realized)', async () => {
    // 40 closed trades: 28 wins of +$50, 12 losses of -$20. Real realized edge.
    const wins = Array.from({ length: 28 }, (_, i) => closedPosition(50, i));
    const losses = Array.from({ length: 12 }, (_, i) => closedPosition(-20, 100 + i));
    const closed = [...wins, ...losses];

    const { service } = makeService({ closed });

    const stats = await service.getRealizedStats(WALLET, 30);

    // Enough closed history => evaluable.
    expect(stats.insufficientHistory).toBe(false);
    expect(stats.qualified).toBe(true);
    expect(stats.closedTrades).toBe(40);

    expect(stats.winningTrades).toBe(28);
    expect(stats.losingTrades).toBe(12);
    expect(stats.winRate).toBeCloseTo(28 / 40, 10); // 0.7
    expect(stats.grossProfit).toBe(28 * 50); // 1400
    expect(stats.grossLoss).toBe(12 * 20); // 240
    expect(stats.realizedPnL).toBe(28 * 50 - 12 * 20); // 1160
    expect(stats.profitFactor).toBeCloseTo(1400 / 240, 10); // ~5.83x

    // A consumer applying a realistic bar (winRate >= 0.55, PF >= 1.5) passes.
    expect(stats.winRate).toBeGreaterThanOrEqual(0.55);
    expect(stats.profitFactor).toBeGreaterThanOrEqual(1.5);
  });

  it('honors the 50-per-page closed-positions pagination contract', async () => {
    // 120 closed trades force 3 pages: 50 + 50 + 20.
    const closed = Array.from({ length: 120 }, (_, i) => closedPosition(i % 2 === 0 ? 10 : -5, i));

    const { service, getClosedPositions } = makeService({ closed });

    const stats = await service.getRealizedStats(WALLET, 30);

    expect(stats.closedTrades).toBe(120);

    // Three pages: offsets 0, 50, 100; each request capped at limit 50.
    expect(getClosedPositions).toHaveBeenCalledTimes(3);
    for (const call of getClosedPositions.mock.calls) {
      expect(call[1]?.limit).toBe(CLOSED_POSITIONS_PAGE_SIZE);
    }
    expect(getClosedPositions.mock.calls.map((c) => c[1]?.offset)).toEqual([0, 50, 100]);
  });

  it('reports profitFactor = Infinity for an all-wins realized record (no fake sentinel)', async () => {
    // 35 closed trades, every one a winner: zero gross loss => Infinity, which
    // correctly clears any finite profit-factor bar. The code must NOT clamp to
    // a fabricated value like 999.
    const closed = Array.from({ length: 35 }, (_, i) => closedPosition(15, i));

    const { service } = makeService({ closed });

    const stats = await service.getRealizedStats(WALLET, 30);

    expect(stats.insufficientHistory).toBe(false);
    expect(stats.qualified).toBe(true);
    expect(stats.grossLoss).toBe(0);
    expect(stats.profitFactor).toBe(Infinity);
  });
});
