import type { Task, PlannerOutput, PlannerTaskOutput } from "../types/index.js";
import type { ExecutionContext } from "../agents/base.js";
import { buildPlannerPrompt } from "../agents/prompts.js";
import { AgentExecutorManager } from "../agents/executor.js";
import { createTask, loadTasks, addTask } from "./tasks.js";
import { loadState, updateStats } from "./state.js";
import logger from "../utils/logger.js";

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
      // Planner should output JSON like: { "analysis": "...", "tasks": [...] }

      // Look for JSON object with analysis and tasks
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
            // Validate each task
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
}

/**
 * Create a planner runner
 */
export function createPlannerRunner(projectPath: string, timeout?: number): PlannerRunner {
  return new PlannerRunner(projectPath, timeout);
}
