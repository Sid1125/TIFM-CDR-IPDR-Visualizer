"""
QLoRA Fine-Tuning Script for Qwen 2.5 7B Instruct on TIFM Telecom Analytics.

Usage:
    pip install torch transformers accelerate peft bitsandbytes datasets trl
    python train_qwen_tifm.py

Requires a CUDA GPU with 8GB+ VRAM (Qwen 2.5 7B 4-bit LoRA).
"""

import json
import math
import sys
from pathlib import Path

import torch
from datasets import load_dataset
from transformers import (
    AutoModelForCausalLM,
    AutoTokenizer,
    BitsAndBytesConfig,
    TrainingArguments,
)
from peft import LoraConfig, get_peft_model, prepare_model_for_kbit_training
from trl import SFTTrainer, SFTConfig


# ── Configuration ──────────────────────────────────────────────────
MODEL_ID = "./llm_models/Qwen2.5-3B-Instruct"
DATASET_PATH = Path(__file__).parent / "app" / "ai" / "tifm_train.jsonl"
OUTPUT_DIR = Path(__file__).parent / "tifm_lora_output"
MERGE_OUTPUT_DIR = Path(__file__).parent / "tifm_merged"

# QLoRA bitsandbytes config
BNB_CONFIG = BitsAndBytesConfig(
    load_in_4bit=True,
    bnb_4bit_quant_type="nf4",
    bnb_4bit_compute_dtype=torch.bfloat16,
    bnb_4bit_use_double_quant=True,
)

# LoRA config
LORA_CONFIG = LoraConfig(
    r=16,
    lora_alpha=32,
    target_modules=["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"],
    lora_dropout=0.05,
    bias="none",
    task_type="CAUSAL_LM",
)

# Training arguments (conservative for 8GB VRAM)
TRAINING_ARGS = SFTConfig(
    per_device_train_batch_size=1,
    gradient_accumulation_steps=4,
    warmup_steps=150,
    max_steps=1500,
    learning_rate=2e-4,
    bf16=True,
    fp16=False,
    logging_steps=50,
    save_steps=500,
    eval_strategy="no",
    output_dir=str(OUTPUT_DIR),
    optim="paged_adamw_8bit",
    save_total_limit=2,
    report_to="none",
    max_length=1024,
)

def format_qwen_chat(example: dict) -> str:
    messages = [
        {"role": "system", "content": example["system"]},
        {"role": "user", "content": example["user"]},
        {"role": "assistant", "content": example["assistant"]},
    ]
    formatted = tokenizer.apply_chat_template(
        messages, tokenize=False, add_generation_prompt=False
    )
    return formatted


def main():
    # 1. Validate dataset
    if not DATASET_PATH.exists():
        print(f"Dataset not found at {DATASET_PATH}")
        print("Run `python -m app.ai.training_data` first.")
        sys.exit(1)

    # 2. Count examples
    with open(DATASET_PATH, encoding="utf-8") as f:
        example_count = sum(1 for _ in f)
    print(f"Loading {example_count} training examples from {DATASET_PATH}")

    # 3. Load tokenizer
    global tokenizer
    print(f"Loading tokenizer from {MODEL_ID} ...")
    tokenizer = AutoTokenizer.from_pretrained(MODEL_ID, trust_remote_code=True)
    tokenizer.pad_token = tokenizer.eos_token
    tokenizer.padding_side = "right"

    # 4. Load model with 4-bit quantization
    print(f"Loading {MODEL_ID} with 4-bit quantization ...")
    model = AutoModelForCausalLM.from_pretrained(
        MODEL_ID,
        quantization_config=BNB_CONFIG,
        device_map={"": 0},
        trust_remote_code=True,
    )
    model.config.use_cache = False
    model = prepare_model_for_kbit_training(model)
    model = get_peft_model(model, LORA_CONFIG)
    model.config.use_cache = False

    trainable_params = sum(p.numel() for p in model.parameters() if p.requires_grad)
    total_params = sum(p.numel() for p in model.parameters())
    print(f"Trainable params: {trainable_params:,} / {total_params:,} ({100 * trainable_params / total_params:.2f}%)")

    # 5. Load dataset
    dataset = load_dataset("json", data_files=str(DATASET_PATH), split="train")

    def format_batch(batch):
        texts = [format_qwen_chat({
            "system": s, "user": u, "assistant": a
        }) for s, u, a in zip(batch["system"], batch["user"], batch["assistant"])]
        return {"text": texts}

    dataset = dataset.map(format_batch, batched=True)

    # Print a sample formatted example
    print("\n--- Sample formatted example ---")
    print(dataset[0]["text"][:500] + "...")
    print("---\n")

    # 6. Train
    trainer = SFTTrainer(
        model=model,
        train_dataset=dataset,
        processing_class=tokenizer,
        args=TRAINING_ARGS,
    )

    print("Starting training ...")
    trainer.train()

    # 7. Save LoRA adapter
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    trainer.save_model(str(OUTPUT_DIR))
    tokenizer.save_pretrained(str(OUTPUT_DIR))
    print(f"LoRA adapter saved to {OUTPUT_DIR}")

    # 8. Optional: merge with base model
    print("Merging LoRA weights with base model ...")
    merged = model.merge_and_unload()
    MERGE_OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    merged.save_pretrained(str(MERGE_OUTPUT_DIR))
    tokenizer.save_pretrained(str(MERGE_OUTPUT_DIR))
    print(f"Merged model saved to {MERGE_OUTPUT_DIR}")


if __name__ == "__main__":
    main()
