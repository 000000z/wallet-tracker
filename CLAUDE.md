# CLAUDE.md - Project Context for Claude Code

## What This Is
A Solana wallet tracking toolkit built as a static site on GitHub Pages.
Built by Chillz (AI assistant) for Zinatard (crypto trader on Solana).

## Quick Start
```bash
cd C:\Users\adnanzinabi\.openclaw\workspace
# Read these first:
# - MEMORY.md (full project history + decisions)
# - TOOLS.md (API keys, wallet addresses)
# - USER.md (who you're helping)
```

## Live Site
- **URL**: https://000000z.github.io/wallet-tracker/
- **Repo**: https://github.com/000000z/wallet-tracker (username: 000000z)
- **Deploy**: `cd site && git add -A && git commit -m "msg" && git push`

## Site Structure (`site/` directory)
| File | Purpose |
|------|---------|
| `index.html` | Wallet Explorer - 338 tracked wallets with filter/sort/search |
| `discover.html` | Wallet Discovery - paste address, find all SOL destinations |
| `token-scanner.html` | Token Scanner - find early buyers of any token |
| `overlap.html` | Overlap Detector - find shared token trades across wallets |
| `profile.html` | Wallet Profile - GMGN-style PnL, positions, charts |
| `shared.js` | Shared sidebar, nav, usage trackers, API key management |
| `shared.css` | Shared layout styles (sidebar, topbar, tracker cards) |

## APIs Used
- **Helius Enhanced API**: `https://api-mainnet.helius-rpc.com/v0/addresses/{addr}/transactions?api-key=KEY`
- **Helius RPC**: `https://mainnet.helius-rpc.com/?api-key=KEY`
- **DexScreener**: `https://api.dexscreener.com/latest/dex/tokens/` (token metadata + prices)
- **CoinGecko**: SOL price
- API key: see TOOLS.md (stored in browser localStorage at runtime)

## Key Data Files (workspace root)
- `tracked_wallets.json` — 338 tracked wallets
- `smart_filter_results.json` — 273 classified wallets (v3, 150 txs each)
- `trace_active_results.json` — outgoing transfer traces
- Various `.ps1` scripts for batch processing

## Architecture Decisions
- **Client-side only** — no backend, API calls from browser directly
- **GitHub Pages** — static hosting, no serverless needed
- **localStorage** — API key + usage tracking persisted in browser
- **Embedded data** — explorer has wallet data inlined in HTML
- **Shared layout** — sidebar + topbar injected via shared.js on DOMContentLoaded

## Known Issues / Constraints
- Jupiter price API returns 401 (broken) — use DexScreener/CoinGecko
- Helius Developer tier ($50/mo) — ~100ms delays sufficient
- PowerShell on Windows: use script files, not inline -Command (variables get mangled)
- Stablecoins (USDC, USDT, USD1, PYUSD, USDH, USDS) excluded from PnL calculations

## TODO (priority order)
1. Proactive wallet discovery tools (find interesting wallets without prior knowledge)
2. Cluster detection (auto-find wallets likely same person)
3. Bulk discover + CSV export
4. Custom domain
5. Portfolio monitoring/alerts
