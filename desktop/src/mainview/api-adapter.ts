import Electrobun, { Electroview } from "electrobun/view";
import type { AutomationConfig, AutomationRunStartedEvent } from "../shared/automation-types";
import type { CreateWorktreeProgressEvent } from "../shared/workspace-creation";
import type { PrLookupResult, ListOpenPrsResult } from "../shared/github-types";

type ViewRPC = {
  bun: {
    requests: {
      gitListWorktrees: { params: { repoPath: string }; response: any[] };
      gitCreateWorktree: { params: any; response: string };
      gitCreateWorktreeFromPr: { params: any; response: { worktreePath: string; branch: string } };
      gitRemoveWorktree: { params: { repoPath: string; worktreePath: string }; response: void };
      gitGetStatus: { params: { worktreePath: string }; response: any[] };
      gitGetDiff: { params: { worktreePath: string; staged: boolean }; response: any[] };
      gitGetFileDiff: { params: { worktreePath: string; filePath: string }; response: string };
      gitGetBranches: { params: { repoPath: string }; response: string[] };
      gitStage: { params: { worktreePath: string; paths: string[] }; response: void };
      gitUnstage: { params: { worktreePath: string; paths: string[] }; response: void };
      gitDiscard: { params: { worktreePath: string; paths: string[]; untracked: string[] }; response: void };
      gitCommit: { params: { worktreePath: string; message: string }; response: void };
      gitGetCurrentBranch: { params: { worktreePath: string }; response: string };
      gitGetDefaultBranch: { params: { repoPath: string }; response: string };
      githubGetPrStatuses: { params: { repoPath: string; branches: string[] }; response: PrLookupResult };
      githubListOpenPrs: { params: { repoPath: string }; response: ListOpenPrsResult };
      ptyCreate: { params: { workingDir: string; shell?: string; extraEnv?: Record<string, string> }; response: string };
      ptyWrite: { params: { ptyId: string; data: string }; response: void };
      ptyResize: { params: { ptyId: string; cols: number; rows: number }; response: void };
      ptyDestroy: { params: { ptyId: string }; response: void };
      ptyList: { params: {}; response: string[] };
      ptyReattach: { params: { ptyId: string; sinceSeq?: number }; response: any };
      fsGetTree: { params: { dirPath: string }; response: any[] };
      fsGetTreeWithStatus: { params: { dirPath: string }; response: any[] };
      fsReadFile: { params: { filePath: string }; response: string };
      fsWriteFile: { params: { filePath: string; content: string }; response: void };
      fsWatchStart: { params: { dirPath: string }; response: void };
      fsWatchStop: { params: { dirPath: string }; response: void };
      appSelectDirectory: { params: {}; response: string | null };
      appAddProjectPath: { params: { dirPath: string }; response: string | null };
      claudeTrustPath: { params: { dirPath: string }; response: void };
      claudeInstallHooks: { params: {}; response: { success: boolean } };
      claudeUninstallHooks: { params: {}; response: { success: boolean } };
      claudeCheckHooks: { params: {}; response: { installed: boolean } };
      codexInstallNotify: { params: {}; response: { success: boolean } };
      codexUninstallNotify: { params: {}; response: { success: boolean } };
      codexCheckNotify: { params: {}; response: { installed: boolean } };
      piInstallActivityExtension: { params: {}; response: { success: boolean } };
      piUninstallActivityExtension: { params: {}; response: { success: boolean } };
      piCheckActivityExtension: { params: {}; response: { installed: boolean } };
      automationCreate: { params: { automation: AutomationConfig }; response: void };
      automationUpdate: { params: { automation: AutomationConfig }; response: void };
      automationDelete: { params: { automationId: string }; response: void };
      automationRunNow: { params: { automation: AutomationConfig }; response: void };
      automationStop: { params: { automationId: string }; response: void };
      clipboardSaveImage: { params: {}; response: string | null };
      stateSave: { params: { data: any }; response: void };
      stateSaveSync: { params: { data: any }; response: boolean };
      stateLoad: { params: {}; response: any };
    };
    messages: {};
  };
  webview: {
    requests: {};
    messages: {
      ptyData: { ptyId: string; startSeq: number; data: string };
      fsWatchChanged: { dirPath: string };
      agentNotifyWorkspace: { workspaceId: string };
      agentActivityUpdate: { workspaceIds: string[] };
      automationRunStarted: AutomationRunStartedEvent;
      gitCreateWorktreeProgress: CreateWorktreeProgressEvent;
    };
  };
};

