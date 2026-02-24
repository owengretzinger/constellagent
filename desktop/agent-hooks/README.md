# Agent hook helpers

`emit-event.sh` writes normalized turn events that Constellagent consumes:

```bash
emit-event.sh <agent> <turn_event_type> [turn_outcome]
```

Supported turn event types:
- `turn_started`
- `awaiting_user`

Optional turn outcomes (for `awaiting_user`):
- `success`
- `failed`

Required environment:
- `AGENT_ORCH_WS_ID` (workspace id)

Optional environment:
- `AGENT_ORCH_SESSION_ID` (session correlation key)
- `CONSTELLAGENT_AGENT_EVENT_DIR` (defaults to `/tmp/constellagent-agent-events`)
