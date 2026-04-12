import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const SESSION_DIR = path.join(os.homedir(), ".outer-sunset");
const SESSION_FILE = path.join(SESSION_DIR, "session-state.json");

async function ensureDir(): Promise<void> {
  await fs.mkdir(SESSION_DIR, { recursive: true });
}

export interface SessionState {
  activeTask: {
    identifier: string;
    title: string;
    description: string | null;
    url: string;
    startedAt: string;
    branch?: string;
    prNumber?: number;
  } | null;
  recentActions: {
    action: string;
    detail: string;
    timestamp: string;
  }[];
  lastBoardView: string | null;
}

const DEFAULT_STATE: SessionState = {
  activeTask: null,
  recentActions: [],
  lastBoardView: null,
};

const MAX_RECENT_ACTIONS = 20;

export async function loadSession(): Promise<SessionState> {
  try {
    const raw = await fs.readFile(SESSION_FILE, "utf-8");
    return { ...DEFAULT_STATE, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_STATE };
  }
}

export async function saveSession(state: SessionState): Promise<void> {
  state.recentActions = state.recentActions.slice(-MAX_RECENT_ACTIONS);
  await ensureDir();
  await fs.writeFile(SESSION_FILE, JSON.stringify(state, null, 2));
}

export async function recordAction(action: string, detail: string): Promise<void> {
  const state = await loadSession();
  state.recentActions.push({
    action,
    detail,
    timestamp: new Date().toISOString(),
  });
  await saveSession(state);
}

export async function setActiveTask(task: SessionState["activeTask"]): Promise<void> {
  const state = await loadSession();
  state.activeTask = task;
  if (task) {
    state.recentActions.push({
      action: "started_task",
      detail: `${task.identifier}: ${task.title}`,
      timestamp: new Date().toISOString(),
    });
  }
  await saveSession(state);
}

export async function updateActiveTaskBranch(branch: string): Promise<void> {
  const state = await loadSession();
  if (state.activeTask) {
    state.activeTask.branch = branch;
    await saveSession(state);
  }
}

export async function updateActiveTaskPR(prNumber: number): Promise<void> {
  const state = await loadSession();
  if (state.activeTask) {
    state.activeTask.prNumber = prNumber;
    state.recentActions.push({
      action: "opened_pr",
      detail: `PR #${prNumber} for ${state.activeTask.identifier}`,
      timestamp: new Date().toISOString(),
    });
    await saveSession(state);
  }
}

export async function clearActiveTask(): Promise<void> {
  const state = await loadSession();
  if (state.activeTask) {
    state.recentActions.push({
      action: "completed_task",
      detail: `${state.activeTask.identifier}: ${state.activeTask.title}`,
      timestamp: new Date().toISOString(),
    });
  }
  state.activeTask = null;
  await saveSession(state);
}

export async function recordBoardView(): Promise<void> {
  const state = await loadSession();
  state.lastBoardView = new Date().toISOString();
  await saveSession(state);
}