type EventCallback<T> = (data: T) => void;

const eventListeners = {
  ptyData: new Map<string, Set<EventCallback<any>>>(),
  fsWatchChanged: new Set<EventCallback<string>>(),
  agentNotifyWorkspace: new Set<EventCallback<string>>(),
  agentActivityUpdate: new Set<EventCallback<string[]>>(),
  automationRunStarted: new Set<EventCallback<AutomationRunStartedEvent>>(),
  gitCreateWorktreeProgress: new Set<EventCallback<CreateWorktreeProgressEvent>>(),
};

const rpc = Electroview.defineRPC<ViewRPC>({
  maxRequestTime: 30000,
  handlers: {
    requests: {},
    messages: {
      ptyData: (msg) => {
        const listeners = eventListeners.ptyData.get(msg.ptyId);
        if (listeners) {
          for (const cb of listeners) cb(msg);
        }
      },
      fsWatchChanged: (msg) => {
        for (const cb of eventListeners.fsWatchChanged) cb(msg.dirPath);
      },
      agentNotifyWorkspace: (msg) => {
        for (const cb of eventListeners.agentNotifyWorkspace) cb(msg.workspaceId);
      },
      agentActivityUpdate: (msg) => {
        for (const cb of eventListeners.agentActivityUpdate) cb(msg.workspaceIds);
      },
      automationRunStarted: (msg) => {
        for (const cb of eventListeners.automationRunStarted) cb(msg);
      },
      gitCreateWorktreeProgress: (msg) => {
        for (const cb of eventListeners.gitCreateWorktreeProgress) cb(msg);
      },
    },
  },
});

const electrobun = new Electrobun.Electroview({ rpc });

const req = electrobun.rpc!.request;

