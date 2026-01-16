import { spawn } from "child_process";
import { writeFile, mkdir } from "fs/promises";
import { join } from "path";
import logger from "./logger.js";

/**
 * Save prompt to .orchestra/prompts/ for debugging
 */
async function savePrompt(
  cwd: string,
  agent: string,
  prompt: string
): Promise<string> {
  const promptsDir = join(cwd, ".orchestra", "prompts");

  // Create prompts directory if it doesn't exist
  await mkdir(promptsDir, { recursive: true });

  // Generate filename with timestamp
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `${agent}-${timestamp}-prompt.txt`;
  const filepath = join(promptsDir, filename);

  // Save prompt
  await writeFile(filepath, prompt, "utf-8");
  logger.debug(`[CLI] Saved prompt to ${filepath}`);

  return filepath;
}

/**
 * Save response to .orchestra/prompts/ for debugging
 */
async function saveResponse(
  cwd: string,
  agent: string,
  rawOutput: string,
  extractedOutput: string
): Promise<void> {
  const promptsDir = join(cwd, ".orchestra", "prompts");

  // Create prompts directory if it doesn't exist
  await mkdir(promptsDir, { recursive: true });

  // Generate filename with timestamp
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");

  // Save raw output
  const rawFilename = `${agent}-${timestamp}-raw.txt`;
  const rawFilepath = join(promptsDir, rawFilename);
  await writeFile(rawFilepath, rawOutput, "utf-8");

  // Save extracted output
  const extractedFilename = `${agent}-${timestamp}-response.txt`;
  const extractedFilepath = join(promptsDir, extractedFilename);
  await writeFile(extractedFilepath, extractedOutput, "utf-8");

  logger.debug(`[CLI] Saved response to ${extractedFilepath}`);
}

/**
 * CLI execution result
 */
export interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  command: string; // The actual command that was run (for debugging)
}

/**
 * CLI execution options
 */
export interface CliOptions {
  cwd?: string;
  timeout?: number;
  env?: Record<string, string>;
}

/**
 * Claude CLI options
 */
export interface ClaudeCliOptions extends CliOptions {
  model?: string;
}

/**
 * Codex CLI options
 */
export interface CodexCliOptions extends CliOptions {
  model?: string;
  reasoningLevel?: string;
}

/**
 * Gemini CLI options
 */
export interface GeminiCliOptions extends CliOptions {
  model?: string;
}

/**
 * Execute Claude CLI with a prompt
 * Uses stdin to avoid shell escaping issues
 */
