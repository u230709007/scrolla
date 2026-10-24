"""
Scrolla — video styles (the mood follows the chart)
=======================================================

Every video gets a style picked from the token's 24h move, and the style
drives everything that makes two videos feel different:

  hype     (+10% and up)  MOON MODE     funny, cheerful narrator, saturated neon,
                                        beat-synced zoom punches, sparks, trap beat
  steady   (0 .. +10%)    ALPHA BRIEF   calm insider, golden grade, slow pan,
                                        bokeh, lo-fi chords
  noir     (manual only)  CRYPTO NOIR   detective monologue, black & white,
                                        letterbox, flicker, heartbeat + drone
  arabesk  (below 0%)     ARABESK       sad-funny lament with a crying mascot, cold
                                        desaturated grade, rain, film grain, Hicaz-makam
                                        baglama tremolo + strings + darbuka

Music is synthesised with numpy (no samples, no downloads, zero cost) and
mixed under the voice with sidechain ducking.
"""

from __future__ import annotations

import math
import random
from dataclasses import dataclass

import numpy as np
from PIL import Image, ImageDraw, ImageEnhance, ImageFilter

SR = 44100  # music / mix sample rate


@dataclass(frozen=True)
class Style:
    key: str
    label: str                 # small on-screen tag
    tone: str                  # mood brief for the LLM
    image_style: str           # appended to the image prompt
    opener: str                # template-script opener (no persona)
    persona_opener: str        # template-script opener ({name} = persona)
    template: str              # fallback narration ({opener} {name} {change} {volume})
    hooks: tuple[str, ...]
    # voice
    voice: str                 # Edge-TTS voice for classic videos ("" = TTS_VOICE)
    rate: str
    pitch_hz: int              # added on top of the persona's pitch
    # captions
    palette: tuple[str, ...]
    hook_color: str
    caption_size: int
    caption_words: int
    caption_chars: int
    caption_anim: str          # pop | slam | fade
    tag_colors: tuple[str, str]  # (text, background)
    # grade
    saturation: float
    contrast: float
    brightness: float
    tint: tuple[int, int, int]
    tint_amount: float
    vignette: float
    grain: float
    # camera
    zoom: tuple[float, float]  # visible fraction of the oversized image, start -> end
    ease: str                  # linear | smooth
    punch: float               # beat zoom punch
    shake: float               # px
    sway: float                # px
    pan: float                 # px
    # extras
    overlay: str               # sparks | bokeh | noir | rain
    music: str                 # trap | lofi | heartbeat | hicaz
    music_level: float         # music RMS relative to the voice RMS
    tail: float                # seconds kept after the voice ends
    avatar_mood: str           # default | sad
    energy: float              # avatar bounce


