# Master Bitfunded · setup and rules

A private trading cockpit for Bitfunded challenges. It runs on a computer you keep switched on, with live crypto prices. Your journal is stored in a Docker volume on that computer, not in the cloud. It is an unofficial personal tool, not made or endorsed by Bitfunded. It records and warns; it never places trades.

## Where everything is

| Item | Value |
|---|---|
| The site | `http://<server IP>:8080` (`http`, and include `:8080`) |
| Login | Any username, plus the `COCKPIT_PASSWORD` you put in `.env` |
| Project folder | `~/bitfunded-cockpit` on the server |
| Settings and secrets | `~/bitfunded-cockpit/.env` (hidden; see it with `ls -a`). Never share this file. |

## Set up from scratch

These steps are for a fresh Ubuntu laptop or PC. On Windows or Mac, install Docker Desktop instead of step 1, edit `.env` in a text editor for step 4, and keep the computer from sleeping.

1. Install Docker and stop the laptop sleeping:

   ```
   sudo apt update && sudo apt install -y unzip curl
   curl -fsSL https://get.docker.com | sudo sh
   sudo usermod -aG docker $USER
   sudo systemctl enable --now docker
   sudo sed -i 's/^#\?HandleLidSwitch=.*/HandleLidSwitch=ignore/; s/^#\?HandleLidSwitchExternalPower=.*/HandleLidSwitchExternalPower=ignore/' /etc/systemd/logind.conf
   sudo systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target
   sudo reboot
   ```

2. Copy this folder to `~/bitfunded-cockpit`.
3. Create your settings file:

   ```
   cd ~/bitfunded-cockpit
   cp .env.example .env
   chmod 600 .env
   ```

4. Set your password. This hides what you type. Use letters, numbers and hyphens only:

   ```
   read -rsp "Password: " p && sed -i "s/^COCKPIT_PASSWORD=.*/COCKPIT_PASSWORD=$p/" .env && unset p && echo && echo saved
   ```

5. Start it. The first build takes a minute or two:

   ```
   docker compose up -d --build
   ```

6. Open `http://<laptop IP>:8080` on a device on the same Wi-Fi. The first time, choose **Load sample test data** to explore, or **Start blank** to begin with your own account. To remove the sample later, use **Test lab**.

If the password is missing, every page is refused, so the site can't end up open by accident.

## Everyday use

Run these on the server, from `~/bitfunded-cockpit`.

| Task | How |
|---|---|
| Stop it | `docker compose stop` |
| Start it again | `docker compose start` |
| Apply a change to `.env` | `docker compose up -d` |
| See what it's doing | `docker compose logs -f` |
| Check it's healthy | `curl -s localhost:8080/api/health` |

The cockpit restarts by itself after a reboot.

**The server does the watching.** Stops, limit fills, price alerts and rule checks run on the server all the time, with or without a page open, so open as many pages as you like. They stop only if the server is off or offline, or if live prices stop, and you get an alert when prices stop.

**The cockpit only knows what you record in it.** It has no link to your Bitfunded account. A stop or take profit here closes the trade in your journal and alerts you, but nothing happens on Bitfunded. Bitfunded is always the source of truth.

**The Room left today tile** shows your max daily loss in dollars and as a %, under the room you have left.

**Sizing by risk:** on the new trade form, set your stop, then type **Risk ($)** and the size is worked out for you. If you type a size instead, the risk updates. Setup, mood, reason and the checklist are folded under **Add setup, mood and checklist**.

**On a phone** the bottom bar has **Dashboard**, **Chart**, **Journal** and **More**. **New trade** is at the bottom of the dashboard.

**Before a trade, the ticket checks the worst case.** It works out your daily and total loss if this trade and every other open position all reach their stops, and pauses the trade if that goes past a limit. A position with no stop can't be counted fully, so the ticket warns you. A **Manual** entry is a fill you already have, so going past a rule only warns you and it can still be logged.

**The server refuses broken records.** A restore file with a broken record changes nothing, and changes sent from other websites are blocked. If a safety check ever hits an error, you get an alert.

