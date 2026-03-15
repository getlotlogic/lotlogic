"""
LotLogic Autonomous Agent — Configuration

Environment variables (set in .env or export):
  ANTHROPIC_API_KEY      — Claude API key
  LOTLOGIC_API_URL       — Backend API base URL
  SUPABASE_URL           — Supabase project URL
  SUPABASE_ANON_KEY      — Supabase anon/public key
  DATABASE_URL           — Direct Postgres connection string (optional)
  DASHBOARD_URL          — Deployed frontend URL
  SLACK_WEBHOOK_URL      — (optional) Slack alerts
"""

import os
from dataclasses import dataclass, field
from pathlib import Path

# Try loading .env if python-dotenv is available
try:
    from dotenv import load_dotenv
    load_dotenv(Path(__file__).parent / ".env")
except ImportError:
    pass


@dataclass
class AgentConfig:
    # Claude API
    anthropic_api_key: str = ""
    model: str = "claude-sonnet-4-6"  # Use Sonnet for cost-effective monitoring

    # LotLogic services
    api_url: str = "https://lotlogic-backend-production.up.railway.app"
    supabase_url: str = "https://nzdkoouoaedbbccraoti.supabase.co"
    supabase_anon_key: str = ""
    database_url: str = ""
    dashboard_url: str = ""

    # Monitoring schedule (seconds)
    health_check_interval: int = 300        # 5 min
    deep_analysis_interval: int = 3600      # 1 hour
    improvement_cycle_interval: int = 86400  # 24 hours

    # Alerting
    slack_webhook_url: str = ""

    # Agent limits
    max_budget_per_cycle_usd: float = 2.0
    max_auto_fix_attempts: int = 3

    # Paths
    log_dir: Path = field(default_factory=lambda: Path(__file__).parent / "logs")
    report_dir: Path = field(default_factory=lambda: Path(__file__).parent / "reports")

    @classmethod
    def from_env(cls) -> "AgentConfig":
        cfg = cls(
            anthropic_api_key=os.getenv("ANTHROPIC_API_KEY", ""),
            supabase_anon_key=os.getenv(
                "SUPABASE_ANON_KEY",
                # Fallback to the public anon key from the dashboard
                "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im56ZGtvb3VvYWVkYmJjY3Jhb3RpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMxMzg2OTQsImV4cCI6MjA4ODcxNDY5NH0.WrlTCKEmmziBUX1E9vBmBpHRSg7_RRKBLIxSPKy189E",
            ),
            database_url=os.getenv("DATABASE_URL", ""),
            dashboard_url=os.getenv("DASHBOARD_URL", ""),
            slack_webhook_url=os.getenv("SLACK_WEBHOOK_URL", ""),
        )
        cfg.log_dir.mkdir(parents=True, exist_ok=True)
        cfg.report_dir.mkdir(parents=True, exist_ok=True)
        return cfg