STYLES = {
    "hype": Style(
        key="hype", label="MOON MODE",
        tone=("Mood: MOON MODE. The chart is ripping and it is FUNNY. Be cheerful, goofy and "
              "breathless: short punchy sentences, exclamations, hype slang, playful jokes (the "
              "rocket needs more snacks, the moon is getting crowded, your landlord is shaking). "
              "Open with a shocking hook and end with a call to action like \"double tap to ape in\"."),
        image_style=("to the moon, funny cartoon mascot riding a rocket to a smiling moon, happy "
                     "party mood, confetti, neon green and electric purple, fireworks, golden coins "
                     "flying, hyper saturated, dynamic low angle"),
        opener="Stop scrolling right now!", persona_opener="Yo degens, {name} here and I am losing it!",
        template=("{opener} {name} just exploded {change} percent in twenty four hours on Monad! "
                  "{volume} in volume and the candles are still green! This is not a drill. "
                  "Are you early or exit liquidity? Double tap to ape in!"),
        hooks=("NEXT 100X?", "IT'S SENDING", "DEGENS WAKE UP", "SEND IT"),
        voice="en-US-GuyNeural", rate="+22%", pitch_hz=4,
        palette=("#FFFFFF", "#FFE600", "#39FF88"), hook_color="#FFE600",
        caption_size=128, caption_words=2, caption_chars=14, caption_anim="slam",
        tag_colors=("#0B0B0F", "#39FF88"),
        saturation=1.35, contrast=1.15, brightness=1.04, tint=(90, 0, 160), tint_amount=0.06,
        vignette=0.25, grain=0.0,
        zoom=(1.10, 0.94), ease="linear", punch=0.045, shake=7, sway=0, pan=0,
        overlay="sparks", music="trap", music_level=0.42, tail=0.6, avatar_mood="default", energy=1.4,
    ),
    "steady": Style(
        key="steady", label="ALPHA BRIEF",
        tone=("Mood: ALPHA BRIEF. A calm, confident insider explaining why this slow, healthy climb "
              "matters. Smooth, smart, a little mysterious, never screaming. End with a call to "
              "action like \"double tap before the crowd notices\"."),
        image_style=("cinematic golden hour, clean blue and gold palette, sleek futuristic trading "
                     "floor, calm confident mood, shallow depth of field"),
        opener="Here is some quiet alpha.", persona_opener="Hey, {name} here with some quiet alpha.",
        template=("{opener} While everyone chases noise, {name} climbed {change} percent today. "
                  "{volume} in volume, no drama, just a steady chart. That is how real moves start. "
                  "Double tap before the crowd notices."),
        hooks=("QUIET ALPHA", "SLOW AND STEADY", "SMART MONEY MOVE", "UNDER THE RADAR"),
        voice="", rate="+6%", pitch_hz=0,
        palette=("#FFFFFF", "#7FE7FF", "#FFD27F"), hook_color="#FFD27F",
        caption_size=106, caption_words=3, caption_chars=17, caption_anim="pop",
        tag_colors=("#0B0B0F", "#FFD27F"),
        saturation=1.05, contrast=1.06, brightness=1.0, tint=(255, 170, 80), tint_amount=0.06,
        vignette=0.3, grain=0.02,
        zoom=(1.12, 1.03), ease="smooth", punch=0, shake=0, sway=0, pan=50,
        overlay="bokeh", music="lofi", music_level=0.32, tail=0.8, avatar_mood="default", energy=0.8,
    ),
    "noir": Style(
        key="noir", label="CRYPTO NOIR",
        tone=("Mood: CRYPTO NOIR. A tense detective voice-over, like a film noir narrator. The chart "
              "is bleeding a little and nobody knows if this is the bottom. Suspense, short dramatic "
              "sentences, rhetorical questions. End with a call to action like \"double tap if you "
              "buy the dip\"."),
        image_style=("film noir, black and white with one red accent, rainy alley at night, detective "
                     "silhouette, hard shadows, venetian blind light, suspense"),
        opener="Midnight, on Monad.", persona_opener="{name} here. Something is off tonight.",
        template=("{opener} The city was quiet. Then {name} slipped {change} percent in a single day. "
                  "{volume} still changed hands in the dark. Is this the bottom, or just the beginning? "
                  "Double tap if you buy the dip."),
        hooks=("WHO SOLD?", "THE DIP FILES", "IS THIS THE BOTTOM?", "CASE OPEN"),
        voice="en-GB-RyanNeural", rate="+0%", pitch_hz=-4,
        palette=("#FFFFFF", "#E0244F", "#D9D9D9"), hook_color="#E0244F",
        caption_size=100, caption_words=3, caption_chars=17, caption_anim="fade",
        tag_colors=("#FFFFFF", "#E0244F"),
        saturation=0.1, contrast=1.35, brightness=0.92, tint=(40, 60, 90), tint_amount=0.07,
        vignette=0.6, grain=0.06,
        zoom=(1.02, 1.12), ease="smooth", punch=0, shake=0, sway=12, pan=0,
        overlay="noir", music="heartbeat", music_level=0.38, tail=1.0, avatar_mood="default", energy=0.6,
    ),
    "arabesk": Style(
        key="arabesk", label="ARABESK MODE",
        tone=("Mood: ARABESK. Write it like a heartbroken Turkish arabesk song turned into a monologue, "
              "sad but FUNNY: melancholic, poetic, over-the-top dramatic self-pity about fate, betrayal "
              "and the cruel world (the chart broke your heart, the candles are red like your tears, "
              "even the wallet is crying). Slow, sorrowful sentences with a deadpan joke or two. "
              "Write in English; the single Turkish word \"kader\" (fate) may appear once. End with a tiny glimmer of hope and a call to action "
              "like \"double tap if your heart still believes\"."),
        image_style=("melancholic, rainy night window, funny crying cartoon mascot with big streaming "
                     "tears, lonely sad mascot with a tear, red candlestick "
                     "chart crashing in the background, blurred Bosphorus city lights, desaturated "
                     "teal and amber, nostalgic 35mm film still"),
        opener="Sit down, my friend.", persona_opener="{name} here, and my heart is heavy tonight.",
        template=("{opener} Oh, kader. I gave my heart to {name}, and it fell {change} percent in one "
                  "night. {volume} of dreams washed away in red candles. The world is cruel to diamond "
                  "hands. But maybe tomorrow the sun rises again. Double tap if your heart still believes."),
        hooks=("KADER BU", "MY HEART IS RED", "IT BROKE ME", "WHY ME, CHART?"),
        voice="en-US-RogerNeural", rate="-8%", pitch_hz=-6,
        palette=("#F2F2F2", "#A9D6FF", "#FFC9A8"), hook_color="#A9D6FF",
        caption_size=96, caption_words=4, caption_chars=20, caption_anim="fade",
        tag_colors=("#FFFFFF", "#2A4A7A"),
        saturation=0.55, contrast=1.08, brightness=0.88, tint=(30, 70, 120), tint_amount=0.14,
        vignette=0.55, grain=0.045,
        zoom=(1.0, 1.12), ease="smooth", punch=0, shake=0, sway=18, pan=0,
        overlay="rain", music="hicaz", music_level=0.5, tail=1.6, avatar_mood="sad", energy=0.4,
    ),
}


