from __future__ import annotations

import json
from pathlib import Path
from app.ai.agents import (
    ServiceAttributionAgent,
    IdentityAgent,
    MovementAgent,
    NetworkAgent,
    ReportAgent
)

class TelecomIntelligenceOrchestrator:
    """
    Telecom Intelligence Orchestrator (TIFM):
    Coordinates the multi-agent system, aggregates the analytics,
    and runs report compilation/reasoning.
    """
    def __init__(self):
        self.attribution_agent = ServiceAttributionAgent()
        self.identity_agent = IdentityAgent()
        self.movement_agent = MovementAgent()
        self.network_agent = NetworkAgent()
        self.report_agent = ReportAgent()

    def analyze_case(self, cdr_records: list[dict], ipdr_records: list[dict]) -> dict:
        """
        Runs the agents chronologically over the dataset.
        """
        all_records = cdr_records + ipdr_records
        
        # 1. Attribute IPDR Apps
        attr_out = self.attribution_agent.analyze(ipdr_records)
        
        # 2. Run Identity Engine
        id_out = self.identity_agent.analyze(all_records)
        
        # 3. Process movement and physical meetings
        move_out = self.movement_agent.analyze(all_records)
        
        # 4. Perform Network community analysis
        net_out = self.network_agent.analyze(cdr_records)
        
        analytics = {
            "attribution": attr_out,
            "identity": id_out,
            "movement": move_out,
            "network": net_out
        }
        
        return analytics

    def generate_report(self, analytics: dict, report_type: str = "full") -> str:
        """
        Generates the formatted markdown report.
        """
        return self.report_agent.generate(analytics, report_type=report_type)
