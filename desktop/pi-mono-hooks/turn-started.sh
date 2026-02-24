#!/bin/bash
# pi-mono hook adapter for Constellagent.
# Configure pi-mono's "prompt submitted / turn started" hook to run this script.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
"$SCRIPT_DIR/../agent-hooks/emit-event.sh" pi-mono turn_started
