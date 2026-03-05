import { BrowserView, BrowserWindow, Updater, Utils, type RPCSchema } from "electrobun/bun";
import { join, relative } from "path";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, watch, type FSWatcher } from "fs";
import { mkdir, writeFile, stat } from "fs/promises";
import { tmpdir, homedir } from "os";
import type { AppRPC } from "../shared/rpc-schema";
import type { AutomationConfig } from "../shared/automation-types";
import type { CreateWorktreeProgressEvent } from "../shared/workspace-creation";
import { PtyManager } from "../main/pty-manager";
import { GitService } from "../main/git-service";
import { GithubService } from "../main/github-service";
import { FileService, type FileNode } from "../main/file-service";
import { AutomationScheduler } from "../main/automation-scheduler";
import { NotificationWatcher } from "../main/notification-watcher";
import {
  trustPathForClaude,
  loadClaudeSettings,
  saveClaudeSettings,
  loadJsonFile,
  saveJsonFile,
} from "../main/claude-config";
import { loadCodexConfigText, saveCodexConfigText } from "../main/codex-config";
import {
  checkPiActivityExtensionInstalled,
  installPiActivityExtension,
  uninstallPiActivityExtension,
} from "../main/pi-config";

const DEV_SERVER_PORT = 5173;
const DEV_SERVER_URL = `http://localhost:${DEV_SERVER_PORT}`;

const ptyManager = new PtyManager();
const automationScheduler = new AutomationScheduler(ptyManager);
const notificationWatcher = new NotificationWatcher();

// State persistence path
const userDataDir = join(homedir(), ".constellagent");
mkdirSync(userDataDir, { recursive: true });
const stateFilePath = join(userDataDir, "constellagent-state.json");

// FS watchers
interface FsWatcherEntry {
  watcher: FSWatcher;
  timer: ReturnType<typeof setTimeout> | null;
  refs: number;
}
const fsWatchers = new Map<string, FsWatcherEntry>();

// State sanitization (same logic as before)
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function sanitizeLoadedState(data: unknown): { data: unknown; changed: boolean; removedWorkspaceCount: number } {
  if (!isRecord(data)) return { data, changed: false, removedWorkspaceCount: 0 };
  const rawWorkspaces = Array.isArray(data.workspaces) ? data.workspaces : null;
  if (!rawWorkspaces) return { data, changed: false, removedWorkspaceCount: 0 };

  const keptWorkspaces: unknown[] = [];
  const keptWorkspaceIds = new Set<string>();
  let removedWorkspaceCount = 0;

  for (const workspace of rawWorkspaces) {
    if (
      !isRecord(workspace) ||
      typeof workspace.id !== "string" ||
      typeof workspace.worktreePath !== "string" ||
      !existsSync(workspace.worktreePath)
    ) {
      removedWorkspaceCount += 1;
      continue;
    }
    keptWorkspaces.push(workspace);
    keptWorkspaceIds.add(workspace.id);
  }

  if (removedWorkspaceCount === 0) {
    return { data, changed: false, removedWorkspaceCount: 0 };
  }

  const next: Record<string, unknown> = { ...data, workspaces: keptWorkspaces };

  const rawTabs = Array.isArray(data.tabs) ? data.tabs : null;
  if (rawTabs) {
    next.tabs = rawTabs.filter(
      (tab) => isRecord(tab) && typeof tab.workspaceId === "string" && keptWorkspaceIds.has(tab.workspaceId)
    );
  }

  return { data: next, changed: true, removedWorkspaceCount };
}

// Hook script helpers
function getHookScriptPath(name: string): string {
  return join(__dirname, "..", "..", "claude-hooks", name);
}

function getCodexHookScriptPath(name: string): string {
  return join(__dirname, "..", "..", "codex-hooks", name);
}

const HOOK_IDENTIFIERS = [
  "claude-hooks/notify.sh",
  "claude-hooks/activity.sh",
  "claude-hooks/question-notify.sh",
];

function shellQuoteArg(value: string): string {
  return `'${value.replace(/'/g, "'\"'\"'")}'`;
}

