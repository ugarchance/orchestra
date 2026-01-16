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
# Interactive model selection
orchestra run "Build a todo list app with React"

# Fast mode (quick iterations)
orchestra run "Fix the login bug" --fast

# Max mode (complex tasks)
orchestra run "Refactor authentication system" --max

# Default models (skip selection)
orchestra run "Add dark mode" -d
```

### Model Selection

Orchestra supports three model presets and manual selection:

#### Presets

| Flag | Claude | Codex | OpenCode | Use Case |
|------|--------|-------|----------|----------|
| `-f, --fast` | Haiku | Low reasoning | Gemini 3 Flash | Quick iterations, testing |
| `-d, --default` | Sonnet | Medium reasoning | Antigravity Claude Opus | Balanced (default) |
| `-m, --max` | Opus | XHigh reasoning | Antigravity Claude Opus | Complex tasks |

```bash
# Fast mode - cheaper & faster
orchestra run "Fix typo in README" --fast

# Max mode - most capable
orchestra run "Implement OAuth2 with refresh tokens" --max
```

#### Manual Model Selection

```bash
# Specify individual models
orchestra run "Build API" --claude opus --codex gpt-5.2-codex --reasoning high

# Mix presets with overrides
orchestra run "Complex task" --fast --claude sonnet  # Fast but use Sonnet for Claude
```

| Option | Values |
|--------|--------|
| `--claude <model>` | `opus`, `sonnet`, `haiku` |
| `--codex <model>` | `gpt-5.2-codex`, `gpt-5.1-codex-max`, `gpt-5.1-codex` |
| `--reasoning <level>` | `minimal`, `low`, `medium`, `high`, `xhigh` |
| `--opencode <model>` | `google/antigravity-*` models |

#### Available Models

**Claude:**
- `opus` - Opus 4.5 (most capable)
- `sonnet` - Sonnet 4.5 (balanced)
- `haiku` - Haiku 4.5 (fastest)

**Codex:**
- `gpt-5.2-codex` - Latest
- `gpt-5.1-codex-max` - High performance
- `gpt-5.1-codex` - Balanced

**Codex Reasoning Levels:**
- `minimal` - Fastest
- `low` - Light reasoning
- `medium` - Balanced (default)
- `high` - Deep reasoning
- `xhigh` - Maximum depth

**OpenCode (Antigravity):**
- `google/antigravity-claude-opus-4-5-thinking`
- `google/antigravity-claude-sonnet-4-5-thinking`
- `google/antigravity-gemini-3-pro-high`
- `google/antigravity-gemini-3-pro-low`
- `google/antigravity-gemini-3-flash`

### All Options

| Option | Default | Description |
|--------|---------|-------------|
| `-c, --max-cycles <n>` | 20 | Maximum planning cycles |
| `-w, --max-workers <n>` | 3 | Parallel worker count |
| `-d, --default-models` | - | Skip model selection, use defaults |
| `-f, --fast` | - | Fast mode (Haiku, Low, Flash) |
| `-m, --max` | - | Max mode (Opus, XHigh) |
| `--claude <model>` | sonnet | Claude model |
| `--codex <model>` | gpt-5.2-codex | Codex model |
| `--reasoning <level>` | medium | Codex reasoning level |
| `--opencode <model>` | antigravity-claude-opus | OpenCode model |

## How It Works

### 1. Planner Phase
- Analyzes the goal and codebase
- Creates well-defined tasks for workers
- Does NOT write code itself

### 2. Worker Phase
- Workers claim tasks from queue (index-based, no locks)
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
│   │   ├── prompts.ts     # Model selection UI
│   │   └── logger.ts      # Logging
│   ├── types/
│   │   └── index.ts       # TypeScript types
│   └── cli/
│       └── commands.ts    # CLI commands
└── dist/                  # Compiled output
```

## Agent Selection & Failover

Orchestra automatically:
1. Detects available CLI tools
2. Uses selected model configuration
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