## Telegram alerts (free)

Alerts go to your private chat with your own bot, and arrive whether or not a page is open.

1. In Telegram, message **@BotFather**, send `/newbot`, and copy the token it gives you. Treat it like a password.
2. Open your new bot, press **Start**, and send it any message.
3. On the server, save the token. This hides what you paste:

   ```
   read -rsp "Bot token: " t && f=~/bitfunded-cockpit/.env && sed -i '/^TELEGRAM_BOT_TOKEN=/d' "$f" && printf 'TELEGRAM_BOT_TOKEN=%s\n' "$t" >> "$f" && unset t && echo && echo saved
   ```

4. Add your chat ID as `TELEGRAM_CHAT_ID=` in `.env`, then run `docker compose up -d`.
5. On the **Data feed** page, press **Send a test message**.

**What it sends:** rule warnings, trades closing, limit fills, price alerts, and a warning if live prices stop. RSI signals are left out because they're frequent; to include them, add `TELEGRAM_LANES=risk,trade,setup,signal` to `.env`. Each rule level alerts once per Bitfunded day, and final-hour and new-day messages only come when you have positions open.

**Asking the bot (free):** send your bot one of these and it answers from the cockpit's own figures. Telegram also shows them in its **/** menu.

| Send | Answer |
|---|---|
| `/status` | Room left on each account and your open positions with P/L |
| `/positions` | Each open trade: entry, price now, P/L, stop, target and what you'd lose if stopped |
| `/room` | Daily and total room, your profit target and when the day resets |
| `/today` | Today so far: trades closed, P/L, how much of the daily limit you've used, and any warnings |
| `/check BTC long stop 79500 risk 100` | The trade form's rule check from your phone: the size for your risk, your worst case if every stop is hit, and whether a rule would pause it. Add a price for a limit entry, `size 2` instead of risk, `tp 81000`, `lev 10`, or `on 15K` to pick an account. Nothing is logged. |
| `/alert BTC 82000 breakout` | Sets a price alert, the same as on the site. `/alert` on its own lists them. Remove alerts on the site. |
| `/quiet 1h` | Pauses price alerts and RSI signals for that long (30m, 2h and so on, up to 24h). Rule warnings, closed trades, the daily summary and price-feed problems still come through. `/quiet off` undoes it. |
| `/alerts` | The last 5 alerts |
| `/help` | This list |

**Daily summary:** a few minutes after each Bitfunded reset (00:10 UTC+8), the bot sends one message for the day that ended: trades closed, P/L, how much of the daily limit you used, any warnings, and where each account stands now. To switch it off, add `TELEGRAM_DAILY=off` to `.env`.

A few plain words work too, like "what's my position status" or "how much room is left". The bot only answers your own chat. Apart from setting a price alert and pausing alerts, it only reads: it can't place, close or change a trade. It works away from home without Tailscale, because the laptop fetches your messages from Telegram. If the laptop is off, it can't answer. To switch the commands off, add `TELEGRAM_COMMANDS=off` to `.env` and run `docker compose up -d`.

If the connection drops, messages wait and send when it's back. If the server itself is off, it can't tell you. If your token ever leaks, send `/revoke` to @BotFather and save the new one.

## Accounts and challenges

Add and edit accounts on the **Challenges** page.

- **Programs:** `2-Step` (leverage up to 1:5) and `2-Step 20x` (leverage up to 1:20). Leave **Max leverage** blank to use the program's default.
- **Sizes:** 5K, 10K, 15K, 25K, 50K, 100K and 200K.
- **Already trading?** Copy **Balance now** from your Bitfunded dashboard. Always set the true size and let the balance cover any profit or loss. If you pick a smaller size, every limit is worked out wrongly.
- **One active challenge per level:** a level is size plus program, so a 15K `2-Step` and a 15K `2-Step 20x` can run side by side. Check with Bitfunded that holding both is allowed.

## Keeping the journal matched to Bitfunded

Prices here come from Binance, so they can differ slightly from Bitfunded's. Use Bitfunded's figures for anything you want exact.