function isOurHook(rule: { hooks?: Array<{ command?: string }> }): boolean {
  return !!rule.hooks?.some((h) => HOOK_IDENTIFIERS.some((id) => h.command?.includes(id)));
}

// Codex TOML helpers
const CODEX_NOTIFY_IDENTIFIER = "codex-hooks/notify.sh";
const TABLE_HEADER_RE = /^\s*\[[^\n]+\]\s*$/m;
const NOTIFY_ASSIGNMENT_RE = /^\s*notify\s*=/;

function tomlEscape(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function firstTableHeaderIndex(configText: string): number {
  const match = configText.match(TABLE_HEADER_RE);
  return match?.index ?? -1;
}

function topLevelSection(configText: string): string {
  const idx = firstTableHeaderIndex(configText);
  return idx === -1 ? configText : configText.slice(0, idx);
}

function hasOurCodexNotify(configText: string): boolean {
  return topLevelSection(configText).includes(CODEX_NOTIFY_IDENTIFIER);
}

function stripNotifyAssignments(
  configText: string,
  shouldStrip: (assignment: string) => boolean = () => true
): string {
  const lines = configText.split("\n");
  const kept: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!NOTIFY_ASSIGNMENT_RE.test(line)) {
      kept.push(line);
      i += 1;
      continue;
    }
    let end = i;
    const startsArray = line.includes("[");
    const endsArray = line.includes("]");
    if (startsArray && !endsArray) {
      let j = i + 1;
      while (j < lines.length) {
        end = j;
        if (lines[j].includes("]")) break;
        j += 1;
      }
    }
    const assignment = lines.slice(i, end + 1).join("\n");
    if (!shouldStrip(assignment)) {
      kept.push(...lines.slice(i, end + 1));
    }
    i = end + 1;
  }
  return kept.join("\n");
}

