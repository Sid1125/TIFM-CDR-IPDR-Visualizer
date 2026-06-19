"""Quick test for generate_synthetic_case."""
import sys, traceback
sys.path.insert(0, '.')
from app.ai.dataset_generator import generate_synthetic_case

for scenario in ['criminal', 'drug', 'scam', 'human_trafficking', 'financial_fraud']:
    try:
        data = generate_synthetic_case(scenario=scenario)
        print(f'{scenario}: CDR={len(data["cdr"])}, IPDR={len(data["ipdr"])}, Towers={len(data["towers"])}')
        if data['cdr']:
            print(f'  Sample CDR keys: {list(data["cdr"][0].keys())}')
        if data['ipdr']:
            print(f'  Sample IPDR keys: {list(data["ipdr"][0].keys())}')
    except Exception as e:
        print(f'{scenario}: ERROR - {e}')
        traceback.print_exc()
