#!/bin/bash
# pi-mono hook adapter for Constellagent.
# Configure pi-mono's "waiting for user" / "turn finished" hook to run this script.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
"$SCRIPT_DIR/../agent-hooks/emit-event.sh" pi-mono awaiting_user
