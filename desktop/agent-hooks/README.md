# Agent hook helpers

`emit-event.sh` writes normalized turn events that Constellagent consumes:

```bash
emit-event.sh <agent> <turn_event_type>
```

Preferred turn event types:
- `turn_started`
- `awaiting_user`

Legacy turn types are still accepted and normalized:
- `turn_completed` → `awaiting_user` (`outcome: success`)
- `turn_failed` → `awaiting_user` (`outcome: failed`)

Required environment:
- `AGENT_ORCH_WS_ID` (workspace id)

Optional environment:
- `AGENT_ORCH_SESSION_ID` (session correlation key)
- `CONSTELLAGENT_AGENT_EVENT_DIR` (defaults to `/tmp/constellagent-agent-events`)
