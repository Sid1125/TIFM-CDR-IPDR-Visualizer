"""Refresh provider IP ranges from official published feeds.

Several large providers publish their own authoritative IP-range feeds. Curated
ranges in app/data/attribution_data.json go stale; this script fetches the live
feeds and writes them where the attribution engine already looks:

  * Default: backend/data/asn_ranges.csv  (gitignored, pluggable loader path)
      The engine (service_attribution_service._load_external_ranges) merges this
      at import time, and longest-prefix matching means these fresh, comprehensive
      ranges win over the broad curated summaries automatically. This is the
      recommended mode — it keeps the committed JSON small while giving runtime
      coverage of every published prefix.

  * --update-json: additionally fold *small* providers' collapsed ranges back into
      app/data/attribution_data.json (those whose collapsed count <= --max-json),
      so the committed curated summary for Cloudflare/Fastly/GitHub stays current.
      Large feeds (AWS, Google) are left to the CSV only, to avoid bloating the JSON.
      Re-run scripts/gen_attribution_js.py afterwards to refresh the frontend copy.

Stdlib only (urllib/json/csv/ipaddress) — no extra dependencies. Each feed is
fetched independently and best-effort: a failing feed is reported and skipped, and
the CSV/JSON is only written if at least one feed succeeded.

Usage:
    python scripts/fetch_provider_ranges.py                 # write CSV (IPv4)
    python scripts/fetch_provider_ranges.py --ipv6          # include IPv6
    python scripts/fetch_provider_ranges.py --update-json   # also refresh small providers in JSON
    python scripts/fetch_provider_ranges.py --only AWS,Cloudflare
"""
from __future__ import annotations

import argparse
import csv
import ipaddress
import json
import os
import ssl
import sys
import urllib.request
from datetime import datetime, timezone

HERE = os.path.dirname(__file__)
JSON_PATH = os.path.join(HERE, "..", "app", "data", "attribution_data.json")
CSV_PATH = os.path.join(HERE, "..", "data", "asn_ranges.csv")

USER_AGENT = "TIFM-CDR-Visualizer/provider-range-fetcher"
TIMEOUT = 30

# Built once in main(); some feeds (e.g. Fastly) fail with the OS trust store on
# Windows where stdlib urllib can't find the issuer, so prefer certifi's bundle.
_SSL_CTX = None


def _build_ssl_context(insecure):
    if insecure:
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        return ctx
    try:
        import certifi  # type: ignore
        return ssl.create_default_context(cafile=certifi.where())
    except Exception:  # noqa: BLE001 - certifi optional; fall back to OS trust store
        return ssl.create_default_context()


def _get(url):
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=TIMEOUT, context=_SSL_CTX) as resp:
        return resp.read().decode("utf-8", "replace")


def _get_json(url):
    return json.loads(_get(url))


# --- Per-provider feed parsers --------------------------------------------------
# Each returns a flat list of CIDR strings (IPv4 and/or IPv6).

def feed_aws():
    data = _get_json("https://ip-ranges.amazonaws.com/ip-ranges.json")
    out = [p["ip_prefix"] for p in data.get("prefixes", []) if p.get("ip_prefix")]
    out += [p["ipv6_prefix"] for p in data.get("ipv6_prefixes", []) if p.get("ipv6_prefix")]
    return out


def feed_google():
    # goog.json is Google's complete published set (Cloud + corporate + crawlers).
    data = _get_json("https://www.gstatic.com/ipranges/goog.json")
    out = []
    for p in data.get("prefixes", []):
        if p.get("ipv4Prefix"):
            out.append(p["ipv4Prefix"])
        elif p.get("ipv6Prefix"):
            out.append(p["ipv6Prefix"])
    return out


def feed_cloudflare():
    out = [ln.strip() for ln in _get("https://www.cloudflare.com/ips-v4").splitlines() if ln.strip()]
    out += [ln.strip() for ln in _get("https://www.cloudflare.com/ips-v6").splitlines() if ln.strip()]
    return out


def feed_fastly():
    data = _get_json("https://api.fastly.com/public-ip-list")
    return list(data.get("addresses", [])) + list(data.get("ipv6_addresses", []))


def feed_github():
    data = _get_json("https://api.github.com/meta")
    # Only GitHub's own user-facing ranges. Deliberately exclude `actions` (and
    # similar), which are thousands of Azure-hosted runner IPs that would mislabel
    # Microsoft/Azure traffic as GitHub.
    keys = ("hooks", "web", "api", "git", "pages", "importer", "packages")
    out = []
    for key in keys:
        for item in data.get(key, []):
            if isinstance(item, str) and "/" in item:
                out.append(item)
    return out


