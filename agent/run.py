"""Main entry point for the LotLogic lead gen agent.

Runs once per invocation. Loads state, asks Claude to plan + execute,
logs everything to agent_logs, and emails Gabriel a daily summary.

Run:
    python -m agent.run                 # live run
    DRY_RUN=true python -m agent.run    # no emails sent, no DB writes
"""

import os
import sys
import traceback
from typing import Any

import anthropic

from leadgen import config
from . import state as state_mod
from . import summary as summary_mod
from .prompt import build_system_prompt
from .tools import AVAILABLE_TOOLS, DRY_RUN, execute_tool


MODEL = os.environ.get("AGENT_MODEL", "claude-sonnet-4-6")
MAX_ITERATIONS = 30  # Safety cap on the agent loop


def main() -> int:
    if not config.ANTHROPIC_API_KEY:
        print("ERROR: ANTHROPIC_API_KEY not set", file=sys.stderr)
        return 1

    if DRY_RUN:
        print("=" * 60)
        print("DRY RUN — no emails will be sent, no DB writes will happen")
        print("=" * 60)

    client = anthropic.Anthropic(api_key=config.ANTHROPIC_API_KEY)

    # Load state and open a log row
    try:
        state = state_mod.load_state()
    except Exception as e:
        print(f"WARNING: could not load state: {e}")
        state = {}

    try:
        run_id = state_mod.start_run() if not DRY_RUN else "dry-run"
    except Exception as e:
        print(f"WARNING: could not start log row: {e}")
        run_id = "local-run"

    print(f"Run started (id={run_id}, model={MODEL})")

    system_prompt = build_system_prompt(state)
    messages: list[dict[str, Any]] = [
        {
            "role": "user",
            "content": (
                "Begin today's run. Review state, check replies, handle "
                "follow-ups, top up the pipeline if needed, and send new outreach "
                "up to the daily cap. End with a plain-text summary of what you did."
            ),
        }
    ]

    actions_taken: list[dict] = []
    outcomes: list[dict] = []
    errors: list[dict] = []
    final_text: str = ""

    try:
        for iteration in range(MAX_ITERATIONS):
            response = client.messages.create(
                model=MODEL,
                max_tokens=4096,
                system=system_prompt,
                tools=AVAILABLE_TOOLS,
                messages=messages,
            )

            # Collect any text from this turn
            text_parts = [b.text for b in response.content if b.type == "text"]
            if text_parts:
                final_text = "\n".join(text_parts)
                print(f"\n[claude] {final_text}")

            if response.stop_reason == "end_turn":
                break

            # Execute any tool calls
            tool_results: list[dict] = []
            for block in response.content:
                if block.type == "tool_use":
                    print(f"\n[tool] {block.name}({block.input})")
                    result = execute_tool(block.name, block.input)
                    print(f"[result] {result[:500]}")

                    actions_taken.append({"tool": block.name, "input": block.input})
                    outcomes.append({"tool": block.name, "result": result[:2000]})

                    tool_results.append({
                        "type": "tool_result",
                        "tool_use_id": block.id,
                        "content": result,
                    })

            if not tool_results:
                # No text, no tool calls — end
                break

            messages.append({"role": "assistant", "content": response.content})
            messages.append({"role": "user", "content": tool_results})
        else:
            print(f"WARNING: hit max iterations ({MAX_ITERATIONS})")
            errors.append({"type": "max_iterations", "limit": MAX_ITERATIONS})

        status = "completed"

    except Exception as e:
        tb = traceback.format_exc()
        print(f"\nERROR during agent run: {e}\n{tb}", file=sys.stderr)
        errors.append({"type": "exception", "message": str(e), "traceback": tb})
        status = "failed"

    # Log outcome
    if not DRY_RUN:
        try:
            state_mod.finish_run(
                run_id,
                status=status,
                actions_taken=actions_taken,
                outcomes=outcomes,
                errors=errors or None,
                summary=final_text,
            )
        except Exception as e:
            print(f"WARNING: could not log run: {e}")

    # Email daily summary
    if not DRY_RUN and final_text:
        try:
            summary_mod.send_daily_summary(final_text)
        except Exception as e:
            print(f"WARNING: could not send summary email: {e}")

    print(f"\nRun finished: status={status}, actions={len(actions_taken)}, errors={len(errors)}")
    return 0 if status == "completed" else 1


if __name__ == "__main__":
    sys.exit(main())
