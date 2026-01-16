import type { JudgeOutput, JudgeDecision } from "../types/index.js";
import type { ExecutionContext } from "../agents/base.js";
import { buildJudgePrompt } from "../agents/prompts.js";
import { AgentExecutorManager } from "../agents/executor.js";
import { loadTasks } from "./tasks.js";
import logger from "../utils/logger.js";

/**
 * Judge Runner
 * Evaluates cycle progress and decides next action
 */
export class JudgeRunner {
  private executorManager: AgentExecutorManager;
  private projectPath: string;

  constructor(projectPath: string, timeout: number = 300000) {
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
   * Run the judge to evaluate cycle
   */
  async run(
    context: ExecutionContext,
    cycle: { current: number; max: number }
  ): Promise<JudgeOutput> {
    logger.info(`[Judge] Evaluating cycle ${cycle.current}/${cycle.max}`);

    // Load all tasks
    const allTasks = await loadTasks(this.projectPath);
    const completedTasks = allTasks.filter(t => t.status === "completed");
    const failedTasks = allTasks.filter(t => t.status === "failed");
    const pendingTasks = allTasks.filter(t => t.status === "pending");

    // Calculate stats
    const stats = {
      completed: completedTasks.length,
      failed: failedTasks.length,
      pending: pendingTasks.length,
      total: allTasks.length,
    };

    // Build judge prompt
    const prompt = buildJudgePrompt(context, cycle, stats, {
      completed: completedTasks,
      failed: failedTasks,
    });

    try {
      // Execute raw prompt (no Worker wrapper for Judge)
      const { result } = await this.executorManager.executeRawPrompt(
        prompt,
        `Judge cycle ${cycle.current}`
      );

      if (!result.success) {
        logger.error(`[Judge] Failed to evaluate: ${result.error?.message}`);
        // Default to CONTINUE on failure
        return this.defaultOutput("CONTINUE", "Judge execution failed, defaulting to continue");
      }

      // Parse judge output
      const judgeOutput = this.parseJudgeOutput(result.output);

      if (!judgeOutput) {
        logger.warn("[Judge] Failed to parse output, using heuristics");
        return this.heuristicDecision(stats, cycle);
      }

      logger.info(`[Judge] Decision: ${judgeOutput.decision}`);
      logger.info(`[Judge] Progress: ${judgeOutput.progress_percent}%`);
      logger.info(`[Judge] Reasoning: ${judgeOutput.reasoning}`);

      if (judgeOutput.issues.length > 0) {
        logger.warn(`[Judge] Issues: ${judgeOutput.issues.join(", ")}`);
      }

      return judgeOutput;

    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`[Judge] Execution error: ${message}`);
      return this.defaultOutput("CONTINUE", `Error: ${message}`);
    }
  }

  /**
   * Parse judge output JSON
   */
  private parseJudgeOutput(output: string): JudgeOutput | null {
    try {
      // Try to find JSON in the output
      const jsonPatterns = [
        /\{[\s\S]*"decision"[\s\S]*\}/,
        /```json\n?([\s\S]*?)```/,
        /```\n?([\s\S]*?)```/,
      ];

      for (const pattern of jsonPatterns) {
        const match = output.match(pattern);
        if (match) {
          const jsonStr = match[1] || match[0];
          const parsed = JSON.parse(jsonStr);

          // Validate structure
          if (parsed.decision && ["CONTINUE", "COMPLETE", "ABORT"].includes(parsed.decision)) {
            return {
              decision: parsed.decision as JudgeDecision,
              reasoning: parsed.reasoning || "No reasoning provided",
              progress_percent: parsed.progress_percent || 0,
              issues: parsed.issues || [],
              recommendations: parsed.recommendations || [],
            };
          }
        }
      }

      // Try to parse entire output as JSON
      const directParse = JSON.parse(output);
      if (directParse.decision) {
        return directParse;
      }

      return null;
    } catch {
      return null;
    }
  }

  /**
   * Make a heuristic decision when judge output can't be parsed
   */
  private heuristicDecision(
    stats: { completed: number; failed: number; pending: number; total: number },
    cycle: { current: number; max: number }
  ): JudgeOutput {
    // If max cycles reached
    if (cycle.current >= cycle.max) {
      return this.defaultOutput(
        "ABORT",
        `Max cycles (${cycle.max}) reached`,
        Math.round((stats.completed / Math.max(stats.total, 1)) * 100)
      );
    }

    // If all tasks completed
    if (stats.pending === 0 && stats.failed === 0 && stats.completed > 0) {
      return this.defaultOutput("COMPLETE", "All tasks completed successfully", 100);
    }

    // If too many failures (>50%)
    if (stats.total > 0 && stats.failed / stats.total > 0.5) {
      return this.defaultOutput(
        "ABORT",
        `High failure rate: ${stats.failed}/${stats.total} tasks failed`,
        Math.round((stats.completed / stats.total) * 100),
        ["High failure rate detected"]
      );
    }

    // Default: continue
    const progress = stats.total > 0
      ? Math.round((stats.completed / stats.total) * 100)
      : 0;

    return this.defaultOutput(
      "CONTINUE",
      `Progress: ${stats.completed}/${stats.total} tasks completed`,
      progress
    );
  }

  /**
   * Create a default output
   */
  private defaultOutput(
    decision: JudgeDecision,
    reasoning: string,
    progress: number = 0,
    issues: string[] = []
  ): JudgeOutput {
    return {
      decision,
      reasoning,
      progress_percent: progress,
      issues,
      recommendations: [],
    };
  }
}

/**
 * Create a judge runner
 */
export function createJudgeRunner(projectPath: string, timeout?: number): JudgeRunner {
  return new JudgeRunner(projectPath, timeout);
}
