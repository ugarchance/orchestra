import chalk from "chalk";

export type LogLevel = "debug" | "info" | "warn" | "error" | "success";

const LOG_COLORS = {
  debug: chalk.gray,
  info: chalk.blue,
  warn: chalk.yellow,
  error: chalk.red,
  success: chalk.green,
};

const LOG_PREFIXES = {
  debug: "DEBUG",
  info: "INFO",
  warn: "WARN",
  error: "ERROR",
  success: "OK",
};

function timestamp(): string {
  return new Date().toISOString().slice(11, 19);
}

function formatMessage(level: LogLevel, message: string): string {
  const color = LOG_COLORS[level];
  const prefix = LOG_PREFIXES[level];
  return `${chalk.dim(timestamp())} ${color(`[${prefix}]`)} ${message}`;
}

export const logger = {
  debug(message: string): void {
    console.log(formatMessage("debug", message));
  },

  info(message: string): void {
    console.log(formatMessage("info", message));
  },

  warn(message: string): void {
    console.log(formatMessage("warn", message));
  },

  error(message: string): void {
    console.error(formatMessage("error", message));
  },

  success(message: string): void {
    console.log(formatMessage("success", message));
  },

  // Formatted section header
  section(title: string): void {
    console.log("");
    console.log(chalk.bold.cyan(`=== ${title} ===`));
    console.log("");
  },

  // Agent status with emoji
  agentStatus(name: string, status: string, detail?: string): void {
    const statusIcons: Record<string, string> = {
      available: chalk.green("✅"),
      busy: chalk.yellow("⏳"),
      rate_limited: chalk.red("⚠️"),
      errored: chalk.red("❌"),
      exhausted: chalk.gray("💤"),
      disabled: chalk.gray("⛔"),
    };
    const icon = statusIcons[status] || "❓";
    const detailStr = detail ? chalk.dim(` (${detail})`) : "";
    console.log(`  ${icon} ${chalk.bold(name)}: ${status}${detailStr}`);
  },

  // Task progress
  taskProgress(completed: number, total: number, failed: number): void {
    const pending = total - completed - failed;
    console.log(
      `Tasks: ${chalk.green(completed)} completed, ` +
      `${chalk.red(failed)} failed, ` +
      `${chalk.yellow(pending)} pending`
    );
  },

  // Raw output (no formatting)
  raw(message: string): void {
    console.log(message);
  },
};

export default logger;
