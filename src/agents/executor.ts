import type { AgentType, Task, ErrorInfo } from "../types/index.js";
import {
  BaseAgentExecutor,
  type ExecutionContext,
  type ExecutionResult,
  isCommandAvailable,
} from "./base.js";
import { ClaudeExecutor, isClaudeRateLimited } from "./claude.js";
import { CodexExecutor, isCodexRateLimited } from "./codex.js";
import { OpenCodeExecutor, isOpenCodeRateLimited } from "./opencode.js";
import {
  selectAgent,
  markAgentBusy,
  markAgentAvailable,
  markAgentRateLimited,
  recordAgentSuccess,
  recordAgentFailure,
  loadAgentPool,
  saveAgentPool,
} from "../core/agents.js";
import { detectError, createErrorInfo, shouldReassign } from "../core/errors.js";
import logger from "../utils/logger.js";

/**
 * Agent executor manager
 * Handles agent selection, execution, and failover
 */
export class AgentExecutorManager {
  private executors: Map<AgentType, BaseAgentExecutor> = new Map();
  private projectPath: string;
  private availableAgents: AgentType[] = [];

  constructor(projectPath: string, timeout: number = 300000) {
    this.projectPath = projectPath;

    // Initialize executors for each agent type
    this.executors.set("claude", new ClaudeExecutor(projectPath, timeout));
    this.executors.set("codex", new CodexExecutor(projectPath, timeout));
    this.executors.set("opencode", new OpenCodeExecutor(projectPath, timeout));
  }

  /**
   * Check which agents are available on the system
   * Also updates agent pool to disable unavailable agents
   */
  async detectAvailableAgents(): Promise<AgentType[]> {
    const agents: AgentType[] = ["claude", "codex", "opencode"];
    const available: AgentType[] = [];

    for (const agent of agents) {
      let command: string;

      // Claude might be installed in a custom location
      if (agent === "claude") {
        const claudePath = process.env.CLAUDE_PATH ||
          `${process.env.HOME}/.claude/local/claude`;
        command = claudePath;
      } else {
        command = agent;
      }

      if (await isCommandAvailable(command)) {
        available.push(agent);
        logger.info(`Agent detected: ${agent}`);
        // Ensure agent is available in pool
        await markAgentAvailable(this.projectPath, agent);
      } else {
        logger.warn(`Agent not found: ${agent}`);
        // Disable agent in pool
        await this.disableAgent(agent);
      }
    }

    this.availableAgents = available;
    return available;
  }

  /**
   * Disable an agent (mark as disabled in pool)
   */
  private async disableAgent(agent: AgentType): Promise<void> {
    try {
      const pool = await loadAgentPool(this.projectPath);
      pool.agents[agent].status = "disabled";
      await saveAgentPool(this.projectPath, pool);
    } catch {
      // Pool might not exist yet, ignore
    }
  }

  /**
   * Execute a task with automatic agent selection and failover
   */
  async executeTask(
    task: Task,
    context: ExecutionContext
  ): Promise<{
    result: ExecutionResult;
    agent: AgentType;
    error?: ErrorInfo;
  }> {
    // Select an agent
    const selection = await selectAgent(this.projectPath);

    if (selection.type === "wait") {
      logger.warn(`No agents available. ${selection.reason}`);
      throw new Error(selection.reason);
    }

    if (selection.type === "pause") {
      logger.error(`System paused: ${selection.reason}`);
      throw new Error(selection.reason);
    }

    const agent = selection.agent;
    const executor = this.executors.get(agent);

    if (!executor) {
      throw new Error(`No executor found for agent: ${agent}`);
    }

    // Mark agent as busy
    await markAgentBusy(this.projectPath, agent);
    logger.info(`Selected agent: ${agent}`);

    try {
      // Execute the task
      const result = await executor.execute(task, context);

      if (result.success) {
        // Record success
        await recordAgentSuccess(this.projectPath, agent, result.durationMs);
        await markAgentAvailable(this.projectPath, agent);

        return { result, agent };
      } else {
        // Handle failure
        const errorCategory = result.error?.category || "unknown";
        const errorInfo = createErrorInfo(
          errorCategory,
          result.error?.message || "Unknown error",
          agent,
          result.output.slice(-500)
        );

        // Check for rate limit
        if (this.isRateLimited(agent, result.output)) {
          const cooldown = this.getCooldownMinutes(agent);
          await markAgentRateLimited(this.projectPath, agent, cooldown);
          logger.warn(`Agent ${agent} rate limited. Cooldown: ${cooldown} minutes`);

          // Try failover to another agent
          if (shouldReassign(errorCategory, task.agent_history.length)) {
            return this.failoverExecution(task, context, agent, errorInfo);
          }
        } else {
          await recordAgentFailure(this.projectPath, agent, errorCategory);
          await markAgentAvailable(this.projectPath, agent);
        }

        return { result, agent, error: errorInfo };
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const errorCategory = detectError(message, 1);

      await recordAgentFailure(this.projectPath, agent, errorCategory);
      await markAgentAvailable(this.projectPath, agent);

      const errorInfo = createErrorInfo(errorCategory, message, agent, "");

      return {
        result: {
          success: false,
          output: message,
          error: { category: errorCategory, message },
          exitCode: 1,
          durationMs: 0,
        },
        agent,
        error: errorInfo,
      };
    }
  }

  /**
   * Attempt failover to another agent
   */
  private async failoverExecution(
    task: Task,
    context: ExecutionContext,
    failedAgent: AgentType,
    originalError: ErrorInfo
  ): Promise<{
    result: ExecutionResult;
    agent: AgentType;
    error?: ErrorInfo;
  }> {
    logger.info(`Attempting failover from ${failedAgent}...`);

    // Select next agent
    const selection = await selectAgent(this.projectPath);

    if (selection.type !== "selected") {
      logger.warn("No other agents available for failover");
      return {
        result: {
          success: false,
          output: "Failover failed: no available agents",
          error: originalError,
          exitCode: 1,
          durationMs: 0,
        },
        agent: failedAgent,
        error: originalError,
      };
    }

    const newAgent = selection.agent;
    logger.info(`Failing over to: ${newAgent}`);

    // Recursively try with new agent
    return this.executeTask(task, context);
  }

  /**
   * Check if output indicates rate limiting
   */
  private isRateLimited(agent: AgentType, output: string): boolean {
    switch (agent) {
      case "claude":
        return isClaudeRateLimited(output);
      case "codex":
        return isCodexRateLimited(output);
      case "opencode":
        return isOpenCodeRateLimited(output);
      default:
        return false;
    }
  }

  /**
   * Get cooldown minutes for an agent
   */
  private getCooldownMinutes(agent: AgentType): number {
    // Default cooldowns based on typical rate limit windows
    const cooldowns: Record<AgentType, number> = {
      claude: 45,
      codex: 30,
      opencode: 30,
    };
    return cooldowns[agent];
  }

  /**
   * Get executor for a specific agent
   */
  getExecutor(agent: AgentType): BaseAgentExecutor | undefined {
    return this.executors.get(agent);
  }

  /**
   * Check if any agents are available
   */
  hasAvailableAgents(): boolean {
    return this.availableAgents.length > 0;
  }
}

/**
 * Create an executor manager for a project
 */
export function createExecutorManager(
  projectPath: string,
  timeout?: number
): AgentExecutorManager {
  return new AgentExecutorManager(projectPath, timeout);
}
