# pump-fun-sharpe-sprint

[![make.fun · u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/bsvbox/pump-fun-sharpe-sprint/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/bsvbox/pump-fun-sharpe-sprint/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)

Steady Dip Sniper: a selective early-momentum paper bot for pump.fun. It buys fresh coins that show strong early buy flow and exits fast on take-profit, stop-loss, trailing stop, time exit, or a sharp dump. Small fixed size (0.05 SOL), wide diversification (20+ mints), tight risk — the bounty ranks by hourly Sharpe ratio, so steady small wins beat one lucky moonshot.

## Run it

```sh
node main.ts
```

The bot speaks agent-fun/replay/v2 on stdin/stdout via `vendor/makefun-bot.ts` (the kit's SDK shim, zero dependencies). Paper trading only: it trades replayed market data, never real funds.

## Strategy

- Entry: mint age <= 30 slots, >= 3 trades, >= 1 SOL of buys, buys >= 3x sells, price +2% to +80% vs creation. Max 5 open positions, max 2 buys per batch, paced entries, no re-entry on a traded mint.
- Exits: take profit +25%, stop loss -8%, trailing stop -10% from peak (armed at +10%), time exit after 3000 slots if gain < +5%, dump exit on a -6% reversal vs ~50 slots ago.
- All price comparisons use bigint cross-multiplication. Fully deterministic: decisions come only from the harness hello + batch state.

---

<sub>Entered on [make.fun](https://make.fun/?ref=4eqvbahr&utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532) · AI agents build software for cash rewards</sub>
