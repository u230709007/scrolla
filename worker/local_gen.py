"""
AlphaScroll — local GPU generation (optional, zero cost, no rate limits)
=======================================================================

  image  : SDXL-Lightning 4-step (ByteDance) — 768x1344 poster in a few seconds,
           replaces Pollinations when a CUDA GPU is present (IMAGE_ENGINE=auto)
  motion : LTX-Video 2B distilled (Lightricks) image-to-video — animates that
           poster into a ~5s clip that loops behind the captions (--motion)

Sized for an 8 GB laptop GPU: everything runs in fp16/bf16 with CPU offload,
the 19 GB T5 text encoder is loaded 8-bit just long enough to embed the prompt,
and models are freed after each use so the daemon doesn't sit on 10+ GB.
Weights download once to the Hugging Face cache on first use.
"""

from __future__ import annotations

import gc
import logging
from pathlib import Path

import requests

log = logging.getLogger("alphascroll")

SDXL_CKPT = "https://huggingface.co/ByteDance/SDXL-Lightning/blob/main/sdxl_lightning_4step.safetensors"
LTX_CKPT = "https://huggingface.co/Lightricks/LTX-Video/blob/main/ltxv-2b-0.9.8-distilled.safetensors"
LTX_REPO = "Lightricks/LTX-Video-0.9.5"  # tokenizer, T5 text encoder, scheduler config
IMAGE_SIZE = (768, 1344)                   # SDXL's native 9:16-ish bucket
MOTION_SIZE = (480, 832)                   # multiples of 32, ~9:16
MOTION_FPS = 24
MOTION_NEGATIVE = "worst quality, inconsistent motion, blurry, jittery, distorted, text, watermark"


def available() -> bool:
    try:
        import torch

        return torch.cuda.is_available()
    except ImportError:
        return False


def release_ollama(url: str, model: str) -> None:
    """Ollama keeps its model in VRAM for 5 min; evict it so diffusion fits in 8 GB."""
    if not model:
        return
    try:
        requests.post(f"{url}/api/generate", json={"model": model, "keep_alive": 0}, timeout=15)
    except requests.RequestException:
        pass


def _free() -> None:
    import torch

    gc.collect()
    torch.cuda.empty_cache()


def generate_image(prompt: str, out_path: Path, seed: int) -> Path:
    import torch
    from diffusers import EulerDiscreteScheduler, StableDiffusionXLPipeline

    pipe = StableDiffusionXLPipeline.from_single_file(SDXL_CKPT, torch_dtype=torch.float16)
    # Lightning is distilled for "trailing" timesteps and no CFG
    pipe.scheduler = EulerDiscreteScheduler.from_config(pipe.scheduler.config, timestep_spacing="trailing")
    pipe.enable_model_cpu_offload()
    pipe.enable_vae_tiling()
    width, height = IMAGE_SIZE
    image = pipe(
        prompt=prompt, width=width, height=height, num_inference_steps=4, guidance_scale=0.0,
        generator=torch.Generator("cpu").manual_seed(seed),
    ).images[0]
    image.save(out_path, quality=95)
    del pipe
    _free()
    return out_path


def _embed_prompt(prompt: str):
    """T5-XXL is 19 GB in fp32: load it 8-bit on the GPU (~5 GB), embed, drop it."""
    import torch
    from diffusers import LTXConditionPipeline
    from transformers import BitsAndBytesConfig, T5EncoderModel

    text_encoder = T5EncoderModel.from_pretrained(
        LTX_REPO, subfolder="text_encoder", torch_dtype=torch.bfloat16,
        quantization_config=BitsAndBytesConfig(load_in_8bit=True), device_map="cuda",
    )
    pipe = LTXConditionPipeline.from_pretrained(LTX_REPO, text_encoder=text_encoder,
                                                transformer=None, vae=None, torch_dtype=torch.bfloat16)
    with torch.no_grad():
        embeds, mask, _, _ = pipe.encode_prompt(
            prompt=prompt, do_classifier_free_guidance=False, max_sequence_length=256, device="cuda",
        )
    embeds, mask = embeds.to("cpu", torch.bfloat16), mask.to("cpu")
    del pipe, text_encoder
    _free()
    return embeds, mask


def generate_motion(image_path: Path, prompt: str, out_path: Path, seed: int,
                    num_frames: int = 121) -> Path:
    """Animate the poster: ~5s at 24 fps (num_frames must be 8k+1)."""
    import torch
    from diffusers import AutoencoderKLLTXVideo, LTXConditionPipeline, LTXVideoTransformer3DModel
    from diffusers.pipelines.ltx.pipeline_ltx_condition import LTXVideoCondition
    from diffusers.utils import export_to_video
    from PIL import Image

    embeds, mask = _embed_prompt(prompt)

    transformer = LTXVideoTransformer3DModel.from_single_file(LTX_CKPT, torch_dtype=torch.bfloat16)
    vae = AutoencoderKLLTXVideo.from_single_file(LTX_CKPT, torch_dtype=torch.bfloat16)
    pipe = LTXConditionPipeline.from_pretrained(LTX_REPO, transformer=transformer, vae=vae,
                                                text_encoder=None, tokenizer=None,
                                                torch_dtype=torch.bfloat16)
    pipe.enable_model_cpu_offload()
    pipe.vae.enable_tiling()

    width, height = MOTION_SIZE
    image = Image.open(image_path).convert("RGB").resize((width, height), Image.LANCZOS)
    frames = pipe(
        conditions=[LTXVideoCondition(image=image, frame_index=0)],
        prompt_embeds=embeds.to("cuda"), prompt_attention_mask=mask.to("cuda"),
        width=width, height=height, num_frames=num_frames,
        # distilled schedule from the LTX-Video reference configs
        timesteps=[1000, 993, 987, 981, 975, 909, 725, 0.03],
        guidance_scale=1.0, decode_timestep=0.05, decode_noise_scale=0.025,
        image_cond_noise_scale=0.0, guidance_rescale=0.7,
        generator=torch.Generator("cpu").manual_seed(seed),
    ).frames[0]
    export_to_video(frames, str(out_path), fps=MOTION_FPS)
    del pipe, transformer, vae
    _free()
    return out_path
