# Master Bitfunded: trade journal and risk cockpit

A private trading cockpit for Bitfunded prop-firm challenges. It runs on your own computer in Docker, watches your Bitfunded rules live, and keeps a trade journal. It records and warns; **it never places trades and has no link to your Bitfunded account.**

This is an unofficial personal tool, not made or endorsed by Bitfunded. Check every rule against Bitfunded's own pages.

## Try it without installing

Download [`Sample-Site.html`](Sample-Site.html) and open it in a browser. It fills itself with made-up accounts and trades and runs on simulated prices, saved only in that browser.

## What it does

- **Protects the account:** daily loss (5%), max total loss, profit target, exposure, leverage, open-position and hold-time limits, tracked live with warnings before a limit is reached. The Bitfunded day resets at 00:00 UTC+8.
- **New trade check:** size from your risk in dollars, and your worst case if every open stop is hit, before you log a trade.
- **Safety loop on the server:** closes positions in the journal at their stop or target, fills limit orders, fires price alerts and RSI signals, with or without a page open.
- **Journal:** every trade with fills, fees, setup, mood, screenshots, your own review, Edit trade, Archive & delete, and Excel or CSV export.
- **Chart:** live crypto prices (Binance or Kraken), timeframes from 1m to 1D, drawing tools.
- **Phone friendly:** summary, chart and trade screens with a bottom menu.
- **Optional:** Telegram alerts and bot commands, and Claude trade reviews (needs your own Anthropic API key, billed separately).

## Install

You need a computer that stays on (an old laptop running Ubuntu works well) with Docker.

```bash
git clone https://github.com/dunhilltrader2022-ire/trade-journal.git bitfunded-cockpit
cd bitfunded-cockpit
cp .env.example .env
```

Set `COCKPIT_PASSWORD` in `.env`, then start it:

```bash
docker compose up -d --build
```

Open `http://<that computer's IP>:8080` and log in with any username and your password. Full steps, backups and safety notes are in [SETUP.md](SETUP.md).

## Your own settings

Nothing personal ships with this copy: no accounts, trades, passwords, API keys or Telegram settings. Telegram is **off** until you add your own bot token and chat ID to `.env` (see "Telegram alerts" in SETUP.md). Keep `.env` to yourself; it's already left out of git.

- Never forward port 8080 on your router. For access away from home, use a private network such as Tailscale.
- Your journal lives in the `cockpit-data` Docker volume. Never run `docker compose down -v`, which deletes it.
