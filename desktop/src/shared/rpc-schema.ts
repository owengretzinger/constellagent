import type { RPCSchema } from "electrobun/bun";
import type { AutomationConfig, AutomationRunStartedEvent } from "./automation-types";
import type { CreateWorktreeProgressEvent } from "./workspace-creation";
import type { PrLookupResult, ListOpenPrsResult } from "./github-types";

export interface FileNode {
  name: string;
  path: string;
  type: "file" | "directory";
  children?: FileNode[];
  gitStatus?: "modified" | "added" | "deleted" | "renamed" | "untracked";
}

export interface ReattachResult {
  ok: boolean;
  replay?: string;
  baseSeq: number;
  endSeq: number;
  truncated: boolean;
  cols: number;
  rows: number;
}

export type AppRPC = {
  bun: RPCSchema<{
    requests: {
      // Git
      gitListWorktrees: { params: { repoPath: string }; response: any[] };
      gitCreateWorktree: {
        params: {
          repoPath: string;
          name: string;
          branch: string;
          newBranch: boolean;
          baseBranch?: string;
          force?: boolean;
          requestId?: string;
        };
        response: string;
      };
      gitCreateWorktreeFromPr: {
        params: {
          repoPath: string;
          name: string;
          prNumber: number;
          localBranch: string;
          force?: boolean;
          requestId?: string;
        };
        response: { worktreePath: string; branch: string };
      };
      gitRemoveWorktree: {
        params: { repoPath: string; worktreePath: string };
        response: void;
      };
      gitGetStatus: { params: { worktreePath: string }; response: any[] };
      gitGetDiff: {
        params: { worktreePath: string; staged: boolean };
        response: any[];
      };
      gitGetFileDiff: {
        params: { worktreePath: string; filePath: string };
        response: string;
      };
      gitGetBranches: { params: { repoPath: string }; response: string[] };
      gitStage: {
        params: { worktreePath: string; paths: string[] };
        response: void;
      };
      gitUnstage: {
        params: { worktreePath: string; paths: string[] };
        response: void;
      };
      gitDiscard: {
        params: { worktreePath: string; paths: string[]; untracked: string[] };
        response: void;
      };
      gitCommit: {
        params: { worktreePath: string; message: string };
        response: void;
      };
      gitGetCurrentBranch: {
        params: { worktreePath: string };
        response: string;
      };
      gitGetDefaultBranch: {
        params: { repoPath: string };
        response: string;
      };
      // GitHub
      githubGetPrStatuses: {
        params: { repoPath: string; branches: string[] };
        response: PrLookupResult;
      };
      githubListOpenPrs: {
        params: { repoPath: string };
        response: ListOpenPrsResult;
      };
      // PTY
      ptyCreate: {
        params: {
          workingDir: string;
          shell?: string;
          extraEnv?: Record<string, string>;
        };
        response: string;
      };
      ptyWrite: {
        params: { ptyId: string; data: string };
        response: void;
      };
      ptyResize: {
        params: { ptyId: string; cols: number; rows: number };
        response: void;
      };
      ptyDestroy: { params: { ptyId: string }; response: void };
      ptyList: { params: {}; response: string[] };
      ptyReattach: {
        params: { ptyId: string; sinceSeq?: number };
        response: ReattachResult;
      };
      // File system
      fsGetTree: { params: { dirPath: string }; response: FileNode[] };
      fsGetTreeWithStatus: {
        params: { dirPath: string };
        response: FileNode[];
      };
      fsReadFile: { params: { filePath: string }; response: string };
      fsWriteFile: {
        params: { filePath: string; content: string };
        response: void;
      };
      fsWatchStart: { params: { dirPath: string }; response: void };
      fsWatchStop: { params: { dirPath: string }; response: void };
      // App
      appSelectDirectory: { params: {}; response: string | null };
      appAddProjectPath: {
        params: { dirPath: string };
        response: string | null;
      };
      // Claude
      claudeTrustPath: { params: { dirPath: string }; response: void };
      claudeInstallHooks: {
        params: {};
        response: { success: boolean };
      };
      claudeUninstallHooks: {
        params: {};
        response: { success: boolean };
      };
      claudeCheckHooks: {
        params: {};
        response: { installed: boolean };
      };
      // Codex
      codexInstallNotify: {
        params: {};
        response: { success: boolean };
      };
      codexUninstallNotify: {
        params: {};
        response: { success: boolean };
      };
      codexCheckNotify: {
        params: {};
        response: { installed: boolean };
      };
      // Pi
      piInstallActivityExtension: {
        params: {};
        response: { success: boolean };
      };
      piUninstallActivityExtension: {
        params: {};
        response: { success: boolean };
      };
      piCheckActivityExtension: {
        params: {};
        response: { installed: boolean };
      };
      // Automation
      automationCreate: { params: { automation: AutomationConfig }; response: void };
      automationUpdate: { params: { automation: AutomationConfig }; response: void };
      automationDelete: { params: { automationId: string }; response: void };
      automationRunNow: { params: { automation: AutomationConfig }; response: void };
      automationStop: { params: { automationId: string }; response: void };
      // Clipboard
      clipboardSaveImage: { params: {}; response: string | null };
      // State
      stateSave: { params: { data: any }; response: void };
      stateSaveSync: { params: { data: any }; response: boolean };
      stateLoad: { params: {}; response: any };
    };
    messages: {};
  }>;
  webview: RPCSchema<{
    requests: {};
    messages: {
      ptyData: { ptyId: string; startSeq: number; data: string };
      fsWatchChanged: { dirPath: string };
      agentNotifyWorkspace: { workspaceId: string };
      agentActivityUpdate: { workspaceIds: string[] };
      automationRunStarted: AutomationRunStartedEvent;
      gitCreateWorktreeProgress: CreateWorktreeProgressEvent;
    };
  }>;
};
