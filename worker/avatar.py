"""
AlphaScroll — talking mascot avatars (PNGtuber style, CPU-only, zero cost)
==========================================================================

A persona is drawn procedurally with Pillow into a small set of sprites
(4 mouth shapes x open/closed eyes). At render time the mouth is driven by
the voice-over's loudness envelope, eyes blink at random, and the body
bounces/squashes while it talks — the classic TikTok "VTuber reacting to a
chart" format, without any GPU lip-sync model.
"""

from __future__ import annotations

import math
import random
from dataclasses import dataclass

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

# Sprite canvas in "design units"; everything below is drawn in these coords.
UNIT_W, UNIT_H = 640, 760
SUPERSAMPLE = 2  # draw large, downscale once -> anti-aliased edges

OUTLINE = (26, 11, 46, 255)
MOUTH = (58, 10, 30, 255)
TONGUE = (255, 105, 140, 255)


@dataclass(frozen=True)
class Persona:
    key: str
    name: str
    body: tuple[int, int, int]
    belly: tuple[int, int, int]
    ears: str        # "frog" | "cat" | "none"
    accessory: str   # "shades" | "cap" | "chain"
    voice: str       # Edge-TTS voice
    pitch: str       # Edge-TTS pitch shift
    vibe: str        # personality hint for the LLM


PERSONAS = [
    Persona("froggy", "Froggy Nad", (88, 214, 120), (196, 248, 190), "frog", "shades",
            "en-US-GuyNeural", "+8Hz", "a cocky degen frog who has seen every rug and still apes in"),
    Persona("chog", "Chog Cat", (150, 92, 255), (222, 204, 255), "cat", "chain",
            "en-US-AnaNeural", "+0Hz", "a hyper, excitable meme cat who screams about pumps"),
    Persona("blob", "Nad Blob", (255, 120, 200), (255, 214, 238), "none", "cap",
            "en-US-ChristopherNeural", "+14Hz", "a chill streetwear blob who explains alpha like a big brother"),
]


def pick_persona(key: str | None = None) -> Persona:
    if key:
        for p in PERSONAS:
            if p.key == key:
                return p
        raise ValueError(f"unknown persona '{key}' (choose: {', '.join(p.key for p in PERSONAS)})")
    return random.choice(PERSONAS)


# --------------------------------------------------------------------------- #
# Sprite drawing
# --------------------------------------------------------------------------- #

EYES = ((230, 330), (410, 330))
MOUTH_CENTER = (320, 478)