def pick_style(change_24h: float, key: str | None = None) -> Style:
    if key and key != "auto":
        return STYLES[key]
    if change_24h >= 10:
        return STYLES["hype"]
    if change_24h >= 0:
        return STYLES["steady"]
    return STYLES["arabesk"]


# --------------------------------------------------------------------------- #
# Colour grade (applied once to the background)
# --------------------------------------------------------------------------- #


def grade(img: Image.Image, s: Style) -> Image.Image:
    img = ImageEnhance.Color(img).enhance(s.saturation)
    img = ImageEnhance.Contrast(img).enhance(s.contrast)
    img = ImageEnhance.Brightness(img).enhance(s.brightness)
    if s.tint_amount:
        img = Image.blend(img, Image.new("RGB", img.size, s.tint), s.tint_amount)
    if s.vignette:
        yy = np.linspace(-1, 1, img.height)[:, None]
        xx = np.linspace(-1, 1, img.width)[None, :]
        dist = np.sqrt(xx ** 2 * 0.8 + yy ** 2)
        shade = 1 - s.vignette * np.clip((dist - 0.45) / 0.9, 0, 1) ** 1.6
        arr = np.asarray(img, dtype=np.float32) * shade[:, :, None]
        img = Image.fromarray(arr.clip(0, 255).astype(np.uint8))
    return img


# --------------------------------------------------------------------------- #
# Per-frame camera + overlays
# --------------------------------------------------------------------------- #


