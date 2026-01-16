import type {
  OrchestraResult,
  CycleResult,
  JudgeDecision,
  SystemStatus,
} from "../types/index.js";
import type { ExecutionContext } from "../agents/base.js";
import { PlannerRunner } from "./planner.js";
import { JudgeRunner } from "./judge.js";
import { AgentExecutorManager } from "../agents/executor.js";
import {
  createInitialState,
  loadState,
  saveState,
  updateStatus,
  incrementCycle,
  updateStats,
} from "./state.js";
import {
  getPendingTasks,
  claimTask,
  markTaskCompleted,
  markTaskFailed,
  recordTaskError,
  releaseTask,
  releaseStuckTasks,
} from "./tasks.js";
import { createInitialAgentPool, saveAgentPool } from "./agents.js";
import logger from "../utils/logger.js";
import { spawn } from "child_process";

/**
 * Orchestra - Main orchestrator
 * Coordinates Planner, Workers, and Judge in a cycle
 */
export class Orchestra {
  private projectPath: string;
  private plannerRunner: PlannerRunner;
  private judgeRunner: JudgeRunner;
  private executorManager: AgentExecutorManager;
  private maxCycles: number;
  private timeout: number;
  private initialized: boolean = false;
  // Note: maxWorkers will be used in Sprint 4 for parallel worker execution

  constructor(
    projectPath: string,
    options: {
      maxCycles?: number;
      maxWorkers?: number;
      timeout?: number;
    } = {}
  ) {
    this.projectPath = projectPath;
    this.maxCycles = options.maxCycles ?? 20;
    // maxWorkers option is reserved for Sprint 4 (parallel execution)
    this.timeout = options.timeout ?? 600000; // 10 min default

    this.plannerRunner = new PlannerRunner(projectPath, this.timeout);
    this.judgeRunner = new JudgeRunner(projectPath, this.timeout);
    this.executorManager = new AgentExecutorManager(projectPath, this.timeout);
  }

  /**
   * Initialize the orchestra
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    logger.info("[Orchestra] Initializing...");

    // Initialize agent pool
    const agentPool = createInitialAgentPool();
    await saveAgentPool(this.projectPath, agentPool);

    // Detect available agents
    const available = await this.executorManager.detectAvailableAgents();
    logger.info(`[Orchestra] Available agents: ${available.join(", ")}`);

    if (available.length === 0) {
      throw new Error("No agents available. Install claude, codex, or opencode.");
    }

    // Initialize planner and judge
    await this.plannerRunner.initialize();
    await this.judgeRunner.initialize();

    this.initialized = true;
    logger.info("[Orchestra] Initialized successfully");
  }

  /**
   * Start a new session
   */
  async start(goal: string): Promise<OrchestraResult> {
    const startTime = Date.now();

    // Initialize if not already
    await this.initialize();

    // Create initial state
    const state = createInitialState(goal, this.projectPath, this.maxCycles);
    await saveState(state);

    logger.info(`[Orchestra] Starting session: ${state.session_id}`);
    logger.info(`[Orchestra] Goal: ${goal}`);
    logger.info(`[Orchestra] Max cycles: ${this.maxCycles}`);

    // Create git branch
    await this.createBranch(state.branch);

    // Build execution context
    const context: ExecutionContext = {
      projectPath: this.projectPath,
      branch: state.branch,
      sessionId: state.session_id,
      goal,
    };

    // Main loop
    let finalStatus: SystemStatus = "running";
    let lastDecision: JudgeDecision = "CONTINUE";

    try {
      while (state.current_cycle < this.maxCycles && finalStatus === "running") {
        // Check if paused
        const currentState = await loadState(this.projectPath);
        if (currentState?.status.startsWith("paused")) {
          logger.info(`[Orchestra] Paused: ${currentState.pause_info?.reason}`);
          finalStatus = currentState.status;
          break;
        }

        // Run a cycle
        const cycleResult = await this.runCycle(context, {
          current: state.current_cycle + 1,
          max: this.maxCycles,
        });

        // Update cycle count
        await incrementCycle(this.projectPath);
        state.current_cycle++;

        lastDecision = cycleResult.judgeDecision;

        // Handle judge decision
        if (lastDecision === "COMPLETE") {
          finalStatus = "completed";
          logger.success(`[Orchestra] Goal achieved! Cycle ${state.current_cycle}`);
        } else if (lastDecision === "ABORT") {
          finalStatus = "aborted";
          logger.error(`[Orchestra] Aborted at cycle ${state.current_cycle}`);
        }
        // CONTINUE continues the loop
      }

      // Check if max cycles reached
      if (state.current_cycle >= this.maxCycles && finalStatus === "running") {
        finalStatus = "aborted";
        logger.warn(`[Orchestra] Max cycles (${this.maxCycles}) reached`);
      }

    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`[Orchestra] Fatal error: ${message}`);
      finalStatus = "aborted";
    }

