import { nanoid } from "nanoid";
import type {
  OrchestraState,
  SystemStatus,
  PauseInfo,
  SessionStats,
  Checkpoint,
} from "../types/index.js";
import { readJson, writeJson, fileExists } from "../utils/files.js";
import { getProjectPaths, ensureProjectDataDir } from "../utils/paths.js";

/**
 * Generate a new session ID
 */
export function generateSessionId(): string {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const id = nanoid(8);
  return `sess-${date}-${id}`;
}

/**
 * Create initial state for a new session
 */
export function createInitialState(
  goal: string,
  projectPath: string,
  maxCycles: number = 20
): OrchestraState {
  const sessionId = generateSessionId();
  const now = new Date().toISOString();

  return {
    goal,
    session_id: sessionId,
    project_path: projectPath,
    status: "running",
    pause_info: null,
    current_cycle: 0,
    max_cycles: maxCycles,
    branch: `orchestra/${sessionId}`,
    checkpoint: {
      last_completed_task: null,
      pending_tasks: [],
      in_progress_tasks: [],
      cycle_started_at: now,
    },
    stats: {
      tasks_created: 0,
      tasks_completed: 0,
      tasks_failed: 0,
      tasks_pending: 0,
    },
    started_at: now,
    updated_at: now,
  };
}

/**
 * Load state from disk
 */
export async function loadState(projectPath: string): Promise<OrchestraState | null> {
  const paths = getProjectPaths(projectPath);
  return readJson<OrchestraState>(paths.state);
}

/**
 * Save state to disk
 */
export async function saveState(state: OrchestraState): Promise<void> {
  const paths = getProjectPaths(state.project_path);
  await ensureProjectDataDir(state.project_path);
  state.updated_at = new Date().toISOString();
  await writeJson(paths.state, state);
}

/**
 * Check if a session exists
 */
export function sessionExists(projectPath: string): boolean {
  const paths = getProjectPaths(projectPath);
  return fileExists(paths.state);
}

/**
 * Update state status
 */
export async function updateStatus(
  projectPath: string,
  status: SystemStatus,
  pauseInfo?: PauseInfo | null
): Promise<OrchestraState> {
  const state = await loadState(projectPath);
  if (!state) {
    throw new Error(`No session found at ${projectPath}`);
  }

  state.status = status;
  if (pauseInfo !== undefined) {
    state.pause_info = pauseInfo;
  }
  await saveState(state);
  return state;
}

/**
 * Update checkpoint
 */
export async function updateCheckpoint(
  projectPath: string,
  checkpoint: Partial<Checkpoint>
): Promise<OrchestraState> {
  const state = await loadState(projectPath);
  if (!state) {
    throw new Error(`No session found at ${projectPath}`);
  }

  state.checkpoint = { ...state.checkpoint, ...checkpoint };
  await saveState(state);
  return state;
}

/**
 * Update stats
 */
export async function updateStats(
  projectPath: string,
  stats: Partial<SessionStats>
): Promise<OrchestraState> {
  const state = await loadState(projectPath);
  if (!state) {
    throw new Error(`No session found at ${projectPath}`);
  }

  state.stats = { ...state.stats, ...stats };
  await saveState(state);
  return state;
}

/**
 * Increment cycle counter
 */
export async function incrementCycle(projectPath: string): Promise<OrchestraState> {
  const state = await loadState(projectPath);
  if (!state) {
    throw new Error(`No session found at ${projectPath}`);
  }

  state.current_cycle++;
  state.checkpoint.cycle_started_at = new Date().toISOString();
  await saveState(state);
  return state;
}

/**
 * Create pause info
 */
export function createPauseInfo(reason: string, autoResume: boolean = false): PauseInfo {
  return {
    paused_at: new Date().toISOString(),
    reason,
    resume_at: null,
    auto_resume: autoResume,
  };
}
