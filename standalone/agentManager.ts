/**
 * Agent registry and lifecycle for standalone mode.
 * Replaces src/agentManager.ts without VS Code terminal dependencies.
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import type { AgentState } from "../src/types.js";
import { startFileWatching, readNewLines } from "../src/fileWatcher.js";
import {
  cancelWaitingTimer,
  cancelPermissionTimer
} from "../src/timerManager.js";
import {
  JSONL_POLL_INTERVAL_MS,
  PROJECT_SCAN_INTERVAL_MS,
  ACTIVE_FILE_RECENCY_MS
} from "../src/constants.js";
import {
  createAgentPane,
  focusAgentPane,
  killAgentPane,
  isTmuxPaneAlive
} from "./tmuxLauncher.js";
import {
  readPersistedAgents,
  writePersistedAgents,
  readSettings
} from "./settingsPersistence.js";
import type { PersistedStandaloneAgent } from "./settingsPersistence.js";

// ── Webview shim interface ──────────────────────────────────
// src/ modules expect { postMessage(msg: unknown): void }
export interface WebviewShim {
  postMessage(msg: unknown): void;
}

// ── Project path ────────────────────────────────────────────

export function getProjectDirPath(cwd: string): string {
  const dirName = cwd.replace(/[^a-zA-Z0-9-]/g, "-");
  return path.join(os.homedir(), ".claude", "projects", dirName);
}

// ── Agent registry ──────────────────────────────────────────

export interface StandaloneContext {
  projectCwd: string;
  projectDir: string;
  tmuxSession: string;
  agents: Map<number, AgentState>;
  agentPanes: Map<number, string>; // agentId → tmuxPaneId
  nextAgentId: { current: number };
  knownJsonlFiles: Set<string>;
  fileWatchers: Map<number, fs.FSWatcher>;
  pollingTimers: Map<number, ReturnType<typeof setInterval>>;
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>;
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>;
  jsonlPollTimers: Map<number, ReturnType<typeof setInterval>>;
  projectScanTimer: { current: ReturnType<typeof setInterval> | null };
  webview: WebviewShim | undefined;
}

export function createContext(
  projectCwd: string,
  tmuxSession: string
): StandaloneContext {
  const projectDir = getProjectDirPath(projectCwd);
  return {
    projectCwd,
    projectDir,
    tmuxSession,
    agents: new Map(),
    agentPanes: new Map(),
    nextAgentId: { current: 1 },
    knownJsonlFiles: new Set(),
    fileWatchers: new Map(),
    pollingTimers: new Map(),
    waitingTimers: new Map(),
    permissionTimers: new Map(),
    jsonlPollTimers: new Map(),
    projectScanTimer: { current: null },
    webview: undefined
  };
}

// ── Agent creation ──────────────────────────────────────────

export function launchNewAgent(ctx: StandaloneContext): number {
  const pane = createAgentPane(ctx.tmuxSession, ctx.projectCwd);

  const expectedFile = path.join(ctx.projectDir, `${pane.sessionId}.jsonl`);
  ctx.knownJsonlFiles.add(expectedFile);

  const id = ctx.nextAgentId.current++;
  // Create a stub terminalRef — src/types.ts requires it but we never use it
  const agent: AgentState = {
    id,
    terminalRef: { name: `Claude Code #${id}` } as never,
    projectDir: ctx.projectDir,
    jsonlFile: expectedFile,
    fileOffset: 0,
    lineBuffer: "",
    activeToolIds: new Set(),
    activeToolStatuses: new Map(),
    activeToolNames: new Map(),
    activeSubagentToolIds: new Map(),
    activeSubagentToolNames: new Map(),
    isWaiting: false,
    permissionSent: false,
    hadToolsInTurn: false
  };

  ctx.agents.set(id, agent);
  ctx.agentPanes.set(id, pane.paneId);
  persistAgents(ctx);

  console.log(
    `[Standalone] Agent ${id}: created (pane=${pane.paneId}, session=${pane.sessionId})`
  );
  ctx.webview?.postMessage({ type: "agentCreated", id });

  // Poll for the JSONL file to appear
  const pollTimer = setInterval(() => {
    try {
      if (fs.existsSync(agent.jsonlFile)) {
        console.log(
          `[Standalone] Agent ${id}: found JSONL file ${path.basename(agent.jsonlFile)}`
        );
        clearInterval(pollTimer);
        ctx.jsonlPollTimers.delete(id);
        startFileWatching(
          id,
          agent.jsonlFile,
          ctx.agents,
          ctx.fileWatchers,
          ctx.pollingTimers,
          ctx.waitingTimers,
          ctx.permissionTimers,
          ctx.webview as never
        );
        readNewLines(
          id,
          ctx.agents,
          ctx.waitingTimers,
          ctx.permissionTimers,
          ctx.webview as never
        );
      }
    } catch {
      /* file may not exist yet */
    }
  }, JSONL_POLL_INTERVAL_MS);
  ctx.jsonlPollTimers.set(id, pollTimer);

  return id;
}