export async function runClaude(
  prompt: string,
  options: ClaudeCliOptions = {}
): Promise<CliResult> {
  const cwd = options.cwd || process.cwd();

  // Save prompt for debugging
  await savePrompt(cwd, "claude", prompt);

  const claudePath = process.env.CLAUDE_PATH ||
    `${process.env.HOME}/.claude/local/claude`;

  const args = [
    "-p", "-",  // Read prompt from stdin
    "--dangerously-skip-permissions",
    "--output-format", "json"
  ];

  // Add model if specified
  if (options.model) {
    args.push("--model", options.model);
  }

  const command = `${claudePath} ${args.join(" ")}`;
  logger.debug(`[CLI] Running: ${command}`);
  logger.debug(`[CLI] Prompt length: ${prompt.length} chars`);

  return new Promise((resolve, reject) => {
    const proc = spawn(claudePath, args, {
      cwd: options.cwd || process.cwd(),
      env: { ...process.env, ...options.env },
      stdio: ["pipe", "pipe", "pipe"], // stdin, stdout, stderr
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
    const timeout = options.timeout || 300000; // 5 min default
    const timer = setTimeout(() => {
      proc.kill("SIGTERM");
      reject(new Error(`Command timed out after ${timeout}ms`));
    }, timeout);

    proc.on("close", async (code) => {
      clearTimeout(timer);

      // Save response for debugging
      const rawOutput = stdout + stderr;
      await saveResponse(cwd, "claude", rawOutput, rawOutput);

      resolve({
        stdout,
        stderr,
        exitCode: code ?? 1,
        command,
      });
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });

    // Write prompt to stdin and close it
    proc.stdin.write(prompt);
    proc.stdin.end();
  });
}

/**
 * Execute Codex CLI with a prompt
 * Uses stdin approach: echo "prompt" | codex exec --full-auto --json --skip-git-repo-check -
 */
export async function runCodex(
  prompt: string,
  options: CodexCliOptions = {}
): Promise<CliResult> {
  const cwd = options.cwd || process.cwd();

  // Save prompt for debugging
  await savePrompt(cwd, "codex", prompt);

  // codex exec with full access (no sandbox restrictions)
  const args = [
    "exec",
    "--dangerously-bypass-approvals-and-sandbox",  // Full access, no sandbox
    "--json",
    "--skip-git-repo-check",
  ];

  // Add model if specified
  if (options.model) {
    args.push("-m", options.model);
  }

  // Add reasoning level if specified
  if (options.reasoningLevel) {
    args.push("-c", `model_reasoning_effort="${options.reasoningLevel}"`);
  }

  // Add stdin marker last
  args.push("-");

  const command = `codex ${args.join(" ")}`;
  logger.debug(`[CLI] Running: ${command}`);
  logger.debug(`[CLI] Prompt length: ${prompt.length} chars`);

  return new Promise((resolve, reject) => {
    const proc = spawn("codex", args, {
      cwd: options.cwd || process.cwd(),
      env: { ...process.env, ...options.env },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    proc.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    const timeout = options.timeout || 300000;
    const timer = setTimeout(() => {
      proc.kill("SIGTERM");
      reject(new Error(`Command timed out after ${timeout}ms`));
    }, timeout);

    proc.on("close", async (code) => {
      clearTimeout(timer);

      // Extract actual response from JSONL output
      const rawOutput = stdout + stderr;
      const extracted = extractCodexResult(stdout);

      // Save response for debugging
      await saveResponse(cwd, "codex", rawOutput, extracted);

      resolve({
        stdout: extracted,
        stderr,
        exitCode: code ?? 1,
        command,
      });
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });

    // Write prompt to stdin and close it
    proc.stdin.write(prompt);
    proc.stdin.end();
  });
}

/**
 * Extract actual result from Codex JSONL output
 * Codex outputs multiple JSON lines, we want the agent_message type
 *
 * Types:
 * - item.type === "reasoning" → thinking/planning text (skip)
 * - item.type === "agent_message" → actual response (use this)
 * - item.type === "command_execution" → shell commands (skip)
 */
function extractCodexResult(jsonlOutput: string): string {
  logger.debug(`[Codex] Raw output (${jsonlOutput.length} chars):`);
  logger.debug(`[Codex] ${jsonlOutput.slice(0, 500)}...`);

  const lines = jsonlOutput.trim().split("\n");
  const agentMessages: string[] = [];

  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      // Only extract agent_message type (actual response)
      if (parsed.type === "item.completed" &&
          parsed.item?.type === "agent_message" &&
          parsed.item?.text) {
        agentMessages.push(parsed.item.text);
      }
    } catch {
      // Skip non-JSON lines
    }
  }

  if (agentMessages.length > 0) {
    // Combine all agent messages (usually just one)
    const result = agentMessages.join("\n");
    logger.info(`[Codex] Extracted ${agentMessages.length} agent message(s) (${result.length} chars)`);
    logger.debug(`[Codex] Result preview: ${result.slice(0, 300)}...`);
    return result;
  }

  // Fallback: return raw output
  logger.warn(`[Codex] No agent_message found, returning raw output`);
  return jsonlOutput;
}

/**
 * Execute Gemini CLI with a prompt
 * gemini -m <model> --approval-mode yolo -o stream-json "prompt"
 */
export async function runGemini(
  prompt: string,
  options: GeminiCliOptions = {}
): Promise<CliResult> {
  const cwd = options.cwd || process.cwd();

  // Save prompt for debugging
  await savePrompt(cwd, "gemini", prompt);

  // gemini -m <model> -y -o stream-json "prompt"
  const args: string[] = [];

  // Add model if specified
  if (options.model) {
    args.push("-m", options.model);
  }

  // YOLO mode for auto-approval (-y is short for --yolo)
  args.push("-y");

  // JSON output for parsing
  args.push("-o", "stream-json");

  // Add prompt last (positional argument)
  args.push(prompt);

  const command = `gemini -m ${options.model || "auto"} -y -o stream-json "..."`;
  logger.debug(`[CLI] Running: ${command}`);
  logger.debug(`[CLI] Prompt length: ${prompt.length} chars`);

  return new Promise((resolve, reject) => {
    const proc = spawn("gemini", args, {
      cwd: options.cwd || process.cwd(),
      env: { ...process.env, ...options.env },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    proc.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    const timeout = options.timeout || 300000;
    const timer = setTimeout(() => {
      proc.kill("SIGTERM");
      reject(new Error(`Command timed out after ${timeout}ms`));
    }, timeout);

    proc.on("close", async (code) => {
      clearTimeout(timer);

      // Extract actual response from stream-json output
      const rawOutput = stdout + stderr;
      const extracted = extractGeminiResult(stdout);

      // Save response for debugging
      await saveResponse(cwd, "gemini", rawOutput, extracted);

      resolve({
        stdout: extracted,
        stderr,
        exitCode: code ?? 1,
        command,
      });
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/**
 * Extract actual result from Gemini stream-json output
 *
 * Format:
 * {"type":"init",...}
 * {"type":"message","role":"user","content":"..."}
 * {"type":"message","role":"assistant","content":"...","delta":true}  <- parça parça geliyor
 * {"type":"message","role":"assistant","content":"...","delta":true}
 * {"type":"result","status":"success",...}
 */
function extractGeminiResult(jsonlOutput: string): string {
  logger.debug(`[Gemini] Raw output (${jsonlOutput.length} chars):`);
  logger.debug(`[Gemini] ${jsonlOutput.slice(0, 500)}...`);

  const lines = jsonlOutput.trim().split("\n");
  const assistantParts: string[] = [];

  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      // Extract assistant message parts (delta: true means streaming)
      if (parsed.type === "message" &&
          parsed.role === "assistant" &&
          parsed.content) {
        assistantParts.push(parsed.content);
      }
    } catch {
      // Skip non-JSON lines (stderr noise, warnings, etc.)
    }
  }

  if (assistantParts.length > 0) {
    // Concatenate all delta parts (no newline, they're continuous)
    const result = assistantParts.join("");
    logger.info(`[Gemini] Extracted ${assistantParts.length} assistant part(s) (${result.length} chars)`);
    logger.debug(`[Gemini] Result preview: ${result.slice(0, 300)}...`);
    return result;
  }

  // Fallback: return raw output
  logger.warn(`[Gemini] No assistant message found, returning raw output`);
  return jsonlOutput;
}

/**
 * Generic command runner (no shell, direct spawn)
 */
export function runCommand(
  command: string,
  args: string[],
  options: CliOptions = {}
): Promise<CliResult> {
  const fullCommand = `${command} ${args.join(" ")}`;

  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, {
      cwd: options.cwd || process.cwd(),
      env: { ...process.env, ...options.env },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    proc.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    const timeout = options.timeout || 300000;
    const timer = setTimeout(() => {
      proc.kill("SIGTERM");
      reject(new Error(`Command timed out after ${timeout}ms`));
    }, timeout);

    proc.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        stdout,
        stderr,
        exitCode: code ?? 1,
        command: fullCommand,
      });
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/**
 * Check if a command is available
 */
export async function isCommandAvailable(command: string): Promise<boolean> {
  try {
    const result = await runCommand("which", [command], { timeout: 5000 });
    return result.exitCode === 0 && result.stdout.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Check if a file exists and is executable
 */
export async function isExecutable(path: string): Promise<boolean> {
  try {
    const result = await runCommand("test", ["-x", path], { timeout: 5000 });
    return result.exitCode === 0;
  } catch {
    return false;
  }
}
