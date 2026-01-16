import type { AgentType, Task, CopilotModel } from "../types/index.js";
import {
  BaseAgentExecutor,
  type AgentExecutorConfig,
  type ExecutionContext,
  type ExecutionResult,
  type ParsedOutput,
} from "./base.js";
import { buildWorkerPrompt } from "./prompts.js";
import { detectError } from "../core/errors.js";
import { runCopilot } from "../utils/cli.js";
import logger from "../utils/logger.js";

/**
 * Copilot model config
 */
export interface CopilotModelConfig {
  model: CopilotModel;
}

/**
 * GitHub Copilot CLI executor
 *
 * Command: copilot -p "prompt" --allow-all-tools --model <model>
 */
export class CopilotExecutor extends BaseAgentExecutor {
  readonly agentType: AgentType = "copilot";
  private timeout: number;
  private workingDir: string;
  private model: CopilotModel;

  constructor(workingDir: string, timeout: number = 300000, modelConfig?: CopilotModelConfig) {
    // Default to claude-sonnet-4.5 if not specified (Copilot's default)
    const model = modelConfig?.model ?? "claude-sonnet-4.5";

    const config: AgentExecutorConfig = {
      command: "copilot",
      flags: ["-p", "--allow-all-tools", "--model", model],
      timeout,
      workingDir,
    };
    super(config);
    this.timeout = timeout;
    this.workingDir = workingDir;
    this.model = model;

    logger.info(`[Copilot] Using model: ${this.model}`);
  }

  /**
   * Build the prompt for Copilot (Worker wrapper)
   */
  buildPrompt(task: Task, context: ExecutionContext): string {
    return buildWorkerPrompt(task, context);
  }

  /**
   * Build CLI arguments for Copilot
   */
  buildArgs(prompt: string): string[] {
    return [prompt];
  }

  /**
   * Override execute to use new CLI utility
   */
  async execute(task: Task, context: ExecutionContext): Promise<ExecutionResult> {
    const startTime = Date.now();
    const prompt = this.buildPrompt(task, context);

    logger.info(`[${this.agentType}] Executing task: ${task.title} with model: ${this.model}`);

    try {
      const result = await runCopilot(prompt, {
        cwd: this.workingDir,
        timeout: this.timeout,
        model: this.model,
      });

      const durationMs = Date.now() - startTime;
      const output = result.stdout + result.stderr;

      if (result.exitCode !== 0) {
        const errorCategory = detectError(output, result.exitCode);
        logger.error(`[${this.agentType}] Task failed: ${errorCategory}`);

        return {
          success: false,
          output,
          error: {
            category: errorCategory,
            message: this.extractErrorMessage(output),
          },
          exitCode: result.exitCode,
          durationMs,
        };
      }

      // Parse output
      const parsed = this.parseOutput(output);

      if (parsed.status === "COMPLETED") {
        logger.success(`[${this.agentType}] Task completed: ${task.title}`);
        return {
          success: true,
          output,
          exitCode: 0,
          durationMs,
        };
      } else if (parsed.status === "FAILED") {
        logger.error(`[${this.agentType}] Task reported failure: ${parsed.error}`);
        return {
          success: false,
          output,
          error: {
            category: "unknown",
            message: parsed.error || "Task reported failure",
          },
          exitCode: 0,
          durationMs,
        };
      }

      // No clear status - treat as success if exit code was 0
      return {
        success: true,
        output,
        exitCode: 0,
        durationMs,
      };
    } catch (err) {
      const durationMs = Date.now() - startTime;
      const message = err instanceof Error ? err.message : String(err);

      logger.error(`[${this.agentType}] Execution error: ${message}`);

      return {
        success: false,
        output: "",
        error: {
          category: detectError(message, 1),
          message,
        },
        exitCode: 1,
        durationMs,
      };
    }
  }

  /**
   * Override executeRaw to use CLI utility
   */
  async executeRaw(prompt: string, taskTitle: string): Promise<ExecutionResult> {
    const startTime = Date.now();

    logger.info(`[${this.agentType}] Executing: ${taskTitle} with model: ${this.model}`);
    logger.debug(`[${this.agentType}] Raw prompt execution`);

    try {
      const result = await runCopilot(prompt, {
        cwd: this.workingDir,
        timeout: this.timeout,
        model: this.model,
      });

      const durationMs = Date.now() - startTime;
      const output = result.stdout + result.stderr;

      if (result.exitCode !== 0) {
        const errorCategory = detectError(output, result.exitCode);
        logger.error(`[${this.agentType}] Failed: ${errorCategory}`);

        return {
          success: false,
          output,
          error: {
            category: errorCategory,
            message: this.extractErrorMessage(output),
          },
          exitCode: result.exitCode,
          durationMs,
        };
      }

      return {
        success: true,
        output,
        exitCode: 0,
        durationMs,
      };
    } catch (err) {
      const durationMs = Date.now() - startTime;
      const message = err instanceof Error ? err.message : String(err);

      logger.error(`[${this.agentType}] Execution error: ${message}`);

      return {
        success: false,
        output: "",
        error: {
          category: detectError(message, 1),
          message,
        },
        exitCode: 1,
        durationMs,
      };
    }
  }

  /**
   * Override runCli to use new utility (for base class compatibility)
   */
  protected override async runCli(
    args: string[]
  ): Promise<{ output: string; exitCode: number }> {
    const prompt = args[0];

    const result = await runCopilot(prompt, {
      cwd: this.workingDir,
      timeout: this.timeout,
      model: this.model,
    });

    return {
      output: result.stdout + result.stderr,
      exitCode: result.exitCode,
    };
  }

  /**
   * Parse Copilot output
   */
  parseOutput(output: string): ParsedOutput {
    try {
      // Look for JSON in output (status object from worker)
      const jsonMatch = output.match(/\{[\s\S]*"status"[\s\S]*\}/);

      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);

        if (parsed.status === "COMPLETED" || parsed.success === true) {
          return {
            status: "COMPLETED",
            summary: parsed.summary || parsed.message,
            filesModified: parsed.files_modified || parsed.files,
            raw: output,
          };
        } else if (parsed.status === "FAILED" || parsed.success === false) {
          return {
            status: "FAILED",
            error: parsed.error || parsed.message,
            raw: output,
          };
        }
      }

      // Check for completion indicators in plain text
      if (
        output.toLowerCase().includes("completed") ||
        output.toLowerCase().includes("successfully") ||
        output.toLowerCase().includes("created file") ||
        output.toLowerCase().includes("wrote file")
      ) {
        return {
          status: "COMPLETED",
          summary: "Task appears completed",
          raw: output,
        };
      }

      return {
        status: "UNKNOWN",
        raw: output,
      };
    } catch {
      return {
        status: "UNKNOWN",
        raw: output,
      };
    }
  }
}

/**
 * Create a Copilot executor with default settings
 */
export function createCopilotExecutor(
  workingDir: string,
  timeout?: number
): CopilotExecutor {
  return new CopilotExecutor(workingDir, timeout);
}

/**
 * Rate limit patterns specific to Copilot
 */
export const COPILOT_RATE_LIMIT_PATTERNS = [
  "rate limit",
  "too many requests",
  "quota exceeded",
  "premium request",
  "capacity",
  "429",
];

/**
 * Check if output indicates Copilot rate limit
 */
export function isCopilotRateLimited(output: string): boolean {
  const lower = output.toLowerCase();
  return COPILOT_RATE_LIMIT_PATTERNS.some((pattern) => lower.includes(pattern));
}
