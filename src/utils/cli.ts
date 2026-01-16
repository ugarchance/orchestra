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
 * Execute Claude CLI with a prompt
 * Uses stdin to avoid shell escaping issues
 */
export async function runClaude(
  prompt: string,
  options: CliOptions = {}
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
  options: CliOptions = {}
): Promise<CliResult> {
  const cwd = options.cwd || process.cwd();

  // Save prompt for debugging
  await savePrompt(cwd, "codex", prompt);

  // codex exec ... - : "-" at end means read prompt from stdin
  const args = [
    "exec",
    "--full-auto",
    "--json",
    "--skip-git-repo-check",
    "-"  // Read from stdin
  ];

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
 * Codex outputs multiple JSON lines, we want the item.completed text
 */
function extractCodexResult(jsonlOutput: string): string {
  logger.debug(`[Codex] Raw output (${jsonlOutput.length} chars):`);
  logger.debug(`[Codex] ${jsonlOutput.slice(0, 500)}...`);

  const lines = jsonlOutput.trim().split("\n");

  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      if (parsed.type === "item.completed" && parsed.item?.text) {
        logger.info(`[Codex] Extracted result (${parsed.item.text.length} chars)`);
        logger.debug(`[Codex] Result preview: ${parsed.item.text.slice(0, 300)}...`);
        return parsed.item.text;
      }
    } catch {
      // Skip non-JSON lines
    }
  }

  // Fallback: return raw output
  logger.warn(`[Codex] Could not extract result, returning raw output`);
  return jsonlOutput;
}

/**
 * Execute OpenCode CLI with a prompt
 * opencode run --format json "prompt"
 */
export async function runOpenCode(
  prompt: string,
  options: CliOptions = {}
): Promise<CliResult> {
  const cwd = options.cwd || process.cwd();

  // Save prompt for debugging
  await savePrompt(cwd, "opencode", prompt);

  // opencode run --format json "prompt"
  const args = [
    "run",
    "--format", "json",
    prompt
  ];

  const command = `opencode run --format json "..."`;
  logger.debug(`[CLI] Running: ${command}`);
  logger.debug(`[CLI] Prompt length: ${prompt.length} chars`);

  return new Promise((resolve, reject) => {
    const proc = spawn("opencode", args, {
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
      const extracted = extractOpenCodeResult(stdout);

      // Save response for debugging
      await saveResponse(cwd, "opencode", rawOutput, extracted);

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
 * Extract actual result from OpenCode JSONL output
 * OpenCode outputs: {"type":"text","part":{"text":"actual_response",...}}
 */
function extractOpenCodeResult(jsonlOutput: string): string {
  logger.debug(`[OpenCode] Raw output (${jsonlOutput.length} chars):`);
  logger.debug(`[OpenCode] ${jsonlOutput.slice(0, 500)}...`);

  const lines = jsonlOutput.trim().split("\n");

  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      if (parsed.type === "text" && parsed.part?.text) {
        logger.info(`[OpenCode] Extracted result (${parsed.part.text.length} chars)`);
        logger.debug(`[OpenCode] Result preview: ${parsed.part.text.slice(0, 300)}...`);
        return parsed.part.text;
      }
    } catch {
      // Skip non-JSON lines
    }
  }

  // Fallback: return raw output
  logger.warn(`[OpenCode] Could not extract result, returning raw output`);
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
