// Steady Dip Sniper v2 — pump.fun Sharpe Sprint (u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
//
// Paper-trading bot for the agent-fun/replay/v2 harness.
//
// What the dev data showed (measured 26 Nov, ~00:30-06:00 WIB):
// - A coin's first trades land in its creation slot and pump the price ~+29%
//   before any buy can fill (2-slot latency), so chasing the pump buys the top
//   and the price then reverts to ~creation. Momentum entries lose.
// - The price of a coin that pumped >= +50% NEVER falls below ~95% of its
//   creation price afterwards: creation is a hard floor. Completing coins all
//   peak at exactly +1370% (real SOL 85 = curve completion).
// - So the edge is the early dip: buy a young coin that pumped >= +50% and
//   fell back to ~creation, then let it re-pump. Wide stop (-15%, below the
//   floor, mostly noise), big take-profit (+50%), short time exit (500 slots).
// - Offline replay of the dev window: +0.06 SOL, 59 trades, win rate ~25%.
//   (v1 momentum bot graded -0.19 SOL on the real harness; every house pilot
//   also grades negative, best -0.50 SOL.)
//
// All price comparisons use bigint cross-multiplication (no floats for
// decisions). Fully deterministic: decisions come only from hello + batch
// state (slots, reserves, fills). No clock, no Math.random, no environment.

import { runBot, LAMPORTS_PER_SOL } from "./vendor/makefun-bot.ts";
import type { Batch, BotState, Done, OrderInput } from "./vendor/makefun-bot.ts";

// ---------------------------------------------------------------- tunables

const BUY_SIZE_LAMPORTS = 50_000_000n; // 0.05 SOL per entry
const MIN_BUY_LAMPORTS = 20_000_000n; // below this the fixed tx fee eats the trade
const MAX_SLIPPAGE_BPS = 500; // 5%
const MAX_BUYS_PER_BATCH = 2;
const BUY_PACING_SLOTS = 250; // spread entries across the window

// Dip entry: young coin, pumped hard, fell back near its creation floor.
const MAX_ENTRY_AGE_SLOTS = 30;
const MIN_ENTRY_TRADES = 8;
const DIP_PEAK_BPS = 10000; // peak price >= +100% vs creation (only the strongest pumps)
const DIP_FRAC_NUM = 80n; // buy once the price fell to <= 80% of its peak
const DIP_FRAC_DEN = 100n;
const DIP_FLOOR_BPS = -500; // ... but never below 95% of creation (the floor)

// Exits (all vs the fill price of the position).
const TAKE_PROFIT_BPS = 10000; // +100%
const STOP_LOSS_BPS = 1500; // -15% (below the creation floor: mostly noise)
const TIME_EXIT_SLOTS = 500; // free stale capital after this long ...
const TIME_EXIT_MAX_GAIN_BPS = 500; // ... if it never gained more than +5%

const PRUNE_AGE_SLOTS = 10_000; // drop stats of old mints never traded

// ---------------------------------------------------------------- bigint price helpers
// A price is a (quote, token) reserve pair: price = quote / token.
// priceGe(cur, base, bps) is true when cur/base >= 1 + bps/10000 (bps may be negative).

function priceGe(
  curQ: bigint,
  curT: bigint,
  baseQ: bigint,
  baseT: bigint,
  bps: number,
): boolean {
  return curQ * baseT * 10_000n >= baseQ * curT * (10_000n + BigInt(bps));
}

function priceLe(
  curQ: bigint,
  curT: bigint,
  baseQ: bigint,
  baseT: bigint,
  bps: number,
): boolean {
  // cur/base <= 1 - bps/10000
  return curQ * baseT * 10_000n <= baseQ * curT * (10_000n - BigInt(bps));
}

// cur/base <= num/den
function priceLeFrac(
  curQ: bigint,
  curT: bigint,
  baseQ: bigint,
  baseT: bigint,
  num: bigint,
  den: bigint,
): boolean {
  return curQ * baseT * den <= baseQ * curT * num;
}

// ---------------------------------------------------------------- per-mint tracking

interface MintStat {
  createdSlot: number;
  createQ: bigint; // virtual quote reserves at creation
  createT: bigint; // virtual token reserves at creation
  peakQ: bigint; // highest price pair seen since creation
  peakT: bigint;
  trades: number;
  lastSlot: number;
}

interface Entry {
  q0: bigint; // SOL spent on the fill (quote_lamports)
  t0: bigint; // tokens received (token_amount)
  entrySlot: number; // slot the buy fill resolved at
}

