# Orchestra

Multi-agent coding orchestration system using CLI tools (Claude, Codex, OpenCode).

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      ORCHESTRA                               │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│   ┌─────────┐     ┌─────────┐     ┌─────────┐              │
│   │ PLANNER │────▶│ WORKERS │────▶│  JUDGE  │              │
│   └─────────┘     └─────────┘     └─────────┘              │
│        │               │               │                    │
│        │          ┌────┴────┐          │                    │
│        │          │         │          │                    │
│        ▼          ▼         ▼          ▼                    │
│   ┌─────────┐ ┌───────┐ ┌───────┐ ┌─────────┐             │
│   │  Tasks  │ │Claude │ │ Codex │ │OpenCode │             │
│   │  Queue  │ │  CLI  │ │  CLI  │ │   CLI   │             │
│   └─────────┘ └───────┘ └───────┘ └─────────┘             │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

## Prerequisites

At least one of these CLI tools must be installed:

### Claude CLI
```bash
# Install from Anthropic
npm install -g @anthropic-ai/claude-code

# Or if installed locally
export CLAUDE_PATH="$HOME/.claude/local/claude"
```

### Codex CLI (OpenAI)
```bash
# Install Codex
npm install -g @openai/codex
```

### OpenCode CLI
```bash
# Install OpenCode
npm install -g opencode
```

## Installation

```bash
# Clone the repository
git clone <repo-url>
cd orchestra

# Install dependencies
npm install

# Build
npm run build

# Link globally (optional)
npm link
```

## Usage

### Basic Usage

```bash
# Run with a goal
orchestra run "Build a todo list app with React"

# With options
orchestra run "Fix the login bug" --max-cycles 10 --max-workers 5

# Verbose mode
orchestra run "Add dark mode" --verbose
```

### Options

| Option | Default | Description |
|--------|---------|-------------|
| `--max-cycles` | 20 | Maximum planning cycles |
| `--max-workers` | 3 | Parallel worker count |
| `--timeout` | 600000 | Timeout per task (ms) |
| `--verbose` | false | Enable debug logging |

## How It Works

### 1. Planner Phase
- Analyzes the goal and codebase
- Creates well-defined tasks for workers
- Does NOT write code itself

### 2. Worker Phase
- Workers claim tasks from queue
- Execute tasks using available CLI tools (Claude/Codex/OpenCode)
- Commit changes after completion
- Run in parallel (up to `maxWorkers`)

### 3. Judge Phase
- Evaluates cycle progress
- Decides: `CONTINUE`, `COMPLETE`, or `ABORT`
- Provides recommendations for next cycle

## Project Structure

```
.orchestra/                 # Orchestra state (in your project)
├── agents.json            # Agent pool state
├── tasks.json             # Task queue
├── logs/                  # Log files
└── prompts/               # Saved prompts & responses
    ├── claude-*-prompt.txt
    ├── claude-*-raw.txt
    ├── claude-*-response.txt
    ├── codex-*-prompt.txt
    └── ...

orchestra/                  # Orchestra source code
├── src/
│   ├── agents/            # Agent executors
│   │   ├── base.ts        # Base executor class
│   │   ├── claude.ts      # Claude CLI executor
│   │   ├── codex.ts       # Codex CLI executor
│   │   ├── opencode.ts    # OpenCode CLI executor
│   │   ├── executor.ts    # Agent manager & failover
│   │   └── prompts.ts     # Prompt templates
│   ├── core/
│   │   ├── orchestrator.ts # Main orchestration loop
│   │   ├── planner.ts     # Planner runner
│   │   ├── judge.ts       # Judge runner
│   │   ├── tasks.ts       # Task management
│   │   ├── state.ts       # State management
│   │   ├── agents.ts      # Agent pool management
│   │   ├── events.ts      # Event bus & wake-up
│   │   └── errors.ts      # Error handling
│   ├── utils/
│   │   ├── cli.ts         # CLI execution utilities
│   │   └── logger.ts      # Logging
│   ├── types/
│   │   └── index.ts       # TypeScript types
│   └── cli/
│       └── index.ts       # CLI entry point
└── dist/                  # Compiled output
```

## Agent Selection & Failover

Orchestra automatically:
1. Detects available CLI tools
2. Selects the best available agent
3. Handles rate limits with cooldowns
4. Fails over to another agent if one fails

Priority: `claude` → `codex` → `opencode`

## Debugging

### View Prompts & Responses

All prompts and responses are saved in `.orchestra/prompts/`:

```bash
# View latest prompt sent to Claude
cat .orchestra/prompts/claude-*-prompt.txt | tail -1

# View raw CLI output
cat .orchestra/prompts/claude-*-raw.txt

# View extracted response
cat .orchestra/prompts/claude-*-response.txt
```

### View Tasks

```bash
# View all tasks
cat .orchestra/tasks.json | jq .

# View completed tasks
cat .orchestra/tasks.json | jq '.[] | select(.status == "completed")'
```

### View Logs

```bash
# View logs
cat .orchestra/logs/*.log
```

## Configuration

### Environment Variables

```bash
# Custom Claude path
export CLAUDE_PATH="$HOME/.claude/local/claude"

# Custom timeouts (ms)
export ORCHESTRA_TIMEOUT=600000
```

## Anti-Laziness Prompts

Orchestra uses aggressive anti-laziness prompts to ensure agents complete tasks fully:

- "Do NOT stop halfway"
- "Do NOT leave TODOs or placeholder code"
- "Do NOT say 'the user can finish this'"
- "You GRIND until the task is DONE"

Based on learnings from [Cursor's scaling-agents research](https://cursor.com/blog/scaling-agents).

## License

MIT
