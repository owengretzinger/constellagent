# pi-mono hooks for Constellagent

These scripts are optional adapters if you want hook-based wiring.

Primary integration now uses the interactive pi extension installed from Settings (Pi-mono extension),
which emits events on `agent_start`/`agent_end`.

If you still want hooks:
- `turn-started.sh` → emit `turn_started`
- `awaiting-user.sh` → emit `awaiting_user`

Both scripts require `AGENT_ORCH_WS_ID` in the environment (Constellagent sets this for PTYs it creates).
