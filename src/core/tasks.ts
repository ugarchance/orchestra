import { nanoid } from "nanoid";
import type {
  Task,
  TaskStatus,
  AgentType,
  ErrorInfo,
  AgentAttempt,
} from "../types/index.js";
import { readJson, writeJson } from "../utils/files.js";
import { getProjectPaths, ensureProjectDataDir } from "../utils/paths.js";
import logger from "../utils/logger.js";

/**
 * Generate a new task ID
 */
export function generateTaskId(): string {
  return `task-${nanoid(8)}`;
}

/**
 * Create a new task
 */
export function createTask(
  title: string,
  description: string,
  createdBy: string,
  files: string[] = [],
  maxAttempts: number = 3
): Task {
  const now = new Date().toISOString();

  return {
    id: generateTaskId(),
    title,
    description,
    status: "pending",
    assigned_agent: null,
    worker_id: null,
    files,
    created_by: createdBy,
    created_at: now,
    started_at: null,
    completed_at: null,
    attempts: 0,
    max_attempts: maxAttempts,
    last_error: null,
    agent_history: [],
  };
}

/**
 * Load all tasks from disk
 */
export async function loadTasks(projectPath: string): Promise<Task[]> {
  const paths = getProjectPaths(projectPath);
  const tasks = await readJson<Task[]>(paths.tasks);
  return tasks ?? [];
}

/**
 * Save all tasks to disk
 */
export async function saveTasks(projectPath: string, tasks: Task[]): Promise<void> {
  const paths = getProjectPaths(projectPath);
  await ensureProjectDataDir(projectPath);
  await writeJson(paths.tasks, tasks);
}

/**
 * Add a new task
 */
export async function addTask(projectPath: string, task: Task): Promise<Task> {
  const tasks = await loadTasks(projectPath);
  tasks.push(task);
  await saveTasks(projectPath, tasks);
  return task;
}

/**
 * Get a task by ID
 */
export async function getTask(projectPath: string, taskId: string): Promise<Task | null> {
  const tasks = await loadTasks(projectPath);
  return tasks.find((t) => t.id === taskId) ?? null;
}

/**
 * Update a task
 */
export async function updateTask(projectPath: string, task: Task): Promise<void> {
  const tasks = await loadTasks(projectPath);
  const index = tasks.findIndex((t) => t.id === task.id);
  if (index === -1) {
    throw new Error(`Task not found: ${task.id}`);
  }
  tasks[index] = task;
  await saveTasks(projectPath, tasks);
}

/**
 * Get tasks by status
 */
export async function getTasksByStatus(
  projectPath: string,
  status: TaskStatus
): Promise<Task[]> {
  const tasks = await loadTasks(projectPath);
  return tasks.filter((t) => t.status === status);
}

/**
 * Get pending tasks
 */
export async function getPendingTasks(projectPath: string): Promise<Task[]> {
  return getTasksByStatus(projectPath, "pending");
}

/**
 * Claim a task for a worker
 *
 * Following Cursor's approach from scaling-agents.md:
 * - Workers don't coordinate with each other
 * - No complex locking - just claim and work
 * - If conflicts happen, workers handle them (git merge)
 * - Each worker gets a DIFFERENT pending task (by index)
 */
export async function claimTask(
  projectPath: string,
  workerId: string,
  agent: AgentType
): Promise<Task | null> {
  const tasks = await loadTasks(projectPath);
  const pendingTasks = tasks.filter((t) => t.status === "pending");

  if (pendingTasks.length === 0) {
    return null;
  }

  // Each worker gets a different task based on worker ID
  // Worker-1 gets first pending, Worker-2 gets second, etc.
  const workerIndex = parseInt(workerId, 10) - 1;
  const taskIndex = workerIndex % pendingTasks.length;
  const task = pendingTasks[taskIndex];

  if (!task) {
    return null;
  }

  // Mark as in_progress
  task.status = "in_progress";
  task.assigned_agent = agent;
  task.worker_id = workerId;
  task.started_at = new Date().toISOString();
  task.attempts++;

  await saveTasks(projectPath, tasks);

  logger.debug(`[Worker-${workerId}] Claimed task: ${task.title}`);
  return task;
}

/**
 * Mark task as completed
 */
export async function markTaskCompleted(
  projectPath: string,
  taskId: string,
  agent: AgentType
): Promise<void> {
  const task = await getTask(projectPath, taskId);
  if (!task) {
    throw new Error(`Task not found: ${taskId}`);
  }

  const now = new Date().toISOString();

  // Record successful attempt
  const attempt: AgentAttempt = {
    agent,
    started_at: task.started_at ?? now,
    ended_at: now,
    result: "completed",
  };
  task.agent_history.push(attempt);

  task.status = "completed";
  task.completed_at = now;

  await updateTask(projectPath, task);
}

/**
 * Record a task error
 */
export async function recordTaskError(
  projectPath: string,
  taskId: string,
  error: ErrorInfo
): Promise<Task> {
  const task = await getTask(projectPath, taskId);
  if (!task) {
    throw new Error(`Task not found: ${taskId}`);
  }

  const now = new Date().toISOString();

  // Record failed attempt
  const attempt: AgentAttempt = {
    agent: error.agent,
    started_at: task.started_at ?? now,
    ended_at: now,
    result: error.category === "rate_limit" ? "rate_limited" : "failed",
    error,
  };
  task.agent_history.push(attempt);

  task.last_error = error;

  await updateTask(projectPath, task);
  return task;
}

/**
 * Release a task back to pending (for retry or reassignment)
 */
export async function releaseTask(projectPath: string, taskId: string): Promise<void> {
  const task = await getTask(projectPath, taskId);
  if (!task) {
    throw new Error(`Task not found: ${taskId}`);
  }

  task.status = "pending";
  task.assigned_agent = null;
  task.worker_id = null;

  await updateTask(projectPath, task);
}

/**
 * Mark task as failed
 */
export async function markTaskFailed(projectPath: string, taskId: string): Promise<void> {
  const task = await getTask(projectPath, taskId);
  if (!task) {
    throw new Error(`Task not found: ${taskId}`);
  }

  task.status = "failed";
  task.completed_at = new Date().toISOString();

  await updateTask(projectPath, task);
}

/**
 * Get task statistics
 */
export async function getTaskStats(projectPath: string) {
  const tasks = await loadTasks(projectPath);

  return {
    total: tasks.length,
    pending: tasks.filter((t) => t.status === "pending").length,
    in_progress: tasks.filter((t) => t.status === "in_progress").length,
    completed: tasks.filter((t) => t.status === "completed").length,
    failed: tasks.filter((t) => t.status === "failed").length,
    waiting_agent: tasks.filter((t) => t.status === "waiting_agent").length,
  };
}

/**
 * Release all stuck tasks (in_progress without worker)
 */
export async function releaseStuckTasks(projectPath: string): Promise<number> {
  const tasks = await loadTasks(projectPath);
  let released = 0;

  for (const task of tasks) {
    if (task.status === "in_progress") {
      task.status = "pending";
      task.assigned_agent = null;
      task.worker_id = null;
      released++;
    }
  }

  if (released > 0) {
    await saveTasks(projectPath, tasks);
  }

  return released;
}