def _draw_sprite(p: Persona, mouth: int, eyes_open: bool, s: float) -> Image.Image:
    def S(*v: float) -> list[float]:
        return [x * s for x in v]

    img = Image.new("RGBA", (int(UNIT_W * s), int(UNIT_H * s)), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    ow = int(10 * s)
    body = (*p.body, 255)

    # Ears / eye bumps go behind the head.
    if p.ears == "frog":
        for ex, _ in EYES:
            d.ellipse(S(ex - 95, 150, ex + 95, 340), fill=body, outline=OUTLINE, width=ow)
    elif p.ears == "cat":
        d.polygon(S(95, 380, 140, 130, 290, 250), fill=body, outline=OUTLINE, width=ow)
        d.polygon(S(545, 380, 500, 130, 350, 250), fill=body, outline=OUTLINE, width=ow)
        d.polygon(S(140, 330, 160, 200, 250, 265), fill=(*p.belly, 255))
        d.polygon(S(500, 330, 480, 200, 390, 265), fill=(*p.belly, 255))

    # Head/body: a big blob that runs off the bottom of the frame.
    d.ellipse(S(55, 205, 585, 905), fill=body, outline=OUTLINE, width=ow)
    d.ellipse(S(165, 520, 475, 860), fill=(*p.belly, 255))

    # Cheeks
    cheeks = Image.new("RGBA", img.size, (0, 0, 0, 0))
    ImageDraw.Draw(cheeks).ellipse(S(120, 430, 200, 480), fill=(255, 90, 130, 110))
    ImageDraw.Draw(cheeks).ellipse(S(440, 430, 520, 480), fill=(255, 90, 130, 110))
    img.alpha_composite(cheeks)

    # Eyes
    for ex, ey in EYES:
        if p.accessory == "shades":
            continue
        if eyes_open:
            d.ellipse(S(ex - 60, ey - 62, ex + 60, ey + 62), fill="white", outline=OUTLINE, width=ow)
            px = ex + (14 if ex < 320 else -14)
            d.ellipse(S(px - 30, ey - 22, px + 30, ey + 38), fill=OUTLINE)
            d.ellipse(S(px - 16, ey - 12, px + 2, ey + 6), fill="white")
        else:
            d.arc(S(ex - 50, ey - 30, ex + 50, ey + 40), 200, 340, fill=OUTLINE, width=int(12 * s))

    if p.accessory == "shades":
        for ex, ey in EYES:
            d.rounded_rectangle(S(ex - 88, ey - 42, ex + 80, ey + 48), radius=int(18 * s), fill=(12, 12, 16, 255))
            d.line(S(ex - 60, ey + 20, ex - 20, ey - 25), fill=(255, 255, 255, 170), width=int(10 * s))
        d.rectangle(S(305, 312, 335, 330), fill=(12, 12, 16, 255))
        d.line(S(60, 320, 145, 315), fill=(12, 12, 16, 255), width=int(14 * s))
        d.line(S(495, 315, 580, 320), fill=(12, 12, 16, 255), width=int(14 * s))

    _draw_mouth(d, mouth, s)

    if p.accessory == "cap":
        cap = (40, 40, 60, 255)
        d.chord(S(135, 120, 505, 400), 180, 360, fill=cap, outline=OUTLINE, width=ow)
        d.rounded_rectangle(S(95, 235, 330, 272), radius=int(18 * s), fill=cap, outline=OUTLINE, width=ow)
        d.ellipse(S(300, 140, 340, 180), fill=(255, 230, 0, 255))
    elif p.accessory == "chain":
        d.arc(S(150, 520, 490, 760), 20, 160, fill=(255, 200, 40, 255), width=int(18 * s))
        d.ellipse(S(285, 700, 355, 770), fill=(255, 210, 50, 255), outline=OUTLINE, width=int(6 * s))
        d.polygon(S(320, 712, 340, 735, 320, 758, 300, 735), fill=(140, 220, 255, 255))

    return img


def _draw_mouth(d: ImageDraw.ImageDraw, state: int, s: float) -> None:
    cx, cy = MOUTH_CENTER
    if state == 0:
        d.arc([(cx - 60) * s, (cy - 40) * s, (cx + 60) * s, (cy + 30) * s], 20, 160,
              fill=OUTLINE, width=int(11 * s))
        return
    w, h = {1: (42, 24), 2: (60, 46), 3: (74, 68)}[state]
    box = [(cx - w) * s, (cy - h * 0.6) * s, (cx + w) * s, (cy + h * 1.4) * s]
    d.ellipse(box, fill=MOUTH, outline=OUTLINE, width=int(8 * s))
    if state >= 2:
        tb = [(cx - w * 0.65) * s, (cy + h * 0.45) * s, (cx + w * 0.65) * s, (cy + h * 1.35) * s]
        d.chord(tb, 180, 360, fill=TONGUE)
    if state == 3:
        d.chord(box, 215, 325, fill="white")


def _sticker_outline(img: Image.Image, px: int) -> Image.Image:
    """White die-cut border + soft shadow, like a TikTok sticker."""
    pad = px * 3
    big = Image.new("RGBA", (img.width + pad * 2, img.height + pad * 2), (0, 0, 0, 0))
    big.paste(img, (pad, pad))
    alpha = big.getchannel("A")
    border = alpha.filter(ImageFilter.MaxFilter(px * 2 + 1))
    shadow = border.filter(ImageFilter.GaussianBlur(px * 1.5)).point(lambda v: v * 0.55)
    out = Image.new("RGBA", big.size, (0, 0, 0, 0))
    out.paste((0, 0, 0, 255), (int(px * 0.6), int(px * 1.2)), shadow)
    out.paste((255, 255, 255, 255), (0, 0), border)
    out.alpha_composite(big)
    return out


def build_sprites(p: Persona, width: int) -> dict[tuple[int, bool], Image.Image]:
    """Pre-render every (mouth, eyes_open) combination at final pixel width."""
    scale = width / UNIT_W
    sprites = {}
    for mouth in range(4):
        for eyes_open in (True, False):
            big = _draw_sprite(p, mouth, eyes_open, scale * SUPERSAMPLE)
            small = big.resize((int(UNIT_W * scale), int(UNIT_H * scale)), Image.LANCZOS)
            sprites[(mouth, eyes_open)] = _sticker_outline(small, max(4, int(9 * scale)))
    return sprites


# --------------------------------------------------------------------------- #
# Lip-sync driver
# --------------------------------------------------------------------------- #


def loudness_envelope(samples: np.ndarray, sr: int, fps: int, n_frames: int) -> np.ndarray:
    """Per-video-frame loudness in [0, 1] (RMS, normalised, attack/release smoothed)."""
    mono = samples.mean(axis=1) if samples.ndim > 1 else samples
    hop = sr / fps
    env = np.zeros(n_frames, dtype=np.float32)
    for i in range(n_frames):
        a, b = int(i * hop), int((i + 1) * hop)
        if a < len(mono):
            seg = mono[a:b]
            env[i] = math.sqrt(float(np.mean(seg * seg))) if len(seg) else 0.0
    ref = np.percentile(env, 95)
    if ref < 1e-4:
        return np.zeros(n_frames, dtype=np.float32)
    env = np.clip(env / ref, 0, 1)
    out = np.zeros_like(env)
    for i in range(n_frames):  # fast attack, slower release reads more natural
        prev = out[i - 1] if i else 0.0
        k = 0.75 if env[i] > prev else 0.35
        out[i] = prev + k * (env[i] - prev)
    return out


def envelope_from_words(words, fps: int, n_frames: int) -> np.ndarray:
    """Fallback when the track is silent: fake ~6 syllables/sec inside each word."""
    env = np.zeros(n_frames, dtype=np.float32)
    for w in words:
        for i in range(int(w.start * fps), min(n_frames, int(w.end * fps) + 1)):
            env[i] = 0.25 + 0.75 * abs(math.sin(math.pi * 6 * (i / fps - w.start)))
    return env


def mouth_states(env: np.ndarray) -> np.ndarray:
    """Quantise loudness to 4 mouth shapes with a little hysteresis."""
    states = np.zeros(len(env), dtype=np.int8)
    thresholds = (0.12, 0.38, 0.68)
    cur = 0
    for i, v in enumerate(env):
        target = sum(v > t for t in thresholds)
        if target != cur and abs(v - thresholds[min(cur, target)]) > 0.04:
            cur = target
        states[i] = cur
    return states


def blink_mask(n_frames: int, fps: int, seed: int) -> np.ndarray:
    rng = random.Random(seed)
    closed = np.zeros(n_frames, dtype=bool)
    t = rng.uniform(0.8, 2.0)
    while t * fps < n_frames:
        start = int(t * fps)
        closed[start:start + max(2, int(0.12 * fps))] = True
        t += rng.uniform(2.2, 4.8)
    return closed


class AvatarAnimator:
    """Returns the posed RGBA avatar for any frame index."""

    def __init__(self, persona: Persona, width: int, env: np.ndarray, fps: int, seed: int = 0):
        self.sprites = build_sprites(persona, width)
        self.env = env
        self.mouth = mouth_states(env)
        self.closed = blink_mask(len(env), fps, seed)
        self.fps = fps

    def frame(self, i: int) -> Image.Image:
        i = min(max(i, 0), len(self.env) - 1)
        t = i / self.fps
        e = float(self.env[i])
        sprite = self.sprites[(int(self.mouth[i]), not self.closed[i])]

        sx, sy = 1 - 0.02 * e, 1 + 0.045 * e  # squash & stretch on loud syllables
        w, h = sprite.size
        posed = sprite.resize((int(w * sx), int(h * sy)), Image.BILINEAR)
        angle = 2.5 * math.sin(2 * math.pi * 0.55 * t) + 2.0 * e * math.sin(2 * math.pi * 2.1 * t)
        return posed.rotate(angle, resample=Image.BILINEAR, expand=True)

    def offset_y(self, i: int) -> int:
        """Idle breathing + jump while talking (negative = up)."""
        i = min(max(i, 0), len(self.env) - 1)
        t = i / self.fps
        return int(-9 * math.sin(2 * math.pi * 1.4 * t) - 38 * float(self.env[i]))
