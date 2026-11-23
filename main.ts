// Trend-rider BTC bot for make.fun's btc-race-24h-20261123-0511.
//
// Strategy in one paragraph: the bot only buys a confirmed uptrend and then
// lets it run. It enters when the fast EMA (8 one-minute closes) crosses
// above the slow EMA (21) while the price is already above the 50-bar EMA,
// i.e. the short trend turns up inside a longer uptrend. It exits the whole
// position at +400 bps, at -100 bps, or after 720 bars (12 h) — whichever
// comes first — and then waits 60 bars before it may enter again, so one
// whipsaw cannot be re-entered immediately. Every trade is full-size, long
// only, never leveraged, never short, and at most one position is ever open.
//
// Why this shape: on the frozen 24 h dev window a full-size round trip costs
// about 26 bps in fee, slippage and price impact, so a trade has to catch a
// move far larger than that. One-minute EMA crosses whipsaw constantly, so a
// cross alone is not a trade: the price-above-EMA50 filter keeps the bot out
// of downtrends and flat chop, and the wide 4:1 take-profit/stop (400 vs 100
// bps) lets a real leg pay for the losers. Exiting on the cross back was
// tested and rejected — on 1-minute bars the cross flips back within a few
// bars of almost every entry and the round-trip cost eats the bot alive.
// A 120-bar "bars left" guard keeps the bot from entering a trade it cannot
// finish before the window ends and is flattened for nothing, and an entry
// is skipped when the latest close's pool depth implies a fill impact above
// 50 bps (about 7 bps on the dev window).
//
// All decisions use integer basis-point arithmetic on the bars the harness
// sends, plus float64 EMAs seeded as the mean of their first span of closes
// (IEEE 754, so the same bars give the same orders every run). There is no
// randomness, no wall clock, no network and no file access, so two runs on
// the same data answer identically.