- **Closing a position:** press **Close** under **Open positions**, or **Close position** on the trade's own page, enter your Bitfunded exit price and, if you have it, the total fees, then confirm. The price box starts at the current feed price. Stops and targets the server closes record the stop or target price, so edit those afterwards if your real fill differed.
- **Editing a trade:** open it from the **Journal** and press **Edit trade**. You can change the account, pair, side, entry price, size, leverage, stop loss, take profit, opened and closed times, exit price, how it closed, total fees, setup, idea source, mood and reason. P/L, balance and limits update when you save, and the trade is marked **Edited**. If the position is still open, enter an exit price to close it when you save, with the real closed time if you have it. Leave the exit price blank to keep it open.
- **Removing a wrong entry:** use the **Archive & delete** menu on the trade's row in the **Journal**, or on the trade's own page, and confirm.
  - **Archive** hides the trade. It stops counting toward your limits, stats, exports and Telegram replies, and if it was open, the cockpit stops watching its stop and target. To find it again, set the journal's status menu to **Archived**, then press **Restore** to put it back as it was, screenshots included.
  - **Delete for good** removes the trade and its screenshots and can't be undone, except by restoring a whole backup from before. If you're not sure, archive it instead.
  - Archiving or deleting changes your room and limits in the cockpit only. Nothing changes on Bitfunded.
- **Fees:** the cockpit estimates 0.04% per side, and open P/L already includes the opening fee. To reflect the true cost, including funding, enter Bitfunded's figure as **Total fees and costs**. It replaces the estimate. You can also enter it when you log a **Manual** trade or close a position.

## Stop loss and take profit

The trade ticket, the **SL/TP** form and **Edit trade** all have a **Value / %** switch.

- **Value:** type the price.
- **%:** type the distance from your entry as a positive number. On a long, a 2% stop is 2% below entry and a 2% target is 2% above; a short is the other way round.

Under each box you'll see the other form of the figure and the profit or loss in dollars if it's hit. The cockpit saves the price, so a % level doesn't move afterwards. It refuses a stop or target on the wrong side of your entry, or one already past the current price on an open trade, because the trade would close straight away.

## The chart

- **Timeframes:** 1m, 5m, 15m, 1h, 4h and 1D. Each device remembers its last choice. Crypto history comes from the exchange. Gold, silver, TSLA and other pairs without exchange candles have a short history.
- **SL, TP and entry:** these show as lines for open positions on the selected account and pair, and the chart zooms out to keep them on screen. Press **Chart** on an open position to jump to its pair.
- **Drawing tools:** **Level** (horizontal line), **Trend**, **Box** and **Fib** (retracement). Press a tool, then click the chart: once for Level, twice for the others. Press the tool again or `Esc` to cancel.
- **Changing a drawing:** click it to select it, then drag it or its round handles. Use **Delete drawing** or the `Delete` key to remove it. **Clear drawings** removes every drawing on that pair.

Drawings are saved on the server for each pair and appear on all your devices and timeframes. They're only markings: they don't send alerts or affect trades. For an alert, use **Price alert**.

## Exporting the journal

On the **Journal** page, press **Export Excel** or **Export CSV**. The file contains the trades matching the filters you've set: type, account and status. Times in the Excel file are UTC.

## Trade screenshots

Open any trade from the **Journal** and go to **Screenshots**. Each trade has a **Before the trade** and an **After the trade** side.

- **Add one:** press **Add screenshot**. On a phone this offers your photos or camera.
- **Paste one (computer):** copy a screenshot, open the trade and press `Ctrl+V`. It goes to Before while the trade is open and After once it's closed.
- **View full size:** click the image.
- **Limits:** PNG, JPEG or WebP, up to 10 MB each, and 6 per side.

## Bitfunded rules the cockpit tracks

These are the 2-Step rules from Bitfunded's Help Center (https://bitfunded.gitbook.io/support), last read in November 2026. If Bitfunded and the cockpit disagree, trust Bitfunded.

