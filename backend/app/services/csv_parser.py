from __future__ import annotations

import pandas as pd


def load_csv(file_path: str) -> pd.DataFrame:
    return pd.read_csv(file_path)