class FrameFX:
    def __init__(self, s: Style, width: int, height: int, duration: float,
                 beats: list[float], seed: int = 0):
        self.s, self.w, self.h, self.d = s, width, height, duration
        self.beats = np.array(sorted(beats), dtype=np.float32)
        rng = np.random.default_rng(seed)
        # Coarse (half-res) grain that changes every 3rd frame: reads as film, still compresses
        self.grain = [np.repeat(np.repeat(rng.normal(0, s.grain * 255, (height // 2, width // 2, 1)),
                                          2, axis=0), 2, axis=1).astype(np.int16)
                      for _ in range(4)] if s.grain else []
        n = {"rain": 170, "sparks": 70, "bokeh": 16, "noir": 40}[s.overlay]
        self.px = rng.uniform(0, width, n)
        self.py = rng.uniform(0, height, n)
        self.speed = rng.uniform(*{"rain": (1500, 2300), "sparks": (180, 520),
                                   "bokeh": (12, 40), "noir": (8, 30)}[s.overlay], n)
        self.size = rng.uniform(*{"rain": (40, 95), "sparks": (3, 8),
                                  "bokeh": (40, 120), "noir": (1.5, 3.5)}[s.overlay], n)
        self.phase = rng.uniform(0, 2 * math.pi, n)
        self.flicker = rng.uniform(0.9, 1.0, 64)
        if s.overlay == "bokeh":
            self.bokeh = {}
            for r in (40, 80, 120):
                m = Image.new("L", (r * 2, r * 2), 0)
                ImageDraw.Draw(m).ellipse((r * 0.3, r * 0.3, r * 1.7, r * 1.7), fill=60)
                self.bokeh[r] = m.filter(ImageFilter.GaussianBlur(r * 0.18))

    def _beat_kick(self, t: float) -> float:
        past = self.beats[self.beats <= t]
        return math.exp(-(t - float(past[-1])) * 10) if len(past) else 0.0

    def zoom(self, t: float) -> float:
        p = min(1.0, t / self.d)
        e = p if self.s.ease == "linear" else p * p * (3 - 2 * p)
        z0, z1 = self.s.zoom
        return (z0 + (z1 - z0) * e) * (1 - self.s.punch * self._beat_kick(t))

    def offset(self, t: float) -> tuple[float, float]:
        s = self.s
        dx = s.sway * math.sin(2 * math.pi * 0.11 * t) + s.pan * (2 * min(1.0, t / self.d) - 1)
        dy = 0.4 * s.sway * math.sin(2 * math.pi * 0.07 * t + 1.3)
        if s.shake:
            k = 0.35 + self._beat_kick(t)
            dx += s.shake * k * math.sin(t * 53.0) * math.cos(t * 17.0)
            dy += s.shake * k * math.sin(t * 41.0 + 0.7)
        return dx, dy

    def apply(self, img: Image.Image, t: float, i: int) -> np.ndarray:
        s, w, h = self.s, self.w, self.h
        mask = Image.new("L", (w, h), 0)
        d = ImageDraw.Draw(mask)
        if s.overlay == "rain":
            ys = (self.py + self.speed * t) % (h + 120) - 120
            for x, y, ln in zip(self.px, ys, self.size):
                d.line((x, y, x - ln * 0.12, y + ln), fill=70, width=2)
            img.paste((200, 215, 235), (0, 0, w, h), mask)
        elif s.overlay == "sparks":
            ys = h - (self.py + self.speed * t) % (h + 60)
            xs = self.px + 18 * np.sin(t * 3 + self.phase)
            for x, y, r, ph in zip(xs, ys, self.size, self.phase):
                a = int(120 + 120 * abs(math.sin(t * 6 + ph)))
                d.ellipse((x - r, y - r, x + r, y + r), fill=a)
            img.paste((255, 236, 140), (0, 0, w, h), mask.filter(ImageFilter.GaussianBlur(1.2)))
        elif s.overlay == "bokeh":
            ys = (self.py - self.speed * t) % (h + 240) - 120
            for x, y, r in zip(self.px, ys, self.size):
                key = min(self.bokeh, key=lambda k: abs(k - r))
                m = self.bokeh[key]
                img.paste((255, 214, 150), (int(x - key), int(y - key)), m)
        elif s.overlay == "noir":
            xs = self.px + 10 * np.sin(t * 0.8 + self.phase)
            ys = (self.py + self.speed * t) % h
            for x, y, r in zip(xs, ys, self.size):
                d.ellipse((x - r, y - r, x + r, y + r), fill=110)
            img.paste((235, 235, 235), (0, 0, w, h), mask)

        arr = np.asarray(img)
        if s.overlay == "noir" or self.grain:
            out = arr.astype(np.int16)
            if s.overlay == "noir":
                out = (out * self.flicker[i % len(self.flicker)]).astype(np.int16)
                bar = int(h * 0.055)  # cinematic letterbox
                out[:bar] = 0
                out[-bar:] = 0
            if self.grain:
                out += self.grain[(i // 3) % len(self.grain)]
            arr = out.clip(0, 255).astype(np.uint8)
        if s.key == "hype" and t < 0.35:  # opening flash
            k = 1 - t / 0.35
            arr = (arr.astype(np.float32) * (1 - 0.8 * k) + 255 * 0.8 * k).astype(np.uint8)
        return arr


# --------------------------------------------------------------------------- #
# Music (procedural, numpy only)
# --------------------------------------------------------------------------- #


def _t(n: int) -> np.ndarray:
    return np.arange(n, dtype=np.float32) / SR


def _midi(m: float) -> float:
    return 440.0 * 2 ** ((m - 69) / 12)


def _add(buf: np.ndarray, sig: np.ndarray, at: float, gain: float = 1.0) -> None:
    i = int(at * SR)
    if 0 <= i < len(buf):
        sig = sig[: len(buf) - i]
        buf[i:i + len(sig)] += sig * gain


def _tone(freq: float, dur: float, harmonics=(1.0,), decay: float = 0.0, vibrato: float = 0.0,
          attack: float = 0.005, release: float = 0.05) -> np.ndarray:
    n = max(2, int(dur * SR))
    t = _t(n)
    f = freq * (1 + vibrato * np.sin(2 * np.pi * 5.5 * t))
    phase = 2 * np.pi * np.cumsum(f) / SR
    sig = np.zeros(n, dtype=np.float32)
    for k, amp in enumerate(harmonics, start=1):
        if k * freq >= SR / 2:
            break
        part = amp * np.sin(k * phase)
        sig += part * np.exp(-t * decay * (1 + 0.6 * (k - 1))) if decay else part
    env = np.minimum(1.0, t / attack) * np.clip((dur - t) / release, 0, 1)
    return (sig * env).astype(np.float32)


def _kick(dur=0.4, f0=150.0, f1=45.0, decay=8.0) -> np.ndarray:
    t = _t(int(dur * SR))
    f = f1 + (f0 - f1) * np.exp(-t * 30)
    return (np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t * decay)).astype(np.float32)


def _noise_hit(rng, dur: float, decay: float, hp: int = 1, tone: float = 0.0) -> np.ndarray:
    n = int(dur * SR)
    t = _t(n)
    x = rng.standard_normal(n).astype(np.float32)
    for _ in range(hp):
        x = np.diff(x, prepend=0)
    x = x / (np.abs(x).max() + 1e-9) * np.exp(-t * decay)
    if tone:
        x += 0.6 * np.sin(2 * np.pi * tone * t) * np.exp(-t * decay * 1.3)
    return x.astype(np.float32)


def _lowpass(x: np.ndarray, cutoff: float) -> np.ndarray:
    spec = np.fft.rfft(x)
    freqs = np.fft.rfftfreq(len(x), 1 / SR)
    spec *= 1 / (1 + (freqs / cutoff) ** 4)
    return np.fft.irfft(spec, len(x)).astype(np.float32)


def _reverb(x: np.ndarray, seconds: float, mix: float, rng) -> np.ndarray:
    n = int(seconds * SR)
    ir = rng.standard_normal(n).astype(np.float32) * np.exp(-_t(n) * 6.9 / seconds)
    ir = _lowpass(ir, 5000)
    ir /= np.sqrt(np.sum(ir ** 2)) + 1e-9
    size = 1 << (len(x) + n - 1).bit_length()
    wet = np.fft.irfft(np.fft.rfft(x, size) * np.fft.rfft(ir, size), size)[: len(x)]
    wet *= (np.std(x) + 1e-9) / (np.std(wet) + 1e-9)
    return (x * (1 - mix) + wet * mix).astype(np.float32)


def _trap(dur: float, rng) -> tuple[np.ndarray, list[float]]:
    bpm = float(rng.choice([140, 145, 150]))
    step = 60 / bpm / 4
    buf = np.zeros(int(dur * SR) + SR, dtype=np.float32)
    progs = [[57, 53, 48, 55], [57, 55, 53, 52], [50, 53, 48, 55]]
    prog = progs[rng.integers(len(progs))]
    kicks = [[0, 6, 10], [0, 7, 10, 14], [0, 3, 8, 11]][rng.integers(3)]
    beats, bar, t0 = [], 0, 0.0
    while t0 < dur:
        root = prog[bar % len(prog)]
        _add(buf, _tone(_midi(root - 24), 16 * step, (1, 0.35, 0.12), decay=0.9, release=0.08), t0, 0.9)
        for st in kicks:
            _add(buf, _kick(), t0 + st * step, 0.9)
            beats.append(t0 + st * step)
        for st in (4, 12):
            _add(buf, _noise_hit(rng, 0.25, 22, 1, tone=190), t0 + st * step, 0.45)
        roll = bar % 4 == 3
        for st in range(0, 16, 1 if roll else 2):
            _add(buf, _noise_hit(rng, 0.05, 90, 2), t0 + st * step, 0.16)
        for st in (0, 10):  # minor chord stab
            for iv in (0, 3, 7):
                _add(buf, _tone(_midi(root + 12 + iv), 0.35, (1, 0.5, 0.33, 0.25), decay=7), t0 + st * step, 0.12)
        bar += 1
        t0 += 16 * step
    return buf, beats


def _lofi(dur: float, rng) -> tuple[np.ndarray, list[float]]:
    beat = 60 / float(rng.choice([78, 82, 86]))
    buf = np.zeros(int(dur * SR) + SR, dtype=np.float32)
    chords = [[65, 69, 72, 76], [64, 67, 71, 74], [62, 65, 69, 72], [60, 64, 67, 71]]
    start = int(rng.integers(len(chords)))
    bar, t0 = 0, 0.0
    while t0 < dur:
        for m in chords[(start + bar) % len(chords)]:
            _add(buf, _tone(_midi(m), 4 * beat, (1, 0.25, 0.08), decay=0.35, vibrato=0.002,
                            attack=0.02, release=0.4), t0, 0.16)
        _add(buf, _tone(_midi(chords[(start + bar) % len(chords)][0] - 24), 4 * beat, (1, 0.3),
                        decay=0.5, release=0.2), t0, 0.35)
        for b in (0, 2.5):
            _add(buf, _kick(0.3, 110, 50, 12), t0 + b * beat, 0.5)
        for b in (1, 3):
            _add(buf, _noise_hit(rng, 0.2, 28, 1), t0 + b * beat, 0.18)
        for b in range(8):
            swing = 0.08 * beat if b % 2 else 0
            _add(buf, _noise_hit(rng, 0.04, 100, 2), t0 + b * beat / 2 + swing, 0.07)
        bar += 1
        t0 += 4 * beat
    crackle = np.zeros_like(buf)
    idx = rng.integers(0, len(buf), int(dur * 25))
    crackle[idx] = rng.uniform(-0.15, 0.15, len(idx))
    return _lowpass(buf, 3800) + crackle, []


def _heartbeat(dur: float, rng) -> tuple[np.ndarray, list[float]]:
    beat = 60 / float(rng.choice([62, 66, 70]))
    n = int(dur * SR) + SR
    t = _t(n)
    span = (n + 2) / SR
    lfo = 0.6 + 0.4 * np.sin(2 * np.pi * 0.15 * t)
    buf = (_tone(55, span, (1, 0.5, 0.25), attack=1.5, release=1.0)[:n] * 0.35
           + _tone(58.27, span, (1, 0.4), attack=2.5, release=1.0)[:n] * 0.2) * lfo
    eerie = _tone(_midi(81), span, (1,), vibrato=0.006, attack=span * 0.8, release=1.0)[:n]
    buf = buf + eerie * 0.05 * (0.5 + 0.5 * np.sin(2 * np.pi * 7 * t))
    beats, t0 = [], 0.4
    while t0 < dur:
        _add(buf, _kick(0.3, 85, 40, 14), t0, 0.9)
        _add(buf, _kick(0.25, 75, 38, 16), t0 + 0.2, 0.55)
        _add(buf, _noise_hit(rng, 0.02, 200, 2, tone=2200), t0 + beat / 2, 0.05)
        beats.append(t0)
        t0 += beat
    return _reverb(_lowpass(buf.astype(np.float32), 2500), 1.8, 0.3, rng), beats


HICAZ = (0, 1, 4, 5, 7, 8, 10, 12)  # D Eb F# G A Bb C D — the classic arabesk makam


def _saz(freq: float, dur: float) -> np.ndarray:
    return _tone(freq, dur, (1, 0.7, 0.5, 0.35, 0.22, 0.14, 0.08), decay=3.2, vibrato=0.0025,
                 attack=0.002, release=0.08)


def _hicaz(dur: float, rng) -> tuple[np.ndarray, list[float]]:
    beat = 60 / float(rng.choice([66, 70, 74]))
    buf = np.zeros(int(dur * SR) + 2 * SR, dtype=np.float32)
    root = 62
    # Strings: D - Cm - Gm - D, slow attack, the "orchestra" of every arabesk record
    pads = [[50, 54, 57, 62], [48, 51, 55, 60], [55, 58, 62, 67], [50, 54, 57, 62]]
    bar, t0 = 0, 0.0
    while t0 < dur:
        for m in pads[(bar // 2) % len(pads)]:
            _add(buf, _tone(_midi(m), 8 * beat + 0.8, (1, 0.5, 0.33, 0.25, 0.2), vibrato=0.003,
                            attack=0.9, release=0.9), t0, 0.07)
        bar += 2
        t0 += 8 * beat
    # Baglama melody: random walk on the Hicaz scale, long notes as tremolo picking
    rhythms = [[1, 0.5, 0.5, 2], [1.5, 0.5, 1, 1], [0.5, 0.5, 1, 2], [2, 1, 1]]
    idx, t0 = 4, beat * 2
    while t0 < dur:
        for length in rhythms[rng.integers(len(rhythms))]:
            idx = int(np.clip(idx + rng.choice([-2, -1, -1, 1, 1, 2]), 0, len(HICAZ) - 1))
            f = _midi(root + HICAZ[idx])
            note = length * beat
            if length >= 1:
                pick = 0.075
                k = 0
                while k * pick < note:
                    _add(buf, _saz(f, 0.25), t0 + k * pick, 0.22 * (0.85 if k % 2 else 1.0))
                    k += 1
            else:
                _add(buf, _saz(f, note + 0.4), t0, 0.3)
            t0 += note
        if rng.random() < 0.5:  # resolve phrases on the root, the way the lament "sighs"
            _add(buf, _saz(_midi(root), 2 * beat), t0, 0.28)
            idx, t0 = 0, t0 + 2 * beat
    # Darbuka, maksum pattern: DUM tek - tek DUM - tek -
    beats, t0 = [], 0.0
    while t0 < dur:
        for pos, hit in ((0, "D"), (1, "T"), (3, "T"), (4, "D"), (6, "T")):
            at = t0 + pos * beat / 2
            if hit == "D":
                _add(buf, _kick(0.35, 120, 75, 9), at, 0.45)
                beats.append(at)
            else:
                _add(buf, _noise_hit(rng, 0.08, 55, 2, tone=900), at, 0.12)
        t0 += 4 * beat
    return _reverb(_lowpass(buf, 6000), 2.4, 0.35, rng), beats


MUSIC = {"trap": _trap, "lofi": _lofi, "heartbeat": _heartbeat, "hicaz": _hicaz}


def make_music(s: Style, duration: float, seed: int = 0) -> tuple[np.ndarray, list[float]]:
    """Mono float32 track at SR, peak-normalised, plus beat times for visuals."""
    rng = np.random.default_rng(seed)
    buf, beats = MUSIC[s.music](duration, rng)
    buf = buf[: int(duration * SR)]
    n = len(buf)
    fade_in, fade_out = int(0.25 * SR), int(min(1.2, duration / 4) * SR)
    buf[:fade_in] *= np.linspace(0, 1, fade_in)
    buf[n - fade_out:] *= np.linspace(1, 0, fade_out)
    return buf / (np.abs(buf).max() + 1e-9), [b for b in beats if b < duration]


def _moving_avg(x: np.ndarray, win: int) -> np.ndarray:
    c = np.cumsum(np.concatenate([[0.0], x]))
    out = (c[win:] - c[:-win]) / win
    pad = len(x) - len(out)
    return np.pad(out, (pad // 2, pad - pad // 2), mode="edge")


def mix_tracks(voice: np.ndarray, music: np.ndarray, s: Style) -> np.ndarray:
    """Voice + music (stereo float32 at SR). Music sits `music_level` under the
    voice RMS and ducks a further ~6 dB while the narrator is talking."""
    n = len(music)
    v = voice if voice.ndim == 2 else voice[:, None]
    if v.shape[1] == 1:
        v = np.repeat(v, 2, axis=1)
    out = np.zeros((n, 2), dtype=np.float32)
    out[: min(n, len(v))] = v[:n]

    level = np.abs(out).mean(axis=1)
    talking = _moving_avg(level, int(0.2 * SR))
    speech = talking > 0.1 * (talking.max() + 1e-9)
    voice_rms = float(np.sqrt(np.mean(out[speech] ** 2))) if speech.any() else 0.1
    music_rms = float(np.sqrt(np.mean(music ** 2))) + 1e-9
    duck = 1 - 0.5 * _moving_avg(speech.astype(np.float32), int(0.3 * SR))
    out += (music * (s.music_level * voice_rms / music_rms) * duck)[:, None]
    peak = np.abs(out).max()
    return out * (0.97 / peak) if peak > 0.97 else out


def random_hook(s: Style) -> str:
    return random.choice(s.hooks)
