#!/usr/bin/env node

import { Command } from "commander";
import {
  startCommand,
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

// Start command
program
  .command("start")
  .description("Start a new orchestra session")
  .argument("<goal>", "The goal for this session")
  .argument("[project-path]", "Path to the project", ".")
  .option("-c, --max-cycles <number>", "Maximum number of cycles", "20")
  .action(async (goal: string, projectPath: string, options: { maxCycles: string }) => {
    await startCommand(goal, projectPath, {
      maxCycles: parseInt(options.maxCycles, 10),
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
