import type {
  OrchestraResult,
  CycleResult,
  JudgeDecision,
  SystemStatus,
  ModelConfig,
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
  claimTask,
  markTaskCompleted,
  markTaskFailed,
  recordTaskError,
  releaseTask,
  releaseStuckTasks,
} from "./tasks.js";
import { createInitialAgentPool, saveAgentPool } from "./agents.js";
import { eventBus, createWakeupController, type PlannerWakeupController } from "./events.js";
import logger from "../utils/logger.js";
import { spawn, execSync } from "child_process";
import {
  checkGitRequirements,
  displayGitCheckResult,
} from "../utils/git.js";

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
  private maxWorkers: number;
  private timeout: number;
  private modelConfig?: ModelConfig;
  private initialized: boolean = false;
  private wakeupController: PlannerWakeupController;
  private plannerWakeupPending: boolean = false;

  constructor(
    projectPath: string,
    options: {
      maxCycles?: number;
      maxWorkers?: number;
      timeout?: number;
      modelConfig?: ModelConfig;
    } = {}
  ) {
    this.projectPath = projectPath;
    this.maxCycles = options.maxCycles ?? 20;
    this.maxWorkers = options.maxWorkers ?? 3;
    this.timeout = options.timeout ?? 600000; // 10 min default
    this.modelConfig = options.modelConfig;

    this.plannerRunner = new PlannerRunner(projectPath, this.timeout, this.modelConfig);
    this.judgeRunner = new JudgeRunner(projectPath, this.timeout, this.modelConfig);
    this.executorManager = new AgentExecutorManager(projectPath, this.timeout, this.modelConfig);

    // Setup planner wake-up controller
    // Wakes up planner after every 3 completed tasks
    this.wakeupController = createWakeupController(3);
    this.setupWakeupListener();
  }

  /**
   * Setup planner wake-up listener
   */
  private setupWakeupListener(): void {
    eventBus.onPlannerWakeup((event) => {
      logger.info(`[Orchestra] Planner wake-up triggered: ${event.reason}`);
      this.plannerWakeupPending = true;
    });
  }

  /**
   * Initialize the orchestra
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    logger.info("[Orchestra] Initializing...");

    // Check git requirements first
    logger.info("[Orchestra] Checking git requirements...");
    const gitCheck = await checkGitRequirements(this.projectPath);

    if (!gitCheck.success) {
      displayGitCheckResult(gitCheck);
      throw new Error("Git requirements not met. Please fix the issues above and try again.");
    }

    if (gitCheck.warnings.length > 0) {
      displayGitCheckResult(gitCheck);
      logger.warn("[Orchestra] Continuing with warnings...");
    }

    logger.info("[Orchestra] Git requirements OK");

    // Initialize agent pool
    const agentPool = createInitialAgentPool();
    await saveAgentPool(this.projectPath, agentPool);

    // Detect available agents
    const available = await this.executorManager.detectAvailableAgents();
    logger.info(`[Orchestra] Available agents: ${available.join(", ")}`);

    if (available.length === 0) {
      throw new Error("No agents available. Install claude, codex, or gemini.");
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

    // Check if planner wake-up was triggered during execution
    if (this.plannerWakeupPending) {
      logger.info("[Orchestra] Planner wake-up triggered - running additional planning...");
      this.plannerWakeupPending = false;
      this.wakeupController.reset();

      const additionalTasks = await this.plannerRunner.run(context, cycle);
      if (additionalTasks.length > 0) {
        logger.info(`[Orchestra] Additional planner created ${additionalTasks.length} tasks`);

        // Execute additional tasks
        const additional = await this.executeAllPendingTasks(context);
        logger.info(`[Orchestra] Additional workers completed: ${additional.completed}, failed: ${additional.failed}`);
      }
    }

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
   * Execute all pending tasks with parallel workers
   * All workers work in the same directory (no worktrees)
   * Each worker commits only its task's files
   * Up to maxWorkers tasks run concurrently
   */
  private async executeAllPendingTasks(
    context: ExecutionContext
  ): Promise<{ completed: number; failed: number }> {
    let completed = 0;
    let failed = 0;

    logger.info(`[Orchestra] Starting parallel execution with ${this.maxWorkers} workers`);

    /**
     * Single worker function - claims and executes one task
     */
    const runWorker = async (workerId: string): Promise<{ success: boolean; taskId?: string }> => {
      // Claim a pending task
      const task = await claimTask(this.projectPath, workerId, "claude");

      if (!task) {
        return { success: false };
      }

      logger.info(`[Worker-${workerId}] Executing: ${task.title}`);

      try {
        const { result, agent, error } = await this.executorManager.executeTask(task, context);

        if (result.success) {
          await markTaskCompleted(this.projectPath, task.id, agent);
          logger.success(`[Worker-${workerId}] Completed: ${task.title}`);

          // Commit only task's files (not git add -A)
          const taskFiles = task.files.length > 0 ? task.files : undefined;
          await this.commitTaskChanges(workerId, `Task completed: ${task.title}`, taskFiles);

          // Emit task completed event (triggers planner wake-up check)
          eventBus.emitTaskCompleted({
            task,
            agent,
            durationMs: result.durationMs,
          });

          return { success: true, taskId: task.id };
        } else {
          if (error) {
            await recordTaskError(this.projectPath, task.id, error);
          }

          if (task.attempts >= task.max_attempts) {
            await markTaskFailed(this.projectPath, task.id);
            logger.error(`[Worker-${workerId}] Failed (max attempts): ${task.title}`);

            // Emit task failed event
            eventBus.emitTaskFailed({
              task,
              agent,
              error: error?.message || "Unknown error",
            });

            return { success: false, taskId: task.id };
          } else {
            await releaseTask(this.projectPath, task.id);
            logger.warn(`[Worker-${workerId}] Will retry: ${task.title}`);
            return { success: false };
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const stack = err instanceof Error ? err.stack : "";
        logger.error(`[Worker-${workerId}] Error: ${message}`);
        logger.error(`[Worker-${workerId}] Stack: ${stack}`);
        logger.error(`[Worker-${workerId}] Task: ${task.title} (${task.id})`);
        await releaseTask(this.projectPath, task.id);
        return { success: false };
      }
    };

    /**
     * Worker loop - runs tasks until no more pending
     */
    const workerLoop = async (workerId: string): Promise<{ completed: number; failed: number }> => {
      let workerCompleted = 0;
      let workerFailed = 0;

      while (true) {
        const result = await runWorker(workerId);

        if (!result.taskId && !result.success) {
          // No task was claimed, worker is done
          break;
        }

        if (result.success) {
          workerCompleted++;
        } else if (result.taskId) {
          workerFailed++;
        }
        // If no taskId but not success, task was released for retry
      }

      return { completed: workerCompleted, failed: workerFailed };
    };

    // Start workers in parallel
    const workerPromises: Promise<{ completed: number; failed: number }>[] = [];

    for (let i = 1; i <= this.maxWorkers; i++) {
      const workerId = String(i);
      const promise = workerLoop(workerId);
      workerPromises.push(promise);
    }

    // Wait for all workers to complete
    const results = await Promise.all(workerPromises);

    // Aggregate results
    for (const result of results) {
      completed += result.completed;
      failed += result.failed;
    }

    logger.info(`[Orchestra] All workers finished. Completed: ${completed}, Failed: ${failed}`);

    return { completed, failed };
  }

  /**
   * Commit task-specific changes with pull --rebase
   * Only commits the files that were part of the task
   */
  private async commitTaskChanges(
    workerId: string,
    message: string,
    files?: string[]
  ): Promise<boolean> {
    try {
      // Step 1: Pull latest changes with rebase
      try {
        execSync("git pull --rebase", { cwd: this.projectPath, stdio: "pipe" });
        logger.debug(`[Worker-${workerId}] Pulled latest changes`);
      } catch {
        // Pull might fail if no remote or nothing to pull - that's OK
        logger.debug(`[Worker-${workerId}] No changes to pull or no remote`);
      }

      // Step 2: Add only task-specific files (or all if no files specified)
      if (files && files.length > 0) {
        // Add only the specified files
        for (const file of files) {
          try {
            execSync(`git add "${file}"`, { cwd: this.projectPath, stdio: "pipe" });
          } catch {
            // File might not exist or be outside repo - continue
            logger.debug(`[Worker-${workerId}] Could not add file: ${file}`);
          }
        }
        logger.debug(`[Worker-${workerId}] Added ${files.length} task files`);
      } else {
        // Fallback: add all changes (less ideal but works)
        execSync("git add -A", { cwd: this.projectPath, stdio: "pipe" });
        logger.debug(`[Worker-${workerId}] Added all changes (no specific files)`);
      }

      // Step 3: Commit
      try {
        execSync(`git commit -m "${message}"`, { cwd: this.projectPath, stdio: "pipe" });
        logger.info(`[Worker-${workerId}] Committed: ${message}`);
        return true;
      } catch {
        // Nothing to commit is OK
        logger.debug(`[Worker-${workerId}] Nothing to commit`);
        return true;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`[Worker-${workerId}] Git commit failed: ${msg}`);
      return false;
    }
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
    modelConfig?: ModelConfig;
  }
): Orchestra {
  return new Orchestra(projectPath, options);
}
