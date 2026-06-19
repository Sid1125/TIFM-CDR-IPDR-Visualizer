from __future__ import annotations

import json
import random
import itertools
from pathlib import Path
from datetime import datetime, timedelta

random.seed(42)

SYSTEM_PROMPT = (
    "You are a Telecom Intelligence Assistant \u2014 an expert digital forensics investigator "
    "trained to analyze Call Detail Records (CDR), IP Detail Records (IPDR), and TIFM "
    "multi-agent analytics. Your role is to interpret structured analytics data and provide "
    "clear, evidence-driven answers to investigation questions. Always cite specific metrics, "
    "highlight anomalies, and assess confidence levels. Use professional forensics language."
)

SUBJECT_POOL = [
    # IP addresses (from IPDR counterpart data)
    "10.1.1.32", "10.1.6.22", "1.1.1.1", "10.1.3.15",
    "172.16.0.5", "192.168.1.100", "10.0.0.45", "172.18.2.10",
    # Phone numbers (from CDR a_party / MSISDN data)
    "+915555555501", "+915555555502", "+915555555503", "+915555555504",
    "+910123456789", "+910987654321", "+917777777701", "+917777777702",
]

IMSI_POOL = [
    "40412901338353", "40478177244239", "40447935789865", "40496469651729",
    "40478537279135", "40469464571817", "40496234993475", "40478438683251",
]

IMEI_POOL = [
    "3539385479847", "3594906782660", "3538066791933", "3533951383393",
    "3544160389756", "3514752700207", "3559957213856", "3537354091810",
]


def pick(arr):
    return arr[random.randint(0, len(arr) - 1)]


def synthetic_analytics(
    subject_count: int = 4,
    app_count: int = 3,
    meeting_count: int = 2,
    sim_swap_count: int = 0,
    device_change_count: int = 0,
    burner_scores: list[int] | None = None,
    roles: list[str] | None = None,
    communities: list[list[str]] | None = None,
) -> dict:
    burner_scores = burner_scores or [5, 10, 15, 8]
    roles = roles or ["Kingpin / Coordinator", "Hub Node / Lieutenant", "Member", "Bridge Node / Broker"]
    subjects = random.sample(SUBJECT_POOL, min(subject_count, len(SUBJECT_POOL)))

    network_nodes = {}
    for i, sub in enumerate(subjects):
        deg = round(random.uniform(0.1, 0.9), 3)
        bet = round(random.uniform(0.05, 0.7), 3)
        network_nodes[sub] = {
            "degree_centrality": deg,
            "betweenness_centrality": bet,
            "inferred_role": roles[i] if i < len(roles) else "Member",
        }

    identity = {}
    for i, sub in enumerate(subjects):
        sim_swaps = []
        device_changes = []
        base_imsi = IMSI_POOL[i % len(IMSI_POOL)]
        base_imei = IMEI_POOL[i % len(IMEI_POOL)]
        for s in range(sim_swap_count if i == 0 else 0):
            sim_swaps.append({
                "timestamp": (datetime.now() - timedelta(days=s * 2)).isoformat(),
                "imei": base_imei,
                "old_imsi": f"{IMSI_POOL[(i + s) % len(IMSI_POOL)]}",
                "new_imsi": f"{IMSI_POOL[(i + s + 1) % len(IMSI_POOL)]}",
                "type": "SIM Swap",
                "confidence": "High",
            })
        for d in range(device_change_count if i == 1 else 0):
            device_changes.append({
                "timestamp": (datetime.now() - timedelta(days=d * 3)).isoformat(),
                "imsi": base_imsi,
                "old_imei": base_imei,
                "new_imei": IMEI_POOL[(i + d + 1) % len(IMEI_POOL)],
                "type": "Device Change",
                "confidence": "High",
            })
        identity[sub] = {
            "unique_identities_count": 1 + len(sim_swaps) + len(device_changes),
            "unique_pairs": [f"IMSI: {base_imsi} / IMEI: {base_imei}"],
            "sim_swaps": sim_swaps,
            "device_changes": device_changes,
            "burner_score": burner_scores[i] if i < len(burner_scores) else 5,
            "is_suspected_burner": (burner_scores[i] if i < len(burner_scores) else 5) > 30,
        }

    towers = ["TWR_DEL_01", "TWR_DEL_02", "TWR_DEL_03", "TWR_MUM_01", "TWR_MUM_02"]
    movement = {}
    for i, sub in enumerate(subjects):
        movement[sub] = {
            "home_tower": towers[0],
            "work_tower": towers[1],
            "total_towers_visited": random.randint(1, len(towers)),
            "towers": towers[:random.randint(1, len(towers))],
            "mobility_index": pick(["High", "Medium", "Low"]),
        }

    meetings = []
    meeting_pairs = list(itertools.combinations(subjects[:min(4, len(subjects))], 2))
    for m in range(min(meeting_count, len(meeting_pairs))):
        a, b = meeting_pairs[m]
        base_time = datetime.now() - timedelta(days=m)
        meetings.append({
            "tower_id": towers[m % len(towers)],
            "subject_a": a,
            "subject_b": b,
            "time_a": base_time.isoformat(),
            "time_b": (base_time + timedelta(minutes=random.randint(5, 55))).isoformat(),
            "gap_minutes": round(random.uniform(3, 55), 2),
        })

    apps = ["WhatsApp", "Telegram", "Signal", "VPN", "Web"]
    attribution = {}
    for app in apps[:app_count]:
        attribution[app] = {
            "count": random.randint(5, 80),
            "confidence": random.randint(70, 98),
            "evidence": [f"Port match: {random.choice([443, 3478, 5222, 8443])}",
                          f"Protocol: {pick(['TCP', 'UDP'])}"],
        }

    comm_list = []
    if communities is None:
        mid = len(subjects) // 2
        if mid > 0:
            comm_list.append({"id": 1, "members": subjects[:mid]})
        if len(subjects) > mid:
            comm_list.append({"id": 2, "members": subjects[mid:]})
    else:
        comm_list = [{"id": i + 1, "members": c} for i, c in enumerate(communities)]

    return {
        "attribution": attribution,
        "identity": identity,
        "movement": {
            "subjects_movement": movement,
            "detected_meetings": meetings,
        },
        "network": {
            "nodes_count": len(subjects),
            "edges_count": random.randint(10, 40),
            "network_density": round(random.uniform(0.05, 0.6), 3),
            "centrality_metrics": network_nodes,
            "communities": comm_list,
        },
    }


