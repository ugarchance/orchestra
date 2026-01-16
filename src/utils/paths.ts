import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { mkdir } from "fs/promises";

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
}