// ── Agent removal ───────────────────────────────────────────

export function removeAgent(ctx: StandaloneContext, agentId: number): void {
  const agent = ctx.agents.get(agentId);
  if (!agent) return;

  // Stop JSONL poll timer
  const jpTimer = ctx.jsonlPollTimers.get(agentId);
  if (jpTimer) {
    clearInterval(jpTimer);
  }
  ctx.jsonlPollTimers.delete(agentId);

  // Stop file watching
  ctx.fileWatchers.get(agentId)?.close();
  ctx.fileWatchers.delete(agentId);
  const pt = ctx.pollingTimers.get(agentId);
  if (pt) {
    clearInterval(pt);
  }
  ctx.pollingTimers.delete(agentId);
  try {
    fs.unwatchFile(agent.jsonlFile);
  } catch {
    /* ignore */
  }

  // Cancel timers
  cancelWaitingTimer(agentId, ctx.waitingTimers);
  cancelPermissionTimer(agentId, ctx.permissionTimers);

  // Kill tmux pane
  const paneId = ctx.agentPanes.get(agentId);
  if (paneId) {
    killAgentPane(paneId);
    ctx.agentPanes.delete(agentId);
  }

  // Remove from maps
  ctx.agents.delete(agentId);
  persistAgents(ctx);

  ctx.webview?.postMessage({ type: "agentClosed", id: agentId });
  console.log(`[Standalone] Agent ${agentId}: removed`);
}

// ── Focus agent ─────────────────────────────────────────────

export function focusAgent(ctx: StandaloneContext, agentId: number): void {
  const paneId = ctx.agentPanes.get(agentId);
  if (paneId) {
    focusAgentPane(paneId);
  }
}

// ── Persistence ─────────────────────────────────────────────

function persistAgents(ctx: StandaloneContext): void {
  const persisted: PersistedStandaloneAgent[] = [];
  for (const [agentId, agent] of ctx.agents) {
    const paneId = ctx.agentPanes.get(agentId) || "";
    persisted.push({
      id: agent.id,
      tmuxPaneId: paneId,
      jsonlFile: agent.jsonlFile,
      projectDir: agent.projectDir
    });
  }
  writePersistedAgents(persisted);
}

// ── Restore agents on reconnect ─────────────────────────────

export function restoreAgents(ctx: StandaloneContext): void {
  const persisted = readPersistedAgents();
  if (persisted.length === 0) return;

  let maxId = 0;

  for (const p of persisted) {
    // Check if tmux pane is still alive
    if (!isTmuxPaneAlive(p.tmuxPaneId)) {
      console.log(
        `[Standalone] Agent ${p.id}: pane ${p.tmuxPaneId} is dead, skipping`
      );
      continue;
    }

    const agent: AgentState = {
      id: p.id,
      terminalRef: { name: `Claude Code #${p.id}` } as never,
      projectDir: p.projectDir,
      jsonlFile: p.jsonlFile,
      fileOffset: 0,
      lineBuffer: "",
      activeToolIds: new Set(),
      activeToolStatuses: new Map(),
      activeToolNames: new Map(),
      activeSubagentToolIds: new Map(),
      activeSubagentToolNames: new Map(),
      isWaiting: false,
      permissionSent: false,
      hadToolsInTurn: false
    };

    ctx.agents.set(p.id, agent);
    ctx.agentPanes.set(p.id, p.tmuxPaneId);
    ctx.knownJsonlFiles.add(p.jsonlFile);

    if (p.id > maxId) maxId = p.id;

    // Start file watching, skip to end of file
    try {
      if (fs.existsSync(p.jsonlFile)) {
        const stat = fs.statSync(p.jsonlFile);
        agent.fileOffset = stat.size;
        startFileWatching(
          p.id,
          p.jsonlFile,
          ctx.agents,
          ctx.fileWatchers,
          ctx.pollingTimers,
          ctx.waitingTimers,
          ctx.permissionTimers,
          ctx.webview as never
        );
        console.log(
          `[Standalone] Restored agent ${p.id} (pane=${p.tmuxPaneId})`
        );
      }
    } catch {
      /* ignore errors during restore */
    }
  }

  if (maxId >= ctx.nextAgentId.current) {
    ctx.nextAgentId.current = maxId + 1;
  }

  // Re-persist cleaned up list
  persistAgents(ctx);
}

// ── Send existing agents to webview ─────────────────────────

