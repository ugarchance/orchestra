import type { AgentType, Task, ClaudeModel } from "../types/index.js";
import {
  BaseAgentExecutor,
  type AgentExecutorConfig,
  type ExecutionContext,
  type ExecutionResult,
  type ParsedOutput,
} from "./base.js";
import { buildWorkerPrompt } from "./prompts.js";
import { detectError } from "../core/errors.js";
import { runClaude } from "../utils/cli.js";
import logger from "../utils/logger.js";

/**
 * Claude model config
 */
export interface ClaudeModelConfig {
  model: ClaudeModel;
}

/**
 * Claude CLI executor
 *
 * Uses stdin approach to avoid shell escaping issues:
 * echo "prompt" | claude -p - --dangerously-skip-permissions --output-format json --model <model>
 */
export class ClaudeExecutor extends BaseAgentExecutor {
  readonly agentType: AgentType = "claude";
  private timeout: number;
  private workingDir: string;
  private model: ClaudeModel;

  constructor(workingDir: string, timeout: number = 300000, modelConfig?: ClaudeModelConfig) {
    const claudePath = process.env.CLAUDE_PATH ||
      `${process.env.HOME}/.claude/local/claude`;

    // Default to sonnet if no model specified
    const model = modelConfig?.model ?? "sonnet";

    const config: AgentExecutorConfig = {
      command: claudePath,
      flags: ["-p", "-", "--dangerously-skip-permissions", "--output-format", "json", "--model", model],
      timeout,
      workingDir,
    };
    super(config);
    this.timeout = timeout;
    this.workingDir = workingDir;
    this.model = model;

    logger.info(`[Claude] Using model: ${this.model}`);
  }

  /**
   * Build the prompt for Claude (Worker wrapper)
   */
  buildPrompt(task: Task, context: ExecutionContext): string {
    return buildWorkerPrompt(task, context);
  }

  /**
   * Build CLI arguments for Claude (not used with new approach)
   */
  buildArgs(prompt: string): string[] {
    // This is now handled by runClaude utility
    return [prompt];
  }

  /**
   * Parse Claude's output
   */
  parseOutput(output: string): ParsedOutput {
    try {
      // Claude with --output-format json returns structured output
      const jsonMatch = output.match(/\{[\s\S]*"status"[\s\S]*\}/);

      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);

        if (parsed.status === "COMPLETED") {
          return {
            status: "COMPLETED",
            summary: parsed.summary,
            filesModified: parsed.files_modified,
            raw: output,
          };
        } else if (parsed.status === "FAILED") {
          return {
            status: "FAILED",
            error: parsed.error || parsed.blocker,
            raw: output,
          };
        }
      }

      // Check for completion indicators in plain text
      if (
        output.toLowerCase().includes("task completed") ||
        output.toLowerCase().includes("successfully implemented") ||
        output.toLowerCase().includes("changes committed")
      ) {
        return {
          status: "COMPLETED",
          summary: "Task appears completed based on output",
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

  /**
   * Override execute to handle web search flag
   */
  override async execute(task: Task, context: ExecutionContext): Promise<ExecutionResult> {
    const startTime = Date.now();
    const prompt = this.buildPrompt(task, context);

    logger.info(`[Claude] Executing task: ${task.title} with model: ${this.model}`);
    if (task.needs_web_search) {
      logger.info(`[Claude] Web search enabled for this task`);
    }

    try {
      const result = await runClaude(prompt, {
        cwd: this.workingDir,
        timeout: this.timeout,
        model: this.model,
        webSearch: task.needs_web_search,
      });

      const durationMs = Date.now() - startTime;
      const output = this.extractClaudeResult(result.stdout + result.stderr);

      if (result.exitCode !== 0) {
        const errorCategory = detectError(output, result.exitCode);
        logger.error(`[Claude] Task failed: ${errorCategory}`);

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
        logger.success(`[Claude] Task completed: ${task.title}`);
        return {
          success: true,
          output,
          exitCode: 0,
          durationMs,
        };
      } else if (parsed.status === "FAILED") {
        logger.error(`[Claude] Task reported failure: ${parsed.error}`);
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

      logger.error(`[Claude] Execution error: ${message}`);

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
   * Override runCli for base class compatibility
   */
  protected override async runCli(
    args: string[]
  ): Promise<{ output: string; exitCode: number }> {
    // args[0] is the prompt (from buildArgs)
    const prompt = args[0];

    const result = await runClaude(prompt, {
      cwd: this.workingDir,
      timeout: this.timeout,
      model: this.model,
    });

    // Extract actual result from Claude's JSON wrapper
    const output = this.extractClaudeResult(result.stdout + result.stderr);

    return {
      output,
      exitCode: result.exitCode,
    };
  }

  /**
   * Extract the actual result from Claude's JSON output wrapper
   * Claude returns: {"type":"result","result":"actual content",...}
   * We want just the "actual content"
   */
  private extractClaudeResult(rawOutput: string): string {
    logger.debug(`[Claude] Raw output (${rawOutput.length} chars):`);
    logger.debug(`[Claude] ${rawOutput.slice(0, 500)}...`);

    try {
      const parsed = JSON.parse(rawOutput);
      if (parsed.type === "result" && parsed.result) {
        logger.info(`[Claude] Extracted result (${parsed.result.length} chars)`);
        logger.debug(`[Claude] Result preview: ${parsed.result.slice(0, 300)}...`);
        return parsed.result;
      }
      // If it's an error result
      if (parsed.is_error) {
        logger.error(`[Claude] Error result: ${parsed.result}`);
        return parsed.result || rawOutput;
      }
    } catch {
      // Not JSON or parsing failed, return raw
      logger.warn(`[Claude] Output is not JSON wrapper, using raw`);
    }
    return rawOutput;
  }
}

/**
 * Create a Claude executor with default settings
 */
export function createClaudeExecutor(
  workingDir: string,
  timeout?: number
): ClaudeExecutor {
  return new ClaudeExecutor(workingDir, timeout);
}

/**
 * Rate limit patterns specific to Claude
 */
export const CLAUDE_RATE_LIMIT_PATTERNS = [
  "rate limit",
  "too many requests",
  "quota exceeded",
  "rate_limit_error",
  "overloaded",
  "capacity",
];

/**
 * Check if output indicates Claude rate limit
 */
export function isClaudeRateLimited(output: string): boolean {
  const lower = output.toLowerCase();
  return CLAUDE_RATE_LIMIT_PATTERNS.some((pattern) => lower.includes(pattern));
}