const stats = new Map<string, MintStat>();
const traded = new Set<string>(); // mints entered once (no re-entry after a fill)
const entries = new Map<string, Entry>();
const buyPending = new Set<string>(); // mints with a buy order awaiting its fill
const sellPending = new Set<string>(); // mints with a sell order awaiting its fill
let lastBuySlot = -1_000_000;
let buysSent = 0;
let sellsSent = 0;
// Diagnostics (stderr only, never part of the action log).
let batchesSeen = 0;
let entryEvals = 0;
let outerPass = 0;
let outerFailPos = 0;
let outerFailPace = 0;
let outerFailCash = 0;
const gateCounts = new Map<string, number>();
function gate(reason: string): void {
  gateCounts.set(reason, (gateCounts.get(reason) ?? 0) + 1);
}

function statFor(mint: string, slot: number): MintStat {
  let s = stats.get(mint);
  if (s === undefined) {
    s = {
      createdSlot: slot,
      createQ: 0n,
      createT: 0n,
      peakQ: 0n,
      peakT: 0n,
      trades: 0,
      lastSlot: slot,
    };
    stats.set(mint, s);
  }
  return s;
}

function notePrice(s: MintStat, q: bigint, t: bigint): void {
  if (q <= 0n || t <= 0n) return;
  if (s.peakQ <= 0n || s.peakT <= 0n || priceGe(q, t, s.peakQ, s.peakT, 0)) {
    s.peakQ = q;
    s.peakT = t;
  }
}

// ---------------------------------------------------------------- the bot

