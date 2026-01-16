import type { Task, PlannerOutput, PlannerTaskOutput } from "../types/index.js";
import type { ExecutionContext } from "../agents/base.js";
import { buildPlannerPrompt, buildSubPlannerPrompt } from "../agents/prompts.js";
import { AgentExecutorManager } from "../agents/executor.js";
import { createTask, loadTasks, addTask } from "./tasks.js";
import { loadState, updateStats } from "./state.js";
import logger from "../utils/logger.js";

/**
 * Sub-planner focus areas that can be spawned
 */
export interface SubPlannerArea {
  name: string;
  description: string;
  files: string[];
}

/**
 * Planner Runner
 * Executes the Planner agent to create new tasks
 */
export class PlannerRunner {
  private executorManager: AgentExecutorManager;
  private projectPath: string;

  constructor(projectPath: string, timeout: number = 600000) {
    this.projectPath = projectPath;
    this.executorManager = new AgentExecutorManager(projectPath, timeout);
  }

  /**
   * Initialize - detect available agents
   */
  async initialize(): Promise<void> {
    await this.executorManager.detectAvailableAgents();
  }

  /**
   * Run the planner to create new tasks
   */
  async run(context: ExecutionContext, cycle: { current: number; max: number }): Promise<Task[]> {
    logger.info(`[Planner] Starting cycle ${cycle.current}/${cycle.max}`);

    // Load current tasks
    const allTasks = await loadTasks(this.projectPath);
    const completedTasks = allTasks.filter(t => t.status === "completed");
    const failedTasks = allTasks.filter(t => t.status === "failed");
    const pendingTasks = allTasks.filter(t => t.status === "pending" || t.status === "in_progress");

    // Build planner prompt
    const prompt = buildPlannerPrompt(context, cycle, {
      completed: completedTasks,
      failed: failedTasks,
      pending: pendingTasks,
    });

    // Create a pseudo-task for the planner
    const plannerTask: Task = {
      id: `planner-${cycle.current}`,
      title: "Plan next batch of tasks",
      description: prompt,
      status: "in_progress",
      assigned_agent: null,
      worker_id: null,
      files: [],
      created_by: "system",
      created_at: new Date().toISOString(),
      started_at: new Date().toISOString(),
      completed_at: null,
      attempts: 0,
      max_attempts: 3,
      last_error: null,
      agent_history: [],
    };

    try {
      // Execute with any available agent
      const { result } = await this.executorManager.executeTask(plannerTask, context);

      if (!result.success) {
        logger.error(`[Planner] Failed to generate tasks: ${result.error?.message}`);
        return [];
      }

      // Parse planner output
      const plannerOutput = this.parsePlannerOutput(result.output);

      if (!plannerOutput) {
        logger.error("[Planner] Failed to parse planner output");
        logger.debug(`[Planner] Raw output: ${result.output.slice(0, 500)}`);
        return [];
      }

      logger.info(`[Planner] Analysis: ${plannerOutput.analysis}`);
      logger.info(`[Planner] Created ${plannerOutput.tasks.length} new tasks`);

      // Convert planner output to Task objects
      const newTasks: Task[] = [];
      for (const taskOutput of plannerOutput.tasks) {
        const task = createTask(
          taskOutput.title,
          taskOutput.description,
          "planner",
          taskOutput.files
        );

        // Add to storage
        await addTask(this.projectPath, task);
        newTasks.push(task);

        logger.debug(`[Planner] Created task: ${task.title}`);
      }

      // Update stats
      const state = await loadState(this.projectPath);
      if (state) {
        await updateStats(this.projectPath, {
          tasks_created: state.stats.tasks_created + newTasks.length,
          tasks_pending: state.stats.tasks_pending + newTasks.length,
        });
      }

      return newTasks;

    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`[Planner] Execution error: ${message}`);
      return [];
    }
  }

  /**
   * Parse planner output JSON
   */
  private parsePlannerOutput(output: string): PlannerOutput | null {
    try {
      // Try to find JSON in the output
      const jsonPatterns = [
        /\{[\s\S]*"analysis"[\s\S]*"tasks"[\s\S]*\}/,
        /```json\n?([\s\S]*?)```/,
        /```\n?([\s\S]*?)```/,
      ];

      for (const pattern of jsonPatterns) {
        const match = output.match(pattern);
        if (match) {
          const jsonStr = match[1] || match[0];
          const parsed = JSON.parse(jsonStr);

          // Validate structure
          if (parsed.analysis && Array.isArray(parsed.tasks)) {
            const validTasks: PlannerTaskOutput[] = parsed.tasks
              .filter((t: PlannerTaskOutput) => t.title && t.description)
              .slice(0, 10); // Max 10 tasks per cycle

            return {
              analysis: parsed.analysis,
              tasks: validTasks,
            };
          }
        }
      }

      // Try to parse entire output as JSON
      const directParse = JSON.parse(output);
      if (directParse.analysis && Array.isArray(directParse.tasks)) {
        return directParse;
      }

      return null;
    } catch {
      return null;
    }
  }

  /**
   * Spawn a sub-planner for a specific focus area
   * Sub-planners create tasks only for their designated area
   */
  async spawnSubPlanner(
    focusArea: SubPlannerArea,
    context: ExecutionContext,
    parentAnalysis: string
  ): Promise<Task[]> {
    logger.info(`[Sub-Planner] Spawning for area: ${focusArea.name}`);

    // Build sub-planner prompt
    const prompt = buildSubPlannerPrompt(
      focusArea.name,
      context.goal,
      `Parent analysis: ${parentAnalysis}\nFocus files: ${focusArea.files.join(", ")}`
    );

    // Create pseudo-task for sub-planner
    const subPlannerTask: Task = {
      id: `sub-planner-${focusArea.name}-${Date.now()}`,
      title: `Sub-plan for ${focusArea.name}`,
      description: prompt,
      status: "in_progress",
      assigned_agent: null,
      worker_id: null,
      files: focusArea.files,
      created_by: "planner",
      created_at: new Date().toISOString(),
      started_at: new Date().toISOString(),
      completed_at: null,
      attempts: 0,
      max_attempts: 2,
      last_error: null,
      agent_history: [],
    };

    try {
      const { result } = await this.executorManager.executeTask(subPlannerTask, context);

      if (!result.success) {
        logger.warn(`[Sub-Planner] Failed for ${focusArea.name}: ${result.error?.message}`);
        return [];
      }

      const output = this.parsePlannerOutput(result.output);

      if (!output) {
        logger.warn(`[Sub-Planner] Failed to parse output for ${focusArea.name}`);
        return [];
      }

      // Create tasks from sub-planner output
      const newTasks: Task[] = [];
      for (const taskOutput of output.tasks.slice(0, 5)) { // Max 5 tasks per sub-planner
        const task = createTask(
          taskOutput.title,
          taskOutput.description,
          `sub-planner:${focusArea.name}`,
          taskOutput.files
        );

        await addTask(this.projectPath, task);
        newTasks.push(task);
        logger.debug(`[Sub-Planner:${focusArea.name}] Created task: ${task.title}`);
      }

      logger.info(`[Sub-Planner] ${focusArea.name} created ${newTasks.length} tasks`);
      return newTasks;

    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`[Sub-Planner] Error for ${focusArea.name}: ${message}`);
      return [];
    }
  }

  /**
   * Run planner with optional sub-planner spawning
   * When areas are provided, spawns sub-planners in parallel
   */
  async runWithSubPlanners(
    context: ExecutionContext,
    cycle: { current: number; max: number },
    focusAreas?: SubPlannerArea[]
  ): Promise<Task[]> {
    // First run main planner
    const mainTasks = await this.run(context, cycle);

    // If no focus areas, just return main tasks
    if (!focusAreas || focusAreas.length === 0) {
      return mainTasks;
    }

    // Get analysis from main planner (simplified)
    const parentAnalysis = "Main planner analysis";

    // Spawn sub-planners in parallel
    logger.info(`[Planner] Spawning ${focusAreas.length} sub-planners`);

    const subPlannerPromises = focusAreas.map(area =>
      this.spawnSubPlanner(area, context, parentAnalysis)
    );

    const subPlannerResults = await Promise.all(subPlannerPromises);

    // Aggregate all tasks
    const allTasks = [...mainTasks];
    for (const tasks of subPlannerResults) {
      allTasks.push(...tasks);
    }

    // Update stats
    const state = await loadState(this.projectPath);
    if (state) {
      const newTaskCount = allTasks.length - mainTasks.length;
      if (newTaskCount > 0) {
        await updateStats(this.projectPath, {
          tasks_created: state.stats.tasks_created + newTaskCount,
          tasks_pending: state.stats.tasks_pending + newTaskCount,
        });
      }
    }

    logger.info(`[Planner] Total tasks: ${allTasks.length} (main: ${mainTasks.length}, sub: ${allTasks.length - mainTasks.length})`);

    return allTasks;
  }
}

/**
 * Create a planner runner
 */
export function createPlannerRunner(projectPath: string, timeout?: number): PlannerRunner {
  return new PlannerRunner(projectPath, timeout);
}