def fmt_analytics(analytics: dict) -> str:
    return json.dumps(analytics, indent=2)


def make_example(analytics: dict, question: str, answer: str) -> dict:
    return {
        "system": SYSTEM_PROMPT,
        "user": f"TIFM Analytics:\n{fmt_analytics(analytics)}\n\nInvestigator Question: {question}",
        "assistant": answer,
    }


def generate_dataset(output_path: str | Path, count_per_type: int = 8):
    examples = []

    # ── Type 1: Subject role analysis ──
    for i in range(count_per_type):
        role = pick(["Kingpin / Coordinator", "Hub Node / Lieutenant", "Bridge Node / Broker", "Member"])
        analytics = synthetic_analytics(subject_count=6, roles=[role, "Member", "Member", "Bridge Node / Broker", "Hub Node / Lieutenant", "Member"])
        subjects = list(analytics["network"]["centrality_metrics"].keys())
        sub = subjects[i % len(subjects)]
        role = analytics["network"]["centrality_metrics"][sub]["inferred_role"]
        q = f"What is the role of subject {sub} in this communication network?"
        a = (
            f"Based on the TIFM network centrality analysis, subject **{sub}** has a degree centrality "
            f"of **{analytics['network']['centrality_metrics'][sub]['degree_centrality']}** and a betweenness "
            f"centrality of **{analytics['network']['centrality_metrics'][sub]['betweenness_centrality']}**. "
            f"Their inferred role is **{role}**. "
        )
        if "Kingpin" in role:
            a += (
                "This subject controls a significant portion of the communication flow. "
                "They have high degree centrality (connecting to many nodes) and high betweenness centrality "
                "(acting as a critical bridge). Interdiction of this node would maximally disrupt the network. "
                "Recommend prioritizing surveillance and evidence collection against this subject."
            )
        elif "Hub" in role:
            a += (
                "This subject serves as a lieutenant or middle-manager, connecting operational nodes "
                "to the leadership. They have high degree centrality but moderate betweenness. "
                "Monitoring their communications may reveal leadership instructions being relayed."
            )
        elif "Bridge" in role:
            a += (
                "This subject is a broker connecting different sub-networks. Their betweenness centrality "
                "is disproportionately high relative to their degree centrality, indicating they are a "
                "structural bridge. They may be the only link between two otherwise separate groups."
            )
        else:
            a += (
                "This subject is a regular network member \u2014 they communicate within their cluster but "
                "do not serve as a coordinator or bridge. Their removal would have limited structural impact."
            )
        examples.append(make_example(analytics, q, a))

    # ── Type 2: Identity / SIM swap analysis ──
    for i in range(count_per_type):
        has_swaps = i % 2 == 0
        has_device_changes = i % 3 == 0
        analytics = synthetic_analytics(
            subject_count=6,
            sim_swap_count=3 if has_swaps else 0,
            device_change_count=2 if has_device_changes else 0,
            burner_scores=[45 if has_swaps else 10, 5, 5, 12, 8, 3],
        )
        subjects = list(analytics["identity"].keys())
        sub = subjects[0]
        id_data = analytics["identity"][sub]
        q = f"Analyze the identity profile of subject {sub}. Are there SIM swaps, device changes, or burner indicators?"

        if has_swaps:
            swaps_detail = "; ".join(
                f"on {s['timestamp']}: IMSI changed from {s['old_imsi']} to {s['new_imsi']} (IMEI: {s['imei']})"
                for s in id_data["sim_swaps"]
            )
            a = (
                f"Subject {sub} shows clear identity evasion behavior:\n\n"
                f"- **SIM Swaps detected**: {len(id_data['sim_swaps'])} instances \u2014 {swaps_detail}\n"
                f"- **Burner Score**: {id_data['burner_score']}/100 (threshold > 30 is suspicious)\n"
                f"- **Unique identity pairs**: {id_data['unique_identities_count']}\n\n"
                f"Multiple SIM swaps on the same device (IMEI unchanged) indicate the subject is "
                f"rotating through different subscriber identities while keeping their handset. "
                f"This is a hallmark of operational security awareness. The subject may be changing "
                f"SIMs on a regular cadence to avoid linkability. Recommended actions: correlate "
                f"these SIM swap events with changes in communication patterns, and check if swaps "
                f"occur before or after significant events."
            )
            if has_device_changes:
                a += (
                    f"\n\nAdditionally, {len(id_data['device_changes'])} device changes were detected. "
                    f"The subject is also swapping handsets, suggesting a higher degree of operational "
                    f"security. This combined SIM+device rotation is typical of a coordinated evasion strategy."
                )
        else:
            a = (
                f"Subject {sub} has a clean identity profile:\n"
                f"- No SIM swaps detected\n"
                f"- No device changes detected\n"
                f"- Burner Score: {id_data['burner_score']}/100 (low)\n"
                f"- Single identity pair in use throughout the observation period\n\n"
                f"The subject appears to use a consistent device and subscriber identity. "
                f"No evidence of deliberate identity obfuscation."
            )
        examples.append(make_example(analytics, q, a))

    # ── Type 3: Meeting analysis ──
    for i in range(count_per_type):
        analytics = synthetic_analytics(subject_count=6, meeting_count=2 + i % 3)
        meetings = analytics["movement"]["detected_meetings"]
        if not meetings:
            continue
        m = meetings[0]
        q = f"Explain the meeting between {m['subject_a']} and {m['subject_b']}. What does the evidence show?"
        a = (
            f"A meeting was detected between **{m['subject_a']}** and **{m['subject_b']}** "
            f"at tower **{m['tower_id']}** with a gap of only **{m['gap_minutes']} minutes**. "
            f"{m['subject_a']} was present at {m['time_a']} and {m['subject_b']} followed at {m['time_b']}.\n\n"
            f"**Significance**: A sub-1-hour co-location at the same cell tower with different subjects "
            f"is highly suggestive of an in-person meeting. The short time delta makes coincidental "
            f"co-location unlikely.\n\n"
            f"**Assessment**: The meeting indicates a direct operational relationship between these two subjects. "
            f"Recommended actions:\n"
            f"1. Cross-reference this meeting time with other intelligence sources\n"
            f"2. Check call records before/after the meeting for coordination calls\n"
            f"3. Identify the tower location for possible CCTV or witness corroboration\n\n"
            f"**Confidence**: Medium-High (based on tight temporal proximity at same tower)"
        )
        examples.append(make_example(analytics, q, a))

    # ── Type 4: Temporal / activity pattern analysis ──
    for i in range(count_per_type):
        is_night_owl = i % 2 == 0
        mobility = pick(["High", "Medium", "Low"])
        analytics = synthetic_analytics(subject_count=6)
        subjects = list(analytics["movement"]["subjects_movement"].keys())
        sub = subjects[i % len(subjects)]
        analytics["movement"]["subjects_movement"][sub] = {
            "home_tower": "TWR_DEL_01",
            "work_tower": "TWR_DEL_02",
            "total_towers_visited": 5 if mobility == "High" else 2,
            "towers": ["TWR_DEL_01", "TWR_DEL_02", "TWR_DEL_03", "TWR_MUM_01"][:5 if mobility == "High" else 2],
            "mobility_index": mobility,
        }
        q = f"Describe the movement and activity patterns of {sub}."
        a = (
            f"Subject {sub} demonstrates a **{mobility.lower()} mobility profile** with "
            f"{analytics['movement']['subjects_movement'][sub]['total_towers_visited']} distinct towers visited.\n\n"
        )
        if mobility == "High":
            a += (
                "The subject moves between multiple cell towers across different sectors, "
                "suggesting a peripatetic lifestyle or role requiring travel. Movement corridors "
                "include both Delhi and Mumbai sectors. This wide geographic footprint could indicate "
                "a coordinator or courier role requiring physical presence at multiple locations.\n\n"
            )
        elif mobility == "Medium":
            a += (
                "The subject operates primarily between a home and work location with occasional "
                "movement to other areas. This is consistent with a normal commuting pattern layered "
                "with operational movements.\n\n"
            )
        else:
            a += (
                "The subject is highly localized, operating primarily from a single tower area. "
                "This suggests either a stationary role (e.g., a lookout or stationary operator) "
                "or a subject under movement restrictions.\n\n"
            )
        if is_night_owl:
            a += (
                "Notable: elevated night-time activity (between 22:00 and 06:00) is present in the temporal profile. "
                "This deviation from normal diurnal patterns may indicate operational activity during "
                "hours with lower surveillance risk."
            )
        else:
            a += (
                "Activity follows conventional daytime patterns with minimal night-time activity. "
                "No unusual temporal anomalies detected."
            )
        examples.append(make_example(analytics, q, a))

    # ── Type 5: Full investigation report ──
    for i in range(count_per_type):
        analytics = synthetic_analytics(
            subject_count=6,
            app_count=4,
            meeting_count=3,
            sim_swap_count=1 if i % 2 == 0 else 0,
            device_change_count=1 if i % 3 == 0 else 0,
            burner_scores=[48, 12, 7, 22, 5, 35],
            roles=["Kingpin / Coordinator", "Hub Node / Lieutenant", "Member", "Bridge Node / Broker", "Member", "Hub Node / Lieutenant"],
            communities=[SUBJECT_POOL[:3], SUBJECT_POOL[3:6]],
        )
        q = "Generate a comprehensive investigation report based on the TIFM analytics."
        comms = analytics["network"]["communities"]
        a = (
            "# TIFM Investigation Report\n\n"
            "## 1. Network Overview\n"
            f"The network consists of **{analytics['network']['nodes_count']}** unique entities with "
            f"**{analytics['network']['edges_count']}** communication edges. "
            f"Network density is **{analytics['network']['network_density']}**, indicating a "
            f"{'tightly-knit' if analytics['network']['network_density'] > 0.3 else 'loosely-connected'} structure.\n\n"
            "## 2. Community Structure\n"
        )
        for c in comms:
            a += f"- **Community {c['id']}**: {', '.join(c['members'])}\n"
        a += (
            "\n## 3. Key Roles\n"
            "| Subject | Role | Degree | Betweenness |\n"
            "|---|---|---|---|\n"
        )
        for sub, m in sorted(
            analytics["network"]["centrality_metrics"].items(),
            key=lambda x: x[1]["degree_centrality"], reverse=True
        ):
            a += f"| {sub} | {m['inferred_role']} | {m['degree_centrality']} | {m['betweenness_centrality']} |\n"

        id_count = sum(
            1 for id_data in analytics["identity"].values()
            if id_data["is_suspected_burner"]
        )
        a += (
            f"\n## 4. Identity Analysis\n"
            f"- **Suspected burner identities**: {id_count}\n"
        )
        for sub, id_data in analytics["identity"].items():
            if id_data["sim_swaps"] or id_data["device_changes"]:
                a += f"- {sub}: {len(id_data['sim_swaps'])} SIM swap(s), {len(id_data['device_changes'])} device change(s), burner score {id_data['burner_score']}\n"

        meetings = analytics["movement"]["detected_meetings"]
        a += (
            f"\n## 5. Physical Meetings\n"
            f"- **Total meetings detected**: {len(meetings)}\n"
        )
        for m in meetings:
            a += f"- {m['subject_a']} and {m['subject_b']} co-located at {m['tower_id']} ({m['gap_minutes']} min gap)\n"

        a += (
            "\n## 6. Application Usage\n"
        )
        for app, data in analytics["attribution"].items():
            a += f"- **{app}**: {data['count']} sessions, {data['confidence']}% confidence\n"

        a += (
            "\n## 7. Recommendations\n"
            "1. Priority surveillance on the highest-centrality node(s)\n"
            "2. Investigate SIM swap timing relative to known events\n"
            "3. Physical surveillance at meeting location tower sites\n"
            "4. Monitor cross-community communications for bridge node activity\n"
            "5. Consider the identified burner subjects for expedited warrants"
        )
        examples.append(make_example(analytics, q, a))

    # ── Type 6: Anomaly / open-ended analysis ──
    for i in range(count_per_type):
        has_anomaly = i % 2 == 0
        analytics = synthetic_analytics(
            subject_count=6,
            sim_swap_count=2 if has_anomaly else 0,
            device_change_count=1 if has_anomaly else 0,
            burner_scores=[60 if has_anomaly else 8, 5, 5, 15, 3, 10],
            meeting_count=3 if has_anomaly else 0,
        )
        q = "What stands out in this data? Are there any suspicious patterns or anomalies?"
        if has_anomaly:
            swaps_count = sum(
                len(id_data["sim_swaps"]) for id_data in analytics["identity"].values()
            )
            a = (
                "Several significant findings require attention:\n\n"
                f"1. **Identity manipulation**: {swaps_count} SIM swap(s) detected. "
                f"Subject {list(analytics['identity'].keys())[0]} shows deliberate identity rotation with a burner score of 60. "
                "This is consistent with operational security behavior.\n\n"
                f"2. **Physical meetings**: {len(analytics['movement']['detected_meetings'])} co-location events detected "
                "between subjects at specific towers. These indicate real-world operational coordination.\n\n"
                "3. **Network structure**: Analysis reveals distinct communities with a clear hierarchy. "
                "The kingpin node bridges otherwise separate clusters.\n\n"
                "**Priority actions**:\n"
                "- Monitor the SIM-swapping subject's new identities for continued activity\n"
                "- Geolocate the meeting tower IDs for physical surveillance opportunities\n"
                "- Prepare warrants targeting the highest-centrality subject"
            )
        else:
            a = (
                "The data presents a routine communication network with no immediate red flags:\n"
                "- No SIM swaps or device changes detected\n"
                "- No physical co-location meetings found\n"
                "- Standard communication patterns across all subjects\n"
                "- No significant temporal anomalies\n\n"
                "The network exhibits typical hierarchical structure. While this appears "
                "low-risk, ongoing monitoring is recommended as patterns may develop over time."
            )
        examples.append(make_example(analytics, q, a))

    # ── Type 7: Context chip questions (matches frontend quick-ask buttons) ──
    chip_questions = [
        {
            "q": "Explain what we know about subject {sub} and assess their role in the network.",
            "answer_template": (
                "Subject **{sub}** profile:\n\n"
                "- **Network role**: {role}\n"
                "- **Identity status**: {id_status}\n"
                "- **Movement range**: {mobility} mobility ({towers} towers)\n"
                "- **Meetings involved**: {meetings} co-location event(s)\n\n"
                "{assessment}"
            ),
        },
        {
            "q": "Analyze the communication clusters in this network. Are there distinct groups or isolated subjects?",
            "answer_template": (
                "The network comprises **{nodes}** nodes with **{edges}** communication edges "
                "(density: {density}).\n\n"
                "**Communities identified**: {comm_count}\n"
                "{comm_details}\n\n"
                "{bridge_analysis}\n\n"
                "**Isolated subjects**: {isolated}\n\n"
                "The network structure is {structure_desc} with {hierarchy_desc}."
            ),
        },
        {
            "q": "Explain the tower movement pattern of {sub}. How many towers did they visit?",
            "answer_template": (
                "Subject **{sub}** visited **{towers}** distinct towers during the observation period "
                "(mobility index: {mobility}).\n\n"
                "- Home tower: {home}\n"
                "- Primary work/activity tower: {work}\n"
                "- Total towers: {tower_list}\n\n"
                "{assessment}"
            ),
        },
    ]

    for cq_def in chip_questions:
        for i in range(count_per_type):
            analytics = synthetic_analytics(
                subject_count=6,
                sim_swap_count=1 if i % 2 == 0 else 0,
                burner_scores=[38 if i % 2 == 0 else 5, 5, 5, 10, 3, 8],
                meeting_count=i % 3,
            )
            subjects = list(analytics["identity"].keys())
            sub = subjects[i % len(subjects)]

            role = analytics["network"]["centrality_metrics"][sub]["inferred_role"]
            id_data = analytics["identity"][sub]
            move_data = analytics["movement"]["subjects_movement"].get(sub, {})
            sub_meetings = [
                m for m in analytics["movement"]["detected_meetings"]
                if m["subject_a"] == sub or m["subject_b"] == sub
            ]

            cq = cq_def["q"].format(sub=sub)
            tpl = cq_def["answer_template"]

            if "role" in tpl:
                id_status = (
                    f"Suspected burner (score: {id_data['burner_score']})"
                    if id_data["is_suspected_burner"]
                    else "Clean profile"
                )
                assessment = (
                    f"This subject likely plays a {role.lower()} role in the network."
                )
                answer = tpl.format(
                    sub=sub, role=role, id_status=id_status,
                    mobility=move_data.get("mobility_index", "Unknown"),
                    towers=move_data.get("total_towers_visited", 0),
                    meetings=len(sub_meetings),
                    assessment=assessment,
                )
            elif "nodes" in tpl:
                comms = analytics["network"].get("communities", [])
                comm_details = "\n".join(
                    f"  - Community {c['id']}: {', '.join(c['members'])}"
                    for c in comms
                ) if comms else "  - None detected"
                bridge_nodes = [
                    s for s, m in analytics["network"]["centrality_metrics"].items()
                    if "Bridge" in m["inferred_role"]
                ]
                bridge_analysis = (
                    f"**Bridge nodes**: {', '.join(bridge_nodes)} \u2014 these subjects connect the communities."
                    if bridge_nodes else "**No bridge nodes** \u2014 communities appear to operate independently."
                )
                all_subjects = list(analytics["network"]["centrality_metrics"].keys())
                comm_members = set()
                for c in comms:
                    comm_members.update(c["members"])
                isolated = [s for s in all_subjects if s not in comm_members]
                isolated_str = ", ".join(isolated) if isolated else "None"
                structure_desc = (
                    "tight-knit (high density)"
                    if analytics["network"]["network_density"] > 0.3
                    else "loose (low density)"
                )
                hierarchy_desc = (
                    "a clear hierarchy present"
                    if any("Kingpin" in m["inferred_role"] for m in analytics["network"]["centrality_metrics"].values())
                    else "no strong hierarchy"
                )
                answer = tpl.format(
                    nodes=analytics["network"]["nodes_count"],
                    edges=analytics["network"]["edges_count"],
                    density=analytics["network"]["network_density"],
                    comm_count=len(comms),
                    comm_details=comm_details,
                    bridge_analysis=bridge_analysis,
                    isolated=isolated_str,
                    structure_desc=structure_desc,
                    hierarchy_desc=hierarchy_desc,
                )
            elif "towers" in tpl:
                towers_visited = analytics["movement"]["subjects_movement"].get(sub, {}).get("towers", [])
                assessment = (
                    f"The subject's movement is {'wide-ranging and suggests a mobile role' if move_data.get('mobility_index') == 'High' else 'localized and consistent with a fixed operational base'}."
                )
                answer = tpl.format(
                    sub=sub,
                    towers=move_data.get("total_towers_visited", 0),
                    mobility=move_data.get("mobility_index", "Unknown"),
                    home=move_data.get("home_tower", "Unknown"),
                    work=move_data.get("work_tower", "Unknown"),
                    tower_list=", ".join(towers_visited) if towers_visited else "None",
                    assessment=assessment,
                )
            else:
                answer = "Analysis complete based on available TIFM data."

            examples.append(make_example(analytics, cq, answer))

    # ── Type 8: IP-specific meeting questions (matches user's test) ──
    for i in range(count_per_type):
        analytics = synthetic_analytics(subject_count=6, meeting_count=2 + i % 3)
        meetings = analytics["movement"]["detected_meetings"]
        if not meetings:
            continue
        m = meetings[0] if len(meetings) > 0 else None
        if not m:
            continue
        q = (
            f"What is the evidence for the meeting between {m['subject_a']} and {m['subject_b']} "
            f"at {m['tower_id']}? How confident is this attribution?"
        )
        a = (
            f"## Meeting Evidence Report\n\n"
            f"**Subjects**: {m['subject_a']} and {m['subject_b']}\n"
            f"**Location**: Tower {m['tower_id']}\n"
            f"**Timeline**:\n"
            f"- {m['subject_a']} arrived at {m['time_a']}\n"
            f"- {m['subject_b']} arrived at {m['time_b']}\n"
            f"- Gap: {m['gap_minutes']} minutes\n\n"
            f"**Evidence supporting meeting**:\n"
            f"1. Both subjects connected to the same cell tower ({m['tower_id']}) within a short time window\n"
            f"2. The temporal gap of {m['gap_minutes']} minutes is well below the 60-minute threshold for meeting detection\n"
            f"3. This is not a coincidental co-location \u2014 these subjects have communication edges in the CDR data\n\n"
            f"**Confidence**: **Medium-High** (80-85%). The tower-level geolocation provides strong but not definitive proof of an in-person meeting. "
            f"Recommended: cross-reference with tower CCTV, financial records, or other intelligence sources for the time window."
        )
        examples.append(make_example(analytics, q, a))

    # ── Type 9: Schema boundary awareness ──
    # Attribution is aggregate across all subjects, no per-IP breakdown in analytics
    for i in range(count_per_type):
        analytics = synthetic_analytics(subject_count=6, app_count=3)
        subjects = list(analytics["identity"].keys())
        sub = subjects[i % len(subjects)]
        app_name = pick(list(analytics["attribution"].keys()))
        q = f"What {app_name} activity does subject {sub} show?"
        if sub.startswith("+"):
            id_type = "phone number"
        else:
            id_type = "IP address"
        a = (
            f"The TIFM analytics `attribution` section provides aggregate application-level statistics "
            f"across all subjects in the case. It does **not** provide a per-subject breakdown of application usage.\n\n"
            f"To determine what {app_name} activity subject {sub} ({id_type}) has, you need to examine the "
            f"**raw IPDR timeline data** rather than the aggregated analytics. "
            f"The analytics show:\n"
            f"- **{app_name}**: {analytics['attribution'][app_name]['count']} total sessions (confidence: {analytics['attribution'][app_name]['confidence']}%)\n\n"
            f"This count represents all {app_name} traffic across the entire network, not just this subject. "
            f"Cross-reference the raw CDR/IPDR records filtered by this subject's identifier for per-IP or per-MSISDN "
            f"application activity."
        )
        examples.append(make_example(analytics, q, a))

    # ── Type 10: Missing / empty analytics sections ──
    for i in range(count_per_type):
        analytics = synthetic_analytics(
            subject_count=6,
            app_count=0 if i % 2 == 0 else 3,
            meeting_count=0 if i % 3 == 0 else 2,
            sim_swap_count=0 if i % 4 == 0 else 1,
        )
        if i % 2 == 0:
            q = "What applications are being used by subjects in this network?"
            a = (
                "The TIFM analytics do not contain any application attribution data. "
                "This means either:\n"
                "1. No IPDR records were provided for this case\n"
                "2. The IPDR records did not match any known application signatures\n\n"
                "Without IPDR data, application-level attribution cannot be assessed. "
                "If you have raw IPDR files, upload them and re-run the analysis."
            )
            examples.append(make_example(analytics, q, a))
        if i % 3 == 0:
            q = "Were any physical meetings detected between subjects?"
            a = (
                "No physical co-location events (meetings) were detected. "
                "This means no two subjects connected from the same cell tower within the 60-minute detection window. "
                "Subjects may still have operational relationships through calls or messages, "
                "but there is no evidence of in-person meetings from the tower data."
            )
            examples.append(make_example(analytics, q, a))
        if i % 4 == 0:
            q = "Are there any SIM swaps or device changes in this data?"
            a = (
                "No SIM swaps or device changes were detected for any subject. "
                "All subjects show a single consistent IMSI/IMEI pair throughout the observation period. "
                "This indicates routine device usage with no deliberate identity obfuscation."
            )
            examples.append(make_example(analytics, q, a))

    # ── Type 11: Distinguish physical meeting vs app session ──
    for i in range(count_per_type):
        analytics = synthetic_analytics(subject_count=6, meeting_count=2, app_count=3)
        meetings = analytics["movement"]["detected_meetings"]
        if not meetings:
            continue
        m = meetings[i % len(meetings)]
        q = (
            f"I see {m['subject_a']} and {m['subject_b']} communicated via WhatsApp. "
            f"Is that the meeting you detected?"
        )
        a = (
            f"No \u2014 the detected meeting between **{m['subject_a']}** and **{m['subject_b']}** "
            f"refers to a **physical in-person meeting**, not an application communication session.\n\n"
            f"**Physical meeting evidence**:\n"
            f"- Both subjects connected to cell tower **{m['tower_id']}** within **{m['gap_minutes']} minutes** of each other\n"
            f"- {m['subject_a']} at {m['time_a']}\n"
            f"- {m['subject_b']} at {m['time_b']}\n\n"
            f"**Application communication** (WhatsApp, Telegram, etc.) is tracked separately in the "
            f"`attribution` section and refers to IP-level traffic, not physical proximity.\n\n"
            f"The two are distinct signals: physical meetings indicate real-world coordination, "
            f"while app attribution indicates digital communication channels used. "
            f"Both can be cross-referenced to build a complete operational picture."
        )
        examples.append(make_example(analytics, q, a))

    # ── Type 12: Confidence caveats ──
    for i in range(count_per_type):
        low_conf = i % 2 == 0
        apps_conf = {"WhatsApp": 65, "Telegram": 58, "Signal": 72} if low_conf else {"WhatsApp": 95, "Telegram": 88, "Signal": 91}
        analytics = synthetic_analytics(subject_count=6, app_count=3)
        for app, conf in apps_conf.items():
            if app in analytics["attribution"]:
                analytics["attribution"][app]["confidence"] = conf
        sub = list(analytics["identity"].keys())[0]
        app_name = pick(list(analytics["attribution"].keys()))
        conf = analytics["attribution"][app_name]["confidence"]
        q = f"How confident is the {app_name} attribution for subject {sub}?"
        a = (
            f"The {app_name} attribution confidence level is **{conf}%**. "
        )
        if conf < 75:
            a += (
                "This is a **low-to-moderate confidence** score. This means the attribution is based on "
                "supporting indicators (e.g., port matches, traffic patterns) but has not reached the "
                "threshold for definitive identification. Factors that may reduce confidence include:\n"
                "- Port numbers that overlap with other applications\n"
                "- Encrypted traffic where deep packet inspection is not possible\n"
                "- Limited session duration or sample size\n\n"
                "**Recommendation**: Treat this as an indicator, not proof. Corroborate with other data sources "
                "before drawing conclusions."
            )
        elif conf < 85:
            a += (
                "This is a **moderate-to-high confidence** score. The traffic patterns and port signatures "
                "are reasonably consistent with {app_name}. However, there is still a possibility of "
                "misattribution due to:\n"
                "- VPN or proxy traffic that mimics application patterns\n"
                "- Shared infrastructure hosting multiple services\n\n"
                "**Recommendation**: Consider this strong evidence but seek corroboration where possible."
            )
        else:
            a += (
                "This is a **high confidence** score (>= 85%). Multiple independent indicators align: "
                "port matching, protocol analysis, traffic patterns, and IP range verification. "
                "The attribution is considered reliable for investigative purposes.\n\n"
                "**Confidence scale used by TIFM**:\n"
                "- 90-98%: Definitive \u2014 multiple strong indicators align\n"
                "- 75-89%: High \u2014 strong indicators but some ambiguity\n"
                "- 60-74%: Moderate \u2014 supportive but not conclusive\n"
                "- Below 60%: Low \u2014 weak or conflicting indicators"
            )
        examples.append(make_example(analytics, q, a))

    # ── Type 13: Burner score explanation ──
    for i in range(count_per_type):
        high_burner = i % 2 == 0
        score = pick([45, 55, 68, 72]) if high_burner else pick([5, 8, 12, 18])
        analytics = synthetic_analytics(
            subject_count=6,
            sim_swap_count=3 if high_burner else 0,
            burner_scores=[score, 5, 5, 12, 8, 3],
        )
        subjects = list(analytics["identity"].keys())
        sub = subjects[0]
        id_data = analytics["identity"][sub]
        q = f"Subject {sub} has a burner score of {id_data['burner_score']}. What does this mean?"
        if high_burner:
            pair_count = len(id_data["unique_pairs"])
            a = (
                f"Subject **{sub}** has a burner score of **{id_data['burner_score']}/100**, which exceeds "
                f"the threshold of 30 and flags them as a **suspected burner**.\n\n"
                f"**What this score means**:\n"
                f"- The subject has used **{id_data['unique_identities_count']}** unique identity pairs "
                f"(IMSI + IMEI combinations)\n"
                f"- {len(id_data['sim_swaps'])} SIM swap(s) were detected, meaning the subject changed "
                f"their subscriber identity while keeping the same device\n"
                f"- Multiple IMSIs registered to the same IMEI is a strong indicator of deliberate "
                f"identity rotation\n\n"
                f"**Operational significance**:\n"
                f"Burner behavior is commonly associated with:\n"
                f"1. Operational security awareness \u2014 the subject actively avoids linkability\n"
                f"2. Pre-planned criminal activity \u2014 rotating identities before/during operations\n"
                f"3. Coordination with other burner users \u2014 synchronized SIM rotations\n\n"
                f"**Recommendation**: Monitor this subject's future identity changes. "
                f"Map the timing of SIM swaps to known events in the case timeline."
            )
        else:
            a = (
                f"Subject **{sub}** has a burner score of **{id_data['burner_score']}/100**, which is "
                f"well below the suspicion threshold of 30.\n\n"
                f"**What this score means**:\n"
                f"- The subject uses a single identity pair (one IMSI + one IMEI)\n"
                f"- No SIM swaps or device changes detected\n"
                f"- No evidence of identity rotation or obfuscation\n\n"
                f"A low burner score indicates the subject is using their device in a conventional manner "
                f"without deliberate identity management. This does not rule out criminal involvement, "
                f"but suggests the subject is not actively evading surveillance through technical means."
            )
        examples.append(make_example(analytics, q, a))

    # ── Type 14: Multi-section cross-reference ──
    for i in range(count_per_type):
        analytics = synthetic_analytics(
            subject_count=6,
            sim_swap_count=1 if i % 2 == 0 else 0,
            meeting_count=1 + i % 2,
            burner_scores=[48 if i % 2 == 0 else 8, 5, 12, 7, 3, 15],
        )
        subjects = list(analytics["identity"].keys())
        sub = subjects[i % len(subjects)]
        id_data = analytics["identity"].get(sub, {})
        move_data = analytics["movement"]["subjects_movement"].get(sub, {})
        centrality = analytics["network"]["centrality_metrics"].get(sub, {})
        sub_meetings = [
            m for m in analytics["movement"]["detected_meetings"]
            if m["subject_a"] == sub or m["subject_b"] == sub
        ]
        q = f"Build a complete profile of subject {sub} by combining all available analytics sections."
        a = (
            f"## Subject Profile: {sub}\n\n"
            f"**Network Role**: {centrality.get('inferred_role', 'Unknown')}\n"
            f"- Degree centrality: {centrality.get('degree_centrality', 'N/A')}\n"
            f"- Betweenness centrality: {centrality.get('betweenness_centrality', 'N/A')}\n\n"
            f"**Identity**:\n"
            f"- Unique identity pairs: {id_data.get('unique_identities_count', 0)}\n"
            f"- SIM swaps: {len(id_data.get('sim_swaps', []))}\n"
            f"- Device changes: {len(id_data.get('device_changes', []))}\n"
            f"- Burner score: {id_data.get('burner_score', 'N/A')}/100 "
            f"{'(SUSPECTED BURNER)' if id_data.get('is_suspected_burner') else '(clean)'}\n\n"
            f"**Movement**:\n"
            f"- Mobility index: {move_data.get('mobility_index', 'Unknown')}\n"
            f"- Towers visited: {move_data.get('total_towers_visited', 0)}\n"
            f"- Home tower: {move_data.get('home_tower', 'Unknown')}\n"
            f"- Work tower: {move_data.get('work_tower', 'Unknown')}\n\n"
            f"**Meetings**: {len(sub_meetings)} detected\n"
        )
        if sub_meetings:
            for m in sub_meetings:
                a += f"- With {m['subject_b'] if m['subject_a'] == sub else m['subject_a']} at {m['tower_id']} ({m['gap_minutes']} min gap)\n"
        a += (
            "\n**Cross-Section Assessment**:\n"
        )
        if id_data.get("is_suspected_burner") and "Kingpin" in centrality.get("inferred_role", ""):
            a += (
                "This subject combines high network centrality with burner behavior \u2014 "
                "a pattern consistent with a leadership figure using operational security measures. "
                "This subject should be a **high-priority target**."
            )
        elif id_data.get("is_suspected_burner"):
            a += (
                "This subject shows burner behavior but has limited network centrality. "
                "They may be an operational-level actor rather than leadership."
            )
        elif "Kingpin" in centrality.get("inferred_role", ""):
            a += (
                "This subject is a high-centrality figure with a clean identity profile. "
                "They may be confident in their communication security or unaware of surveillance."
            )
        else:
            a += (
                "This subject shows routine patterns across all sections. "
                "No significant red flags from the combined analytics."
            )
        examples.append(make_example(analytics, q, a))

    # ── Type 15: Data completeness warnings ──
    for i in range(count_per_type):
        has_cdr = i % 2 == 0
        has_ipdr = i % 3 == 0
        desc = []
        if not has_cdr:
            desc.append("no CDR (call) records")
        if not has_ipdr:
            desc.append("no IPDR (data) records")
        if not desc:
            desc.append("both CDR and IPDR records")
        q = f"How complete is this data? What types of records are included?"
        a = (
            "## Data Completeness Assessment\n\n"
            f"The current TIFM analytics include **{', '.join(desc)}**.\n\n"
        )
        if not has_cdr:
            a += (
                "**Missing: CDR records** \u2014 Without Call Detail Records, the following analyses "
                "are limited or unavailable:\n"
                "- Voice call network graph and centrality analysis\n"
                "- SMS communication patterns\n"
                "- Call-based meeting detection (co-location analysis still works via IPDR tower data)\n\n"
            )
        if not has_ipdr:
            a += (
                "**Missing: IPDR records** \u2014 Without IP Detail Records, the following analyses "
                "are limited or unavailable:\n"
                "- Application attribution (WhatsApp, Telegram, Signal detection)\n"
                "- IP-based session analysis\n"
                "- Data traffic pattern analysis\n\n"
            )
        a += (
            "**Scope note**: TIFM analytics are derived only from uploaded records. "
            "If records are incomplete or cover a limited time window, the analysis reflects only that subset. "
            "For a comprehensive investigation, upload all available CDR and IPDR files covering the full "
            "period of interest."
        )
        examples.append(make_example(analytics, q, a))

    # Shuffle and deduplicate by question
    random.shuffle(examples)
    seen_qs = set()
    unique = []
    for ex in examples:
        key = ex["user"]
        if key not in seen_qs:
            seen_qs.add(key)
            unique.append(ex)

    output_path = Path(output_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with open(output_path, "w", encoding="utf-8") as f:
        for ex in unique:
            f.write(json.dumps(ex, ensure_ascii=False) + "\n")

    print(f"Generated {len(unique)} training examples -> {output_path}")
    return len(unique)


if __name__ == "__main__":
    generate_dataset(Path(__file__).parent / "tifm_train.jsonl", count_per_type=200)