export const api = {
  git: {
    listWorktrees: (repoPath: string) => req.gitListWorktrees({ repoPath }),
    createWorktree: (repoPath: string, name: string, branch: string, newBranch: boolean, baseBranch?: string, force?: boolean, requestId?: string) =>
      req.gitCreateWorktree({ repoPath, name, branch, newBranch, baseBranch, force, requestId }),
    createWorktreeFromPr: (repoPath: string, name: string, prNumber: number, localBranch: string, force?: boolean, requestId?: string) =>
      req.gitCreateWorktreeFromPr({ repoPath, name, prNumber, localBranch, force, requestId }) as Promise<{ worktreePath: string; branch: string }>,
    onCreateWorktreeProgress: (callback: (progress: CreateWorktreeProgressEvent) => void) => {
      eventListeners.gitCreateWorktreeProgress.add(callback);
      return () => { eventListeners.gitCreateWorktreeProgress.delete(callback); };
    },
    removeWorktree: (repoPath: string, worktreePath: string) =>
      req.gitRemoveWorktree({ repoPath, worktreePath }),
    getStatus: (worktreePath: string) => req.gitGetStatus({ worktreePath }),
    getDiff: (worktreePath: string, staged: boolean) => req.gitGetDiff({ worktreePath, staged }),
    getFileDiff: (worktreePath: string, filePath: string) => req.gitGetFileDiff({ worktreePath, filePath }),
    getBranches: (repoPath: string) => req.gitGetBranches({ repoPath }),
    stage: (worktreePath: string, paths: string[]) => req.gitStage({ worktreePath, paths }),
    unstage: (worktreePath: string, paths: string[]) => req.gitUnstage({ worktreePath, paths }),
    discard: (worktreePath: string, paths: string[], untracked: string[]) =>
      req.gitDiscard({ worktreePath, paths, untracked }),
    commit: (worktreePath: string, message: string) => req.gitCommit({ worktreePath, message }),
    getCurrentBranch: (worktreePath: string) => req.gitGetCurrentBranch({ worktreePath }) as Promise<string>,
    getDefaultBranch: (repoPath: string) => req.gitGetDefaultBranch({ repoPath }) as Promise<string>,
  },
  pty: {
    create: (workingDir: string, shell?: string, extraEnv?: Record<string, string>) =>
      req.ptyCreate({ workingDir, shell, extraEnv }),
    write: (ptyId: string, data: string) => req.ptyWrite({ ptyId, data }),
    resize: (ptyId: string, cols: number, rows: number) => req.ptyResize({ ptyId, cols, rows }),
    destroy: (ptyId: string) => req.ptyDestroy({ ptyId }),
    list: () => req.ptyList({}) as Promise<string[]>,
    reattach: (ptyId: string, sinceSeq?: number) =>
      req.ptyReattach({ ptyId, sinceSeq }) as Promise<{ ok: boolean; replay?: string; baseSeq: number; endSeq: number; truncated: boolean; cols: number; rows: number }>,
    onData: (ptyId: string, callback: (data: string, startSeq?: number) => void) => {
      const wrappedCb = (msg: { ptyId: string; startSeq: number; data: string }) => {
        callback(msg.data, msg.startSeq);
      };
      if (!eventListeners.ptyData.has(ptyId)) {
        eventListeners.ptyData.set(ptyId, new Set());
      }
      eventListeners.ptyData.get(ptyId)!.add(wrappedCb);
      return () => {
        const set = eventListeners.ptyData.get(ptyId);
        if (set) {
          set.delete(wrappedCb);
          if (set.size === 0) eventListeners.ptyData.delete(ptyId);
        }
      };
    },
  },
  fs: {
    getTree: (dirPath: string) => req.fsGetTree({ dirPath }),
    getTreeWithStatus: (dirPath: string) => req.fsGetTreeWithStatus({ dirPath }),
    readFile: (filePath: string) => req.fsReadFile({ filePath }),
    writeFile: (filePath: string, content: string) => req.fsWriteFile({ filePath, content }),
    watchDir: (dirPath: string) => req.fsWatchStart({ dirPath }),
    unwatchDir: (dirPath: string) => req.fsWatchStop({ dirPath }),
    onDirChanged: (callback: (dirPath: string) => void) => {
      eventListeners.fsWatchChanged.add(callback);
      return () => { eventListeners.fsWatchChanged.delete(callback); };
    },
  },
  app: {
    selectDirectory: () => req.appSelectDirectory({}),
    addProjectPath: (dirPath: string) => req.appAddProjectPath({ dirPath }),
  },
  agent: {
    onNotifyWorkspace: (callback: (workspaceId: string) => void) => {
      eventListeners.agentNotifyWorkspace.add(callback);
      return () => { eventListeners.agentNotifyWorkspace.delete(callback); };
    },
    onActivityUpdate: (callback: (workspaceIds: string[]) => void) => {
      eventListeners.agentActivityUpdate.add(callback);
      return () => { eventListeners.agentActivityUpdate.delete(callback); };
    },
  },
  claude: {
    trustPath: (dirPath: string) => req.claudeTrustPath({ dirPath }),
    installHooks: () => req.claudeInstallHooks({}),
    uninstallHooks: () => req.claudeUninstallHooks({}),
    checkHooks: () => req.claudeCheckHooks({}),
  },
  codex: {
    installNotify: () => req.codexInstallNotify({}),
    uninstallNotify: () => req.codexUninstallNotify({}),
    checkNotify: () => req.codexCheckNotify({}),
  },
  pi: {
    installActivityExtension: () => req.piInstallActivityExtension({}),
    uninstallActivityExtension: () => req.piUninstallActivityExtension({}),
    checkActivityExtension: () => req.piCheckActivityExtension({}),
  },
  automations: {
    create: (automation: AutomationConfig) => req.automationCreate({ automation }),
    update: (automation: AutomationConfig) => req.automationUpdate({ automation }),
    delete: (automationId: string) => req.automationDelete({ automationId }),
    runNow: (automation: AutomationConfig) => req.automationRunNow({ automation }),
    stop: (automationId: string) => req.automationStop({ automationId }),
    onRunStarted: (callback: (data: AutomationRunStartedEvent) => void) => {
      eventListeners.automationRunStarted.add(callback);
      return () => { eventListeners.automationRunStarted.delete(callback); };
    },
  },
  github: {
    getPrStatuses: (repoPath: string, branches: string[]) =>
      req.githubGetPrStatuses({ repoPath, branches }) as Promise<PrLookupResult>,
    listOpenPrs: (repoPath: string) =>
      req.githubListOpenPrs({ repoPath }) as Promise<ListOpenPrsResult>,
  },
  clipboard: {
    saveImage: () => req.clipboardSaveImage({}) as Promise<string | null>,
  },
  state: {
    save: (data: unknown) => req.stateSave({ data }),
    saveSync: (data: unknown) => {
      req.stateSaveSync({ data });
      return true;
    },
    load: () => req.stateLoad({}),
  },
};

(window as any).api = api;

export type ElectronAPI = typeof api;
