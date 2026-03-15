#!/usr/bin/env bash
# LotLogic Autonomous Monitoring Agent — Launcher
#
# Usage:
#   ./run_agent.sh              # Single health check
#   ./run_agent.sh daemon       # Continuous monitoring
#   ./run_agent.sh analyze      # Health check + Claude analysis
#   ./run_agent.sh report       # Full improvement report
#   ./run_agent.sh install      # Install dependencies
#   ./run_agent.sh cron         # Install cron jobs
#
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

# Load .env if present
if [ -f .env ]; then
    set -a
    source .env
    set +a
fi

case "${1:-once}" in
    install)
        echo "Installing dependencies..."
        pip3 install -r requirements.txt
        echo "Done. Set your environment variables in monitoring/.env:"
        echo "  ANTHROPIC_API_KEY=sk-ant-..."
        echo "  DASHBOARD_URL=https://your-app.up.railway.app"
        ;;

    daemon)
        echo "Starting LotLogic monitoring daemon..."
        echo "Press Ctrl+C to stop."
        python3 agent_monitor.py --daemon
        ;;

    analyze)
        python3 agent_monitor.py --analyze
        ;;

    report)
        python3 agent_monitor.py --report
        ;;

    cron)
        # Install cron jobs for automated monitoring
        CRON_HEALTH="*/5 * * * * cd $DIR && python3 agent_monitor.py --once >> logs/cron.log 2>&1"
        CRON_ANALYSIS="0 * * * * cd $DIR && python3 agent_monitor.py --analyze >> logs/cron.log 2>&1"
        CRON_REPORT="0 6 * * * cd $DIR && python3 agent_monitor.py --report >> logs/cron.log 2>&1"

        # Add to crontab (preserving existing entries)
        (crontab -l 2>/dev/null | grep -v "agent_monitor"; echo "$CRON_HEALTH"; echo "$CRON_ANALYSIS"; echo "$CRON_REPORT") | crontab -
        echo "Cron jobs installed:"
        echo "  - Health check: every 5 minutes"
        echo "  - Claude analysis: every hour"
        echo "  - Improvement report: daily at 6am"
        echo ""
        echo "View cron jobs: crontab -l"
        echo "View logs: tail -f $DIR/logs/cron.log"
        ;;

    once|*)
        python3 agent_monitor.py --once
        ;;
esac
