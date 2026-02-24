import { mkdir, readFile, unlink, writeFile } from 'fs/promises'
import { join } from 'path'
import { homedir } from 'os'

export const PI_AGENT_DIR = join(homedir(), '.pi', 'agent')
export const PI_EXTENSIONS_DIR = join(PI_AGENT_DIR, 'extensions')
export const PI_ACTIVITY_EXTENSION_FILE = join(PI_EXTENSIONS_DIR, 'constellagent-activity.ts')

const EXTENSION_MARKER = 'Constellagent pi-mono activity extension'

const PI_ACTIVITY_EXTENSION_SOURCE = `/**
 * ${EXTENSION_MARKER}
 *
 * Auto-installed by Constellagent.
 * Emits normalized turn events for interactive pi/pi-mono sessions.
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type AgentTurnType = "turn_started" | "awaiting_user";
type AgentTurnOutcome = "success" | "failed";

const WS_ID = process.env.AGENT_ORCH_WS_ID?.trim();
const SESSION_ID = process.env.AGENT_ORCH_SESSION_ID?.trim();
const EVENT_DIR = process.env.CONSTELLAGENT_AGENT_EVENT_DIR || "/tmp/constellagent-agent-events";

function emit(type: AgentTurnType, outcome?: AgentTurnOutcome): void {
  if (!WS_ID) return;

  try {
    mkdirSync(EVENT_DIR, { recursive: true });
    const event: {
      schema: 1;
      workspaceId: string;
      agent: string;
      type: AgentTurnType;
      outcome?: AgentTurnOutcome;
      sessionId?: string;
      at: number;
    } = {
      schema: 1,
      workspaceId: WS_ID,
      agent: "pi-mono",
      type,
      sessionId: SESSION_ID,
      at: Date.now(),
    };
    if (outcome) event.outcome = outcome;

    const baseName = Date.now().toString() + "-" + process.pid.toString() + "-" + Math.random().toString(16).slice(2);
    const target = join(EVENT_DIR, baseName + ".json");
    const tmpTarget = target + ".tmp";
    writeFileSync(tmpTarget, JSON.stringify(event), "utf-8");
    renameSync(tmpTarget, target);
  } catch {
    // best effort
  }
}

export default function(pi: ExtensionAPI) {
  if (!WS_ID) return;

  pi.on("agent_start", async () => {
    emit("turn_started");
  });

  pi.on("agent_end", async () => {
    emit("awaiting_user", "success");
  });
}
`

export async function checkPiActivityExtensionInstalled(): Promise<boolean> {
  try {
    const content = await readFile(PI_ACTIVITY_EXTENSION_FILE, 'utf-8')
    return content.includes(EXTENSION_MARKER)
  } catch {
    return false
  }
}

export async function installPiActivityExtension(): Promise<void> {
  await mkdir(PI_EXTENSIONS_DIR, { recursive: true })
  await writeFile(PI_ACTIVITY_EXTENSION_FILE, PI_ACTIVITY_EXTENSION_SOURCE, 'utf-8')
}

export async function uninstallPiActivityExtension(): Promise<void> {
  try {
    await unlink(PI_ACTIVITY_EXTENSION_FILE)
  } catch {
    // ignore missing file
  }
}
