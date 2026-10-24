#!/usr/bin/env python3
"""
AlphaScroll — Zero-Cost Autonomous Video Worker
================================================

Two formats (picked per run, see --format / AVATAR_RATIO):
  classic : AI poster background + captions
  avatar  : a talking mascot (PNGtuber style, lip-synced to the voice) reacting
            in front of the AI background — see avatar.py

Pipeline (every run):
  1. Token data   -> by default a mix of live Monad mainnet memecoins
                     (DexScreener, display only) and setup:testnet tokens
                     (double-tap buys on testnet); or mock tokens
  2. Script       -> Groq (openai/gpt-oss-120b), strict JSON output
  3. Voice-over   -> Edge-TTS (free, keyless) + per-word timestamps
  4. Background   -> Pollinations.ai (free, keyless) 1080x1920 image
  5. Render       -> MoviePy: Ken Burns zoom + ticker badge + word-synced
                     TikTok captions -> H.264/AAC .mp4 (faststart for web)
  6. Index        -> SQLite row so the Next.js feed can list videos

Every external step has an offline fallback, so the worker never crashes the
daemon loop: no Groq key -> template script, Pollinations down -> procedural
neon background, Edge-TTS down -> silent track with estimated word timings.

Usage:
  python video_worker.py                     # one video (mainnet/testnet mix if deployed, else mainnet)
  python video_worker.py --source dexscreener
  python video_worker.py --format avatar --persona froggy
  python video_worker.py --loop              # daemon, every INTERVAL_MINUTES
"""

from __future__ import annotations

import argparse
import asyncio
import collections
import difflib
import json
import logging
import math
import os
import random
import re
import sqlite3
import time
import uuid
import wave
from dataclasses import asdict, dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import quote

import numpy as np
import requests
from PIL import Image, ImageDraw, ImageFilter

try:
    from dotenv import load_dotenv

    load_dotenv(Path(__file__).with_name(".env"))
except ImportError:
    pass

from avatar import PERSONAS, AvatarAnimator, Persona, envelope_from_words, loudness_envelope, pick_persona
from moviepy import (
    AudioFileClip,
    CompositeVideoClip,
    ImageClip,
    TextClip,
    VideoClip,
    vfx,
)
import cloud
import local_gen
from styles import SR, STYLES, FrameFX, Style, grade, make_music, mix_tracks, pick_style, random_hook

# --------------------------------------------------------------------------- #
# Config
# --------------------------------------------------------------------------- #

W, H = 1080, 1920
FPS = int(os.getenv("VIDEO_FPS", "24"))  # per-frame Python effects dominate render time; 24 is ~20% faster than 30
BASE_DIR = Path(__file__).resolve().parent

GROQ_API_KEY = os.getenv("GROQ_API_KEY", "").strip()
OLLAMA_MODEL = os.getenv("OLLAMA_MODEL", "").strip()
OLLAMA_URL = os.getenv("OLLAMA_URL", "http://127.0.0.1:11434").rstrip("/")
GROQ_MODEL = os.getenv("GROQ_MODEL", "openai/gpt-oss-120b")
OPENROUTER_API_KEY = os.getenv("OPENROUTER_API_KEY", "").strip()
OPENROUTER_URL = "https://openrouter.ai/api/v1"
# Free models only: no credits needed, ~50 requests/day on a free account.
# openrouter/free routes to whichever free model is up (single free models often 404/429).
OPENROUTER_MODEL = os.getenv("OPENROUTER_MODEL", "openrouter/free")
FISH_MODEL = os.getenv("FISH_MODEL", "fish-audio/s2.1-pro-free:free")
FISH_VOICE = os.getenv("FISH_VOICE", "").strip()  # empty = provider default voice
TTS_ENGINE = os.getenv("TTS_ENGINE", "fish")  # fish (needs OpenRouter + Groq keys) or edge
TTS_VOICE = os.getenv("TTS_VOICE", "en-US-ChristopherNeural")
TTS_RATE = os.getenv("TTS_RATE", "+12%")
OUTPUT_DIR = BASE_DIR / os.getenv("OUTPUT_DIR", "output")
DB_PATH = BASE_DIR / os.getenv("DB_PATH", "output/alphascroll.db")
INTERVAL_MINUTES = float(os.getenv("INTERVAL_MINUTES", "2"))
AVATAR_RATIO = float(os.getenv("AVATAR_RATIO", "0.5"))  # share of avatar videos in random mode
MAINNET_RATIO = float(os.getenv("MAINNET_RATIO", "0.5"))  # share of mainnet reels in --source mixed
# auto: SDXL-Lightning on the local GPU when CUDA is available, else Pollinations
IMAGE_ENGINE = os.getenv("IMAGE_ENGINE", "auto")  # auto | local | pollinations
# Share of videos whose background is animated with LTX-Video (slow: minutes per clip)
MOTION_RATIO = float(os.getenv("MOTION_RATIO", "0"))
# Written by `npm run setup:testnet` in contracts/: test tokens with liquidity on Monad testnet
DEPLOYMENT_FILE = BASE_DIR / os.getenv("DEPLOYMENT_FILE", "../contracts/deployments/10143.json")
# The web app's database: its trades table steers which tokens get videos next
APP_DB_PATH = BASE_DIR / os.getenv("APP_DB_PATH", "../web/data/app.db")
LIVE_MINUTES = float(os.getenv("LIVE_MINUTES", "60"))  # what counts as a recent trade


def _csv_env(name: str, default: str) -> list[str]:
    return [s.strip() for s in os.getenv(name, default).split(",") if s.strip()]


# --source dexscreener (free public API, no key)
DEX_CHAIN = os.getenv("DEX_CHAIN", "monad")
# DexScreener has no "list a chain" endpoint; these searches surface ~40 Monad memecoins
DEX_QUERIES = _csv_env("DEX_QUERIES", "nad,nad-fun,WMON monad,monad nad,chog")
DEX_PICK = os.getenv("DEX_PICK", "live")  # live | trending | volume | gainers | new
DEX_MIN_LIQUIDITY = float(os.getenv("DEX_MIN_LIQUIDITY", "5000"))
DEX_MIN_VOLUME = float(os.getenv("DEX_MIN_VOLUME", "500"))
DEX_MAX_AGE_HOURS = float(os.getenv("DEX_MAX_AGE_HOURS", "0"))  # 0 = any age
DEX_COOLDOWN_HOURS = float(os.getenv("DEX_COOLDOWN_HOURS", "6"))  # don't repeat a token sooner
DEX_TOP_N = max(1, int(os.getenv("DEX_TOP_N", "5")))
DEX_EXCLUDE = {s.upper() for s in _csv_env(
    "DEX_EXCLUDE", "MON,WMON,SHMON,GMON,APRMON,SMON,USDC,USDT,USDT0,AUSD,USDE,DAI,WETH,ETH,WSTETH,WBTC,CBBTC,LBTC,BTC,SOL,WSOL")}

# Farcaster buzz via Neynar cast search (free key: https://dev.neynar.com). Empty = skipped.
NEYNAR_API_KEY = os.getenv("NEYNAR_API_KEY", "").strip()
FARCASTER_HOURS = float(os.getenv("FARCASTER_HOURS", "24"))  # look-back window for casts
FARCASTER_WEIGHT = float(os.getenv("FARCASTER_WEIGHT", "1"))  # buzz weight in the trending rank

# Individual on-chain trades via GeckoTerminal (free, no key)
GT_API = "https://api.geckoterminal.com/api/v2"
GT_NETWORK = {"ethereum": "eth", "polygon": "polygon_pos", "avalanche": "avax"}  # DexScreener id -> GeckoTerminal id
TRADES_WINDOW_MIN = float(os.getenv("TRADES_WINDOW_MIN", "15"))

FONT_CANDIDATES = [
    os.getenv("FONT_PATH", ""),
    str(BASE_DIR / "fonts" / "Anton-Regular.ttf"),
    "/usr/share/fonts/opentype/inter/Inter-ExtraBold.otf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
    "/System/Library/Fonts/Supplemental/Arial Black.ttf",
    "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
    "C:/Windows/Fonts/ariblk.ttf",
    "C:/Windows/Fonts/arialbd.ttf",
]

log = logging.getLogger("alphascroll")


def resolve_font() -> str:
    for path in FONT_CANDIDATES:
        if path and Path(path).is_file():
            return path
    raise FileNotFoundError(
        "No bold font found. Set FONT_PATH in .env to any .ttf/.otf file "
        "(e.g. download Anton-Regular.ttf from Google Fonts into worker/fonts/)."
    )


