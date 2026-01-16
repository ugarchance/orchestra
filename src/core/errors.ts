import type { ErrorCategory, ErrorHandler, ErrorInfo, AgentType } from "../types/index.js";

/**
 * Error handlers configuration based on PLAN-v3
 */
export const ERROR_HANDLERS: Record<ErrorCategory, ErrorHandler> = {
  rate_limit: {
    category: "rate_limit",
    retry: false,
    cooldown_minutes: 45,
    max_retries: 0,
    fallback_to_other_agent: true,
    action: "reassign",
  },
  timeout: {
    category: "timeout",
    retry: true,
    cooldown_minutes: 0,
    max_retries: 2,
    fallback_to_other_agent: true,
    action: "retry",
  },
  crash: {
    category: "crash",
    retry: true,
    cooldown_minutes: 1,
    max_retries: 3,
    fallback_to_other_agent: true,
    action: "retry",
  },
  invalid_output: {
    category: "invalid_output",
    retry: true,
    cooldown_minutes: 0,
    max_retries: 2,
    fallback_to_other_agent: false,
    action: "retry",
  },
  git_conflict: {
    category: "git_conflict",
    retry: true,
    cooldown_minutes: 0,
    max_retries: 2,
    fallback_to_other_agent: false,
    action: "retry",
  },
  permission: {
    category: "permission",
    retry: false,
    cooldown_minutes: 0,
    max_retries: 0,
    fallback_to_other_agent: false,
    action: "fail",
  },
  network: {
    category: "network",
    retry: true,
    cooldown_minutes: 0.5, // 30 seconds
    max_retries: 5,
    fallback_to_other_agent: false,
    action: "retry",
  },
  unknown: {
    category: "unknown",
    retry: true,
    cooldown_minutes: 1,
    max_retries: 1,
    fallback_to_other_agent: true,
    action: "retry",
  },
};

/**
 * Detect error category from CLI output and exit code
 */
export function detectError(output: string, exitCode: number): ErrorCategory {
  const lowerOutput = output.toLowerCase();

  // Rate limit patterns
  if (
    lowerOutput.includes("rate limit") ||
    lowerOutput.includes("too many requests") ||
    lowerOutput.includes("quota exceeded") ||
    lowerOutput.includes("429") ||
    lowerOutput.includes("rate_limit") ||
    lowerOutput.includes("ratelimit")
  ) {
    return "rate_limit";
  }

  // Timeout patterns
  if (exitCode === 124 || lowerOutput.includes("timed out") || lowerOutput.includes("timeout")) {
    return "timeout";
  }

  // Permission patterns
  if (
    lowerOutput.includes("permission denied") ||
    lowerOutput.includes("eacces") ||
    lowerOutput.includes("access denied") ||
    lowerOutput.includes("unauthorized")
  ) {
    return "permission";
  }

  // Network patterns
  if (
    lowerOutput.includes("enotfound") ||
    lowerOutput.includes("econnrefused") ||
    lowerOutput.includes("econnreset") ||
    lowerOutput.includes("network error") ||
    lowerOutput.includes("connection refused") ||
    lowerOutput.includes("fetch failed")
  ) {
    return "network";
  }

  // Git conflict patterns
  if (
    lowerOutput.includes("conflict") ||
    lowerOutput.includes("merge conflict") ||
    lowerOutput.includes("cannot merge")
  ) {
    return "git_conflict";
  }

  // Crash (non-zero exit with no clear error)
  if (exitCode !== 0 && !lowerOutput.includes("error")) {
    return "crash";
  }

  // Unknown error
  return "unknown";
}

/**
 * Try to parse JSON from output, return category if fails
 */
export function validateJsonOutput(output: string): ErrorCategory | null {
  try {
    // Find JSON in output (may have other text)
    const jsonMatch = output.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return "invalid_output";
    }
    JSON.parse(jsonMatch[0]);
    return null; // Valid JSON
  } catch {
    return "invalid_output";
  }
}

/**
 * Create an ErrorInfo object
 */
export function createErrorInfo(
  category: ErrorCategory,
  message: string,
  agent: AgentType,
  outputSnippet: string = ""
): ErrorInfo {
  return {
    category,
    message,
    occurred_at: new Date().toISOString(),
    agent,
    output_snippet: outputSnippet.slice(0, 500), // Limit snippet size
  };
}

/**
 * Get handler for an error category
 */
export function getErrorHandler(category: ErrorCategory): ErrorHandler {
  return ERROR_HANDLERS[category];
}

/**
 * Determine if a task should be retried based on error and attempts
 */
export function shouldRetry(
  category: ErrorCategory,
  attempts: number,
  maxAttempts: number
): boolean {
  const handler = ERROR_HANDLERS[category];

  if (!handler.retry) {
    return false;
  }

  return attempts < maxAttempts && attempts <= handler.max_retries;
}

/**
 * Determine if task should be reassigned to different agent
 */
export function shouldReassign(
  category: ErrorCategory,
  agentHistoryLength: number
): boolean {
  const handler = ERROR_HANDLERS[category];

  // Don't reassign more than 3 times
  if (agentHistoryLength >= 3) {
    return false;
  }

  return handler.fallback_to_other_agent;
}

/**
 * Extract relevant error snippet from output
 */
export function extractErrorSnippet(output: string): string {
  // Look for common error indicators
  const errorPatterns = [
    /error[:\s].*$/im,
    /exception[:\s].*$/im,
    /failed[:\s].*$/im,
    /fatal[:\s].*$/im,
  ];

  for (const pattern of errorPatterns) {
    const match = output.match(pattern);
    if (match) {
      return match[0];
    }
  }

  // Return last 200 chars if no pattern found
  return output.slice(-200);
}
