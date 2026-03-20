#!/usr/bin/env python3
"""Docker healthcheck for the puller process.

The async puller writes a heartbeat file every 30s. If the file is
older than 120s, something is stuck — Docker will restart the container.
"""
import os
import sys
import time

HEARTBEAT_FILE = "/tmp/puller_heartbeat"
MAX_AGE_SECONDS = 120

if not os.path.exists(HEARTBEAT_FILE):
    # Give the process time to start up
    print("WARN: heartbeat file not found yet")
    sys.exit(0)

age = time.time() - os.path.getmtime(HEARTBEAT_FILE)
if age > MAX_AGE_SECONDS:
    print(f"FAIL: heartbeat is {age:.0f}s old (max {MAX_AGE_SECONDS}s)")
    sys.exit(1)

print(f"OK: heartbeat {age:.0f}s ago")
sys.exit(0)