# --------------------------------------------------------------------------- #
# 1. Token data
# --------------------------------------------------------------------------- #


@dataclass
class TokenData:
    symbol: str
    name: str
    chain: str
    price_usd: float
    change_24h: float
    volume_24h: float
    liquidity_usd: float
    market_cap: float
    pair_address: str
    dex_url: str = ""
    token_address: str = ""  # ERC-20 address; empty for mock tokens (demo trades only)
    socials: dict = field(default_factory=dict)  # DexScreener links: twitter, telegram, website...
    farcaster: dict = field(default_factory=dict)  # cashtag buzz from farcaster_buzz()
    trades: dict = field(default_factory=dict)  # last-minutes on-chain trades from recent_trades()


MOCK_TOKENS = [
    ("MOLANDAK", "Molandak"),
    ("CHOG", "Chog"),
    ("MOYAKI", "Moyaki"),
    ("PURPLE", "Purple Frog"),
    ("GMONAD", "Gmonad"),
    ("NADS", "Nad Army"),
]


MOCK_CHANGES = {"hype": (10, 900), "steady": (1, 10), "arabesk": (-80, -1)}


def mock_change(style_key: str | None = None) -> float:
    """Pumps, slow climbs and crashes, so every video style shows up."""
    if style_key in MOCK_CHANGES:
        lo, hi = MOCK_CHANGES[style_key]
    else:
        lo, hi = random.choices(list(MOCK_CHANGES.values()), weights=[45, 15, 40])[0]
    return round(random.uniform(lo, hi), 1)


def fetch_mock_token() -> TokenData:
    symbol, name = random.choice(MOCK_TOKENS)
    price = round(random.uniform(0.00001, 0.05), 6)
    mcap = random.uniform(400_000, 25_000_000)
    return TokenData(
        symbol=symbol,
        name=name,
        chain="monad",
        price_usd=price,
        change_24h=mock_change(),
        volume_24h=round(mcap * random.uniform(0.4, 3.0)),
        liquidity_usd=round(mcap * random.uniform(0.05, 0.2)),
        market_cap=round(mcap),
        pair_address="0x" + uuid.uuid4().hex + uuid.uuid4().hex[:8],
    )