function insertTopLevelNotify(configText: string, notifyLine: string): string {
  const withoutNotify = configText.trimEnd();
  if (!withoutNotify) return `${notifyLine}\n`;
  const idx = firstTableHeaderIndex(withoutNotify);
  if (idx === -1) return `${withoutNotify}\n${notifyLine}\n`;
  const beforeTables = withoutNotify.slice(0, idx).trimEnd();
  const tablesAndBelow = withoutNotify.slice(idx).replace(/^\n+/, "");
  const rebuilt = beforeTables
    ? `${beforeTables}\n${notifyLine}\n\n${tablesAndBelow}`
    : `${notifyLine}\n\n${tablesAndBelow}`;
  return `${rebuilt.replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
}

// RPC setup
let sendMessageToWebview: ((msg: any) => void) | null = null;

const rpc = BrowserView.defineRPC<AppRPC>({
  maxRequestTime: 30000,
  handlers: {
    requests: {
      // Git
      gitListWorktrees: ({ repoPath }) => GitService.listWorktrees(repoPath),
      gitCreateWorktree: async ({ repoPath, name, branch, newBranch, baseBranch, force, requestId }) => {
        return GitService.createWorktree(repoPath, name, branch, newBranch, baseBranch, force, (progress) => {
          const payload: CreateWorktreeProgressEvent = { requestId, ...progress };
          try { rpcSend()?.gitCreateWorktreeProgress?.(payload); } catch {}
        });
      },
      gitCreateWorktreeFromPr: async ({ repoPath, name, prNumber, localBranch, force, requestId }) => {
        return GitService.createWorktreeFromPr(repoPath, name, prNumber, localBranch, force, (progress) => {
          const payload: CreateWorktreeProgressEvent = { requestId, ...progress };
          try { rpcSend()?.gitCreateWorktreeProgress?.(payload); } catch {}
        });
      },
      gitRemoveWorktree: ({ repoPath, worktreePath }) => GitService.removeWorktree(repoPath, worktreePath),
      gitGetStatus: ({ worktreePath }) => GitService.getStatus(worktreePath),
      gitGetDiff: ({ worktreePath, staged }) => GitService.getDiff(worktreePath, staged),
      gitGetFileDiff: ({ worktreePath, filePath }) => GitService.getFileDiff(worktreePath, filePath),
      gitGetBranches: ({ repoPath }) => GitService.getBranches(repoPath),
      gitStage: ({ worktreePath, paths }) => GitService.stage(worktreePath, paths),
      gitUnstage: ({ worktreePath, paths }) => GitService.unstage(worktreePath, paths),
      gitDiscard: ({ worktreePath, paths, untracked }) => GitService.discard(worktreePath, paths, untracked),
      gitCommit: ({ worktreePath, message }) => GitService.commit(worktreePath, message),
      gitGetCurrentBranch: ({ worktreePath }) => GitService.getCurrentBranch(worktreePath),
      gitGetDefaultBranch: ({ repoPath }) => GitService.getDefaultBranch(repoPath),

      // GitHub
      githubGetPrStatuses: ({ repoPath, branches }) => GithubService.getPrStatuses(repoPath, branches),
      githubListOpenPrs: ({ repoPath }) => GithubService.listOpenPrs(repoPath),

      // PTY
      ptyCreate: ({ workingDir, shell, extraEnv }) => {
        return ptyManager.create(workingDir, shell, extraEnv);
      },
      ptyWrite: ({ ptyId, data }) => {
        ptyManager.write(ptyId, data);
      },
      ptyResize: ({ ptyId, cols, rows }) => {
        ptyManager.resize(ptyId, cols, rows);
      },
      ptyDestroy: ({ ptyId }) => {
        ptyManager.destroy(ptyId);
      },
      ptyList: () => ptyManager.list(),
      ptyReattach: ({ ptyId, sinceSeq }) => {
        return ptyManager.reattach(ptyId, sinceSeq);
      },

      // File system
      fsGetTree: ({ dirPath }) => FileService.getTree(dirPath),
      fsGetTreeWithStatus: async ({ dirPath }) => {
        const [tree, statuses, topLevel] = await Promise.all([
          FileService.getTree(dirPath),
          GitService.getStatus(dirPath).catch(() => []),
          GitService.getTopLevel(dirPath).catch(() => dirPath),
        ]);

        const prefix = relative(topLevel, dirPath);
        const statusMap = new Map<string, string>();
        for (const s of statuses) {
          let p = s.path;
          if (p.includes(" -> ")) p = p.split(" -> ")[1];
          if (prefix && p.startsWith(prefix + "/")) p = p.slice(prefix.length + 1);
          statusMap.set(p, s.status);
        }

        function annotate(nodes: FileNode[]): boolean {
          let hasStatus = false;
          for (const node of nodes) {
            const rel = node.path.startsWith(dirPath) ? node.path.slice(dirPath.length + 1) : node.path;
            if (node.type === "file") {
              const st = statusMap.get(rel);
              if (st) {
                node.gitStatus = st as FileNode["gitStatus"];
                hasStatus = true;
              }
            } else if (node.children) {
              if (annotate(node.children)) {
                node.gitStatus = "modified";
                hasStatus = true;
              }
            }
          }
          return hasStatus;
        }

        annotate(tree);
        return tree;
      },
      fsReadFile: ({ filePath }) => FileService.readFile(filePath),
      fsWriteFile: ({ filePath, content }) => FileService.writeFile(filePath, content),
      fsWatchStart: ({ dirPath }) => {
        const existing = fsWatchers.get(dirPath);
        if (existing) {
          existing.refs += 1;
          return;
        }
        try {
          const watcher = watch(dirPath, { recursive: true }, (_eventType, filename) => {
            if (filename && (filename.startsWith(".git/") || filename.startsWith(".git\\"))) {
              const f = filename.replaceAll("\\", "/");
              const isStateChange = f === ".git/index" || f === ".git/HEAD" || f.startsWith(".git/refs/");
              if (!isStateChange) return;
            }
            const entry = fsWatchers.get(dirPath);
            if (!entry) return;
            if (entry.timer) clearTimeout(entry.timer);
            entry.timer = setTimeout(() => {
              try { rpcSend()?.fsWatchChanged?.({ dirPath }); } catch {}
            }, 500);
          });
          fsWatchers.set(dirPath, { watcher, timer: null, refs: 1 });
        } catch {
          // Directory may not exist
        }
      },
      fsWatchStop: ({ dirPath }) => {
        const entry = fsWatchers.get(dirPath);
        if (!entry) return;
        entry.refs -= 1;
        if (entry.refs <= 0) {
          if (entry.timer) clearTimeout(entry.timer);
          entry.watcher.close();
          fsWatchers.delete(dirPath);
        }
      },

      // App
      appSelectDirectory: async () => {
        try {
          const paths = await Utils.openFileDialog({
            startingFolder: homedir(),
            canChooseFiles: false,
            canChooseDirectory: true,
            allowsMultipleSelection: false,
          });
          if (paths.length > 0 && paths[0] !== "") return paths[0];
          return null;
        } catch {
          return null;
        }
      },
      appAddProjectPath: async ({ dirPath }) => {
        try {
          const s = await stat(dirPath);
          if (!s.isDirectory()) return null;
          return dirPath;
        } catch {
          return null;
        }
      },

      // Claude
      claudeTrustPath: ({ dirPath }) => trustPathForClaude(dirPath),
      claudeCheckHooks: async () => {
        const settings = await loadClaudeSettings();
        const hooks = settings.hooks as Record<string, unknown[]> | undefined;
        if (!hooks) return { installed: false };
        const hasStop = (hooks.Stop as Array<{ hooks?: Array<{ command?: string }> }> | undefined)?.some(isOurHook);
        const hasNotification = (hooks.Notification as Array<{ hooks?: Array<{ command?: string }> }> | undefined)?.some(isOurHook);
        const hasPromptSubmit = (hooks.UserPromptSubmit as Array<{ hooks?: Array<{ command?: string }> }> | undefined)?.some(isOurHook);
        const hasQuestionHook = (hooks.PreToolUse as Array<{ hooks?: Array<{ command?: string }> }> | undefined)?.some(isOurHook);
        return { installed: !!(hasStop && hasNotification && hasPromptSubmit && hasQuestionHook) };
      },
      claudeInstallHooks: async () => {
        const settings = await loadClaudeSettings();
        const notifyPath = getHookScriptPath("notify.sh");
        const activityPath = getHookScriptPath("activity.sh");
        const questionNotifyPath = getHookScriptPath("question-notify.sh");
        const hooks = (settings.hooks ?? {}) as Record<string, unknown[]>;

        function ensureHook(event: string, scriptPath: string, matcher = "") {
          const rules = (hooks[event] ?? []) as Array<Record<string, unknown>>;
          const filtered = rules.filter((rule) => !isOurHook(rule as { hooks?: Array<{ command?: string }> }));
          filtered.push({ matcher, hooks: [{ type: "command", command: shellQuoteArg(scriptPath) }] });
          hooks[event] = filtered;
        }

        ensureHook("Stop", notifyPath);
        ensureHook("Notification", notifyPath);
        ensureHook("UserPromptSubmit", activityPath);
        ensureHook("PreToolUse", questionNotifyPath);
        settings.hooks = hooks;
        await saveClaudeSettings(settings);
        return { success: true };
      },
      claudeUninstallHooks: async () => {
        const settings = await loadClaudeSettings();
        const hooks = settings.hooks as Record<string, unknown[]> | undefined;
        if (!hooks) return { success: true };
        for (const event of ["Stop", "Notification", "UserPromptSubmit", "PreToolUse"]) {
          const rules = (hooks[event] ?? []) as Array<{ hooks?: Array<{ command?: string }> }>;
          hooks[event] = rules.filter((rule) => !isOurHook(rule));
          if ((hooks[event] as unknown[]).length === 0) delete hooks[event];
        }
        if (Object.keys(hooks).length === 0) delete settings.hooks;
        await saveClaudeSettings(settings);
        return { success: true };
      },

      // Codex
      codexCheckNotify: async () => {
        const config = await loadCodexConfigText();
        return { installed: hasOurCodexNotify(config) };
      },
      codexInstallNotify: async () => {
        const notifyPath = getCodexHookScriptPath("notify.sh");
        const notifyLine = `notify = ["${tomlEscape(notifyPath)}"]`;
        let config = await loadCodexConfigText();
        config = stripNotifyAssignments(config);
        config = insertTopLevelNotify(config, notifyLine);
        await saveCodexConfigText(config);
        return { success: true };
      },
      codexUninstallNotify: async () => {
        let config = await loadCodexConfigText();
        if (!config.includes(CODEX_NOTIFY_IDENTIFIER)) return { success: true };
        config = stripNotifyAssignments(config, (a) => a.includes(CODEX_NOTIFY_IDENTIFIER));
        config = config.replace(/\n{3,}/g, "\n\n").trimEnd();
        if (config) config += "\n";
        await saveCodexConfigText(config);
        return { success: true };
      },

      // Pi
      piCheckActivityExtension: async () => ({ installed: await checkPiActivityExtensionInstalled() }),
      piInstallActivityExtension: async () => {
        await installPiActivityExtension();
        return { success: true };
      },
      piUninstallActivityExtension: async () => {
        await uninstallPiActivityExtension();
        return { success: true };
      },

      // Automation
      automationCreate: ({ automation }) => {
        automationScheduler.schedule(automation);
      },
      automationUpdate: ({ automation }) => {
        automationScheduler.schedule(automation);
      },
      automationDelete: ({ automationId }) => {
        automationScheduler.unschedule(automationId);
      },
      automationRunNow: ({ automation }) => {
        automationScheduler.runNow(automation);
      },
      automationStop: ({ automationId }) => {
        automationScheduler.unschedule(automationId);
      },

      // Clipboard
      clipboardSaveImage: () => {
        // Clipboard image access is not available in Electrobun's Bun process.
        return null;
      },

      // State persistence
      stateSave: async ({ data }) => {
        await mkdir(userDataDir, { recursive: true });
        await saveJsonFile(stateFilePath, data);
      },
      stateSaveSync: ({ data }) => {
        try {
          mkdirSync(userDataDir, { recursive: true });
          writeFileSync(stateFilePath, JSON.stringify(data, null, 2), "utf-8");
          return true;
        } catch {
          return false;
        }
      },
      stateLoad: async () => {
        const loaded = await loadJsonFile(stateFilePath, null);
        const sanitized = sanitizeLoadedState(loaded);
        if (sanitized.changed) {
          await saveJsonFile(stateFilePath, sanitized.data).catch(() => {});
        }
        return sanitized.data;
      },
    },
    messages: {},
  },
});

// Check for dev server
async function getMainViewUrl(): Promise<string> {
  const channel = await Updater.localInfo.channel();
  if (channel === "dev") {
    try {
      await fetch(DEV_SERVER_URL, { method: "HEAD" });
      console.log(`HMR enabled: Using Vite dev server at ${DEV_SERVER_URL}`);
      return DEV_SERVER_URL;
    } catch {
      console.log("Vite dev server not running. Run 'bun run dev:hmr' for HMR support.");
    }
  }
  return "views://mainview/index.html";
}

const url = await getMainViewUrl();

const mainWindow = new BrowserWindow({
  title: "Constellagent",
  url,
  rpc,
  frame: {
    width: 1400,
    height: 900,
    x: 200,
    y: 200,
  },
  titleBarStyle: "hiddenInset",
});

// Set up PTY data forwarding via Electrobun RPC send
const rpcSend = () => (mainWindow.webview.rpc as any)?.send;

sendMessageToWebview = (msg: any) => {
  try {
    const send = rpcSend();
    send?.[msg.type]?.(msg);
  } catch {
    // Window may be closed
  }
};

ptyManager.setDataCallback((ptyId: string, startSeq: number, data: string) => {
  try {
    rpcSend()?.ptyData?.({ ptyId, startSeq, data });
  } catch {}
});

notificationWatcher.setCallbacks({
  notifyWorkspace: (workspaceId: string) => {
    try { rpcSend()?.agentNotifyWorkspace?.({ workspaceId }); } catch {}
  },
  activityUpdate: (workspaceIds: string[]) => {
    try { rpcSend()?.agentActivityUpdate?.({ workspaceIds }); } catch {}
  },
});

automationScheduler.setNotifyCallback((event) => {
  try { rpcSend()?.automationRunStarted?.(event); } catch {}
});

notificationWatcher.start();

console.log("Constellagent started!");
