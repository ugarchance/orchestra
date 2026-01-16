import * as readline from "readline/promises";
import chalk from "chalk";
import type {
  ModelConfig,
  ClaudeModel,
  CodexModel,
  CodexReasoningLevel,
  GeminiModel,
} from "../types/index.js";

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

/**
 * Prompt user to select from a list of options
 */
async function selectOption<T extends string>(
  question: string,
  options: { value: T; label: string }[]
): Promise<T> {
  console.log("");
  console.log(chalk.bold(question));
  options.forEach((opt, i) => {
    console.log(`  ${chalk.cyan(i + 1)}. ${opt.label}`);
  });

  while (true) {
    const answer = await rl.question(chalk.dim("  Select (1-" + options.length + "): "));
    const num = parseInt(answer.trim(), 10);
    if (num >= 1 && num <= options.length) {
      return options[num - 1].value;
    }
    console.log(chalk.red("  Invalid selection, try again."));
  }
}

/**
 * Ask yes/no question
 */
export async function askYesNo(question: string, defaultYes: boolean = true): Promise<boolean> {
  const hint = defaultYes ? "[Y/n]" : "[y/N]";
  const answer = await rl.question(`${question} ${chalk.dim(hint)}: `);
  const trimmed = answer.trim().toLowerCase();

  if (trimmed === "") return defaultYes;
  return trimmed === "y" || trimmed === "yes";
}

/**
 * Claude model options
 */
const CLAUDE_MODELS: { value: ClaudeModel; label: string }[] = [
  { value: "opus", label: "Opus 4.5 - Most capable for complex work" },
  { value: "sonnet", label: "Sonnet 4.5 - Best for everyday tasks" },
  { value: "haiku", label: "Haiku 4.5 - Fastest for quick answers" },
];

/**
 * Codex model options
 */
const CODEX_MODELS: { value: CodexModel; label: string }[] = [
  { value: "gpt-5.2-codex", label: "GPT-5.2 Codex - Latest and most capable" },
  { value: "gpt-5.1-codex-max", label: "GPT-5.1 Codex Max - High performance" },
  { value: "gpt-5.1-codex", label: "GPT-5.1 Codex - Balanced" },
];

/**
 * Codex reasoning level options
 */
const CODEX_REASONING_LEVELS: { value: CodexReasoningLevel; label: string }[] = [
  { value: "minimal", label: "Minimal - Fastest responses" },
  { value: "low", label: "Low - Light reasoning" },
  { value: "medium", label: "Medium - Balanced (default)" },
  { value: "high", label: "High - Deep reasoning" },
  { value: "xhigh", label: "Extra High - Maximum reasoning depth" },
];

/**
 * Gemini model options
 */
const GEMINI_MODELS: { value: GeminiModel; label: string }[] = [
  { value: "gemini-3-pro-preview", label: "Gemini 3 Pro (Preview) - Most capable" },
  { value: "gemini-3-flash-preview", label: "Gemini 3 Flash (Preview) - Fast & efficient" },
  { value: "gemini-2.5-pro", label: "Gemini 2.5 Pro - Stable, balanced" },
  { value: "gemini-2.5-flash", label: "Gemini 2.5 Flash - Stable, quick" },
];

/**
 * Prompt user for model configuration
 */
export async function promptModelConfig(
  availableAgents: ("claude" | "codex" | "gemini")[]
): Promise<ModelConfig> {
  const config: ModelConfig = {};

  console.log("");
  console.log(chalk.bold.blue("═══════════════════════════════════════════"));
  console.log(chalk.bold.blue("         Model Configuration"));
  console.log(chalk.bold.blue("═══════════════════════════════════════════"));

  // Claude
  if (availableAgents.includes("claude")) {
    console.log("");
    console.log(chalk.bold.green("Claude CLI"));
    const model = await selectOption("Select Claude model:", CLAUDE_MODELS);
    config.claude = { model };
    console.log(chalk.dim(`  → Using: ${model}`));
  }

  // Codex
  if (availableAgents.includes("codex")) {
    console.log("");
    console.log(chalk.bold.green("Codex CLI"));
    const model = await selectOption("Select Codex model:", CODEX_MODELS);
    const reasoningLevel = await selectOption("Select reasoning level:", CODEX_REASONING_LEVELS);
    config.codex = { model, reasoningLevel };
    console.log(chalk.dim(`  → Using: ${model} with ${reasoningLevel} reasoning`));
  }

  // Gemini
  if (availableAgents.includes("gemini")) {
    console.log("");
    console.log(chalk.bold.green("Gemini CLI"));
    const model = await selectOption("Select Gemini model:", GEMINI_MODELS);
    config.gemini = { model };
    console.log(chalk.dim(`  → Using: ${model}`));
  }

  console.log("");
  console.log(chalk.bold.blue("═══════════════════════════════════════════"));

  return config;
}

/**
 * Close readline interface
 */
export function closePrompts(): void {
  rl.close();
}

/**
 * Skip model selection and use defaults (balanced)
 */
export function getDefaultModelConfig(): ModelConfig {
  return {
    claude: { model: "sonnet" },
    codex: { model: "gpt-5.2-codex", reasoningLevel: "medium" },
    gemini: { model: "gemini-3-flash-preview" },
  };
}

/**
 * Fast mode - uses faster/cheaper models
 * Good for quick iterations and testing
 */
export function getFastModelConfig(): ModelConfig {
  return {
    claude: { model: "haiku" },
    codex: { model: "gpt-5.2-codex", reasoningLevel: "low" },
    gemini: { model: "gemini-3-flash-preview" },
  };
}

/**
 * Max mode - uses most capable models
 * Best for complex tasks requiring deep reasoning
 */
export function getMaxModelConfig(): ModelConfig {
  return {
    claude: { model: "opus" },
    codex: { model: "gpt-5.2-codex", reasoningLevel: "xhigh" },
    gemini: { model: "gemini-3-pro-preview" },
  };
}