await runBot({
  onHello(state: BotState): void {
    console.error(
      `hello: capital=${state.hello.capital.lamports} maxOpen=${state.hello.caps.max_open_positions} ` +
        `maxOrdersPerBatch=${state.hello.caps.max_orders_per_batch} latency=${state.hello.latency_slots}`,
    );
  },

  onBatch(state: BotState, batch: Batch): OrderInput[] {
    const slot = batch.slot;
    const orders: OrderInput[] = [];
    batchesSeen += 1;

    // 1. Fold this batch's events into per-mint stats (peak tracking included).
    for (const e of batch.events) {
      if (e.event === "CreateEvent") {
        const s = statFor(e.mint, e.slot);
        s.createdSlot = e.slot;
        s.createQ = BigInt(e.virtual_quote_reserves);
        s.createT = BigInt(e.virtual_token_reserves);
        s.lastSlot = e.slot;
        notePrice(s, s.createQ, s.createT);
      } else if (e.event === "TradeEvent") {
        const s = statFor(e.mint, e.slot);
        s.trades += 1;
        s.lastSlot = e.slot;
        notePrice(s, BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves));
      } else {
        // CompleteEvent: the curve is done; drop its stat (harness closes positions).
        stats.delete(e.mint);
        entries.delete(e.mint);
        sellPending.delete(e.mint);
        buyPending.delete(e.mint);
      }
    }
    // Marks carry the latest reserves of held / pending mints: refresh peaks.
    for (const m of batch.marks) {
      const s = stats.get(m.mint);
      if (s !== undefined) {
        notePrice(s, BigInt(m.virtual_quote_reserves), BigInt(m.virtual_token_reserves));
      }
    }

    // 2. Fold fills. A rejected sell must NOT orphan the position: keep its
    // entry so it is re-evaluated next batch. A rejected buy frees the mint
    // for a later retry inside its entry window.
    for (const f of batch.fills) {
      if (f.side === "buy") {
        buyPending.delete(f.mint);
        if (f.status === "filled") {
          const q = BigInt(f.quote_lamports);
          const t = BigInt(f.token_amount);
          if (q > 0n && t > 0n) {
            entries.set(f.mint, { q0: q, t0: t, entrySlot: f.slot });
            traded.add(f.mint);
          }
        } else {
          traded.delete(f.mint);
        }
      } else {
        sellPending.delete(f.mint);
        if (f.status === "filled") entries.delete(f.mint);
      }
    }
    // Sync with the account: a position the harness closed is gone from entries.
    for (const mint of [...entries.keys()]) {
      if (!state.positions.has(mint)) entries.delete(mint);
    }

    // 3. Exits first: check every open position against its exit rules.
    for (const [mint, pos] of state.positions) {
      if (sellPending.has(mint)) continue; // a sell is already on its way
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      const entry = entries.get(mint);
      if (entry === undefined) continue; // fill not seen yet; cannot price it
      const q = curve.virtual_quote_reserves;
      const t = curve.virtual_token_reserves;
      if (q <= 0n || t <= 0n) continue;

      let exit = false;
      if (priceGe(q, t, entry.q0, entry.t0, TAKE_PROFIT_BPS)) exit = true;
      else if (priceLe(q, t, entry.q0, entry.t0, STOP_LOSS_BPS)) exit = true;
      else if (
        slot - entry.entrySlot > TIME_EXIT_SLOTS &&
        !priceGe(q, t, entry.q0, entry.t0, TIME_EXIT_MAX_GAIN_BPS)
      ) {
        exit = true;
      }

      if (exit) {
        orders.push({
          side: "sell",
          mint,
          token_amount: pos.token_amount,
          max_slippage_bps: MAX_SLIPPAGE_BPS,
        });
        sellsSent += 1;
        sellPending.add(mint);
      }
    }

    // 4. Entries: young coins that pumped >= +50% and dipped back near the floor.
    if (state.committedPositionCount() >= state.hello.caps.max_open_positions) {
      outerFailPos += 1;
    } else if (slot - lastBuySlot < BUY_PACING_SLOTS) {
      outerFailPace += 1;
    } else if (state.freeCashLamports() <= BUY_SIZE_LAMPORTS + state.txFeeLamports()) {
      outerFailCash += 1;
    } else {
      outerPass += 1;
    }
    if (
      state.committedPositionCount() < state.hello.caps.max_open_positions &&
      slot - lastBuySlot >= BUY_PACING_SLOTS &&
      state.freeCashLamports() > BUY_SIZE_LAMPORTS + state.txFeeLamports()
    ) {
      let buysThisBatch = 0;
      for (const e of batch.events) {
        if (buysThisBatch >= MAX_BUYS_PER_BATCH) break;
        if (e.event !== "TradeEvent" && e.event !== "CreateEvent") continue;
        const mint = e.mint;
        entryEvals += 1;
        if (traded.has(mint)) { gate("traded"); continue; }
        if (state.positions.has(mint)) { gate("holding"); continue; }
        if (buyPending.has(mint)) { gate("pending"); continue; }
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) { gate("nocurve"); continue; }
        const s = stats.get(mint);
        if (s === undefined) { gate("nostat"); continue; }
        if (s.createQ <= 0n || s.createT <= 0n) { gate("nocreate"); continue; }
        if (slot - s.createdSlot > MAX_ENTRY_AGE_SLOTS) { gate("age"); continue; }
        if (s.trades < MIN_ENTRY_TRADES) { gate("trades"); continue; }
        // The coin must have pumped >= +50% vs creation ...
        if (!priceGe(s.peakQ, s.peakT, s.createQ, s.createT, DIP_PEAK_BPS)) { gate("nopeak"); continue; }
        const q = curve.virtual_quote_reserves;
        const t = curve.virtual_token_reserves;
        if (q <= 0n || t <= 0n) { gate("noreserves"); continue; }
        // ... and fallen back to <= 80% of that peak ...
        if (!priceLeFrac(q, t, s.peakQ, s.peakT, DIP_FRAC_NUM, DIP_FRAC_DEN)) { gate("nodip"); continue; }
        // ... but not below 95% of creation (the floor).
        if (!priceGe(q, t, s.createQ, s.createT, DIP_FLOOR_BPS)) { gate("belowfloor"); continue; }
        // Size: 0.05 SOL, capped at 80% of the per-mint buy cap.
        const cap = state.maxBuyLamports(mint);
        let size = BUY_SIZE_LAMPORTS;
        const capped = (cap * 80n) / 100n;
        if (capped < size) size = capped;
        if (size < MIN_BUY_LAMPORTS) { gate("cap"); continue; }
        if (state.freeCashLamports() < size + state.txFeeLamports()) { gate("cash"); continue; }
        if (state.committedPositionCount() >= state.hello.caps.max_open_positions) { gate("full"); break; }

        orders.push({
          side: "buy",
          mint,
          quote_lamports: size,
          max_slippage_bps: MAX_SLIPPAGE_BPS,
        });
        buysSent += 1;
        buysThisBatch += 1;
        traded.add(mint);
        buyPending.add(mint);
        lastBuySlot = slot;
      }
    }

    // 5. Prune stale stats so the maps stay small over a long window.
    if (batch.seq % 1000 === 0) {
      for (const [mint, s] of stats) {
        if (
          slot - s.lastSlot > PRUNE_AGE_SLOTS &&
          !state.positions.has(mint) &&
          !traded.has(mint)
        ) {
          stats.delete(mint);
        }
      }
    }

    return orders;
  },

  onDone(_state: BotState, _done: Done): void {
    const gates = [...gateCounts.entries()].map(([k, v]) => `${k}=${v}`).join(" ");
    console.error(
      `done: batches=${batchesSeen} evals=${entryEvals} buys sent=${buysSent} sells sent=${sellsSent} mints traded=${traded.size} outer pass=${outerPass} failPos=${outerFailPos} failPace=${outerFailPace} failCash=${outerFailCash} gates: ${gates}`,
    );
  },
});
