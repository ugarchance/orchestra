import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { mkdir, readFile, writeFile, access } from "fs/promises";

// Get the directory where orchestra is installed
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Root of orchestra project
export const ORCHESTRA_ROOT = join(__dirname, "..", "..");

// Data directory for runtime state
export const DATA_DIR = join(ORCHESTRA_ROOT, "data");

// File paths
export const PATHS = {
  state: join(DATA_DIR, "state.json"),
  tasks: join(DATA_DIR, "tasks.json"),
  agents: join(DATA_DIR, "agents.json"),
  config: join(ORCHESTRA_ROOT, "orchestra.config.json"),
};

// Ensure data directory exists
export async function ensureDataDir(): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
}

// Get project-specific data directory
export function getProjectDataDir(projectPath: string): string {
  return join(projectPath, ".orchestra");
}

// Get project-specific file paths
export function getProjectPaths(projectPath: string) {
  const dataDir = getProjectDataDir(projectPath);
  return {
    dataDir,
    state: join(dataDir, "state.json"),
    tasks: join(dataDir, "tasks.json"),
    agents: join(dataDir, "agents.json"),
    logs: join(dataDir, "logs"),
  };
}

// Ensure project data directory exists
export async function ensureProjectDataDir(projectPath: string): Promise<void> {
  const { dataDir, logs } = getProjectPaths(projectPath);
  await mkdir(dataDir, { recursive: true });
  await mkdir(logs, { recursive: true });

  // Add .orchestra/ to .gitignore if not already there
  await ensureGitignore(projectPath);
}

// Ensure .orchestra/ is in .gitignore and commit it
async function ensureGitignore(projectPath: string): Promise<void> {
  const gitignorePath = join(projectPath, ".gitignore");
  const orchestraEntry = ".orchestra/";

  try {
    // Check if .gitignore exists
    let content = "";
    let existed = false;
    try {
      await access(gitignorePath);
      content = await readFile(gitignorePath, "utf-8");
      existed = true;
    } catch {
      // .gitignore doesn't exist, will create it
    }

    // Check if .orchestra/ is already in gitignore
    const lines = content.split("\n").map((l) => l.trim());
    if (!lines.includes(orchestraEntry) && !lines.includes(".orchestra")) {
      // Add .orchestra/ to gitignore
      const newContent = content.trim()
        ? `${content.trim()}\n\n# Orchestra session data\n${orchestraEntry}\n`
        : `# Orchestra session data\n${orchestraEntry}\n`;

      await writeFile(gitignorePath, newContent, "utf-8");

      // Commit the .gitignore change (but don't push)
      const { execSync } = await import("child_process");
      try {
        execSync("git add .gitignore", { cwd: projectPath, stdio: "pipe" });
        const msg = existed ? "Update .gitignore: add .orchestra/" : "Add .gitignore with .orchestra/";
        execSync(`git commit -m "${msg}"`, { cwd: projectPath, stdio: "pipe" });
      } catch {
        // Commit might fail if nothing to commit, that's OK
      }
    }
  } catch {
    // Ignore errors - gitignore is nice-to-have
  }
}
