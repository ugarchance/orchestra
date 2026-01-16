#!/usr/bin/env node

import { Command } from "commander";
import {
  startCommand,
  runCommand,
  statusCommand,
  resumeCommand,
  pauseCommand,
  agentStatusCommand,
  agentDetectCommand,
  execCommand,
} from "./cli/commands.js";

const program = new Command();

program
  .name("orchestra")
  .description("Multi-agent coding orchestration system")
  .version("0.1.0");

// Start command (initialize only)
program
  .command("start")
  .description("Initialize a new orchestra session (without running)")
  .argument("<goal>", "The goal for this session")
  .argument("[project-path]", "Path to the project", ".")
  .option("-c, --max-cycles <number>", "Maximum number of cycles", "20")
  .action(async (goal: string, projectPath: string, options: { maxCycles: string }) => {
    await startCommand(goal, projectPath, {
      maxCycles: parseInt(options.maxCycles, 10),
    });
  });

// Run command (main execution loop)
program
  .command("run")
  .description("Run the orchestra - executes Planner/Worker/Judge cycles")
  .argument("<goal>", "The goal to achieve")
  .argument("[project-path]", "Path to the project", ".")
  .option("-c, --max-cycles <number>", "Maximum number of cycles", "20")
  .option("-w, --max-workers <number>", "Maximum concurrent workers", "3")
  // Model presets
  .option("-d, --default-models", "Skip model selection, use defaults (Sonnet, Medium)")
  .option("-f, --fast", "Fast mode: Haiku, Low reasoning, Gemini Flash")
  .option("-m, --max", "Max mode: Opus, XHigh reasoning")
  // Manual model selection
  .option("--claude <model>", "Claude model: opus, sonnet, haiku")
  .option("--codex <model>", "Codex model: gpt-5.2-codex, gpt-5.1-codex-max, gpt-5.1-codex")
  .option("--reasoning <level>", "Codex reasoning: minimal, low, medium, high, xhigh")
  .option("--gemini <model>", "Gemini model: gemini-3-pro, gemini-3-flash, gemini-2.5-pro, gemini-2.5-flash")
  .action(async (goal: string, projectPath: string, options: {
    maxCycles: string;
    maxWorkers: string;
    defaultModels?: boolean;
    fast?: boolean;
    max?: boolean;
    claude?: string;
    codex?: string;
    reasoning?: string;
    gemini?: string;
  }) => {
    await runCommand(goal, projectPath, {
      maxCycles: parseInt(options.maxCycles, 10),
      maxWorkers: parseInt(options.maxWorkers, 10),
      skipModelSelect: options.defaultModels,
      fast: options.fast,
      max: options.max,
      claudeModel: options.claude as any,
      codexModel: options.codex as any,
      codexReasoning: options.reasoning as any,
      geminiModel: options.gemini as any,
    });
  });

// Status command
program
  .command("status")
  .description("Show session status")
  .argument("[project-path]", "Path to the project", ".")
  .action(async (projectPath: string) => {
    await statusCommand(projectPath);
  });

// Resume command
program
  .command("resume")
  .description("Resume a paused or crashed session")
  .argument("[project-path]", "Path to the project", ".")
  .action(async (projectPath: string) => {
    await resumeCommand(projectPath);
  });

// Pause command
program
  .command("pause")
  .description("Pause a running session")
  .argument("[project-path]", "Path to the project", ".")
  .action(async (projectPath: string) => {
    await pauseCommand(projectPath);
  });

// Agent subcommand
const agentCmd = program
  .command("agent")
  .description("Agent management commands");

agentCmd
  .command("status")
  .description("Show agent pool status")
  .argument("[project-path]", "Path to the project", ".")
  .action(async (projectPath: string) => {
    await agentStatusCommand(projectPath);
  });

agentCmd
  .command("detect")
  .description("Detect available agents on the system")
  .action(async () => {
    await agentDetectCommand();
  });

// Exec command - execute a single task (for testing)
program
  .command("exec")
  .description("Execute a single task with an agent")
  .argument("<task>", "The task description")
  .argument("[project-path]", "Path to the project", ".")
  .action(async (task: string, projectPath: string) => {
    await execCommand(task, projectPath);
  });

// Parse arguments
program.parse();
