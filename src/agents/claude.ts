import type { AgentType, Task } from "../types/index.js";
import {
  BaseAgentExecutor,
  type AgentExecutorConfig,
  type ExecutionContext,
  type ParsedOutput,
} from "./base.js";
import { buildWorkerPrompt } from "./prompts.js";

/**
 * Claude CLI executor
 *
 * Command: claude -p "prompt" --dangerously-skip-permissions --output-format json
 *
 * Flags:
 * - `-p`: Print mode (non-interactive)
 * - `--dangerously-skip-permissions`: Skip permission prompts for full automation
 * - `--output-format json`: Get structured JSON output
 *
 * Note: Claude is often installed as an alias, so we try multiple paths
 */
export class ClaudeExecutor extends BaseAgentExecutor {
  readonly agentType: AgentType = "claude";

  constructor(workingDir: string, timeout: number = 300000) {
    // Try to find claude - it might be an alias or in a custom location
    const claudePath = process.env.CLAUDE_PATH ||
      `${process.env.HOME}/.claude/local/claude` ||
      "claude";

    const config: AgentExecutorConfig = {
      command: claudePath,
      flags: ["-p", "--dangerously-skip-permissions", "--output-format", "json"],
      timeout,
      workingDir,
    };
    super(config);
  }

  /**
   * Build the prompt for Claude
   */
  buildPrompt(task: Task, context: ExecutionContext): string {
    return buildWorkerPrompt(task, context);
  }

  /**
   * Build CLI arguments for Claude
   */
  buildArgs(prompt: string): string[] {
    // Claude uses -p for the prompt followed by the prompt text
    // Escape the prompt for shell
    const escapedPrompt = prompt.replace(/'/g, "'\\''");
    return [...this.config.flags.slice(0, 1), `'${escapedPrompt}'`, ...this.config.flags.slice(1)];
  }

  /**
   * Parse Claude's output
   */
  parseOutput(output: string): ParsedOutput {
    try {
      // Claude with --output-format json returns structured output
      // Try to find JSON in the output
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
   * Override runCli to handle Claude-specific behavior
   */
  protected override async runCli(
    args: string[]
  ): Promise<{ output: string; exitCode: number }> {
    // For Claude, we construct the command differently
    // claude -p 'prompt' --dangerously-skip-permissions --output-format json
    const prompt = args[1]; // The escaped prompt is at index 1
    const flags = [args[0], prompt, ...args.slice(2)];

    return super.runCli(flags);
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
