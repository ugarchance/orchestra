import type {
  AgentType,
  AgentStatus,
  AgentState,
  AgentPool,
  AgentPoolConfig,
  SelectionResult,
} from "../types/index.js";
import { readJson, writeJson } from "../utils/files.js";
import { getProjectPaths, ensureProjectDataDir } from "../utils/paths.js";

/**
 * Create initial agent state
 */
function createInitialAgentState(): AgentState {
  return {
    status: "available",
    available_at: null,
    cooldown_minutes: 0,
    stats: {
      tasks_completed: 0,
      tasks_failed: 0,
      total_errors: 0,
      last_error: null,
      last_error_at: null,
    },
    health: {
      consecutive_failures: 0,
      success_rate: 1.0,
      avg_task_duration_ms: 0,
    },
  };
}

/**
 * Create initial agent pool
 */
export function createInitialAgentPool(): AgentPool {
  const config: AgentPoolConfig = {
    selection_strategy: "round_robin_healthy",
    fallback_order: ["claude", "codex", "opencode"],
    min_available_agents: 1,
    max_consecutive_failures: 3,
    cooldown_multiplier: 1.5,
  };

  return {
    agents: {
      claude: createInitialAgentState(),
      codex: createInitialAgentState(),
      opencode: createInitialAgentState(),
    },
    pool_config: config,
  };
}

/**
 * Load agent pool from disk
 */
export async function loadAgentPool(projectPath: string): Promise<AgentPool> {
  const paths = getProjectPaths(projectPath);
  const pool = await readJson<AgentPool>(paths.agents);
  return pool ?? createInitialAgentPool();
}

/**
 * Save agent pool to disk
 */
export async function saveAgentPool(projectPath: string, pool: AgentPool): Promise<void> {
  const paths = getProjectPaths(projectPath);
  await ensureProjectDataDir(projectPath);
  await writeJson(paths.agents, pool);
}

/**
 * Get an agent's state
 */
export async function getAgentState(
  projectPath: string,
  agent: AgentType
): Promise<AgentState> {
  const pool = await loadAgentPool(projectPath);
  return pool.agents[agent];
}

/**
 * Update an agent's status
 */
export async function updateAgentStatus(
  projectPath: string,
  agent: AgentType,
  status: AgentStatus,
  availableAt?: string | null,
  cooldownMinutes?: number
): Promise<void> {
  const pool = await loadAgentPool(projectPath);
  pool.agents[agent].status = status;

  if (availableAt !== undefined) {
    pool.agents[agent].available_at = availableAt;
  }
  if (cooldownMinutes !== undefined) {
    pool.agents[agent].cooldown_minutes = cooldownMinutes;
  }

  await saveAgentPool(projectPath, pool);
}

/**
 * Mark agent as rate limited
 */
export async function markAgentRateLimited(
  projectPath: string,
  agent: AgentType,
  cooldownMinutes: number = 45
): Promise<void> {
  const pool = await loadAgentPool(projectPath);
  const agentState = pool.agents[agent];

  const availableAt = new Date();
  availableAt.setMinutes(availableAt.getMinutes() + cooldownMinutes);

  agentState.status = "rate_limited";
  agentState.available_at = availableAt.toISOString();
  agentState.cooldown_minutes = cooldownMinutes;
  agentState.stats.last_error = "rate_limit";
  agentState.stats.last_error_at = new Date().toISOString();
  agentState.stats.total_errors++;

  await saveAgentPool(projectPath, pool);
}

/**
 * Mark agent as busy
 */
export async function markAgentBusy(
  projectPath: string,
  agent: AgentType
): Promise<void> {
  await updateAgentStatus(projectPath, agent, "busy");
}

/**
 * Mark agent as available
 */
export async function markAgentAvailable(
  projectPath: string,
  agent: AgentType
): Promise<void> {
  await updateAgentStatus(projectPath, agent, "available", null, 0);
}

/**
 * Record successful task completion
 */
export async function recordAgentSuccess(
  projectPath: string,
  agent: AgentType,
  durationMs: number
): Promise<void> {
  const pool = await loadAgentPool(projectPath);
  const agentState = pool.agents[agent];

  agentState.status = "available";
  agentState.stats.tasks_completed++;
  agentState.health.consecutive_failures = 0;

  // Update success rate
  const total = agentState.stats.tasks_completed + agentState.stats.tasks_failed;
  agentState.health.success_rate = agentState.stats.tasks_completed / total;

  // Update average duration (rolling average)
  const prevAvg = agentState.health.avg_task_duration_ms;
  const count = agentState.stats.tasks_completed;
  agentState.health.avg_task_duration_ms =
    prevAvg === 0 ? durationMs : (prevAvg * (count - 1) + durationMs) / count;

  await saveAgentPool(projectPath, pool);
}

