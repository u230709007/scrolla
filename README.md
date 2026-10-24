# AlphaScroll

## Creator UI

The phone includes Home, Discover, Create (+), Trade and Profile navigation.
Discover searches loaded videos and offers pagination. Profile shows your uploads
and bookmarks stored in this browser, with wallet settings available separately.
Signed-in users can publish MP4 files up to 50 MB with captions up to 300 characters.
`POST /api/uploads` validates authentication, origin, size and MP4 signature;
`GET /api/uploads` returns the current account's uploads. Media is stored in
`worker/output/videos/`, and ownership/metadata in `web/data/app.db`.
Uploads join the feed with likes/comments but do not trigger token purchases.
Back up both locations. Hosting requires persistent writable storage.

### Local Ollama scripts

Start Ollama and choose a text model already available in `ollama list`.
Set `OLLAMA_MODEL` to that exact model name in `worker/.env`; optionally set
`OLLAMA_URL` (default: `http://127.0.0.1:11434`). Then run:

```powershell
cd worker
python video_worker.py --format avatar --persona chog
```

Ollama generates the narration, hook and image prompt. MoviePy renders the MP4,
which appears through the existing feed polling. Configured cloud providers and
the template remain fallbacks if Ollama fails. Voice/image services may still use
the internet. The Studio's Local AI panel explains setup; it does not start jobs
or install models. [Ollama chat API](https://github.com/ollama/ollama/blob/main/docs/api.md).

TikTok-style SocialFi & trading dApp for Monad degens, fed by an autonomous AI video pipeline that only uses free tools.

![AlphaScroll: mobile feed, double-tap buy with confetti, comments](docs/screenshot.png)

```
worker/      Python daemon: market data -> AI script -> voice -> image -> .mp4 + SQLite row
web/         Next.js 16 app: feed, SIWE login, likes/comments, double-tap buys
contracts/   AlphaScrollSessionVault.sol: session-key trading on Monad
```

The worker and the web app share only the worker's output folder (`worker/output/`): videos, thumbnails and `alphascroll.db`. The web app reads that database read-only and keeps its own data (likes, comments, trades) in `web/data/app.db`.

## Quick start

```bash
# 1. Render a first video (works offline with fallbacks)
cd worker && pip install -r requirements.txt && python video_worker.py && cd ..

# 2. Start the app
cd web && npm install
cp .env.example .env.local     # then set AUTH_SECRET (npx auth secret)
npm run dev                    # http://localhost:3000
```

Requires Python 3.10+ and Node.js 22.5+ (the app uses the built-in `node:sqlite`).

## Monad testnet with MetaMask

Without a deployed vault, double-tap buys run in demo mode. To make them real trades on Monad testnet:

1. Create a fresh MetaMask account for deploying, and fund it with about 2 MON from the [Monad faucet](https://faucet.monad.xyz).
2. Export its private key (MetaMask → Account details → Show private key) and run:

   ```bash
   cd contracts && npm install
   DEPLOYER_PRIVATE_KEY=0x... npm run setup:testnet
   ```

   On Windows PowerShell: `$env:DEPLOYER_PRIVATE_KEY="0x..."; npm run setup:testnet`.

   This deploys a small test DEX (WMON, a V2-compatible router and six test memecoins with liquidity) and the session vault, writes `contracts/deployments/10143.json`, and sets `NEXT_PUBLIC_CHAIN_ID` and `NEXT_PUBLIC_VAULT_ADDRESS` in `web/.env.local`. If it stops halfway, run it again: it picks up where it left off.
3. Restart `npm run dev` in `web/` and render new reels (`python video_worker.py`). The worker picks up the deployment file and tags each reel with a real testnet token address.
4. Open the app and click **Connect MetaMask**. MetaMask asks to add and switch to Monad Testnet, then to sign the login message. The first double-tap opens One-tap trading; after one confirmation, every double-tap is a real swap on testnet.

Monad charges for the whole gas limit, so a buy costs about 0.015 MON in gas at 100 gwei. The session key gets a 0.1 MON gas stipend (`NEXT_PUBLIC_SESSION_GAS_STIPEND`) and returns what's left when you revoke the session.

Reels rendered before the setup, or for tokens from another network (such as `--source dexscreener` mainnet tokens), stay in demo mode.

## Video worker (`worker/`)

`video_worker.py` builds a vertical 1080x1920 `.mp4` from market data:

| Step | Tool | Fallback if unavailable |
|---|---|---|
| Token data | Monad testnet tokens from `setup:testnet` (default once deployed), mock generator, or DexScreener (`--source dexscreener`) | Mock token |
| Script + image prompt | Groq `openai/gpt-oss-120b` (JSON mode), then OpenRouter `openrouter/free` | Template script |
| Voice-over + word timestamps | Fish Audio S2 (free on OpenRouter) + Groq Whisper timings, or Edge-TTS (no key) | Edge-TTS, then silent track with estimated timings |
| Background | Pollinations.ai (no key) | Procedural neon chart |
| Render | MoviePy 2 + FFmpeg: Ken Burns zoom, ticker badge, word-synced captions | — |
| Index | SQLite `videos` table (for the Next.js feed) | — |

### Video formats

Each run picks a format (`--format random` mixes them using `AVATAR_RATIO`, default 50%):

- **classic**: AI poster background with word-synced captions.
- **avatar**: a talking mascot in TikTok PNGtuber/VTuber style, reacting in front of the AI background. Drawn with Pillow (`avatar.py`), so it needs no GPU or model download. The mouth follows the loudness of the voice-over, the eyes blink, and the body bounces on loud syllables. The script is written in first person in the persona's voice.

| Persona (`--persona`) | Look | Edge-TTS voice |
|---|---|---|
| `froggy` (Froggy Nad) | Green frog, sunglasses | `en-US-GuyNeural` |
| `chog` (Chog Cat) | Purple cat, gold chain | `en-US-AnaNeural` |
| `blob` (Nad Blob) | Pink blob, cap | `en-US-ChristopherNeural` |

To add a persona, add a `Persona(...)` entry to `PERSONAS` in `avatar.py`.

### Setup

```bash
cd worker
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env   # add your free GROQ_API_KEY (console.groq.com) and OPENROUTER_API_KEY (openrouter.ai)
```

FFmpeg ships with MoviePy (`imageio-ffmpeg`), so no system install is needed. No ImageMagick either: MoviePy 2 draws text with Pillow.

### Run

```bash
python video_worker.py                      # one video: testnet token if deployed, else mock
python video_worker.py --source dexscreener # top Monad pair by 24h volume
python video_worker.py --format avatar --persona chog
python video_worker.py --loop               # daemon: one video every 15 min
```

Output:

- `output/videos/*.mp4`: H.264 + AAC, `yuv420p`, `+faststart` (plays instantly in `<video>`)
- `output/thumbs/*.jpg`: poster images
- `output/alphascroll.db`: one row per video (paths, token stats, script, `format`, `persona`)
- `output/work/<id>/`: intermediate files (script, voice, image)

## Web app (`web/`)

Next.js 16 (App Router), React 19, Tailwind CSS v4, Framer Motion, wagmi/viem, NextAuth v5.

- **iPhone mockup** (`max-w-[400px] h-[850px] rounded-[40px]`) on desktop; full screen with no bezel on phones.
- **Feed**: CSS snap scroll. Only the visible video plays, the next one is preloaded, and the others are paused and rewound. Videos are kept mounted only near the viewport. New reels from the worker show up as a "N new reels" pill instead of shifting the video you're watching. Arrow keys scroll, `m` toggles sound.
- **Gestures**: a single tap pauses or plays. A double-tap (mouse or touch) shows a heart burst, likes the video and buys the token.
- **Right rail**: like, comments (bottom sheet), token stats (live DexScreener data, falling back to the render-time snapshot), share.
- **SIWE login**: MetaMask (or another injected wallet) signs a single-use nonce (httpOnly cookie). The server checks the domain, chain and expiry, then verifies the signature: locally for EOAs, over RPC for ERC-1271/6492 smart wallets. You can also browse as a guest.

### API

| Route | |
|---|---|
| `GET /api/feed?cursor=&limit=` | Paginated videos with like/comment/trade counts |
| `GET /api/media/{videos,thumbs}/<file>` | Worker output with HTTP Range (206) support and immutable caching |
| `POST /api/videos/:id/like` | Toggle a like, or set it with `{ "liked": true }` |
| `GET/POST /api/videos/:id/comments` | List or post comments (1–280 chars) |
| `GET /api/videos/:id/stats` | Live token stats, cached 15s |
| `POST /api/trades` | Record a buy. On-chain buys are verified from the receipt's `Bought` event |
| `GET /api/auth/nonce`, `/api/auth/*` | SIWE nonce and NextAuth |

### Double-tap trading

Without `NEXT_PUBLIC_VAULT_ADDRESS`, for mock tokens that have no contract address, or for tokens from another network, buys run in **demo mode**: you still get the confetti, and the trade is recorded as `demo`.

If MetaMask is on another network, or has switched to an account other than the one signed in, a banner offers to switch network or sign in again.

With a deployed vault, the first double-tap opens **One-tap trading**. The user picks a budget, a per-tap amount and an expiry, then confirms **once** in their wallet. That single transaction deposits the MON, authorises a session key generated in the browser, and sends the key a small gas stipend. After that, each double-tap is signed by the session key with no wallet popup: the app gets a quote, applies slippage, calls `vault.buy()` and waits for the receipt. Monad's fast blocks make this feel instant. The session can be revoked, and the remaining balance withdrawn, from the Trade tab.

## Contracts (`contracts/`)

`src/AlphaScrollSessionVault.sol`:

- The owner deposits MON and authorises one session key with an expiry, a per-trade cap and a total budget.
- The session key can **only** call `buy(token, amountIn, minOut, deadline)`. That swaps the owner's deposit on a Uniswap V2-compatible router (`swapExactETHForTokensSupportingFeeOnTransferTokens`) and sends the tokens **straight to the owner**.
- The key cannot withdraw anything. If it leaks, the worst case is bad trades within the remaining budget.

`src/testnet/AlphaTestDex.sol` (testnet only): `TestToken`, `WMON` and `AlphaTestRouter`, a constant-product router (0.3% fee) with the Uniswap V2 functions the vault uses plus a sell path. Only the deployer can add liquidity.

```bash
cd contracts && npm install
npm test        # compiles with bundled solc-js, runs 11 tests on Ganache (incl. a full setup:testnet run)
DEPLOYER_PRIVATE_KEY=0x... npm run setup:testnet                 # test DEX + tokens + vault on Monad testnet
DEPLOYER_PRIVATE_KEY=0x... ROUTER_ADDRESS=0x... npm run deploy   # vault only, on an existing router
```

`setup:testnet` accepts `LIQUIDITY_MON` (MON per pool, default 0.2) and `RPC_URL`. For `deploy`, `ROUTER_ADDRESS` must be a V2-compatible router on the target chain. The deploy script prints the `NEXT_PUBLIC_VAULT_ADDRESS` value to put in `web/.env.local`. After changing the contract, run `npm run abi` to regenerate `web/src/lib/web3/vaultAbi.ts`.

The contracts have tests and an internal review ([contracts/SECURITY.md](contracts/SECURITY.md): manual review plus Slither), but **no professional audit**. Use small budgets.
