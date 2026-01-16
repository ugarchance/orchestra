import { resolve } from "path";
import chalk from "chalk";
import logger from "../utils/logger.js";
import {
  createInitialState,
  loadState,
  saveState,
  sessionExists,
  updateStatus,
  createPauseInfo,
} from "../core/state.js";
import {
  getTaskStats,
  releaseStuckTasks,
  createTask,
  addTask,
} from "../core/tasks.js";
import {
  loadAgentPool,
  saveAgentPool,
  createInitialAgentPool,
  resetAgentPool,
} from "../core/agents.js";
import { ensureProjectDataDir } from "../utils/paths.js";
import { createExecutorManager } from "../agents/executor.js";
import type { AgentType, OrchestraState } from "../types/index.js";

/**
 * Start a new orchestra session
 */
export async function startCommand(
  goal: string,
  projectPath: string,
  options: { maxCycles?: number }
): Promise<void> {
  const absPath = resolve(projectPath);

  logger.section("Starting Orchestra");
  logger.info(`Goal: ${goal}`);
  logger.info(`Project: ${absPath}`);

  // Check if session already exists
  if (sessionExists(absPath)) {
    const existingState = await loadState(absPath);
    if (existingState && existingState.status === "running") {
      logger.error("A session is already running in this project.");
      logger.info(`Session: ${existingState.session_id}`);
      logger.info("Use 'orchestra status' to check progress or 'orchestra resume' to continue.");
      process.exit(1);
    }
  }

  // Create directories
  await ensureProjectDataDir(absPath);

  // Create initial state
  const state = createInitialState(goal, absPath, options.maxCycles);
  await saveState(state);

  // Initialize agent pool
  const agentPool = createInitialAgentPool();
  await saveAgentPool(absPath, agentPool);

  logger.success(`Session created: ${state.session_id}`);
  logger.info(`Branch: ${state.branch}`);
  logger.info(`Max cycles: ${state.max_cycles}`);

  console.log("");
  logger.raw(chalk.dim("─".repeat(50)));
  console.log("");
  logger.info("Session initialized. Ready to run.");
  logger.info("Note: Execution loop not yet implemented (Sprint 1)");
}

/**
 * Show session status
 */
export async function statusCommand(projectPath: string): Promise<void> {
  const absPath = resolve(projectPath);

  if (!sessionExists(absPath)) {
    logger.error("No session found in this project.");
    logger.info("Use 'orchestra start <goal>' to create a new session.");
    process.exit(1);
  }

  const state = await loadState(absPath);
  if (!state) {
    logger.error("Failed to load session state.");
    process.exit(1);
  }

  const pool = await loadAgentPool(absPath);
  const taskStats = await getTaskStats(absPath);

  logger.section("Orchestra Status");

  // Session info
  console.log(chalk.bold("Session:"), state.session_id);
  console.log(chalk.bold("Goal:"), state.goal);
  console.log(chalk.bold("Status:"), formatStatus(state.status));
  console.log(chalk.bold("Cycle:"), `${state.current_cycle}/${state.max_cycles}`);
  console.log(chalk.bold("Branch:"), state.branch);

  // Pause info
  if (state.pause_info) {
    console.log("");
    console.log(chalk.yellow("⏸  Paused:"), state.pause_info.reason);
    if (state.pause_info.resume_at) {
      console.log(chalk.dim("   Resume at:"), state.pause_info.resume_at);
    }
  }

  // Task stats
  console.log("");
  console.log(chalk.bold("Tasks:"));
  logger.taskProgress(taskStats.completed, taskStats.total, taskStats.failed);
  console.log(chalk.dim(`  (${taskStats.pending} pending, ${taskStats.in_progress} in progress)`));

  // Agent status
  console.log("");
  console.log(chalk.bold("Agents:"));
  for (const agent of ["claude", "codex", "opencode"] as AgentType[]) {
    const agentState = pool.agents[agent];
    let detail: string | undefined;

    if (agentState.status === "rate_limited" && agentState.available_at) {
      const availableIn = Math.ceil(
        (new Date(agentState.available_at).getTime() - Date.now()) / 60000
      );
      detail = `available in ${availableIn} min`;
    } else if (agentState.status === "busy") {
      detail = "working";
    }

    logger.agentStatus(agent, agentState.status, detail);
  }

  // Stats
  console.log("");
  console.log(chalk.dim("Started:"), state.started_at);
  console.log(chalk.dim("Updated:"), state.updated_at);
}