/**
 * Record task failure
 */
export async function recordAgentFailure(
  projectPath: string,
  agent: AgentType,
  errorCategory: string
): Promise<void> {
  const pool = await loadAgentPool(projectPath);
  const agentState = pool.agents[agent];

  agentState.stats.tasks_failed++;
  agentState.stats.total_errors++;
  agentState.stats.last_error = errorCategory as AgentState["stats"]["last_error"];
  agentState.stats.last_error_at = new Date().toISOString();
  agentState.health.consecutive_failures++;

  // Update success rate
  const total = agentState.stats.tasks_completed + agentState.stats.tasks_failed;
  agentState.health.success_rate = agentState.stats.tasks_completed / total;

  // Check if should disable
  if (agentState.health.consecutive_failures >= pool.pool_config.max_consecutive_failures) {
    agentState.status = "errored";
  } else {
    agentState.status = "available";
  }

  await saveAgentPool(projectPath, pool);
}

/**
 * Get available agents
 */
export async function getAvailableAgents(projectPath: string): Promise<AgentType[]> {
  const pool = await loadAgentPool(projectPath);
  return (Object.keys(pool.agents) as AgentType[]).filter(
    (agent) => pool.agents[agent].status === "available"
  );
}

/**
 * Check and update agents that have completed their cooldown
 */
export async function refreshAgentCooldowns(projectPath: string): Promise<AgentType[]> {
  const pool = await loadAgentPool(projectPath);
  const now = new Date();
  const refreshed: AgentType[] = [];

  for (const agent of Object.keys(pool.agents) as AgentType[]) {
    const agentState = pool.agents[agent];

    if (
      agentState.status === "rate_limited" &&
      agentState.available_at &&
      new Date(agentState.available_at) <= now
    ) {
      agentState.status = "available";
      agentState.available_at = null;
      agentState.cooldown_minutes = 0;
      refreshed.push(agent);
    }
  }

  if (refreshed.length > 0) {
    await saveAgentPool(projectPath, pool);
  }

  return refreshed;
}

/**
 * Select an agent for a task
 */
export async function selectAgent(projectPath: string): Promise<SelectionResult> {
  // First, refresh any agents that have completed cooldown
  await refreshAgentCooldowns(projectPath);

  const pool = await loadAgentPool(projectPath);

  // Get available agents
  const available = (Object.keys(pool.agents) as AgentType[]).filter(
    (agent) => pool.agents[agent].status === "available"
  );

  if (available.length > 0) {
    // Select by health score (success_rate / avg_duration)
    const sorted = available.sort((a, b) => {
      const stateA = pool.agents[a];
      const stateB = pool.agents[b];

      const scoreA =
        stateA.health.success_rate *
        (1 / (stateA.health.avg_task_duration_ms || 1));
      const scoreB =
        stateB.health.success_rate *
        (1 / (stateB.health.avg_task_duration_ms || 1));

      return scoreB - scoreA;
    });

    return { type: "selected", agent: sorted[0] };
  }

  // Check rate-limited agents
  const rateLimited = (Object.keys(pool.agents) as AgentType[]).filter(
    (agent) => pool.agents[agent].status === "rate_limited"
  );

  if (rateLimited.length > 0) {
    // Find soonest available
    const sorted = rateLimited.sort((a, b) => {
      const timeA = new Date(pool.agents[a].available_at ?? 0);
      const timeB = new Date(pool.agents[b].available_at ?? 0);
      return timeA.getTime() - timeB.getTime();
    });

    const soonest = sorted[0];
    const soonestState = pool.agents[soonest];

    return {
      type: "wait",
      until: new Date(soonestState.available_at ?? new Date()),
      reason: `All agents rate limited. ${soonest} available in ${soonestState.cooldown_minutes} min`,
    };
  }

  // All agents exhausted or disabled
  return {
    type: "pause",
    reason: "All agents exhausted or disabled. System paused.",
  };
}

/**
 * Reset agent pool (for resume after crash)
 */
export async function resetAgentPool(projectPath: string): Promise<void> {
  const pool = await loadAgentPool(projectPath);

  for (const agent of Object.keys(pool.agents) as AgentType[]) {
    const agentState = pool.agents[agent];

    // Reset busy agents (were working when crashed)
    if (agentState.status === "busy") {
      agentState.status = "available";
    }

    // Check if rate-limited agents are now available
    if (
      agentState.status === "rate_limited" &&
      agentState.available_at &&
      new Date(agentState.available_at) <= new Date()
    ) {
      agentState.status = "available";
      agentState.available_at = null;
      agentState.cooldown_minutes = 0;
    }
  }

  await saveAgentPool(projectPath, pool);
}
