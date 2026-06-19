"""Generate the frontend copy of the shared attribution knowledge base.

Reads the canonical backend/app/data/attribution_data.json and writes
backend/static/attribution_data.js, which defines a global `ATTR_DATA` consumed by
app.js. Run this after editing the JSON:

    python scripts/gen_attribution_js.py
"""
import json
import os

HERE = os.path.dirname(__file__)
SRC = os.path.join(HERE, "..", "app", "data", "attribution_data.json")
OUT = os.path.join(HERE, "..", "static", "attribution_data.js")

with open(SRC, encoding="utf-8") as handle:
    data = json.load(handle)

banner = (
    "// AUTO-GENERATED from app/data/attribution_data.json by scripts/gen_attribution_js.py\n"
    "// Do not edit by hand — edit the JSON and re-run the generator.\n"
)

with open(OUT, "w", encoding="utf-8") as handle:
    handle.write(banner)
    handle.write("var ATTR_DATA = " + json.dumps(data, separators=(",", ":")) + ";\n")

print(f"wrote {os.path.relpath(OUT)} ({os.path.getsize(OUT)} bytes)")