    // Update final status
    await updateStatus(this.projectPath, finalStatus);

    // Commit final changes
    await this.commitChanges(`Orchestra: ${finalStatus} - ${goal.slice(0, 50)}`);

    // Get final stats
    const finalState = await loadState(this.projectPath);
    const durationMs = Date.now() - startTime;

    return {
      success: finalStatus === "completed",
      finalStatus,
      totalCycles: state.current_cycle,
      totalTasks: finalState?.stats.tasks_created ?? 0,
      completedTasks: finalState?.stats.tasks_completed ?? 0,
      failedTasks: finalState?.stats.tasks_failed ?? 0,
      durationMs,
      message: this.getResultMessage(finalStatus, lastDecision),
    };
  }

  /**
   * Run a single cycle
   */
  private async runCycle(
    context: ExecutionContext,
    cycle: { current: number; max: number }
  ): Promise<CycleResult> {
    const cycleStart = Date.now();

    logger.info(`\n${"=".repeat(60)}`);
    logger.info(`[Orchestra] CYCLE ${cycle.current}/${cycle.max}`);
    logger.info(`${"=".repeat(60)}\n`);

    // Release any stuck tasks from previous cycle
    const released = await releaseStuckTasks(this.projectPath);
    if (released > 0) {
      logger.warn(`[Orchestra] Released ${released} stuck tasks`);
    }

    // STEP 1: Run Planner
    logger.info("[Orchestra] Step 1: Running Planner...");
    const newTasks = await this.plannerRunner.run(context, cycle);
    logger.info(`[Orchestra] Planner created ${newTasks.length} tasks`);

    // STEP 2: Execute pending tasks with Workers
    logger.info("[Orchestra] Step 2: Executing tasks with Workers...");
    const { completed, failed } = await this.executeAllPendingTasks(context);
    logger.info(`[Orchestra] Workers completed: ${completed}, failed: ${failed}`);

    // Update stats
    const state = await loadState(this.projectPath);
    if (state) {
      await updateStats(this.projectPath, {
        tasks_completed: state.stats.tasks_completed + completed,
        tasks_failed: state.stats.tasks_failed + failed,
        tasks_pending: Math.max(0, state.stats.tasks_pending - completed - failed),
      });
    }

    // STEP 3: Run Judge
    logger.info("[Orchestra] Step 3: Running Judge...");
    const judgeOutput = await this.judgeRunner.run(context, cycle);

    const durationMs = Date.now() - cycleStart;

    logger.info(`[Orchestra] Cycle ${cycle.current} completed in ${Math.round(durationMs / 1000)}s`);
    logger.info(`[Orchestra] Judge decision: ${judgeOutput.decision}`);

    return {
      cycle: cycle.current,
      tasksCreated: newTasks.length,
      tasksCompleted: completed,
      tasksFailed: failed,
      judgeDecision: judgeOutput.decision,
      durationMs,
    };
  }

  /**
   * Execute all pending tasks
   * For now, runs sequentially. Can be parallelized in Sprint 4.
   */
  private async executeAllPendingTasks(
    context: ExecutionContext
  ): Promise<{ completed: number; failed: number }> {
    let completed = 0;
    let failed = 0;

    while (true) {
      // Get next pending task
      const pendingTasks = await getPendingTasks(this.projectPath);

      if (pendingTasks.length === 0) {
        logger.info("[Orchestra] No more pending tasks");
        break;
      }

      // Claim the first pending task
      const task = await claimTask(this.projectPath, "worker-1", "claude");

      if (!task) {
        break;
      }

      logger.info(`[Orchestra] Executing task: ${task.title}`);

      try {
        // Execute the task
        const { result, agent, error } = await this.executorManager.executeTask(task, context);

        if (result.success) {
          await markTaskCompleted(this.projectPath, task.id, agent);
          completed++;
          logger.success(`[Orchestra] Task completed: ${task.title}`);

          // Commit after each completed task
          await this.commitChanges(`Task completed: ${task.title}`);
        } else {
          // Record error
          if (error) {
            await recordTaskError(this.projectPath, task.id, error);
          }

          // Check if max attempts reached
          if (task.attempts >= task.max_attempts) {
            await markTaskFailed(this.projectPath, task.id);
            failed++;
            logger.error(`[Orchestra] Task failed (max attempts): ${task.title}`);
          } else {
            // Release for retry
            await releaseTask(this.projectPath, task.id);
            logger.warn(`[Orchestra] Task will retry: ${task.title}`);
          }
        }

      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error(`[Orchestra] Task error: ${message}`);

        // Release for retry
        await releaseTask(this.projectPath, task.id);
      }
    }

    return { completed, failed };
  }

  /**
   * Create a git branch for this session
   */
  private async createBranch(branchName: string): Promise<void> {
    return new Promise((resolve) => {
      const proc = spawn("git", ["checkout", "-b", branchName], {
        cwd: this.projectPath,
        shell: true,
      });

      proc.on("close", (code) => {
        if (code === 0) {
          logger.info(`[Orchestra] Created branch: ${branchName}`);
          resolve();
        } else {
          // Branch might already exist, try to checkout
          const checkout = spawn("git", ["checkout", branchName], {
            cwd: this.projectPath,
            shell: true,
          });
          checkout.on("close", (c) => {
            if (c === 0) {
              logger.info(`[Orchestra] Checked out branch: ${branchName}`);
              resolve();
            } else {
              // Continue anyway, might not be a git repo
              logger.warn(`[Orchestra] Could not create/checkout branch: ${branchName}`);
              resolve();
            }
          });
        }
      });

      proc.on("error", () => {
        // Continue anyway
        logger.warn("[Orchestra] Git not available, continuing without branch");
        resolve();
      });
    });
  }

  /**
   * Commit changes
   */
  private async commitChanges(message: string): Promise<void> {
    return new Promise((resolve) => {
      // Stage all changes
      const add = spawn("git", ["add", "-A"], {
        cwd: this.projectPath,
        shell: true,
      });

      add.on("close", () => {
        // Commit
        const commit = spawn(
          "git",
          ["commit", "-m", `"${message}"`],
          {
            cwd: this.projectPath,
            shell: true,
          }
        );

        commit.on("close", (code) => {
          if (code === 0) {
            logger.debug(`[Orchestra] Committed: ${message}`);
          }
          resolve();
        });

        commit.on("error", () => resolve());
      });

      add.on("error", () => resolve());
    });
  }

  /**
   * Get result message
   */
  private getResultMessage(status: SystemStatus, decision: JudgeDecision): string {
    switch (status) {
      case "completed":
        return "Goal achieved successfully!";
      case "aborted":
        if (decision === "ABORT") {
          return "Aborted by Judge due to issues";
        }
        return "Aborted - max cycles reached or critical error";
      case "paused_manual":
        return "Paused by user";
      case "paused_no_agents":
        return "Paused - all agents exhausted";
      case "paused_error":
        return "Paused due to critical error";
      default:
        return `Session ended with status: ${status}`;
    }
  }

  /**
   * Resume a paused session
   */
  async resume(): Promise<OrchestraResult> {
    const state = await loadState(this.projectPath);

    if (!state) {
      throw new Error("No session found to resume");
    }

    if (!state.status.startsWith("paused")) {
      throw new Error(`Cannot resume session with status: ${state.status}`);
    }

    logger.info(`[Orchestra] Resuming session: ${state.session_id}`);

    // Update status to running
    await updateStatus(this.projectPath, "running", null);

    // Continue from where we left off
    return this.continueSession(state.goal);
  }

  /**
   * Continue an existing session
   */
  private async continueSession(goal: string): Promise<OrchestraResult> {
    const state = await loadState(this.projectPath);

    if (!state) {
      throw new Error("No session found");
    }

    // Resume the main loop
    // Note: In Sprint 4, implement proper checkpoint resume using state.checkpoint
    // For now, we restart with the same goal
    return this.start(goal);
  }
}

/**
 * Create an orchestra instance
 */
export function createOrchestra(
  projectPath: string,
  options?: {
    maxCycles?: number;
    maxWorkers?: number;
    timeout?: number;
  }
): Orchestra {
  return new Orchestra(projectPath, options);
}