def load_testnet_deployment() -> dict:
    try:
        data = json.loads(DEPLOYMENT_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    data["tokens"] = [t for t in data.get("tokens", []) if t.get("seeded") and t.get("address")]
    return data


def recent_app_trades(minutes: float | None = None) -> dict[str, int]:
    """AlphaScroll double-tap buys per token address (lowercase) in the last
    `minutes`, read from the web app's database. Empty if the app never ran."""
    since = datetime.now(timezone.utc) - timedelta(minutes=minutes or LIVE_MINUTES)
    if cloud.TURSO_ENABLED:  # the deployed site writes its trades to Turso
        try:
            [rows] = cloud.turso((
                "SELECT lower(token_address), COUNT(*) FROM trades "
                "WHERE token_address IS NOT NULL AND created_at >= ? GROUP BY 1",
                (since.isoformat(timespec="milliseconds").replace("+00:00", "Z"),),
            ))
            return dict(rows)
        except Exception as exc:
            log.warning("Couldn't read AlphaScroll trades from Turso: %s", exc)
            return {}
    if not APP_DB_PATH.is_file():
        return {}
    try:
        with sqlite3.connect(f"file:{quote(APP_DB_PATH.as_posix(), safe='/:')}?mode=ro", uri=True) as db:
            rows = db.execute(
                "SELECT lower(token_address), COUNT(*) FROM trades "
                "WHERE token_address IS NOT NULL AND created_at >= ? GROUP BY 1",
                (since.isoformat(timespec="milliseconds").replace("+00:00", "Z"),),
            )
            return dict(rows)
    except sqlite3.Error as exc:
        log.warning("Couldn't read AlphaScroll trades from %s: %s", APP_DB_PATH, exc)
        return {}


def fetch_testnet_token() -> TokenData:
    """A token deployed by setup:testnet, so double-tap buys hit a real pool.
    Market stats stay synthetic: testnet pools have no 24h history."""
    deployment = load_testnet_deployment()
    if not deployment.get("tokens"):
        raise RuntimeError(f"no seeded tokens in {DEPLOYMENT_FILE}")
    # Tokens people are buying in AlphaScroll right now get a fresh video first
    trades = recent_app_trades()
    weights = [1 + 5 * trades.get(t["address"].lower(), 0) for t in deployment["tokens"]]
    picked = random.choices(deployment["tokens"], weights=weights)[0]
    if trades:
        log.info("      AlphaScroll buys (last %.0f min): %s", LIVE_MINUTES,
                 ", ".join(f"{t['symbol']} {trades.get(t['address'].lower(), 0)}" for t in deployment["tokens"]))
    token = fetch_mock_token()
    token.symbol, token.name = picked["symbol"], picked["name"]
    token.chain = "monad-testnet"
    token.token_address = picked["address"]
    token.pair_address = deployment.get("router", token.pair_address)
    return token


DEX_API = "https://api.dexscreener.com"


def _num(obj: dict | None, key: str) -> float:
    try:
        return float((obj or {}).get(key) or 0)
    except (TypeError, ValueError):
        return 0.0


def _dex_get(path: str, **params) -> list | dict:
    resp = requests.get(f"{DEX_API}{path}", params=params or None, timeout=20)
    resp.raise_for_status()
    return resp.json()


def dex_candidate_pairs(chain: str) -> list[dict]:
    """Pairs on `chain` from every free DexScreener feed: keyword searches
    (the only way to reach Monad pairs) plus boosted and freshly profiled
    tokens (mostly Solana/Base, but picked up whenever DEX_CHAIN matches)."""
    pairs: list[dict] = []
    for q in DEX_QUERIES:
        try:
            pairs += _dex_get("/latest/dex/search", q=q).get("pairs") or []
        except Exception as exc:
            log.warning("DexScreener search %r failed: %s", q, exc)

    promoted: dict[str, int] = {}  # token address -> boost amount (0 = profile only)
    for path in ("/token-boosts/top/v1", "/token-boosts/latest/v1", "/token-profiles/latest/v1"):
        try:
            for item in _dex_get(path):
                if item.get("chainId") == chain and item.get("tokenAddress"):
                    addr = item["tokenAddress"]
                    promoted[addr] = max(promoted.get(addr, 0), int(item.get("totalAmount") or 0))
        except Exception as exc:
            log.warning("DexScreener %s failed: %s", path, exc)
    addrs = list(promoted)
    for i in range(0, len(addrs), 30):  # /tokens/v1 takes up to 30 comma-separated addresses
        try:
            pairs += _dex_get(f"/tokens/v1/{chain}/{','.join(addrs[i:i + 30])}")
        except Exception as exc:
            log.warning("DexScreener token lookup failed: %s", exc)
    return [p for p in pairs if p.get("chainId") == chain]


def _txn_count(pair: dict, window: str) -> float:
    t = (pair.get("txns") or {}).get(window) or {}
    return _num(t, "buys") + _num(t, "sells")


def dex_score(pair: dict, mode: str, app_trades: dict[str, int] | None = None) -> float:
    vol = pair.get("volume") or {}
    change = pair.get("priceChange") or {}
    if mode == "live":
        # what is trading right now: last 5 minutes dominate, the hour breaks ties,
        # and buys made inside AlphaScroll count the most
        mine = (app_trades or {}).get(((pair.get("baseToken") or {}).get("address") or "").lower(), 0)
        return 3 * math.log1p(_txn_count(pair, "m5")) + math.log1p(_txn_count(pair, "h1")) + 4 * math.log1p(mine)
    if mode == "volume":
        return _num(vol, "h24")
    if mode == "gainers":
        return _num(change, "h24")
    if mode == "new":
        return float(pair.get("pairCreatedAt") or 0)
    # trending: real activity (volume + trade count) nudged by short-term momentum,
    # buy pressure and paid boosts, so a dead pair with one big trade doesn't win
    txns = (pair.get("txns") or {}).get("h24") or {}
    buys, sells = _num(txns, "buys"), _num(txns, "sells")
    buy_ratio = buys / (buys + sells) if buys + sells else 0.5
    momentum = max(-50.0, min(200.0, _num(change, "h6"))) / 50
    boosted = 1.0 if _num(pair.get("boosts"), "active") else 0.0
    return math.log1p(_num(vol, "h24")) + math.log1p(buys + sells) + momentum + (buy_ratio - 0.5) * 2 + boosted


def farcaster_buzz(symbol: str) -> dict:
    """Casts from the last FARCASTER_HOURS that cashtag $SYMBOL, via Neynar.
    Only exact cashtags count, so short tickers like BOB don't match chatter."""
    if not NEYNAR_API_KEY:
        return {}
    since = datetime.now(timezone.utc) - timedelta(hours=FARCASTER_HOURS)
    try:
        resp = requests.get(
            "https://api.neynar.com/v2/farcaster/cast/search/",
            headers={"x-api-key": NEYNAR_API_KEY},
            params={"q": f"${symbol} after:{since:%Y-%m-%d}", "limit": 100, "sort_type": "desc_chron"},
            timeout=20,
        )
        resp.raise_for_status()
        casts = (resp.json().get("result") or {}).get("casts") or []
    except Exception as exc:
        log.warning("Neynar search for $%s failed: %s", symbol, exc)
        return {}

    tag = re.compile(rf"\${re.escape(symbol)}\b", re.IGNORECASE)
    hits = []
    for c in casts:
        try:
            posted = datetime.fromisoformat(str(c.get("timestamp")).replace("Z", "+00:00"))
        except ValueError:
            continue
        if posted >= since and tag.search(c.get("text") or ""):
            hits.append(c)
    if not hits:
        return {"casts": 0, "authors": 0, "engagement": 0}

    def engagement(c: dict) -> int:
        r = c.get("reactions") or {}
        return int(r.get("likes_count") or 0) + int(r.get("recasts_count") or 0) \
            + int((c.get("replies") or {}).get("count") or 0)

    top = max(hits, key=engagement)
    author = (top.get("author") or {}).get("username") or ""
    return {
        "casts": len(hits),
        "authors": len({(c.get("author") or {}).get("fid") for c in hits}),
        "engagement": sum(engagement(c) for c in hits),
        "top_cast": re.sub(r"\s+", " ", top.get("text") or "")[:280],
        "top_author": author,
        "top_url": f"https://farcaster.xyz/{author}/{top.get('hash', '')[:10]}" if author else "",
    }


def buzz_score(buzz: dict) -> float:
    return math.log1p(buzz.get("authors", 0) * 2 + buzz.get("engagement", 0) / 10)


def recent_trades(chain: str, pool: str) -> dict:
    """Individual on-chain trades of `pool` in the last TRADES_WINDOW_MIN minutes,
    from GeckoTerminal's free API (no key, ~30 requests/min)."""
    network = GT_NETWORK.get(chain, chain)
    try:
        resp = requests.get(f"{GT_API}/networks/{network}/pools/{pool}/trades", timeout=15,
                            headers={"accept": "application/json"})
        if resp.status_code == 404:  # e.g. nad.fun bonding-curve pairs aren't indexed
            log.info("      GeckoTerminal doesn't index pool %s", pool)
            return {}
        resp.raise_for_status()
        rows = [t.get("attributes") or {} for t in resp.json().get("data") or []]
    except Exception as exc:
        log.warning("GeckoTerminal trades for %s failed: %s", pool, exc)
        return {}

    now = datetime.now(timezone.utc)
    since = now - timedelta(minutes=TRADES_WINDOW_MIN)
    recent, last = [], None
    for t in rows:
        if t.get("is_anomalous") or not t.get("block_timestamp"):
            continue
        at = datetime.fromisoformat(t["block_timestamp"].replace("Z", "+00:00"))
        last = max(last, at) if last else at
        if at >= since:
            recent.append(t)
    buys = [t for t in recent if t.get("kind") == "buy"]
    buyer_counts = collections.Counter(t.get("tx_from_address") for t in buys)
    return {
        "window_min": TRADES_WINDOW_MIN,
        "last_trade_min_ago": round((now - last).total_seconds() / 60, 1) if last else None,
        "buys": len(buys),
        "sells": len(recent) - len(buys),
        "buy_usd": round(sum(_num(t, "volume_in_usd") for t in buys), 2),
        "sell_usd": round(sum(_num(t, "volume_in_usd") for t in recent if t.get("kind") != "buy"), 2),
        "largest_buy_usd": round(max((_num(t, "volume_in_usd") for t in buys), default=0), 2),
        "buyers": len(buyer_counts),
        "repeat_buyers": sum(1 for n in buyer_counts.values() if n >= 2),  # wallets buying again and again
    }


def trades_score(trades: dict) -> float:
    """Freshness of the last trade dominates, then how many buys and repeat buyers."""
    if not trades or trades.get("last_trade_min_ago") is None:
        return 0.0
    freshness = max(0.0, 1 - trades["last_trade_min_ago"] / 30)
    return 3 * freshness + math.log1p(trades["buys"]) + 0.5 * trades["repeat_buyers"]


def recent_pair_addresses(hours: float) -> set[str]:
    if hours <= 0:
        return set()
    since = datetime.fromtimestamp(time.time() - hours * 3600, timezone.utc).isoformat()
    if cloud.TURSO_ENABLED:
        try:
            [rows] = cloud.turso(("SELECT pair_address FROM videos WHERE created_at >= ?", (since,)))
            return {r[0].lower() for r in rows if r[0]}
        except Exception as exc:
            log.warning("Couldn't read recent videos from Turso: %s", exc)
    if not DB_PATH.is_file():
        return set()
    try:
        with sqlite3.connect(DB_PATH) as db:
            rows = db.execute("SELECT pair_address FROM videos WHERE created_at >= ?", (since,))
            return {r[0].lower() for r in rows if r[0]}
    except sqlite3.Error:
        return set()


def fetch_dexscreener_token(chain: str | None = None) -> TokenData:
    """A live memecoin on `chain`, ranked by DEX_PICK among pairs that pass the
    liquidity/volume/age filters. Majors and stables are skipped, tokens used
    in the last DEX_COOLDOWN_HOURS are skipped, and the winner is drawn from
    the top few so consecutive runs don't all cover the same coin."""
    chain = chain or DEX_CHAIN
    pairs = dex_candidate_pairs(chain)
    if not pairs:
        raise RuntimeError(f"DexScreener returned no pairs for chain '{chain}'")

    now_ms = time.time() * 1000
    best: dict[str, dict] = {}  # one pair per token: the most liquid one
    for p in pairs:
        base = p.get("baseToken") or {}
        addr = (base.get("address") or "").lower()
        if not addr or (base.get("symbol") or "").upper() in DEX_EXCLUDE:
            continue
        if _num(p.get("liquidity"), "usd") < DEX_MIN_LIQUIDITY or _num(p.get("volume"), "h24") < DEX_MIN_VOLUME:
            continue
        created = p.get("pairCreatedAt")
        if DEX_MAX_AGE_HOURS > 0 and (not created or now_ms - created > DEX_MAX_AGE_HOURS * 3_600_000):
            continue
        if addr not in best or _num(p.get("liquidity"), "usd") > _num(best[addr].get("liquidity"), "usd"):
            best[addr] = p
    if not best:
        raise RuntimeError(f"no {chain} pairs passed the filters "
                           f"(liq >= ${DEX_MIN_LIQUIDITY:,.0f}, vol >= ${DEX_MIN_VOLUME:,.0f})")

    app_trades = recent_app_trades() if DEX_PICK == "live" else {}
    ranked = sorted(best.values(), key=lambda p: dex_score(p, DEX_PICK, app_trades), reverse=True)
    recent = recent_pair_addresses(DEX_COOLDOWN_HOURS)
    fresh = [p for p in ranked if (p.get("pairAddress") or "").lower() not in recent] or ranked
    top_n = fresh[:DEX_TOP_N]
    # One GeckoTerminal + one Neynar call per finalist; in live/trending mode the
    # freshest on-chain trades and Farcaster buzz re-rank the shortlist
    trades = {p["pairAddress"]: recent_trades(chain, p["pairAddress"]) for p in top_n}
    buzz = {p["pairAddress"]: farcaster_buzz(p["baseToken"]["symbol"]) for p in top_n} if NEYNAR_API_KEY else {}
    if DEX_PICK in ("live", "trending"):
        top_n.sort(key=lambda p: dex_score(p, DEX_PICK, app_trades)
                   + (trades_score(trades[p["pairAddress"]]) if DEX_PICK == "live" else 0)
                   + FARCASTER_WEIGHT * buzz_score(buzz.get(p["pairAddress"], {})),
                   reverse=True)
    top = random.choices(top_n, weights=range(len(top_n), 0, -1))[0]  # rank 1 most likely
    log.info("      DexScreener: %d pairs -> %d tokens passed filters, picked $%s from top %d (%s)",
             len(pairs), len(best), top["baseToken"]["symbol"], len(top_n), DEX_PICK)
    log.info("      Trades %.0fm: %s", TRADES_WINDOW_MIN, ", ".join(
        f"${p['baseToken']['symbol']} {t.get('buys', '?')}b/{t.get('sells', '?')}s last {t.get('last_trade_min_ago', '?')}m"
        for p in top_n for t in [trades[p["pairAddress"]]]))
    if buzz:
        log.info("      Farcaster %.0fh: %s", FARCASTER_HOURS, ", ".join(
            f"${p['baseToken']['symbol']} {buzz[p['pairAddress']].get('casts', 0)} casts" for p in top_n))

    base = top["baseToken"]
    info = top.get("info") or {}
    socials = {s["type"]: s["url"] for s in info.get("socials") or [] if s.get("type") and s.get("url")}
    if info.get("websites"):
        socials.setdefault("website", info["websites"][0].get("url", ""))
    return TokenData(
        symbol=base["symbol"].upper(),
        name=base.get("name") or base["symbol"],
        chain=chain,
        price_usd=_num(top, "priceUsd"),
        change_24h=_num(top.get("priceChange"), "h24"),
        volume_24h=_num(top.get("volume"), "h24"),
        liquidity_usd=_num(top.get("liquidity"), "usd"),
        market_cap=_num(top, "marketCap") or _num(top, "fdv"),
        pair_address=top.get("pairAddress", ""),
        dex_url=top.get("url", ""),
        token_address=base.get("address", ""),
        socials=socials,
        farcaster=buzz.get(top["pairAddress"], {}),
        trades=trades.get(top["pairAddress"], {}),
    )


def get_token(source: str) -> TokenData:
    has_testnet = bool(load_testnet_deployment().get("tokens"))
    if source == "auto":
        source = "mixed" if has_testnet else "dexscreener"
    if source == "mixed":
        # Mainnet reels show the real market; testnet reels are the ones a double-tap buys
        source = "dexscreener" if random.random() < MAINNET_RATIO else "testnet"
        if source == "dexscreener" and has_testnet:
            try:
                return fetch_dexscreener_token()
            except Exception as exc:
                log.warning("DexScreener failed (%s) — making a testnet reel instead", exc)
                source = "testnet"
    if source == "testnet":
        try:
            return fetch_testnet_token()
        except Exception as exc:
            log.warning("Testnet tokens unavailable (%s) — falling back to mock token", exc)
    if source == "dexscreener":
        try:
            return fetch_dexscreener_token()
        except Exception as exc:  # network / schema issues must not kill the daemon
            log.warning("DexScreener failed (%s) — falling back to mock token", exc)
    return fetch_mock_token()


def fmt_usd(value: float) -> str:
    for unit, div in (("B", 1e9), ("M", 1e6), ("K", 1e3)):
        if abs(value) >= div:
            return f"${value / div:.1f}{unit}"
    if 0 < abs(value) < 10:  # small trades: "$0.19", not "$0"
        return f"${value:.2f}"
    return f"${value:,.0f}"


# --------------------------------------------------------------------------- #
# 2. Script (Groq)
# --------------------------------------------------------------------------- #


@dataclass
class Script:
    narration: str
    image_prompt: str
    hook: str


SYSTEM_PROMPT = """You are a viral crypto TikTok scriptwriter for degens on the Monad blockchain.
Write a 15-second reels voice-over (35-45 words). Open with a hook that fits the
mood and cite 2 of the real numbers given, rounded (prefer the 24h change, volume
or market cap over the tiny raw price).
{tone}
Spoken English only: no emojis, no hashtags, no markdown, write numbers the way
they should be spoken. Never promise guaranteed profit.
Only state facts from the data given: never invent claims like locked liquidity,
audits, doxxed devs, partnerships or listings.

{persona}
Return ONLY a JSON object with exactly these keys:
{
  "narration": "<the text that will be read aloud>",
  "image_prompt": "<English prompt for an AI image generator: vertical 9:16 poster,
                   cinematic, {image_style}, the token's mascot, no text or letters>",
  "hook": "<2-4 word on-screen headline in the same mood, uppercase>"
}"""


def persona_brief(persona: Persona | None) -> str:
    if persona is None:
        return ""
    return (
        f"You ARE {persona.name}, {persona.vibe}. You talk straight to the camera in "
        "first person like a TikTok creator reacting to a chart: greet the viewers, "
        "use slang, and play the mood above to the max.\n"
    )


def _ollama_chat(messages: list[dict]) -> str:
    """Small local models write 10-20 words despite the brief, so feed the word
    count back and ask for a longer rewrite (up to two extra rounds)."""
    messages = list(messages)
    content = ""
    for _ in range(3):
        response = requests.post(
            f"{OLLAMA_URL}/api/chat",
            # think=False: reasoning models (qwen3, deepseek-r1) would spend 30s+ thinking first
            json={"model": OLLAMA_MODEL, "messages": messages, "stream": False, "think": False,
                  "format": "json", "options": {"temperature": 0.8}},
            timeout=180,
        )
        response.raise_for_status()
        content = response.json()["message"]["content"]
        try:
            n = len(str(json.loads(content).get("narration", "")).split())
        except ValueError:
            return content
        if n >= 30:
            return content
        messages += [
            {"role": "assistant", "content": content},
            {"role": "user", "content": (
                f"Your narration has only {n} words; it must be 35-45 words. Keep the mood, add "
                "vivid detail and another number, write every number and symbol as spoken words "
                "(no $ or %). Return the same JSON with the longer narration.")},
        ]
    return content


def _groq_chat(messages: list[dict]) -> str:
    from groq import Groq

    # Reasoning models (gpt-oss, qwen3) count hidden thinking against max_tokens.
    extra = {"reasoning_effort": "low"} if "gpt-oss" in GROQ_MODEL else {}
    completion = Groq(api_key=GROQ_API_KEY).chat.completions.create(
        model=GROQ_MODEL,
        messages=messages,
        response_format={"type": "json_object"},
        temperature=0.9,
        max_tokens=1500,
        **extra,
    )
    return completion.choices[0].message.content


def _openrouter_chat(messages: list[dict]) -> str:
    resp = requests.post(
        f"{OPENROUTER_URL}/chat/completions",
        headers={"Authorization": f"Bearer {OPENROUTER_API_KEY}"},
        json={
            "model": OPENROUTER_MODEL,
            "messages": messages,
            "response_format": {"type": "json_object"},
            "temperature": 0.9,
            "max_tokens": 1500,
        },
        timeout=90,
    )
    resp.raise_for_status()
    content = resp.json()["choices"][0]["message"]["content"] or ""
    # Some free models wrap JSON in ``` fences despite response_format
    return content[content.find("{"): content.rfind("}") + 1]


UNITS = {"K": "thousand", "M": "million", "B": "billion"}


def spoken_symbols(text: str) -> str:
    """'$11.2M' -> '11.2 million dollars', '-63.7%' -> '63.7 percent' (TTS reads symbols badly)."""
    text = re.sub(r"\$(\d[\d,]*(?:\.\d+)?)\s*([KMB])\b",
                  lambda m: f"{m[1]} {UNITS[m[2]]} dollars", text)
    text = re.sub(r"\$(\d[\d,]*(?:\.\d+)?)\s*(thousand|million|billion)\b", r"\1 \2 dollars", text)
    text = re.sub(r"(\d[\d,]*(?:\.\d+)?)\s*([KMB])\b", lambda m: f"{m[1]} {UNITS[m[2]]}", text)
    text = re.sub(r"\$(\d[\d,]*(?:\.\d+)?)", r"\1 dollars", text)
    return re.sub(r"[+-]?(\d[\d,]*(?:\.\d+)?)\s*%", r"\1 percent", text)


def generate_script(token: TokenData, style: Style, persona: Persona | None = None) -> Script:
    providers = [(name, fn) for name, fn, key in (
        # Groq's 120B model writes the best scripts; a local 7B model often misses the
        # brief, so Ollama is the unlimited fallback for when Groq is rate-limited or down.
        ("Groq", _groq_chat, GROQ_API_KEY),
        ("Ollama", _ollama_chat, OLLAMA_MODEL),
        ("OpenRouter", _openrouter_chat, OPENROUTER_API_KEY),
    ) if key]
    if not providers:
        log.warning("No OLLAMA_MODEL, GROQ_API_KEY or OPENROUTER_API_KEY — using template script")
        return template_script(token, style, persona)
    user_msg = (
        f"Token: ${token.symbol} ({token.name}) on {token.chain}\n"
        f"Price: ${token.price_usd:.8g}\n"
        f"24h change: {token.change_24h:+.1f}%\n"
        f"24h volume: {fmt_usd(token.volume_24h)}\n"
        f"Liquidity: {fmt_usd(token.liquidity_usd)}\n"
        f"Market cap: {fmt_usd(token.market_cap)}"
    )
    tr = token.trades
    if tr.get("buys") or tr.get("sells"):
        user_msg += (f"\nOn-chain, last {tr['window_min']:.0f} min: {tr['buys']} buys ({fmt_usd(tr['buy_usd'])}) "
                     f"vs {tr['sells']} sells ({fmt_usd(tr['sell_usd'])}) from {tr['buyers']} buying wallets; "
                     f"biggest buy {fmt_usd(tr['largest_buy_usd'])}; last trade "
                     f"{tr['last_trade_min_ago']:.0f} min ago")
        if tr.get("repeat_buyers"):
            user_msg += f"\n{tr['repeat_buyers']} wallets bought more than once in that window"
    fc = token.farcaster
    if fc.get("casts"):
        user_msg += (f"\nFarcaster, last {FARCASTER_HOURS:.0f}h: {fc['casts']} casts from "
                     f"{fc['authors']} accounts mention ${token.symbol}")
        if fc.get("top_cast"):
            user_msg += f"\nMost liked cast: \"{fc['top_cast']}\""
    elif fc:
        user_msg += f"\nFarcaster, last {FARCASTER_HOURS:.0f}h: nobody is talking about ${token.symbol} yet"
    system = (SYSTEM_PROMPT.replace("{tone}", style.tone)
              .replace("{image_style}", style.image_style)
              .replace("{persona}", persona_brief(persona)))
    messages = [
        {"role": "system", "content": system},
        {"role": "user", "content": user_msg},
    ]
    # openrouter/free lands on a different model each call, so give it a second try
    attempts = [(name, chat) for name, chat in providers for _ in range(2 if name == "OpenRouter" else 1)]
    for name, chat in attempts:
        try:
            data = json.loads(chat(messages))
            # LLMs love em dashes and non-breaking hyphens; captions would glue words together
            narration = re.sub(r"\s*[—–]\s*", ", ", str(data["narration"]))
            narration = spoken_symbols(narration.replace("‑", "-").replace(" ", " "))
            script = Script(
                narration=narration.strip(),
                image_prompt=str(data["image_prompt"]).strip(),
                hook=str(data.get("hook") or random_hook(style)).strip().upper(),
            )
            # Small local models often ignore the brief: too short, or "$11.2M" / "-63%" that
            # TTS reads badly. Reject so the next provider (e.g. Groq) gets a turn.
            if len(script.narration.split()) < 25:
                raise ValueError(f"narration too short ({len(script.narration.split())} words)")
            if re.search(r"%|\$\d", script.narration):
                raise ValueError("narration has unspoken symbols ($, %)")
            if re.search(r"[çğıöşüÇĞİÖŞÜ]", script.narration):  # the TTS voice is English
                raise ValueError("narration is not in English")
            return script
        except Exception as exc:
            log.warning("%s script failed (%s)", name, exc)
    log.warning("All LLM providers failed — using template script")
    return template_script(token, style, persona)


def template_script(token: TokenData, style: Style, persona: Persona | None = None) -> Script:
    opener = style.persona_opener.format(name=persona.name) if persona else style.opener
    narration = style.template.format(
        opener=opener, name=token.name, change=f"{abs(token.change_24h):.0f}",
        volume=spoken_usd(token.volume_24h),
    )
    return Script(
        narration=narration,
        image_prompt=(
            f"cinematic vertical poster of a cute {token.name} memecoin mascot, "
            f"{style.image_style}, volumetric light, 8k, no text"
        ),
        hook=random_hook(style),
    )


def spoken_usd(value: float) -> str:
    for unit, div in (("billion", 1e9), ("million", 1e6), ("thousand", 1e3)):
        if value >= div:
            return f"{value / div:.1f} {unit} dollars"
    return f"{value:.0f} dollars"


# --------------------------------------------------------------------------- #
# 3. Voice-over (Edge-TTS) with word timestamps
# --------------------------------------------------------------------------- #


@dataclass
class Word:
    text: str
    start: float
    end: float


async def _edge_tts(text: str, out_path: Path, voice: str, pitch: str, rate: str) -> list[Word]:
    import edge_tts

    communicate = edge_tts.Communicate(
        text, voice, rate=rate, pitch=pitch, boundary="WordBoundary"
    )
    words: list[Word] = []
    with open(out_path, "wb") as f:
        async for chunk in communicate.stream():
            if chunk["type"] == "audio":
                f.write(chunk["data"])
            elif chunk["type"] == "WordBoundary":
                start = chunk["offset"] / 1e7  # 100-ns ticks -> seconds
                words.append(Word(chunk["text"], start, start + chunk["duration"] / 1e7))
    return words


def _norm(word: str) -> str:
    return re.sub(r"[^a-z0-9]", "", word.lower())


def align_words(text: str, heard: list[Word]) -> list[Word]:
    """Put the script's own words on Whisper's timeline. Whisper mishears slang
    ("degens" -> "Daghens") and writes numbers as digits, so matched words take
    Whisper's timing and the rest are spread evenly between their neighbours."""
    tokens = text.split()
    times: list[tuple[float, float] | None] = [None] * len(tokens)
    matcher = difflib.SequenceMatcher(None, [_norm(t) for t in tokens], [_norm(w.text) for w in heard],
                                      autojunk=False)
    for a, b, n in matcher.get_matching_blocks():
        for k in range(n):
            times[a + k] = (heard[b + k].start, heard[b + k].end)
    i = 0
    while i < len(tokens):
        if times[i] is not None:
            i += 1
            continue
        j = i
        while j < len(tokens) and times[j] is None:
            j += 1
        lo = times[i - 1][1] if i > 0 else (heard[0].start if heard else 0.0)
        hi = times[j][0] if j < len(tokens) else (heard[-1].end if heard else lo)
        if hi - lo < 0.15 * (j - i):
            hi = lo + 0.3 * (j - i)
        step = (hi - lo) / (j - i)
        for k in range(i, j):
            times[k] = (lo + (k - i) * step, lo + (k - i + 1) * step)
        i = j
    return [Word(t, s, e) for t, (s, e) in zip(tokens, times)]


def _fish_tts(text: str, out_path: Path) -> list[Word]:
    """Fish Audio S2 (free on OpenRouter) for the voice, Groq Whisper (free) for word timings."""
    from groq import Groq

    body = {"model": FISH_MODEL, "input": text, "response_format": "mp3"}
    if FISH_VOICE:
        body["voice"] = FISH_VOICE
    resp = requests.post(f"{OPENROUTER_URL}/audio/speech", json=body, timeout=180,
                         headers={"Authorization": f"Bearer {OPENROUTER_API_KEY}"})
    resp.raise_for_status()
    if not resp.headers.get("content-type", "").startswith("audio/"):
        raise RuntimeError(f"unexpected response: {resp.text[:200]}")
    out_path.write_bytes(resp.content)
    with open(out_path, "rb") as f:
        result = Groq(api_key=GROQ_API_KEY).audio.transcriptions.create(
            file=f, model="whisper-large-v3-turbo", response_format="verbose_json",
            timestamp_granularities=["word"], language="en",
        )
    heard = [Word(w["word"], w["start"], w["end"]) for w in (result.words or [])]
    if not heard:
        raise RuntimeError("Whisper returned no word timings")
    return align_words(text, heard)


def synthesize_speech(
    text: str, workdir: Path, voice: str = TTS_VOICE, pitch: str = "+0Hz", rate: str = TTS_RATE
) -> tuple[Path, list[Word]]:
    mp3 = workdir / "voice.mp3"
    if TTS_ENGINE == "fish" and OPENROUTER_API_KEY and GROQ_API_KEY:
        try:
            return mp3, _fish_tts(text, mp3)
        except Exception as exc:
            log.warning("Fish Audio TTS failed (%s) — falling back to Edge-TTS", exc)
    for attempt in range(1, 4):
        try:
            # last try uses the default voice in case the style's voice is unavailable
            words = asyncio.run(_edge_tts(text, mp3, voice if attempt < 3 else TTS_VOICE, pitch, rate))
            if mp3.stat().st_size > 0 and words:
                return mp3, words
            raise RuntimeError("empty TTS response")
        except Exception as exc:
            log.warning("Edge-TTS attempt %d failed: %s", attempt, exc)
            time.sleep(2 * attempt)
    log.warning("Edge-TTS unavailable — rendering with a silent track")
    return silent_track(text, workdir)


def silent_track(text: str, workdir: Path) -> tuple[Path, list[Word]]:
    """Offline fallback: silence + word timings estimated at ~2.8 words/sec."""
    tokens = text.split()
    per_word = 1 / 2.8
    words = [Word(t, i * per_word, (i + 1) * per_word) for i, t in enumerate(tokens)]
    duration = len(tokens) * per_word + 0.3
    path = workdir / "voice.wav"
    with wave.open(str(path), "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(24000)
        wf.writeframes(b"\x00\x00" * int(24000 * duration))
    return path, words


# --------------------------------------------------------------------------- #
# 4. Background image (Pollinations.ai)
# --------------------------------------------------------------------------- #


def fetch_image(prompt: str, workdir: Path, up: bool = True) -> Path:
    path = workdir / "background.jpg"
    if IMAGE_ENGINE == "local" or (IMAGE_ENGINE == "auto" and local_gen.available()):
        try:
            local_gen.release_ollama(OLLAMA_URL, OLLAMA_MODEL)
            return local_gen.generate_image(prompt, path, random.randint(1, 10**9))
        except Exception as exc:
            log.warning("Local SDXL failed (%s) — falling back to Pollinations", exc)
    url = f"https://image.pollinations.ai/prompt/{quote(prompt, safe='')}"
    params = {
        "width": W,
        "height": H,
        "seed": random.randint(1, 10**9),
        "nologo": "true",
        "model": "flux",
    }
    for attempt in range(1, 5):
        wait = 5 * attempt
        try:
            resp = requests.get(url, params=params, timeout=120)
            if resp.status_code in (402, 429):
                # Keyless tier: 1 image / 45s per IP. The body says "Retry after Ns".
                m = re.search(r"[Rr]etry after (\d+)", resp.text)
                wait = int(m.group(1)) + 2 if m else 47
            resp.raise_for_status()
            path.write_bytes(resp.content)
            Image.open(path).verify()  # reject HTML error pages
            return path
        except Exception as exc:
            log.warning("Pollinations attempt %d failed: %s (retry in %ds)", attempt, exc, wait)
            if attempt < 4:
                time.sleep(wait)
    log.warning("Pollinations unavailable — generating procedural background")
    return procedural_background(path, up)


def procedural_background(path: Path, up: bool = True) -> Path:
    """Neon purple gradient + glowing candles, so a run never fails on images."""
    yy = np.linspace(0, 1, H)[:, None]
    xx = np.linspace(0, 1, W)[None, :]
    r = 40 + 90 * (1 - yy) * (0.6 + 0.4 * xx)
    g = 10 + 20 * yy + 0 * xx
    b = 80 + 140 * (1 - 0.5 * yy) + 0 * xx
    img = Image.fromarray(np.dstack([r, g, b]).clip(0, 255).astype(np.uint8))

    glow = Image.new("RGB", (W, H))
    draw = ImageDraw.Draw(glow)
    level = H * 0.75 if up else H * 0.3
    for i in range(14):
        x = 60 + i * 72
        move = random.uniform(-40, 140) if up else random.uniform(-140, 40)
        top, bottom = sorted((level, level - move))
        color = (40, 255, 140) if move > 0 else (255, 60, 110)
        draw.line([(x + 20, top - 40), (x + 20, bottom + 40)], fill=color, width=6)
        draw.rectangle([x, top, x + 40, max(bottom, top + 8)], fill=color)
        level -= move
    img = Image.blend(img, glow.filter(ImageFilter.GaussianBlur(18)), 0.5)
    img.paste(glow, mask=glow.convert("L").point(lambda v: 255 if v > 0 else 0))
    img.save(path, quality=92)
    return path


# --------------------------------------------------------------------------- #
# 5. Render (MoviePy)
# --------------------------------------------------------------------------- #


def prepare_background(path: Path | Image.Image, style: Style, res: float = 1.0) -> np.ndarray:
    """Cover-crop to 9:16 at 112% size (room for the zoom), style colour grade + bottom vignette.
    `res` < 1 keeps motion frames small; the camera crop upscales them per frame."""
    img = (path if isinstance(path, Image.Image) else Image.open(path)).convert("RGB")
    scale = max(W / img.width, H / img.height) * 1.12 * res
    img = img.resize((math.ceil(img.width * scale), math.ceil(img.height * scale)), Image.LANCZOS)
    img = grade(img, style)

    shade = np.ones((img.height, 1), dtype=np.float32)
    ramp = np.linspace(0, 1, img.height)
    shade[:, 0] = 1 - 0.55 * np.clip((ramp - 0.45) / 0.55, 0, 1) ** 1.5
    arr = np.asarray(img, dtype=np.float32) * shade[:, :, None]
    return arr.clip(0, 255).astype(np.uint8)


def load_motion_frames(clip_path: Path, style: Style) -> list[Image.Image]:
    from moviepy import VideoFileClip

    with VideoFileClip(str(clip_path)) as clip:
        frames = list(clip.iter_frames())
    return [Image.fromarray(prepare_background(Image.fromarray(f), style, res=0.6)) for f in frames]


def ken_burns(
    frame: np.ndarray | list[Image.Image], duration: float, fx: FrameFX,
    avatar: AvatarAnimator | None = None, motion_fps: int = 24,
) -> VideoClip:
    """Camera move over the oversized background (zoom, beat punches, shake,
    sway or pan — set by the style), optionally with the talking avatar
    composited bottom-centre, then the style's overlays (rain, sparks, ...).
    A list of frames is an animated background, played back and forth (boomerang)."""
    frames = frame if isinstance(frame, list) else [Image.fromarray(frame)]
    fw, fh = frames[0].size
    n = len(frames)

    def make_frame(t: float) -> np.ndarray:
        k = int(t * motion_fps) % max(1, 2 * n - 2)
        pil = frames[k if k < n else 2 * n - 2 - k]
        z = fx.zoom(t)  # visible fraction of the oversized image
        cw, ch = min(fw, fw / 1.12 * z), min(fh, fh / 1.12 * z)
        dx, dy = fx.offset(t)
        left = min(max((fw - cw) / 2 + dx, 0), fw - cw)
        top = min(max((fh - ch) / 2 + dy, 0), fh - ch)
        crop = pil.resize((W, H), Image.BICUBIC, box=(left, top, left + cw, top + ch))
        i = int(t * FPS)
        if avatar is not None:
            sprite = avatar.frame(i)
            x = (W - sprite.width) // 2
            y = H - sprite.height + 150 + avatar.offset_y(i)
            crop.paste(sprite, (x, y), sprite)
        return fx.apply(crop, t, i)

    return VideoClip(make_frame, duration=duration)


def clean_caption(text: str) -> str:
    # Drop emoji / symbols the font can't draw; keep $, %, digits, letters.
    return re.sub(r"[^\w$%+\-.,!?'&# ]", "", text).strip()


def chunk_words(words: list[Word], max_words: int = 3, max_chars: int = 16) -> list[Word]:
    """Group words into short TikTok-style caption beats."""
    chunks: list[Word] = []
    cur: list[Word] = []
    for w in words:
        if cur and (
            len(cur) >= max_words
            or len(" ".join(x.text for x in cur + [w])) > max_chars
            or cur[-1].text[-1:] in ".!?,"
        ):
            chunks.append(Word(" ".join(x.text for x in cur), cur[0].start, cur[-1].end))
            cur = []
        cur.append(w)
    if cur:
        chunks.append(Word(" ".join(x.text for x in cur), cur[0].start, cur[-1].end))
    # Close gaps so a caption stays on screen until the next one starts.
    for a, b in zip(chunks, chunks[1:]):
        a.end = b.start
    return chunks


def caption_clips(words: list[Word], font: str, duration: float, y: int, style: Style) -> list[TextClip]:
    clips = []
    palette = style.palette
    for i, chunk in enumerate(chunk_words(words, style.caption_words, style.caption_chars)):
        text = clean_caption(chunk.text).upper()
        if not text:
            continue
        end = min(chunk.end, duration)
        if end <= chunk.start:
            continue
        clip = (
            TextClip(
                font=font,
                text=text,
                font_size=style.caption_size,
                color=palette[i % len(palette)],
                stroke_color="black",
                stroke_width=12 if style.caption_anim != "fade" else 8,
                method="caption",
                size=(W - 120, None),
                text_align="center",
                margin=(20, 30),
            )
            .with_start(chunk.start)
            .with_end(end)
        )
        if style.caption_anim == "pop":  # 70% -> 100% over the first 0.12s
            clip = clip.resized(lambda t: min(1.0, 0.7 + 2.5 * t))
        elif style.caption_anim == "slam":  # 140% -> 100%, hits like a punch
            clip = clip.resized(lambda t: max(1.0, 1.4 - 4.0 * t))
        else:  # soft fade for the moody styles
            clip = clip.with_effects([vfx.CrossFadeIn(min(0.2, (end - chunk.start) / 2))])
        clips.append(clip.with_position(("center", y)))
    return clips


def pill_clip(text: str, font: str, size: int, fg: str, bg: str, pad: tuple[int, int]) -> ImageClip:
    """Rounded label drawn with Pillow (MoviePy's bg_color labels clip the glyph bottoms)."""
    from PIL import ImageFont

    face = ImageFont.truetype(font, size)
    left, top, right, bottom = face.getbbox(text)
    w, h = right - left + 2 * pad[0], bottom - top + 2 * pad[1]
    img = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    draw.rounded_rectangle((0, 0, w - 1, h - 1), radius=h // 4, fill=bg)
    draw.text((pad[0] - left, pad[1] - top), text, font=face, fill=fg)
    return ImageClip(np.asarray(img))


def header_clips(token: TokenData, hook: str, font: str, duration: float, avatar_mode: bool,
                 style: Style) -> list:
    up = token.change_24h >= 0
    tag = pill_clip(style.label, font, 36, *style.tag_colors, pad=(18, 10)) \
        .with_duration(duration).with_position(("center", 112))
    badge = pill_clip(f"${token.symbol}  {token.change_24h:+.0f}%", font, 72, "white",
                      "#18A957" if up else "#E0244F", pad=(30, 18)) \
        .with_duration(duration).with_position(("center", 185))
    hook_clip = TextClip(
        font=font,
        text=clean_caption(hook).upper(),
        font_size=92,
        color=style.hook_color,
        stroke_color="black",
        stroke_width=10,
        method="caption",
        size=(W - 140, None),
        text_align="center",
        margin=(20, 20),
    ).with_duration(min(2.2, duration)).with_position(("center", 310))
    stats = TextClip(
        font=font,
        text=f"VOL {fmt_usd(token.volume_24h)}   MC {fmt_usd(token.market_cap)}",
        font_size=48,
        color="white",
        stroke_color="black",
        stroke_width=5,
        margin=(10, 10),
    )
    if avatar_mode:  # the avatar owns the bottom of the frame; stats replace the hook
        hook_end = min(2.2, duration)
        stats = stats.with_start(hook_end).with_end(duration).with_position(("center", 310))
    else:
        stats = stats.with_duration(duration).with_position(("center", H - 260))
    return [tag, badge, hook_clip, stats]


def build_avatar(persona: Persona, voice: AudioFileClip, words: list[Word],
                 duration: float, style: Style) -> AvatarAnimator:
    n_frames = int(math.ceil(duration * FPS)) + 1
    sr = 16000
    env = loudness_envelope(voice.to_soundarray(fps=sr), sr, FPS, n_frames)
    if not env.any():  # silent fallback track -> animate from word timings
        env = envelope_from_words(words, FPS, n_frames)
    return AvatarAnimator(persona, width=int(W * 0.78), env=env, fps=FPS,
                          seed=random.randint(0, 10**6), mood=style.avatar_mood, energy=style.energy)


def write_wav(path: Path, stereo: np.ndarray) -> Path:
    with wave.open(str(path), "wb") as wf:
        wf.setnchannels(2)
        wf.setsampwidth(2)
        wf.setframerate(SR)
        wf.writeframes((stereo.clip(-1, 1) * 32767).astype("<i2").tobytes())
    return path


def render_video(
    token: TokenData, script: Script, image: Path, audio_path: Path,
    words: list[Word], out_path: Path, style: Style, persona: Persona | None = None,
    motion: Path | None = None,
) -> float:
    font = resolve_font()
    voice = AudioFileClip(str(audio_path))
    duration = voice.duration + style.tail
    seed = random.randint(0, 10**6)

    music, beats = make_music(style, duration, seed)
    mixed = mix_tracks(voice.to_soundarray(fps=SR), music, style)
    audio = AudioFileClip(str(write_wav(audio_path.with_name("mix.wav"), mixed)))

    avatar = build_avatar(persona, voice, words, duration, style) if persona else None
    fx = FrameFX(style, W, H, duration, beats, seed)
    background = load_motion_frames(motion, style) if motion else prepare_background(image, style)
    bg = ken_burns(background, duration, fx, avatar, local_gen.MOTION_FPS)
    caption_y = int(H * 0.36) if persona else int(H * 0.62)
    layers = [bg, *header_clips(token, script.hook, font, duration, persona is not None, style),
              *caption_clips(words, font, duration, caption_y, style)]
    video = CompositeVideoClip(layers, size=(W, H)).with_duration(duration).with_audio(audio)
    video.write_videofile(
        str(out_path),
        fps=FPS,
        codec="libx264",
        audio_codec="aac",
        audio_bitrate="192k",
        preset=os.getenv("X264_PRESET", "veryfast"),
        threads=os.cpu_count() or 2,
        # CRF for quality, capped so grain/rain can't balloon the file past a phone-friendly bitrate
        ffmpeg_params=["-pix_fmt", "yuv420p", "-movflags", "+faststart", "-crf", "22",
                       "-maxrate", "9M", "-bufsize", "18M", "-profile:v", "high"],
        temp_audiofile=str(out_path.with_suffix(".tmp.m4a")),
        logger=None,
    )
    video.close()
    audio.close()
    voice.close()
    return duration


# --------------------------------------------------------------------------- #
# 6. Index (SQLite)
# --------------------------------------------------------------------------- #

SCHEMA = """
CREATE TABLE IF NOT EXISTS videos (
    id            TEXT PRIMARY KEY,
    created_at    TEXT NOT NULL,
    video_path    TEXT NOT NULL,
    thumbnail     TEXT NOT NULL,
    duration      REAL NOT NULL,
    token_symbol  TEXT NOT NULL,
    token_name    TEXT NOT NULL,
    chain         TEXT NOT NULL,
    pair_address  TEXT,
    price_usd     REAL,
    change_24h    REAL,
    volume_24h    REAL,
    market_cap    REAL,
    narration     TEXT,
    image_prompt  TEXT,
    hook          TEXT,
    token_json    TEXT,
    format        TEXT NOT NULL DEFAULT 'classic',
    persona       TEXT,
    style         TEXT
);
CREATE INDEX IF NOT EXISTS idx_videos_created ON videos(created_at DESC);
"""


MIGRATIONS = {
    "format": "ALTER TABLE videos ADD COLUMN format TEXT NOT NULL DEFAULT 'classic'",
    "persona": "ALTER TABLE videos ADD COLUMN persona TEXT",
    "style": "ALTER TABLE videos ADD COLUMN style TEXT",
}
COLUMNS = (
    "id, created_at, video_path, thumbnail, duration, token_symbol, token_name, "
    "chain, pair_address, price_usd, change_24h, volume_24h, market_cap, "
    "narration, image_prompt, hook, token_json, format, persona, style"
)


def save_record(vid: str, token: TokenData, script: Script, video: Path,
                thumb: Path, duration: float, persona: Persona | None, style: Style) -> None:
    insert = f"INSERT INTO videos ({COLUMNS}) VALUES ({','.join('?' * 20)})"
    row = (
        vid, datetime.now(timezone.utc).isoformat(),
        video.relative_to(OUTPUT_DIR).as_posix(), thumb.relative_to(OUTPUT_DIR).as_posix(),
        round(duration, 2), token.symbol, token.name, token.chain,
        token.pair_address, token.price_usd, token.change_24h,
        token.volume_24h, token.market_cap, script.narration,
        script.image_prompt, script.hook, json.dumps(asdict(token)),
        "avatar" if persona else "classic", persona.key if persona else None, style.key,
    )
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(DB_PATH) as db:
        db.executescript(SCHEMA)
        existing = {r[1] for r in db.execute("PRAGMA table_info(videos)")}
        for col, ddl in MIGRATIONS.items():
            if col not in existing:
                db.execute(ddl)
        db.execute(insert, row)
    if cloud.TURSO_ENABLED:  # the deployed site reads its feed from Turso
        statements = [s.strip() for s in SCHEMA.split(";") if s.strip()]
        *_, columns = cloud.turso(*((s, ()) for s in statements), ("PRAGMA table_info(videos)", ()))
        existing = {r[1] for r in columns}
        cloud.turso(*((ddl, ()) for col, ddl in MIGRATIONS.items() if col not in existing), (insert, row))


# --------------------------------------------------------------------------- #
# Orchestration
# --------------------------------------------------------------------------- #


def publish_existing() -> None:
    """One-off: copy every locally rendered video to Blob/R2 + Turso (skips ones already there)."""
    if not (cloud.MEDIA_ENABLED and cloud.TURSO_ENABLED and DB_PATH.is_file()):
        raise SystemExit("Needs BLOB_READ_WRITE_TOKEN (or R2_*) and TURSO_* in .env "
                         "and a local output/alphascroll.db")
    with sqlite3.connect(DB_PATH) as db:
        db.row_factory = sqlite3.Row
        rows = [dict(r) for r in db.execute("SELECT * FROM videos ORDER BY created_at")]
    statements = [s.strip() for s in SCHEMA.split(";") if s.strip()]
    *_, columns = cloud.turso(*((s, ()) for s in statements), ("PRAGMA table_info(videos)", ()))
    existing = {r[1] for r in columns}
    cloud.turso(*((ddl, ()) for col, ddl in MIGRATIONS.items() if col not in existing))
    [have] = cloud.turso(("SELECT id FROM videos", ()))
    have = {r[0] for r in have}
    names = [c.strip() for c in COLUMNS.split(",")]
    for row in rows:
        if row["id"] in have:
            continue
        files = [OUTPUT_DIR / row["video_path"], OUTPUT_DIR / row["thumbnail"]]
        if not all(f.is_file() for f in files):
            log.warning("Skipping %s: media missing on disk", row["id"])
            continue
        cloud.upload_media([(f, f.relative_to(OUTPUT_DIR).as_posix()) for f in files])
        cloud.turso((f"INSERT INTO videos ({COLUMNS}) VALUES ({','.join('?' * len(names))})",
                     tuple(row.get(n) for n in names)))
        log.info("Published %s ($%s)", row["id"], row["token_symbol"])


def edge_pitch(*shifts: str | int) -> str:
    return f"{sum(int(str(s).replace('Hz', '')) for s in shifts):+d}Hz"


def animate_background(image: Path, prompt: str, workdir: Path) -> Path | None:
    if not local_gen.available():
        log.warning("--motion needs a CUDA GPU with torch installed — using a still background")
        return None
    try:
        local_gen.release_ollama(OLLAMA_URL, OLLAMA_MODEL)
        # LTX wants motion words, not poster words
        motion_prompt = f"{prompt}. Slow cinematic camera movement, subtle natural motion, atmospheric"
        return local_gen.generate_motion(image, motion_prompt, workdir / "motion.mp4",
                                         random.randint(1, 10**9))
    except Exception as exc:
        log.warning("LTX-Video failed (%s) — using a still background", exc)
        return None


def run_once(source: str, fmt: str = "random", persona_key: str | None = None,
             style_key: str | None = None, motion: bool | None = None) -> Path:
    vid = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S") + "-" + uuid.uuid4().hex[:6]
    workdir = OUTPUT_DIR / "work" / vid
    workdir.mkdir(parents=True, exist_ok=True)
    (OUTPUT_DIR / "videos").mkdir(parents=True, exist_ok=True)
    (OUTPUT_DIR / "thumbs").mkdir(parents=True, exist_ok=True)

    t0 = time.time()
    token = get_token(source)
    if style_key in MOCK_CHANGES and not token.dex_url:  # synthetic stats: make them fit the forced mood
        token.change_24h = mock_change(style_key)
    log.info("[1/5] Token: $%s %+.1f%% vol %s", token.symbol, token.change_24h, fmt_usd(token.volume_24h))

    if fmt == "random":
        fmt = "avatar" if random.random() < AVATAR_RATIO else "classic"
    persona = pick_persona(persona_key) if fmt == "avatar" else None
    style = pick_style(token.change_24h, style_key)
    log.info("      Format: %s%s, style: %s", fmt, f" ({persona.name})" if persona else "", style.label)

    script = generate_script(token, style, persona)
    log.info("[2/5] Script: %s", script.narration)
    (workdir / "script.json").write_text(json.dumps(asdict(script), indent=2))

    if persona:
        audio_path, words = synthesize_speech(script.narration, workdir, persona.voice,
                                              edge_pitch(persona.pitch, style.pitch_hz), style.rate)
    else:
        audio_path, words = synthesize_speech(script.narration, workdir, style.voice or TTS_VOICE,
                                              edge_pitch(style.pitch_hz), style.rate)
    log.info("[3/5] Voice: %s (%d words)", audio_path.name, len(words))

    prompt = script.image_prompt
    if style.image_style not in prompt:  # keep the look on-mood even if the LLM drifts
        prompt = f"{prompt}, {style.image_style}"
    image = fetch_image(prompt, workdir, token.change_24h >= 0)
    log.info("[4/5] Image: %s", image)
    if motion is None:
        motion = random.random() < MOTION_RATIO
    clip = animate_background(image, prompt, workdir) if motion else None
    if clip:
        log.info("      Motion: %s", clip)

    out = OUTPUT_DIR / "videos" / f"{vid}_{token.symbol}.mp4"
    duration = render_video(token, script, image, audio_path, words, out, style, persona, clip)

    thumb = OUTPUT_DIR / "thumbs" / f"{vid}_{token.symbol}.jpg"
    Image.fromarray(prepare_background(image, style)).resize((540, 960)).save(thumb, quality=85)
    if cloud.MEDIA_ENABLED:  # upload before the row exists, so the feed never links a missing file
        cloud.upload_media([(p, p.relative_to(OUTPUT_DIR).as_posix()) for p in (out, thumb)])
        log.info("      Uploaded to %s", cloud.MEDIA_TARGET)
    save_record(vid, token, script, out, thumb, duration, persona, style)
    log.info("[5/5] Rendered %s (%.1fs video) in %.1fs", out, duration, time.time() - t0)
    return out


def main() -> None:
    parser = argparse.ArgumentParser(description="AlphaScroll AI video worker")
    parser.add_argument("--source", choices=["auto", "mixed", "testnet", "mock", "dexscreener"], default="auto",
                        help="mixed: mainnet (DexScreener) and testnet reels by MAINNET_RATIO; "
                             "auto: mixed if contracts/deployments/10143.json exists, else dexscreener")
    parser.add_argument("--format", choices=["random", "classic", "avatar"], default="random",
                        help="random mixes both using AVATAR_RATIO")
    parser.add_argument("--persona", choices=[p.key for p in PERSONAS],
                        help="avatar character (default: random)")
    parser.add_argument("--style", choices=["auto", *STYLES], default="auto",
                        help="auto picks the mood from the 24h change (pump=hype ... crash=arabesk)")
    parser.add_argument("--motion", action=argparse.BooleanOptionalAction, default=None,
                        help="animate the background with LTX-Video on the local GPU "
                             "(default: MOTION_RATIO share of runs)")
    parser.add_argument("--loop", action="store_true", help="run forever as a daemon")
    parser.add_argument("--interval", type=float, default=INTERVAL_MINUTES, help="minutes between runs")
    parser.add_argument("--publish-existing", action="store_true",
                        help="upload already rendered local videos to R2 + Turso, then exit")
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

    if args.publish_existing:
        publish_existing()
        return
    if not args.loop:
        run_once(args.source, args.format, args.persona, args.style, args.motion)
        return
    log.info("Daemon started — one video every %.0f min (Ctrl+C to stop)", args.interval)
    while True:
        started = time.time()
        try:
            run_once(args.source, args.format, args.persona, args.style, args.motion)
        except Exception:
            log.exception("Run failed; retrying next cycle")
        time.sleep(max(0.0, args.interval * 60 - (time.time() - started)))


if __name__ == "__main__":
    main()