/**
 * Resume a paused or crashed session
 */
export async function resumeCommand(projectPath: string): Promise<void> {
  const absPath = resolve(projectPath);

  if (!sessionExists(absPath)) {
    logger.error("No session found to resume.");
    process.exit(1);
  }

  logger.section("Resuming Session");

  const state = await loadState(absPath);
  if (!state) {
    logger.error("Failed to load session state.");
    process.exit(1);
  }

  logger.info(`Session: ${state.session_id}`);
  logger.info(`Goal: ${state.goal}`);
  logger.info(`Progress: ${state.stats.tasks_completed}/${state.stats.tasks_created} tasks`);

  // Release stuck tasks
  const released = await releaseStuckTasks(absPath);
  if (released > 0) {
    logger.warn(`Released ${released} stuck tasks back to pending`);
  }

  // Reset agent pool
  await resetAgentPool(absPath);
  logger.info("Agent pool reset");

  // Update state
  await updateStatus(absPath, "running", null);
  logger.success("Session resumed");

  console.log("");
  logger.info("Note: Execution loop not yet implemented (Sprint 1)");
}

/**
 * Pause a running session
 */
export async function pauseCommand(projectPath: string): Promise<void> {
  const absPath = resolve(projectPath);

  if (!sessionExists(absPath)) {
    logger.error("No session found.");
    process.exit(1);
  }

  const state = await loadState(absPath);
  if (!state) {
    logger.error("Failed to load session state.");
    process.exit(1);
  }

  if (state.status !== "running") {
    logger.warn(`Session is already ${state.status}`);
    return;
  }

  const pauseInfo = createPauseInfo("Manual pause by user", false);
  await updateStatus(absPath, "paused_manual", pauseInfo);

  logger.success("Session paused");
  logger.info("Use 'orchestra resume' to continue");
}

/**
 * Show agent pool status
 */
export async function agentStatusCommand(projectPath: string): Promise<void> {
  const absPath = resolve(projectPath);
  const pool = await loadAgentPool(absPath);

  logger.section("Agent Pool");

  for (const agent of ["claude", "codex", "opencode"] as AgentType[]) {
    const agentState = pool.agents[agent];

    console.log("");
    console.log(chalk.bold(`${agent.toUpperCase()}`));
    console.log(`  Status: ${formatAgentStatus(agentState.status)}`);
    console.log(`  Tasks completed: ${agentState.stats.tasks_completed}`);
    console.log(`  Tasks failed: ${agentState.stats.tasks_failed}`);
    console.log(`  Success rate: ${(agentState.health.success_rate * 100).toFixed(1)}%`);
    console.log(`  Consecutive failures: ${agentState.health.consecutive_failures}`);

    if (agentState.status === "rate_limited" && agentState.available_at) {
      const availableIn = Math.ceil(
        (new Date(agentState.available_at).getTime() - Date.now()) / 60000
      );
      console.log(chalk.yellow(`  Available in: ${availableIn} min`));
    }

    if (agentState.stats.last_error) {
      console.log(chalk.dim(`  Last error: ${agentState.stats.last_error}`));
    }
  }
}

// Helper functions