export function sendExistingAgents(ctx: StandaloneContext): void {
  if (!ctx.webview) return;

  const agentIds: number[] = [];
  for (const id of ctx.agents.keys()) {
    agentIds.push(id);
  }
  agentIds.sort((a, b) => a - b);

  // Read seat assignments from settings
  const settings = readSettings();
  const agentMeta = settings.agentSeats || {};

  ctx.webview.postMessage({
    type: "existingAgents",
    agents: agentIds,
    agentMeta,
    folderNames: {}
  });

  // Re-send current agent statuses
  for (const [agentId, agent] of ctx.agents) {
    for (const [toolId, status] of agent.activeToolStatuses) {
      ctx.webview.postMessage({
        type: "agentToolStart",
        id: agentId,
        toolId,
        status
      });
    }
    if (agent.isWaiting) {
      ctx.webview.postMessage({
        type: "agentStatus",
        id: agentId,
        status: "waiting"
      });
    }
  }
}

// ── Project directory scanning ──────────────────────────────
// Simplified version of src/fileWatcher.ts ensureProjectScan
// without VS Code terminal adoption logic.

export function startProjectScan(ctx: StandaloneContext): void {
  if (ctx.projectScanTimer.current) return;

  // Seed known files — only files already tracked by persisted agents
  // All other existing files will be checked for recent activity and adopted
  // This ensures externally-spawned sessions (e.g. Agent Teams) are discovered
  for (const agent of ctx.agents.values()) {
    ctx.knownJsonlFiles.add(agent.jsonlFile);
  }

  // Immediately scan for active files on startup
  scanForNewJsonlFiles(ctx);

  ctx.projectScanTimer.current = setInterval(() => {
    scanForNewJsonlFiles(ctx);
  }, PROJECT_SCAN_INTERVAL_MS);
}

function scanForNewJsonlFiles(ctx: StandaloneContext): void {
  let files: string[];
  try {
    files = fs
      .readdirSync(ctx.projectDir)
      .filter((f: string) => f.endsWith(".jsonl"))
      .map((f: string) => path.join(ctx.projectDir, f));
  } catch {
    return;
  }

  const now = Date.now();
  for (const file of files) {
    if (!ctx.knownJsonlFiles.has(file)) {
      // Only adopt files modified recently (within ACTIVE_FILE_RECENCY_MS)
      // This prevents adopting old dead sessions on startup
      try {
        const stat = fs.statSync(file);
        if (now - stat.mtimeMs > ACTIVE_FILE_RECENCY_MS) {
          ctx.knownJsonlFiles.add(file); // Mark as known so we don't re-check
          continue;
        }
      } catch {
        continue;
      }

      ctx.knownJsonlFiles.add(file);
      console.log(
        `[Standalone] New JSONL file detected: ${path.basename(file)}`
      );

      // Check if any existing agent is assigned this file
      let alreadyTracked = false;
      for (const agent of ctx.agents.values()) {
        if (agent.jsonlFile === file) {
          alreadyTracked = true;
          break;
        }
      }

      if (!alreadyTracked) {
        // Auto-discover: create an agent for this JSONL file
        // This handles cases where Claude was started outside of Pixel Agents
        autoAdoptJsonlFile(ctx, file);
      }
    }
  }
}

function autoAdoptJsonlFile(ctx: StandaloneContext, jsonlFile: string): void {
  const id = ctx.nextAgentId.current++;
  const agent: AgentState = {
    id,
    terminalRef: { name: `Claude Code #${id}` } as never,
    projectDir: ctx.projectDir,
    jsonlFile,
    fileOffset: 0,
    lineBuffer: "",
    activeToolIds: new Set(),
    activeToolStatuses: new Map(),
    activeToolNames: new Map(),
    activeSubagentToolIds: new Map(),
    activeSubagentToolNames: new Map(),
    isWaiting: false,
    permissionSent: false,
    hadToolsInTurn: false
  };

  ctx.agents.set(id, agent);
  ctx.agentPanes.set(id, "external"); // Not a managed pane
  persistAgents(ctx);

  console.log(
    `[Standalone] Agent ${id}: auto-adopted ${path.basename(jsonlFile)}`
  );
  ctx.webview?.postMessage({ type: "agentCreated", id });

  startFileWatching(
    id,
    jsonlFile,
    ctx.agents,
    ctx.fileWatchers,
    ctx.pollingTimers,
    ctx.waitingTimers,
    ctx.permissionTimers,
    ctx.webview as never
  );
  readNewLines(
    id,
    ctx.agents,
    ctx.waitingTimers,
    ctx.permissionTimers,
    ctx.webview as never
  );
}

// ── Cleanup ─────────────────────────────────────────────────

export function disposeAll(ctx: StandaloneContext): void {
  if (ctx.projectScanTimer.current) {
    clearInterval(ctx.projectScanTimer.current);
    ctx.projectScanTimer.current = null;
  }

  for (const [id] of ctx.agents) {
    const jpTimer = ctx.jsonlPollTimers.get(id);
    if (jpTimer) clearInterval(jpTimer);

    ctx.fileWatchers.get(id)?.close();
    const pt = ctx.pollingTimers.get(id);
    if (pt) clearInterval(pt);

    cancelWaitingTimer(id, ctx.waitingTimers);
    cancelPermissionTimer(id, ctx.permissionTimers);
  }
}
