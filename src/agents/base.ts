import { spawn } from "child_process";
import { writeFile, unlink } from "fs/promises";
import { join } from "path";
import { randomUUID } from "crypto";
import type { AgentType, ErrorCategory, Task } from "../types/index.js";
import { detectError } from "../core/errors.js";
import logger from "../utils/logger.js";

/**
 * Result of an agent execution
 */
export interface ExecutionResult {
  success: boolean;
  output: string;
  error?: {
    category: ErrorCategory;
    message: string;
  };
  exitCode: number;
  durationMs: number;
}

/**
 * Agent configuration
 */
export interface AgentExecutorConfig {
  command: string;
  subcommand?: string;
  flags: string[];
  timeout: number;
  workingDir: string;
}

/**
 * Base class for agent executors
 */
export abstract class BaseAgentExecutor {
  abstract readonly agentType: AgentType;
  protected config: AgentExecutorConfig;

  constructor(config: AgentExecutorConfig) {
    this.config = config;
  }

  /**
   * Build the prompt for this agent
   */
  abstract buildPrompt(task: Task, context: ExecutionContext): string;

  /**
   * Build CLI arguments
   */
  abstract buildArgs(prompt: string): string[];

  /**
   * Parse the output from CLI
   */
  abstract parseOutput(output: string): ParsedOutput;

  /**
   * Execute a raw prompt directly (for Planner/Judge - no Worker wrapper)
   */
  async executeRaw(prompt: string, taskTitle: string): Promise<ExecutionResult> {
    const startTime = Date.now();
    const args = this.buildArgs(prompt);

    logger.info(`[${this.agentType}] Executing: ${taskTitle}`);
    logger.debug(`[${this.agentType}] Raw prompt execution`);

    try {
      const result = await this.runCli(args);
      const durationMs = Date.now() - startTime;

      if (result.exitCode !== 0) {
        const errorCategory = detectError(result.output, result.exitCode);
        logger.error(`[${this.agentType}] Failed: ${errorCategory}`);

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

      // For raw execution, just return the output
      return {
        success: true,
        output: result.output,
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
   * Execute a task with this agent
   */
  async execute(task: Task, context: ExecutionContext): Promise<ExecutionResult> {
    const startTime = Date.now();
    const prompt = this.buildPrompt(task, context);
    const args = this.buildArgs(prompt);

    logger.info(`[${this.agentType}] Executing task: ${task.title}`);
    logger.debug(`[${this.agentType}] Command: ${this.config.command} ${args.join(" ")}`);

    try {
      const result = await this.runCli(args);
      const durationMs = Date.now() - startTime;

      // Check for errors in output
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

      // Parse output to check for completion status
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
   * Run the CLI command
   */
  protected runCli(args: string[]): Promise<{ output: string; exitCode: number }> {
    return new Promise((resolve, reject) => {
      const fullArgs = this.config.subcommand
        ? [this.config.subcommand, ...args]
        : args;

      const proc = spawn(this.config.command, fullArgs, {
        cwd: this.config.workingDir,
        shell: true,
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
   * Extract error message from output
   */
  protected extractErrorMessage(output: string): string {
    // Look for common error patterns
    const patterns = [
      /error[:\s]+(.+?)(?:\n|$)/i,
      /failed[:\s]+(.+?)(?:\n|$)/i,
      /exception[:\s]+(.+?)(?:\n|$)/i,
    ];

    for (const pattern of patterns) {
      const match = output.match(pattern);
      if (match) {
        return match[1].trim();
      }
    }

    // Return last 200 chars if no pattern found
    return output.slice(-200).trim();
  }

  /**
   * Write prompt to a temporary file and return path
   */
  protected async writePromptFile(prompt: string): Promise<string> {
    const filename = `.orchestra-prompt-${randomUUID()}.txt`;
    const filepath = join(this.config.workingDir, filename);
    await writeFile(filepath, prompt, "utf-8");
    return filepath;
  }

  /**
   * Clean up prompt file
   */
  protected async cleanupPromptFile(filepath: string): Promise<void> {
    try {
      await unlink(filepath);
    } catch {
      // Ignore cleanup errors
    }
  }
}

/**
 * Execution context passed to agents
 */
export interface ExecutionContext {
  projectPath: string;
  branch: string;
  sessionId: string;
  goal: string;
}

/**
 * Parsed output from agent
 */
export interface ParsedOutput {
  status: "COMPLETED" | "FAILED" | "UNKNOWN";
  summary?: string;
  filesModified?: string[];
  error?: string;
  raw: string;
}

/**
 * Check if a CLI command is available
 * Handles both regular commands and aliases
 */
export async function isCommandAvailable(command: string): Promise<boolean> {
  // First try the exact path if it looks like an absolute path
  if (command.startsWith("/")) {
    return new Promise((resolve) => {
      const proc = spawn("test", ["-x", command], { shell: true });
      proc.on("close", (code) => {
        resolve(code === 0);
      });
      proc.on("error", () => {
        resolve(false);
      });
    });
  }

  // Try which command
  return new Promise((resolve) => {
    const proc = spawn("sh", ["-c", `which ${command} || type ${command}`], { shell: false });
    proc.on("close", (code) => {
      resolve(code === 0);
    });
    proc.on("error", () => {
      resolve(false);
    });
  });
}

/**
 * Get the actual path for a command (resolving aliases)
 */
export async function resolveCommandPath(command: string): Promise<string | null> {
  // If already an absolute path and executable, use it
  if (command.startsWith("/")) {
    const exists = await isCommandAvailable(command);
    return exists ? command : null;
  }

  return new Promise((resolve) => {
    const proc = spawn("sh", ["-c", `which ${command} 2>/dev/null || echo ""`], { shell: false });
    let output = "";
    proc.stdout.on("data", (data) => {
      output += data.toString();
    });
    proc.on("close", () => {
      const path = output.trim();
      resolve(path || null);
    });
    proc.on("error", () => {
      resolve(null);
    });
  });
}