# (provider name as it appears in attribution_data.json, is_isp, parser)
FEEDS = [
    ("Amazon", False, feed_aws),
    ("Google", False, feed_google),
    ("Cloudflare", False, feed_cloudflare),
    ("Fastly", False, feed_fastly),
    ("GitHub", False, feed_github),
]


def _collapse(cidrs, include_ipv6):
    """Parse, drop the wrong family, and collapse to the minimal covering set."""
    v4, v6 = [], []
    for c in cidrs:
        try:
            net = ipaddress.ip_network(c.strip(), strict=False)
        except ValueError:
            continue
        (v4 if net.version == 4 else v6).append(net)
    nets = list(ipaddress.collapse_addresses(v4))
    if include_ipv6:
        nets += list(ipaddress.collapse_addresses(v6))
    return nets


def main(argv=None):
    ap = argparse.ArgumentParser(description="Refresh provider IP ranges from official feeds.")
    ap.add_argument("--ipv6", action="store_true", help="include IPv6 prefixes (default IPv4 only)")
    ap.add_argument("--update-json", action="store_true",
                    help="also fold small providers' ranges into attribution_data.json")
    ap.add_argument("--max-json", type=int, default=40,
                    help="max collapsed ranges to fold into JSON per provider (default 40)")
    ap.add_argument("--only", default="",
                    help="comma-separated provider names to fetch (default: all)")
    ap.add_argument("--csv", default=CSV_PATH, help="output CSV path")
    ap.add_argument("--insecure", action="store_true",
                    help="skip TLS certificate verification (last resort)")
    args = ap.parse_args(argv)

    global _SSL_CTX
    _SSL_CTX = _build_ssl_context(args.insecure)

    only = {s.strip().lower() for s in args.only.split(",") if s.strip()}
    feeds = [f for f in FEEDS if not only or f[0].lower() in only]
    if not feeds:
        print(f"No matching providers for --only={args.only!r}. Known: "
              + ", ".join(f[0] for f in FEEDS), file=sys.stderr)
        return 2

    results = {}  # provider -> list[ip_network]
    failures = []
    for provider, _is_isp, parser in feeds:
        try:
            raw = parser()
            nets = _collapse(raw, args.ipv6)
            results[provider] = nets
            print(f"  {provider:<12} {len(raw):>5} prefixes -> {len(nets):>5} collapsed")
        except Exception as exc:  # noqa: BLE001 - best-effort per feed
            failures.append(provider)
            print(f"  {provider:<12} FAILED: {exc}", file=sys.stderr)

    if not results:
        print("All feeds failed; nothing written.", file=sys.stderr)
        return 1

    isp_flag = {p: is_isp for p, is_isp, _ in FEEDS}
    os.makedirs(os.path.dirname(os.path.abspath(args.csv)), exist_ok=True)
    total = 0
    with open(args.csv, "w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        writer.writerow(["network", "provider", "is_isp"])
        writer.writerow([f"# generated {datetime.now(timezone.utc).isoformat()} "
                         f"by fetch_provider_ranges.py", "", ""])
        for provider, nets in sorted(results.items()):
            for net in nets:
                writer.writerow([str(net), provider, "1" if isp_flag.get(provider) else "0"])
                total += 1
    print(f"\nWrote {total} ranges for {len(results)} providers -> {os.path.relpath(args.csv)}")

    if args.update_json:
        _update_json(results, args.max_json)

    if failures:
        print(f"\nNote: {len(failures)} feed(s) failed and were skipped: {', '.join(failures)}",
              file=sys.stderr)
    return 0


def _update_json(results, max_json):
    """Fold small providers' collapsed IPv4 ranges into the curated JSON."""
    with open(JSON_PATH, encoding="utf-8") as handle:
        data = json.load(handle)
    by_name = {p.get("pr"): p for p in data.get("providers", [])}
    updated = []
    for provider, nets in sorted(results.items()):
        v4 = [str(n) for n in nets if n.version == 4]
        if provider not in by_name:
            continue
        if len(v4) > max_json:
            print(f"  skip JSON {provider}: {len(v4)} ranges > --max-json {max_json} (CSV only)")
            continue
        by_name[provider]["ranges"] = v4
        updated.append(f"{provider} ({len(v4)})")
    if not updated:
        print("No providers small enough to fold into JSON.")
        return
    with open(JSON_PATH, "w", encoding="utf-8") as handle:
        json.dump(data, handle, indent=2, ensure_ascii=False)
        handle.write("\n")
    print(f"Updated attribution_data.json: {', '.join(updated)}")
    print("Now run: python scripts/gen_attribution_js.py")


if __name__ == "__main__":
    raise SystemExit(main())
