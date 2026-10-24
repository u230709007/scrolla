#!/usr/bin/env python3
"""
AlphaScroll — Zero-Cost Autonomous Video Worker
================================================

Two formats (picked per run, see --format / AVATAR_RATIO):
  classic : AI poster background + captions
  avatar  : a talking mascot (PNGtuber style, lip-synced to the voice) reacting
            in front of the AI background — see avatar.py

Pipeline (every run):
  1. Token data   -> Monad testnet tokens from setup:testnet (default when
                     deployed), mock generator, or DexScreener (Monad chain)
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
  python video_worker.py                     # one video (testnet tokens if deployed, else mock)
  python video_worker.py --source dexscreener
  python video_worker.py --format avatar --persona froggy
  python video_worker.py --loop              # daemon, every INTERVAL_MINUTES
"""

from __future__ import annotations

import argparse
import asyncio
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
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
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
)

# --------------------------------------------------------------------------- #
# Config
# --------------------------------------------------------------------------- #

W, H = 1080, 1920
FPS = 30
BASE_DIR = Path(__file__).resolve().parent

GROQ_API_KEY = os.getenv("GROQ_API_KEY", "").strip()
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
INTERVAL_MINUTES = float(os.getenv("INTERVAL_MINUTES", "15"))
AVATAR_RATIO = float(os.getenv("AVATAR_RATIO", "0.5"))  # share of avatar videos in random mode
# Written by `npm run setup:testnet` in contracts/: test tokens with liquidity on Monad testnet
DEPLOYMENT_FILE = BASE_DIR / os.getenv("DEPLOYMENT_FILE", "../contracts/deployments/10143.json")

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


MOCK_TOKENS = [
    ("MOLANDAK", "Molandak"),
    ("CHOG", "Chog"),
    ("MOYAKI", "Moyaki"),
    ("PURPLE", "Purple Frog"),
    ("GMONAD", "Gmonad"),
    ("NADS", "Nad Army"),
]


