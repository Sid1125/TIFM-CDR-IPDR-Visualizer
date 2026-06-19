"""
Inference module for the fine-tuned Qwen TIFM model.
Single-pass: fine-tuned model answers directly with trimmed analytics for speed.
"""

from __future__ import annotations

import json
import logging
import threading
from pathlib import Path
from typing import Any

import torch
from peft import PeftModel
from transformers import (
    AutoModelForCausalLM,
    AutoTokenizer,
    BitsAndBytesConfig,
)

logger = logging.getLogger(__name__)

BASE_MODEL_ID = "./llm_models/Qwen2.5-3B-Instruct"
ADAPTER_PATH = Path(__file__).parents[2] / "tifm_lora_output"

_model = None
_tokenizer = None
_adapter_loaded = False
_load_lock = threading.Lock()

FINETUNE_SYSTEM = (
    "You are a Telecom Intelligence Assistant \u2014 an expert digital forensics investigator "
    "trained to analyze Call Detail Records (CDR), IP Detail Records (IPDR), and TIFM "
    "multi-agent analytics. Your role is to interpret structured analytics data and provide "
    "clear, evidence-driven answers to investigation questions. Always cite specific metrics, "
    "highlight anomalies, and assess confidence levels. Use professional forensics language."
)

MAX_ANALYTICS_CHARS = 2000


def load_model():
    global _model, _tokenizer, _adapter_loaded

    if _adapter_loaded:
        return

    if not ADAPTER_PATH.exists():
        logger.warning(f"No LoRA adapter found at {ADAPTER_PATH}.")
        return

    with _load_lock:
        if _adapter_loaded:
            return

        try:
            logger.info("Loading base model in 4-bit ...")
            _tokenizer = AutoTokenizer.from_pretrained(
                BASE_MODEL_ID, trust_remote_code=True
            )
            _tokenizer.pad_token = _tokenizer.eos_token

            bnb_config = BitsAndBytesConfig(
                load_in_4bit=True,
                bnb_4bit_quant_type="nf4",
                bnb_4bit_compute_dtype=torch.float16,
                bnb_4bit_use_double_quant=True,
            )

            base = AutoModelForCausalLM.from_pretrained(
                BASE_MODEL_ID,
                quantization_config=bnb_config,
                device_map="auto",
                trust_remote_code=True,
            )

            logger.info("Loading LoRA adapter ...")
            _model = PeftModel.from_pretrained(base, str(ADAPTER_PATH))
            _model.eval()
            _adapter_loaded = True
            logger.info("Fine-tuned model loaded successfully.")
        except Exception as e:
            logger.error(f"Failed to load fine-tuned model: {e}")
            import traceback
            traceback.print_exc()


def unload_model():
    global _model, _tokenizer, _adapter_loaded
    with _load_lock:
        if _model is not None:
            del _model
        if _tokenizer is not None:
            del _tokenizer
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
        _model = None
        _tokenizer = None
        _adapter_loaded = False


def generate_answer(
    analytics: dict[str, Any],
    question: str,
    context_chips: list[str] | None = None,
    max_new_tokens: int = 1024,
    temperature: float = 0.3,
) -> str:
    if not _adapter_loaded:
        load_model()
    if not _adapter_loaded or _model is None or _tokenizer is None:
        return "Fine-tuned model not available. Please run train_qwen_tifm.py first."

    analytics_json = json.dumps(analytics, indent=2, default=str)
    if len(analytics_json) > MAX_ANALYTICS_CHARS:
        analytics_json = analytics_json[:MAX_ANALYTICS_CHARS] + "\n  ... [truncated]"

    user_content = f"TIFM Analytics:\n{analytics_json}"
    if context_chips:
        user_content += f"\n\nActive context: {', '.join(context_chips)}"
    user_content += f"\n\nInvestigator Question: {question}"

    messages = [
        {"role": "system", "content": FINETUNE_SYSTEM},
        {"role": "user", "content": user_content},
    ]

    text = _tokenizer.apply_chat_template(
        messages, tokenize=False, add_generation_prompt=True
    )

    inputs = _tokenizer(text, return_tensors="pt", truncation=True, max_length=2048)
    inputs = {k: v.to(_model.device) for k, v in inputs.items()}

    with torch.no_grad():
        outputs = _model.generate(
            **inputs,
            max_new_tokens=max_new_tokens,
            temperature=temperature,
            top_p=0.9,
            do_sample=True,
            pad_token_id=_tokenizer.eos_token_id,
        )

    generated = outputs[0][inputs["input_ids"].shape[1]:]
    answer = _tokenizer.decode(generated, skip_special_tokens=True).strip()
    return answer
