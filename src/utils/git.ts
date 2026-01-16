import { execSync } from "child_process";
import logger from "./logger.js";

/**
 * Git system requirements check result
 */
export interface GitCheckResult {
  success: boolean;
  errors: string[];
  warnings: string[];
  instructions: string[];
}

/**
 * Check if git is installed and configured properly
 */
export async function checkGitRequirements(projectPath: string): Promise<GitCheckResult> {
  const result: GitCheckResult = {
    success: true,
    errors: [],
    warnings: [],
    instructions: [],
  };

  // 1. Check if git is installed
  try {
    execSync("git --version", { stdio: "pipe" });
  } catch {
    result.success = false;
    result.errors.push("Git is not installed");
    result.instructions.push("Install git:");
    result.instructions.push("  macOS: brew install git");
    result.instructions.push("  Ubuntu: sudo apt install git");
    result.instructions.push("  Windows: https://git-scm.com/download/win");
    return result;
  }

  // 2. Check if project is a git repository
  try {
    execSync("git rev-parse --git-dir", { cwd: projectPath, stdio: "pipe" });
  } catch {
    result.success = false;
    result.errors.push("Project is not a git repository");
    result.instructions.push("Initialize git repository:");
    result.instructions.push(`  cd ${projectPath}`);
    result.instructions.push("  git init");
    result.instructions.push("  git add .");
    result.instructions.push('  git commit -m "Initial commit"');
    return result;
  }

  // 3. Check if there are uncommitted changes
  try {
    const status = execSync("git status --porcelain", { cwd: projectPath, stdio: "pipe" }).toString();
    if (status.trim().length > 0) {
      result.warnings.push("There are uncommitted changes in the repository");
      result.instructions.push("Commit or stash your changes before running orchestra:");
      result.instructions.push("  git add . && git commit -m 'Save work before orchestra'");
      result.instructions.push("  # or");
      result.instructions.push("  git stash");
    }
  } catch {
    result.warnings.push("Could not check git status");
  }

  // 4. Check if git user is configured
  try {
    execSync("git config user.name", { cwd: projectPath, stdio: "pipe" });
    execSync("git config user.email", { cwd: projectPath, stdio: "pipe" });
  } catch {
    result.success = false;
    result.errors.push("Git user not configured");
    result.instructions.push("Configure git user:");
    result.instructions.push('  git config --global user.name "Your Name"');
    result.instructions.push('  git config --global user.email "your@email.com"');
    return result;
  }

  // 5. Check if worktree is supported (git 2.5+)
  try {
    const version = execSync("git --version", { stdio: "pipe" }).toString();
    const match = version.match(/(\d+)\.(\d+)/);
    if (match) {
      const major = parseInt(match[1], 10);
      const minor = parseInt(match[2], 10);
      if (major < 2 || (major === 2 && minor < 5)) {
        result.success = false;
        result.errors.push(`Git version ${major}.${minor} is too old. Worktree requires git 2.5+`);
        result.instructions.push("Upgrade git to version 2.5 or higher");
      }
    }
  } catch {
    result.warnings.push("Could not determine git version");
  }

  return result;
}

/**
 * Display git check results to user
 */
export function displayGitCheckResult(result: GitCheckResult): void {
  if (result.errors.length > 0) {
    logger.error("Git requirements not met:");
    result.errors.forEach((err) => logger.error(`  - ${err}`));
  }

  if (result.warnings.length > 0) {
    logger.warn("Warnings:");
    result.warnings.forEach((warn) => logger.warn(`  - ${warn}`));
  }

  if (result.instructions.length > 0) {
    console.log("");
    logger.info("To fix, run the following commands:");
    result.instructions.forEach((inst) => console.log(`  ${inst}`));
  }
}
