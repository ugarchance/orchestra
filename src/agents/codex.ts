import { spawn } from "child_process";
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
import logger from "../utils/logger.js";

/**
 * Codex CLI executor
 *
 * Uses file-based prompt to avoid shell escaping issues
 */
export class CodexExecutor extends BaseAgentExecutor {
  readonly agentType: AgentType = "codex";

  constructor(workingDir: string, timeout: number = 300000) {
    const config: AgentExecutorConfig = {
      command: "codex",
      flags: [
        "--full-auto",
        "--skip-git-repo-check",
      ],
      timeout,
      workingDir,
    };
    super(config);
  }

  /**
   * Build the prompt for Codex
   */
  buildPrompt(task: Task, context: ExecutionContext): string {
    return buildWorkerPrompt(task, context);
  }

  /**
   * Build CLI arguments for Codex
   * Note: Not used directly, we use file-based approach
   */
  buildArgs(prompt: string): string[] {
    return [prompt, ...this.config.flags];
  }

  /**
   * Override execute to use file-based prompt
   */
  async execute(task: Task, context: ExecutionContext): Promise<ExecutionResult> {
    const startTime = Date.now();
    const prompt = this.buildPrompt(task, context);

    logger.info(`[${this.agentType}] Executing task: ${task.title}`);

    // Write prompt to temp file
    const promptFile = await this.writePromptFile(prompt);

    try {
      // Build command: codex "$(cat promptfile)" --flags
      const args = [
        ...this.config.flags,
      ];

      logger.debug(`[${this.agentType}] Using prompt file: ${promptFile}`);

      const result = await this.runWithPromptFile(promptFile, args);
      const durationMs = Date.now() - startTime;

      // Check for errors
      if (result.exitCode !== 0) {
        const errorCategory = detectError(result.output, result.exitCode);
        logger.error(`[${this.agentType}] Task failed: ${errorCategory}`);

        return {
          success: false,
          output: result.output,
          error: {
            category: errorCategory,
            message: this.extractErrorMessage(result.output),
          },
          exitCode: result.exitCode,
          durationMs,
        };
      }

      // Parse output
      const parsed = this.parseOutput(result.output);

      if (parsed.status === "COMPLETED") {
        logger.success(`[${this.agentType}] Task completed: ${task.title}`);
        return {
          success: true,
          output: result.output,
          exitCode: 0,
          durationMs,
        };
      } else if (parsed.status === "FAILED") {
        logger.error(`[${this.agentType}] Task reported failure: ${parsed.error}`);
        return {
          success: false,
          output: result.output,
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
        output: result.output,
        exitCode: 0,
        durationMs,
      };

    } finally {
      // Clean up prompt file
      await this.cleanupPromptFile(promptFile);
    }
  }

  /**
   * Run codex with prompt from file using stdin
   */
  private runWithPromptFile(
    promptFile: string,
    args: string[]
  ): Promise<{ output: string; exitCode: number }> {
    return new Promise((resolve, reject) => {
      // Use cat to pipe the prompt file to codex exec via stdin
      // "-" tells codex to read prompt from stdin
      const command = `cat "${promptFile}" | codex exec - ${args.join(" ")} --json`;

      logger.debug(`[${this.agentType}] Command: ${command}`);

      const proc = spawn("sh", ["-c", command], {
        cwd: this.config.workingDir,
        env: { ...process.env },
      });

      let stdout = "";
      let stderr = "";

      proc.stdout.on("data", (data) => {
        stdout += data.toString();
      });

      proc.stderr.on("data", (data) => {
        stderr += data.toString();
      });

      // Timeout handling
      const timeout = setTimeout(() => {
        proc.kill("SIGTERM");
        reject(new Error(`Command timed out after ${this.config.timeout}ms`));
      }, this.config.timeout);

      proc.on("close", (code) => {
        clearTimeout(timeout);
        resolve({
          output: stdout + stderr,
          exitCode: code ?? 1,
        });
      });

      proc.on("error", (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  }

  /**
   * Parse Codex output
   */
  parseOutput(output: string): ParsedOutput {
    try {
      // Look for JSON in output
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
 * Create a Codex executor with default settings
 */
export function createCodexExecutor(
  workingDir: string,
  timeout?: number
): CodexExecutor {
  return new CodexExecutor(workingDir, timeout);
}

/**
 * Rate limit patterns specific to Codex/OpenAI
 */
export const CODEX_RATE_LIMIT_PATTERNS = [
  "rate limit",
  "too many requests",
  "quota exceeded",
  "rate_limit_exceeded",
  "429",
  "capacity",
  "overloaded",
];

/**
 * Check if output indicates Codex rate limit
 */
export function isCodexRateLimited(output: string): boolean {
  const lower = output.toLowerCase();
  return CODEX_RATE_LIMIT_PATTERNS.some((pattern) => lower.includes(pattern));
}
