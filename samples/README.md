# ARGUS sample import files

Small, ready-to-import samples that double as **format templates** for the non-CDR/IPDR importers.
(CDR and IPDR samples are intentionally omitted — use your own case dumps for those.)

All importers are flexible: headers are matched case-insensitively against known aliases, and you can
re-map columns in the upload preview. `.csv`, `.xls`, `.xlsx` and `.txt` are all accepted.

| File | Import via | Notes |
|------|-----------|-------|
| `sample_towers.csv` | Dashboard → **Towers** tile | Tower registry: `tower_id` + lat/long + city/state. Grows the permanent tower repository. |
| `sample_tower_dump.csv` | **Tower Dump** tab → Import (label e.g. `Scene A`) | One cell's dump. `msisdn,imei,imsi,other_party,start_time,call_type,tower_id,cell_id,lac`. |
| `sample_tower_dump_scene2.csv` | **Tower Dump** tab → Import (label e.g. `Scene B`) | A second scene. Import both, then run **Common numbers** — `9810012345` and `9820055667` appear in BOTH. |
| `sample_sdr.csv` | Dashboard → **SDR** tile | Subscriber/CAF data, global by number. Shows on the subject profile + dossier. |

## Things to try with these
- **Tower Dump → Common numbers** across `Scene A` + `Scene B` → the two repeat numbers surface ("present at both scenes").
- **Tower Dump → SIM/IMEI multiplicity** → `9820055667` used two IMEIs (`…672` and `…999999`).
- **SDR** → open `9810012345`'s profile → the **Subscriber (SDR)** card shows "Ramesh Kumar"; it also appears in the dossier POIs.
- The numbers use real allocation series, so the profile's **Operator / Circle** line resolves (e.g. `9810` → Airtel / Delhi).
