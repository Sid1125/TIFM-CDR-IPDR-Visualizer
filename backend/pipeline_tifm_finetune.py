"""
TIFM Fine-Tuning Pipeline — one script to generate data, train, and export.

Usage:
    # Full pipeline: generate training data, then train
    python pipeline_tifm_finetune.py --train

    # Generate training data only
    python pipeline_tifm_finetune.py --generate-only

    # Load existing dataset and train only
    python pipeline_tifm_finetune.py --train-only
"""

import argparse
import sys
from pathlib import Path

# Add parent to path so imports work
BASE = Path(__file__).parent
sys.path.insert(0, str(BASE))


def main():
    parser = argparse.ArgumentParser(description="TIFM Fine-Tuning Pipeline")
    parser.add_argument("--generate-only", action="store_true", help="Only generate training data")
    parser.add_argument("--train-only", action="store_true", help="Only run training (dataset must exist)")
    parser.add_argument("--train", action="store_true", help="Generate data then train")
    parser.add_argument("--count", type=int, default=8, help="Examples per question type (default: 8)")
    parser.add_argument("--output", type=str, default=None, help="Output path for dataset")
    args = parser.parse_args()

    if not any([args.generate_only, args.train_only, args.train]):
        parser.print_help()
        sys.exit(1)

    dataset_path = args.output or str(BASE / "app" / "ai" / "tifm_train.jsonl")

    if args.generate_only or args.train:
        print("=" * 60)
        print("STEP 1: Generating training dataset")
        print("=" * 60)
        # Import and run dataset generation
        from app.ai.training_data import generate_dataset
        generate_dataset(dataset_path, count_per_type=args.count)

    if args.train_only or args.train:
        print()
        print("=" * 60)
        print("STEP 2: Starting QLoRA fine-tuning")
        print("=" * 60)
        if not Path(dataset_path).exists():
            print(f"Dataset not found at {dataset_path}. Run --generate-only first.")
            sys.exit(1)

        # Import and run training
        from train_qwen_tifm import main as train_main
        train_main()

    print()
    print("DONE. Fine-tuned model saved to:")
    print(f"  LoRA adapter: {BASE / 'tifm_lora_output'}")
    print(f"  Merged model: {BASE / 'tifm_merged'}")
    print()
    print("To use in the app:")
    print("  1. Restart the backend server")
    print('  2. In the AI Chat tab, select "FINE-TUNED TIFM" from the mode dropdown')
    print("  3. Type a question and click Analyze")


if __name__ == "__main__":
    main()