import { runBars, type BarsState, type Batch, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
const MAX_SLIPPAGE_BPS = 300; // fills move at most ~28 bps from the latest close here

// Entry and exit, all in basis points.
const FAST_SPAN = 8;
const SLOW_SPAN = 21;
const TREND_SPAN = 50;
const TAKE_PROFIT_BPS = 400; // exit a winner this far above the entry close
const STOP_LOSS_BPS = 100; // cut a loser this far below the entry close
const MAX_HOLD_BARS = 720; // longest a position is held, in bars (12 h)
const COOLDOWN_BARS = 60; // bars to wait after an exit before a new entry
const MIN_BARS_LEFT = 120; // do not enter with fewer bars left in the window

// Do not chase a cross when the price has already run far ahead of the fast
// EMA: at a fresh cross the price sits near it, so a gap above 100 bps means
// the move is already overextended and the entry would buy the top. On the
// dev window no entry ever trips this (it costs nothing there) — it only
// guards the race window, where conditions are unknown.
const MAX_OVEREXTENSION_BPS = 100;

// Both windows of this competition are 1,440 one-minute bars.
const WINDOW_BARS = 1440;

// A full-size buy moves its own fill by about 7 bps at the dev window's
// depth. If the latest close's depth implies far worse impact the pool has
// gone thin and the trade is not worth its cost, so the entry is skipped.
const MAX_ENTRY_IMPACT_BPS = 50n;

/** Return of `now` against `then`, in integer basis points. */
function bpsChange(now: bigint, then: bigint): bigint {
  return ((now - then) * 10000n) / then;
}

/** One EMA: the closes it has seen until it starts, then its value. */
interface Ema {
  span: number;
  warm: number[];
  value: number | null;
}

function emaStep(e: Ema, close: number): void {
  if (e.value !== null) {
    e.value += (2 / (e.span + 1)) * (close - e.value);
    return;
  }
  e.warm.push(close);
  if (e.warm.length === e.span) {
    e.value = e.warm.reduce((a, x) => a + x, 0) / e.span;
  }
}

class Bot {
  private closes: (bigint | null)[] = [];
  private fast: Ema = { span: FAST_SPAN, warm: [], value: null };
  private slow: Ema = { span: SLOW_SPAN, warm: [], value: null };
  private trend: Ema = { span: TREND_SPAN, warm: [], value: null };
  /** fast - slow after the previous bar, once both EMAs are set. */
  private prevGap: number | null = null;
  private entry: { close: bigint; seq: number } | null = null;
  private pendingBuy: { close: bigint; seq: number } | null = null;
  private pendingSellSeq: number | null = null;
  private lastExitSeq = -1000000;

  /** Sequence inside the scored window (warm-up batches do not count). */
  private tradedSeq(state: BarsState): number {
    return state.seq - state.warmupBars;
  }

  onBatch(state: BarsState, batch: Batch): (BuyInput | SellInput)[] {
    let bar: (typeof batch.bars)[number] | undefined;
    for (const candidate of batch.bars) {
      if (candidate.symbol === SYMBOL) {
        bar = candidate;
        break;
      }
    }
    const close = bar === undefined ? null : BigInt(bar.c);
    this.closes.push(close);
    if (close !== null) {
      const c = Number(close);
      emaStep(this.fast, c);
      emaStep(this.slow, c);
      emaStep(this.trend, c);
    }

    const position = state.positions.get(SYMBOL);
    const seq = this.tradedSeq(state);

    // Bookkeeping: turn sent orders into state once the account shows it.
    if (position !== undefined) {
      if (this.pendingBuy !== null) {
        this.entry = this.pendingBuy;
        this.pendingBuy = null;
      }
      if (this.entry === null && close !== null) {
        // Defensive fallback (a position with no remembered buy):
        // measure from the current close with the usual exits.
        this.entry = { close, seq };
      }
    } else {
      if (this.pendingBuy !== null && seq > this.pendingBuy.seq) {
        this.pendingBuy = null; // the buy was rejected; nothing filled
      }
      if (this.pendingSellSeq !== null) {
        this.lastExitSeq = this.pendingSellSeq;
        this.pendingSellSeq = null;
      }
      this.entry = null;
    }

    // The gap for the next bar's cross test is the gap after this bar.
    const gap =
      this.fast.value !== null && this.slow.value !== null
        ? this.fast.value - this.slow.value
        : null;

    if (state.warmingUp || bar === undefined || close === null) {
      this.prevGap = gap;
      return [];
    }

    // Exit: one open position, sold whole when any exit trips.
    if (position !== undefined && this.entry !== null) {
      const change = bpsChange(close, this.entry.close);
      const held = seq - this.entry.seq;
      if (
        change >= BigInt(TAKE_PROFIT_BPS) ||
        change <= BigInt(-STOP_LOSS_BPS) ||
        held >= MAX_HOLD_BARS
      ) {
        this.pendingSellSeq = seq;
        this.prevGap = gap;
        return [{ side: 'sell', symbol: SYMBOL, qty: position.qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
      }
      this.prevGap = gap;
      return [];
    }

    // Entry: flat, cooled down, in an uptrend, with a fresh cross up.
    if (seq - this.lastExitSeq < COOLDOWN_BARS) {
      this.prevGap = gap;
      return [];
    }
    if (this.closes.length < TREND_SPAN + 1 || gap === null || this.prevGap === null) {
      this.prevGap = gap;
      return [];
    }
    if (this.trend.value === null || close <= BigInt(Math.floor(this.trend.value))) {
      this.prevGap = gap;
      return []; // not above the 50-bar EMA: no uptrend, no trade
    }
    if (!(gap > 0 && this.prevGap <= 0)) {
      this.prevGap = gap;
      return []; // no fresh cross of the fast EMA above the slow EMA
    }
    if (bpsChange(close, BigInt(Math.floor(this.fast.value!))) > BigInt(MAX_OVEREXTENSION_BPS)) {
      this.prevGap = gap;
      return []; // price already ran far above the fast EMA: do not chase it
    }
    if (WINDOW_BARS - 1 - seq < MIN_BARS_LEFT) {
      this.prevGap = gap;
      return []; // too late in the window for a trade to pay
    }

    const room = state.weightRoom(SYMBOL);
    const spend = state.cash < room ? state.cash : room;
    const minNotional = BigInt(state.hello.fees.min_notional_quote_units);
    if (spend < minNotional) {
      this.prevGap = gap;
      return [];
    }
    const impact = state.impactBps(SYMBOL, spend);
    if (impact === null || impact > MAX_ENTRY_IMPACT_BPS) {
      this.prevGap = gap;
      return []; // the pool is too thin for a full-size fill
    }
    this.pendingBuy = { close, seq };
    this.prevGap = gap;
    return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: spend, max_slippage_bps: MAX_SLIPPAGE_BPS }];
  }
}

const bot = new Bot();

await runBars({
  onBatch(state, batch) {
    return bot.onBatch(state, batch);
  },
});
