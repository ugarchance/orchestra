import { writeFile, access, constants } from "fs/promises";
import { join } from "path";
import type { AgentType, Task } from "../types/index.js";
import {
  BaseAgentExecutor,
  type AgentExecutorConfig,
  type ExecutionContext,
  type ExecutionResult,
  type ParsedOutput,
} from "./base.js";
import { buildWorkerPrompt } from "./prompts.js";
import { detectError } from "../core/errors.js";
import { runOpenCode } from "../utils/cli.js";
import logger from "../utils/logger.js";

/**
 * OpenCode configuration file content
 * This enables auto-approve mode for full automation
 */
const OPENCODE_CONFIG = {
  permission: "allow",
  auto_approve: true,
};

/**
 * OpenCode CLI executor
 *
 * Command: opencode run --format json "prompt"
 *
 * Note: OpenCode requires a config file (opencode.json) in the project
 * with "permission": "allow" for auto-approve mode
 */
export class OpenCodeExecutor extends BaseAgentExecutor {
  readonly agentType: AgentType = "opencode";

  constructor(workingDir: string, timeout: number = 300000) {
    const config: AgentExecutorConfig = {
      command: "opencode",
      subcommand: "run",
      flags: ["--format", "json"],
      timeout,
      workingDir,
    };
    super(config);
  }

  /**
   * Ensure opencode.json config exists in project directory
   */
  async ensureConfig(): Promise<void> {
    const configPath = join(this.config.workingDir, "opencode.json");

    try {
      await access(configPath, constants.F_OK);
      // Config exists, check if it has correct settings
    } catch {
      // Config doesn't exist, create it
      await writeFile(configPath, JSON.stringify(OPENCODE_CONFIG, null, 2));
    }
  }

  /**
   * Build the prompt for OpenCode
   */
  buildPrompt(task: Task, context: ExecutionContext): string {
    return buildWorkerPrompt(task, context);
  }

  /**
   * Build CLI arguments for OpenCode
   */
  buildArgs(prompt: string): string[] {
    // opencode run --format json "prompt"
    const escapedPrompt = prompt.replace(/"/g, '\\"').replace(/\n/g, "\\n");
    return [...this.config.flags, `"${escapedPrompt}"`];
  }

  /**
   * Override executeRaw to use cli utility
   */
  async executeRaw(prompt: string, taskTitle: string): Promise<ExecutionResult> {
    const startTime = Date.now();

    logger.info(`[${this.agentType}] Executing: ${taskTitle}`);
    logger.debug(`[${this.agentType}] Raw prompt execution`);

    // Ensure config exists
    await this.ensureConfig();

    try {
      const result = await runOpenCode(prompt, {
        cwd: this.config.workingDir,
        timeout: this.config.timeout,
      });

      const durationMs = Date.now() - startTime;

      if (result.exitCode !== 0) {
        const errorCategory = detectError(result.stdout + result.stderr, result.exitCode);
        logger.error(`[${this.agentType}] Failed: ${errorCategory}`);

        return {
          success: false,
          output: result.stdout + result.stderr,
          error: {
            category: errorCategory,
            message: this.extractErrorMessage(result.stdout + result.stderr),
          },
          exitCode: result.exitCode,
          durationMs,
        };
      }

      return {
        success: true,
        output: result.stdout + result.stderr,
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
   * Parse OpenCode output
   */
  parseOutput(output: string): ParsedOutput {
    try {
      // OpenCode with --format json returns structured output
      const jsonMatch = output.match(/\{[\s\S]*\}/);

      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);

        if (parsed.status === "COMPLETED" || parsed.success === true) {
          return {
            status: "COMPLETED",
            summary: parsed.summary || parsed.output,
            filesModified: parsed.files_modified || parsed.changed_files,
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

      // Check for completion indicators
      if (
        output.includes("completed") ||
        output.includes("success") ||
        output.includes("done")
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

  /**
   * Override execute to ensure config exists
   */
  async execute(task: Task, context: ExecutionContext) {
    await this.ensureConfig();
    return super.execute(task, context);
  }
}

/**
 * Create an OpenCode executor with default settings
 */
export function createOpenCodeExecutor(
  workingDir: string,
  timeout?: number
): OpenCodeExecutor {
  return new OpenCodeExecutor(workingDir, timeout);
}

/**
 * Rate limit patterns for OpenCode
 */
export const OPENCODE_RATE_LIMIT_PATTERNS = [
  "rate limit",
  "too many requests",
  "quota exceeded",
  "429",
];

/**
 * Check if output indicates OpenCode rate limit
 */
export function isOpenCodeRateLimited(output: string): boolean {
  const lower = output.toLowerCase();
  return OPENCODE_RATE_LIMIT_PATTERNS.some((pattern) => lower.includes(pattern));
}