def fetch_mock_token() -> TokenData:
    symbol, name = random.choice(MOCK_TOKENS)
    price = round(random.uniform(0.00001, 0.05), 6)
    mcap = random.uniform(400_000, 25_000_000)
    return TokenData(
        symbol=symbol,
        name=name,
        chain="monad",
        price_usd=price,
        change_24h=round(random.uniform(35, 900), 1),
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


def fetch_testnet_token() -> TokenData:
    """A token deployed by setup:testnet, so double-tap buys hit a real pool.
    Market stats stay synthetic: testnet pools have no 24h history."""
    deployment = load_testnet_deployment()
    if not deployment.get("tokens"):
        raise RuntimeError(f"no seeded tokens in {DEPLOYMENT_FILE}")
    picked = random.choice(deployment["tokens"])
    token = fetch_mock_token()
    token.symbol, token.name = picked["symbol"], picked["name"]
    token.chain = "monad-testnet"
    token.token_address = picked["address"]
    token.pair_address = deployment.get("router", token.pair_address)
    return token


def fetch_dexscreener_token(chain: str = "monad") -> TokenData:
    """Highest 24h-volume pair on `chain` from DexScreener's public API."""
    resp = requests.get(
        "https://api.dexscreener.com/latest/dex/search",
        params={"q": chain},
        timeout=20,
    )
    resp.raise_for_status()
    pairs = [p for p in resp.json().get("pairs") or [] if p.get("chainId") == chain]
    if not pairs:
        raise RuntimeError(f"DexScreener returned no pairs for chain '{chain}'")
    top = max(pairs, key=lambda p: float((p.get("volume") or {}).get("h24") or 0))
    base = top["baseToken"]
    return TokenData(
        symbol=base["symbol"].upper(),
        name=base.get("name") or base["symbol"],
        chain=chain,
        price_usd=float(top.get("priceUsd") or 0),
        change_24h=float((top.get("priceChange") or {}).get("h24") or 0),
        volume_24h=float((top.get("volume") or {}).get("h24") or 0),
        liquidity_usd=float((top.get("liquidity") or {}).get("usd") or 0),
        market_cap=float(top.get("marketCap") or top.get("fdv") or 0),
        pair_address=top.get("pairAddress", ""),
        dex_url=top.get("url", ""),
        token_address=base.get("address", ""),
    )


def get_token(source: str) -> TokenData:
    if source == "auto":
        source = "testnet" if load_testnet_deployment().get("tokens") else "mock"
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
Write a 15-second reels voice-over (35-45 words) that creates FOMO: open with a
punchy hook, cite 2 of the real numbers given, end with a call to action like
"double tap to ape in". Spoken English only: no emojis, no hashtags, no markdown,
write numbers the way they should be spoken. Never promise guaranteed profit.
Only state facts from the data given: never invent claims like locked liquidity,
audits, doxxed devs, partnerships or listings.

{persona}
Return ONLY a JSON object with exactly these keys:
{
  "narration": "<the text that will be read aloud>",
  "image_prompt": "<English prompt for an AI image generator: vertical 9:16 poster,
                   cinematic, neon purple, the token's mascot, no text or letters>",
  "hook": "<2-4 word on-screen headline, uppercase>"
}"""


def persona_brief(persona: Persona | None) -> str:
    if persona is None:
        return ""
    return (
        f"You ARE {persona.name}, {persona.vibe}. You talk straight to the camera in "
        "first person like a TikTok creator reacting to a chart: greet the viewers "
        "(e.g. \"yo degens\"), use slang, sound genuinely hyped.\n"
    )


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


def generate_script(token: TokenData, persona: Persona | None = None) -> Script:
    providers = [(name, fn) for name, fn, key in (
        ("Groq", _groq_chat, GROQ_API_KEY),
        ("OpenRouter", _openrouter_chat, OPENROUTER_API_KEY),
    ) if key]
    if not providers:
        log.warning("No GROQ_API_KEY or OPENROUTER_API_KEY — using template script")
        return template_script(token, persona)
    user_msg = (
        f"Token: ${token.symbol} ({token.name}) on {token.chain}\n"
        f"Price: ${token.price_usd:.8g}\n"
        f"24h change: {token.change_24h:+.1f}%\n"
        f"24h volume: {fmt_usd(token.volume_24h)}\n"
        f"Liquidity: {fmt_usd(token.liquidity_usd)}\n"
        f"Market cap: {fmt_usd(token.market_cap)}"
    )
    messages = [
        {"role": "system", "content": SYSTEM_PROMPT.replace("{persona}", persona_brief(persona))},
        {"role": "user", "content": user_msg},
    ]
    # openrouter/free lands on a different model each call, so give it a second try
    attempts = [(name, chat) for name, chat in providers for _ in range(2 if name == "OpenRouter" else 1)]
    for name, chat in attempts:
        try:
            data = json.loads(chat(messages))
            script = Script(
                narration=str(data["narration"]).strip(),
                image_prompt=str(data["image_prompt"]).strip(),
                hook=str(data.get("hook") or f"${token.symbol} IS MOVING").strip().upper(),
            )
            if len(script.narration.split()) < 8:
                raise ValueError("narration too short")
            return script
        except Exception as exc:
            log.warning("%s script failed (%s)", name, exc)
    log.warning("All LLM providers failed — using template script")
    return template_script(token, persona)


def template_script(token: TokenData, persona: Persona | None = None) -> Script:
    opener = f"Yo degens, {persona.name} here." if persona else "Stop scrolling."
    narration = (
        f"{opener} {token.name} just pumped {token.change_24h:.0f} percent "
        f"in twenty four hours on Monad. {spoken_usd(token.volume_24h)} in volume and "
        f"the chart is still breathing. Smart money is already in. "
        f"Are you early or exit liquidity? Double tap to ape in."
    )
    return Script(
        narration=narration,
        image_prompt=(
            f"epic cinematic vertical poster of a cute purple {token.name} memecoin "
            "mascot riding a rocket over a neon cyberpunk city, green candlestick "
            "charts exploding upward, volumetric light, 8k, no text"
        ),
        hook=random.choice(["NEXT 100X?", "STOP SCROLLING", "DEGENS WAKE UP", "SEND IT"]),
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


async def _edge_tts(text: str, out_path: Path, voice: str, pitch: str) -> list[Word]:
    import edge_tts

    communicate = edge_tts.Communicate(
        text, voice, rate=TTS_RATE, pitch=pitch, boundary="WordBoundary"
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
    text: str, workdir: Path, voice: str = TTS_VOICE, pitch: str = "+0Hz"
) -> tuple[Path, list[Word]]:
    mp3 = workdir / "voice.mp3"
    if TTS_ENGINE == "fish" and OPENROUTER_API_KEY and GROQ_API_KEY:
        try:
            return mp3, _fish_tts(text, mp3)
        except Exception as exc:
            log.warning("Fish Audio TTS failed (%s) — falling back to Edge-TTS", exc)
    for attempt in range(1, 4):
        try:
            words = asyncio.run(_edge_tts(text, mp3, voice, pitch))
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


def fetch_image(prompt: str, workdir: Path) -> Path:
    path = workdir / "background.jpg"
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
    return procedural_background(path)


def procedural_background(path: Path) -> Path:
    """Neon purple gradient + glowing candles, so a run never fails on images."""
    yy = np.linspace(0, 1, H)[:, None]
    xx = np.linspace(0, 1, W)[None, :]
    r = 40 + 90 * (1 - yy) * (0.6 + 0.4 * xx)
    g = 10 + 20 * yy + 0 * xx
    b = 80 + 140 * (1 - 0.5 * yy) + 0 * xx
    img = Image.fromarray(np.dstack([r, g, b]).clip(0, 255).astype(np.uint8))

    glow = Image.new("RGB", (W, H))
    draw = ImageDraw.Draw(glow)
    level = H * 0.75
    for i in range(14):
        x = 60 + i * 72
        move = random.uniform(-40, 140)
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


def prepare_background(path: Path) -> np.ndarray:
    """Cover-crop to 9:16 at 112% size (room for the zoom) + bottom vignette."""
    img = Image.open(path).convert("RGB")
    scale = max(W / img.width, H / img.height) * 1.12
    img = img.resize((math.ceil(img.width * scale), math.ceil(img.height * scale)), Image.LANCZOS)

    shade = np.ones((img.height, 1), dtype=np.float32)
    ramp = np.linspace(0, 1, img.height)
    shade[:, 0] = 1 - 0.55 * np.clip((ramp - 0.45) / 0.55, 0, 1) ** 1.5
    arr = np.asarray(img, dtype=np.float32) * shade[:, :, None]
    return arr.clip(0, 255).astype(np.uint8)


def ken_burns(
    frame: np.ndarray, duration: float, avatar: AvatarAnimator | None = None
) -> VideoClip:
    """Slow zoom-in from 100% to 112% of the 1080x1920 frame, optionally with
    the talking avatar composited bottom-centre (it runs off the bottom edge)."""
    fh, fw = frame.shape[:2]
    pil = Image.fromarray(frame)

    def make_frame(t: float) -> np.ndarray:
        z = 1.12 - 0.12 * (t / duration)  # visible fraction of the oversized image
        cw, ch = fw / 1.12 * z, fh / 1.12 * z
        left, top = (fw - cw) / 2, (fh - ch) / 2
        crop = pil.resize((W, H), Image.BILINEAR, box=(left, top, left + cw, top + ch))
        if avatar is not None:
            i = int(t * FPS)
            sprite = avatar.frame(i)
            x = (W - sprite.width) // 2
            y = H - sprite.height + 150 + avatar.offset_y(i)
            crop.paste(sprite, (x, y), sprite)
        return np.asarray(crop)

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


def caption_clips(words: list[Word], font: str, duration: float, y: int) -> list[TextClip]:
    clips = []
    palette = ["#FFFFFF", "#FFE600", "#39FF88"]
    for i, chunk in enumerate(chunk_words(words)):
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
                font_size=118,
                color=palette[i % len(palette)],
                stroke_color="black",
                stroke_width=12,
                method="caption",
                size=(W - 120, None),
                text_align="center",
                margin=(20, 30),
            )
            .with_start(chunk.start)
            .with_end(end)
        )
        # Pop-in: 70% -> 100% over the first 0.12s
        clip = clip.resized(lambda t: min(1.0, 0.7 + 2.5 * t))
        clips.append(clip.with_position(("center", y)))
    return clips


def header_clips(token: TokenData, hook: str, font: str, duration: float, avatar_mode: bool) -> list:
    up = token.change_24h >= 0
    badge = TextClip(
        font=font,
        text=f" ${token.symbol}  {token.change_24h:+.0f}% ",
        font_size=76,
        color="white",
        bg_color="#18A957" if up else "#E0244F",
        margin=(24, 14),
    ).with_duration(duration).with_position(("center", 170))
    hook_clip = TextClip(
        font=font,
        text=clean_caption(hook).upper(),
        font_size=92,
        color="#FFE600",
        stroke_color="black",
        stroke_width=10,
        method="caption",
        size=(W - 140, None),
        text_align="center",
        margin=(20, 20),
    ).with_duration(min(2.2, duration)).with_position(("center", 300))
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
        stats = stats.with_start(hook_end).with_end(duration).with_position(("center", 300))
    else:
        stats = stats.with_duration(duration).with_position(("center", H - 260))
    return [badge, hook_clip, stats]


def build_avatar(persona: Persona, audio: AudioFileClip, words: list[Word],
                 duration: float) -> AvatarAnimator:
    n_frames = int(math.ceil(duration * FPS)) + 1
    sr = 16000
    env = loudness_envelope(audio.to_soundarray(fps=sr), sr, FPS, n_frames)
    if not env.any():  # silent fallback track -> animate from word timings
        env = envelope_from_words(words, FPS, n_frames)
    return AvatarAnimator(persona, width=int(W * 0.78), env=env, fps=FPS,
                          seed=random.randint(0, 10**6))


def render_video(
    token: TokenData, script: Script, image: Path, audio_path: Path,
    words: list[Word], out_path: Path, persona: Persona | None = None,
) -> float:
    font = resolve_font()
    audio = AudioFileClip(str(audio_path))
    duration = audio.duration + 0.6

    avatar = build_avatar(persona, audio, words, duration) if persona else None
    bg = ken_burns(prepare_background(image), duration, avatar)
    caption_y = int(H * 0.36) if persona else int(H * 0.62)
    layers = [bg, *header_clips(token, script.hook, font, duration, persona is not None),
              *caption_clips(words, font, duration, caption_y)]
    video = CompositeVideoClip(layers, size=(W, H)).with_duration(duration).with_audio(audio)
    video.write_videofile(
        str(out_path),
        fps=FPS,
        codec="libx264",
        audio_codec="aac",
        preset="veryfast",
        threads=os.cpu_count() or 2,
        ffmpeg_params=["-pix_fmt", "yuv420p", "-movflags", "+faststart", "-crf", "23"],
        temp_audiofile=str(out_path.with_suffix(".tmp.m4a")),
        logger=None,
    )
    video.close()
    audio.close()
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
    persona       TEXT
);
CREATE INDEX IF NOT EXISTS idx_videos_created ON videos(created_at DESC);
"""


MIGRATIONS = {
    "format": "ALTER TABLE videos ADD COLUMN format TEXT NOT NULL DEFAULT 'classic'",
    "persona": "ALTER TABLE videos ADD COLUMN persona TEXT",
}
COLUMNS = (
    "id, created_at, video_path, thumbnail, duration, token_symbol, token_name, "
    "chain, pair_address, price_usd, change_24h, volume_24h, market_cap, "
    "narration, image_prompt, hook, token_json, format, persona"
)


def save_record(vid: str, token: TokenData, script: Script, video: Path,
                thumb: Path, duration: float, persona: Persona | None) -> None:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(DB_PATH) as db:
        db.executescript(SCHEMA)
        existing = {row[1] for row in db.execute("PRAGMA table_info(videos)")}
        for col, ddl in MIGRATIONS.items():
            if col not in existing:
                db.execute(ddl)
        db.execute(
            f"INSERT INTO videos ({COLUMNS}) VALUES ({','.join('?' * 19)})",
            (
                vid, datetime.now(timezone.utc).isoformat(),
                video.relative_to(OUTPUT_DIR).as_posix(), thumb.relative_to(OUTPUT_DIR).as_posix(),
                round(duration, 2), token.symbol, token.name, token.chain,
                token.pair_address, token.price_usd, token.change_24h,
                token.volume_24h, token.market_cap, script.narration,
                script.image_prompt, script.hook, json.dumps(asdict(token)),
                "avatar" if persona else "classic", persona.key if persona else None,
            ),
        )


# --------------------------------------------------------------------------- #
# Orchestration
# --------------------------------------------------------------------------- #


def run_once(source: str, fmt: str = "random", persona_key: str | None = None) -> Path:
    vid = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S") + "-" + uuid.uuid4().hex[:6]
    workdir = OUTPUT_DIR / "work" / vid
    workdir.mkdir(parents=True, exist_ok=True)
    (OUTPUT_DIR / "videos").mkdir(parents=True, exist_ok=True)
    (OUTPUT_DIR / "thumbs").mkdir(parents=True, exist_ok=True)

    t0 = time.time()
    token = get_token(source)
    log.info("[1/5] Token: $%s %+.1f%% vol %s", token.symbol, token.change_24h, fmt_usd(token.volume_24h))

    if fmt == "random":
        fmt = "avatar" if random.random() < AVATAR_RATIO else "classic"
    persona = pick_persona(persona_key) if fmt == "avatar" else None
    log.info("      Format: %s%s", fmt, f" ({persona.name})" if persona else "")

    script = generate_script(token, persona)
    log.info("[2/5] Script: %s", script.narration)
    (workdir / "script.json").write_text(json.dumps(asdict(script), indent=2))

    if persona:
        audio_path, words = synthesize_speech(script.narration, workdir, persona.voice, persona.pitch)
    else:
        audio_path, words = synthesize_speech(script.narration, workdir)
    log.info("[3/5] Voice: %s (%d words)", audio_path.name, len(words))

    image = fetch_image(script.image_prompt, workdir)
    log.info("[4/5] Image: %s", image)

    out = OUTPUT_DIR / "videos" / f"{vid}_{token.symbol}.mp4"
    duration = render_video(token, script, image, audio_path, words, out, persona)

    thumb = OUTPUT_DIR / "thumbs" / f"{vid}_{token.symbol}.jpg"
    Image.fromarray(prepare_background(image)).resize((540, 960)).save(thumb, quality=85)
    save_record(vid, token, script, out, thumb, duration, persona)
    log.info("[5/5] Rendered %s (%.1fs video) in %.1fs", out, duration, time.time() - t0)
    return out


def main() -> None:
    parser = argparse.ArgumentParser(description="AlphaScroll AI video worker")
    parser.add_argument("--source", choices=["auto", "testnet", "mock", "dexscreener"], default="auto",
                        help="auto: testnet tokens if contracts/deployments/10143.json exists, else mock")
    parser.add_argument("--format", choices=["random", "classic", "avatar"], default="random",
                        help="random mixes both using AVATAR_RATIO")
    parser.add_argument("--persona", choices=[p.key for p in PERSONAS],
                        help="avatar character (default: random)")
    parser.add_argument("--loop", action="store_true", help="run forever as a daemon")
    parser.add_argument("--interval", type=float, default=INTERVAL_MINUTES, help="minutes between runs")
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

    if not args.loop:
        run_once(args.source, args.format, args.persona)
        return
    log.info("Daemon started — one video every %.0f min (Ctrl+C to stop)", args.interval)
    while True:
        started = time.time()
        try:
            run_once(args.source, args.format, args.persona)
        except Exception:
            log.exception("Run failed; retrying next cycle")
        time.sleep(max(0.0, args.interval * 60 - (time.time() - started)))


if __name__ == "__main__":
    main()