function formatStatus(status: OrchestraState["status"]): string {
  const colors: Record<string, (s: string) => string> = {
    running: chalk.green,
    paused_manual: chalk.yellow,
    paused_no_agents: chalk.yellow,
    paused_error: chalk.red,
    completed: chalk.blue,
    aborted: chalk.red,
  };
  const color = colors[status] ?? chalk.white;
  return color(status);
}

function formatAgentStatus(status: string): string {
  const colors: Record<string, (s: string) => string> = {
    available: chalk.green,
    busy: chalk.yellow,
    rate_limited: chalk.red,
    errored: chalk.red,
    exhausted: chalk.gray,
    disabled: chalk.gray,
  };
  const color = colors[status] ?? chalk.white;
  return color(status);
}

/**
 * Detect available agents on the system
 */
export async function agentDetectCommand(): Promise<void> {
  logger.section("Detecting Agents");

  const manager = createExecutorManager(".");
  const available = await manager.detectAvailableAgents();

  if (available.length === 0) {
    logger.error("No agents found!");
    logger.info("Please install at least one of: claude, codex, opencode");
    process.exit(1);
  }

  logger.success(`Found ${available.length} agent(s):`);
  for (const agent of available) {
    console.log(`  ${chalk.green("✓")} ${agent}`);
  }

  const missing = (["claude", "codex", "opencode"] as AgentType[]).filter(
    (a) => !available.includes(a)
  );

  if (missing.length > 0) {
    console.log("");
    logger.info("Not found:");
    for (const agent of missing) {
      console.log(`  ${chalk.gray("✗")} ${agent}`);
    }
  }
}

/**
 * Execute a single task (for testing)
 */
export async function execCommand(
  taskDescription: string,
  projectPath: string
): Promise<void> {
  const absPath = resolve(projectPath);

  logger.section("Executing Single Task");
  logger.info(`Task: ${taskDescription}`);
  logger.info(`Project: ${absPath}`);

  // Check if session exists, create if not
  if (!sessionExists(absPath)) {
    logger.info("No session found, creating temporary session...");
    await ensureProjectDataDir(absPath);
    const state = createInitialState("Single task execution", absPath, 1);
    await saveState(state);
    const agentPool = createInitialAgentPool();
    await saveAgentPool(absPath, agentPool);
  }

  const state = await loadState(absPath);
  if (!state) {
    logger.error("Failed to load session state.");
    process.exit(1);
  }

  // Create the task
  const task = createTask(
    "Manual task",
    taskDescription,
    "cli",
    [],
    3
  );

  await addTask(absPath, task);
  logger.info(`Task created: ${task.id}`);

  // Create executor manager and detect agents
  const manager = createExecutorManager(absPath);
  const available = await manager.detectAvailableAgents();

  if (available.length === 0) {
    logger.error("No agents available!");
    process.exit(1);
  }

  logger.info(`Using agents: ${available.join(", ")}`);

  // Execute the task
  console.log("");
  logger.info("Executing...");
  console.log(chalk.dim("─".repeat(50)));
  console.log("");

  try {
    const { result, agent, error } = await manager.executeTask(task, {
      projectPath: absPath,
      branch: state.branch,
      sessionId: state.session_id,
      goal: state.goal,
    });

    console.log("");
    console.log(chalk.dim("─".repeat(50)));
    console.log("");

    if (result.success) {
      logger.success(`Task completed by ${agent}`);
      logger.info(`Duration: ${(result.durationMs / 1000).toFixed(1)}s`);
    } else {
      logger.error(`Task failed`);
      logger.info(`Agent: ${agent}`);
      if (error) {
        logger.info(`Error: ${error.category} - ${error.message}`);
      }
    }

    // Show output preview
    if (result.output) {
      console.log("");
      logger.info("Output preview:");
      console.log(chalk.dim(result.output.slice(0, 500)));
      if (result.output.length > 500) {
        console.log(chalk.dim("... (truncated)"));
      }
    }
  } catch (err) {
    logger.error(`Execution failed: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}