| Rule | Stage 1 | Stage 2 | Funded |
|---|---|---|---|
| Daily loss | 5% | 5% | 5% |
| Max total loss | 10% | 8% | 8% |
| Profit target | 8% | 5% | None |

| Rule | Limit |
|---|---|
| Daily loss includes | Realised losses today plus floating losses on open positions |
| Day reset | 00:00 UTC+8 (16:00 London in winter, 17:00 in summer); settles by 00:10 |
| Open positions | 5 at most |
| Margin exposure | Below 65% of available margin |
| Leverage | 1:5 (`2-Step 20x`: 1:20) |
| Longest hold, major crypto | 10 days: BTC, ETH, BNB, XRP, SOL, TRX, HYPE, ZEC, DOGE, ADA |
| Longest hold, other crypto | 7 days |
| Longest hold, XAU, XAG, TSLA | 5 days |
| Payout | At least 2 closed trades per stage, each open 10+ minutes |
| Stop loss and take profit | Expected on trades |
| Banned | Hedging, including across accounts, and coordinated trading across accounts |

**The 20x offer:** Bitfunded's public pages didn't list it when this was written and still said 1x to 5x. The `2-Step 20x` program here applies the 2-Step rules with leverage up to 1:20. That is an assumption, so get the terms from Bitfunded in writing before relying on it.

**The cockpit is deliberately cautious:** wins today don't offset realised losses in its daily loss figure.

## Your data and backups

- Everything lives in the Docker volume `bitfunded-cockpit_cockpit-data`.
- **Nightly:** a backup file is written inside the volume, and the last 14 are kept.
- **Test lab → Environment** has:
  - **Download full backup:** one JSON file with everything. Keep copies on another device too, because the others are all on the server.
  - **Download trades (CSV):** for spreadsheets.
  - **Restore from a backup file:** replaces everything. A safety copy of the current data is saved first.

**Screenshots aren't in these backups.** The nightly files and **Download full backup** only hold your data, not images. To copy the images out, run this on the server, then copy that folder to another device:

```
mkdir -p ~/cockpit-backups && docker cp bitfunded-cockpit:/data/shots ~/cockpit-backups/shots-$(date +%Y%m%d)
```

**Never run `docker compose down -v`, and never delete that volume.** Either one erases your journal, your screenshots and the nightly backups inside it.

## Access and safety

- **On your Wi-Fi:** use the site address at the top of this guide. Your browser may say "Not secure", because the connection isn't encrypted. Only use it on a network you trust.
- **Away from home:** use a private network such as Tailscale (free for personal use), installed on the server and your phone, then open `http://<server Tailscale IP>:8080`. Never forward this port on your router.
- **If the site stops loading:** the server's IP may have changed; check it with `ip -4 addr` on the server. Reserving its address in your router's settings prevents this.
- **Change the password:** run the command from step 4 in the project folder, then `docker compose up -d`.

## Live prices

Open **Data feed** in the top menu.

- **Status** should say **Connected**, and **Last price** should be under a few seconds.
- Gold, silver, TSLA and coins the exchange doesn't list stay **Simulated**, and are labelled that way. The cockpit won't close positions, fill limit orders or fire price alerts on these made-up prices. It tells you once, and you close the position yourself when Bitfunded does. Their P/L, and so the limits that include it, is only approximate.
- If it stays on **Reconnecting**, switch the source to **Kraken**. If neither connects, check the server's internet connection.
- When live prices stop for more than 30 seconds, the Dashboard shows a red **Prices** warning.

## Claude (optional, off by default)

Trade reviews, the coach and journal chat need an Anthropic API key. **It's billed per use and isn't covered by Claude Pro.** Everything else works without one.

To turn them on, create a key at https://platform.claude.com, add it after `ANTHROPIC_API_KEY=` in `.env`, then run `docker compose up -d`. Requests stop at `AI_MONTHLY_CAP_USD` (default $10). A Sonnet review costs about $0.03 and an Opus review about $0.12.

## For Claude Code (development)

See `CLAUDE.md`. `dev/` holds the page source, the rules engine and the tests.
