# Orchestra

Multi-agent coding orchestration system using CLI tools (Claude, Codex, Gemini).

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         ORCHESTRA                                │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│   ┌─────────┐                                                   │
│   │ PLANNER │──────┬──────────────────────┐                     │
│   └─────────┘      │                      │                     │
│        │           ▼                      ▼                     │
│        │    ┌─────────────┐        ┌─────────────┐             │
│        │    │ Sub-Planner │        │ Sub-Planner │  (parallel) │
│        │    │    (API)    │        │    (UI)     │             │
│        │    └─────────────┘        └─────────────┘             │
│        │           │                      │                     │
│        ▼           ▼                      ▼                     │
│   ┌─────────────────────────────────────────┐                   │
│   │              Task Queue                  │                   │
│   └─────────────────────────────────────────┘                   │
│                       │                                          │
│              ┌────────┼────────┐                                │
│              ▼        ▼        ▼                                │
│         ┌────────┐┌────────┐┌────────┐                          │
│         │Worker-1││Worker-2││Worker-3│  (parallel)              │
│         └────────┘└────────┘└────────┘                          │
│              │        │        │                                │
│              ▼        ▼        ▼                                │
│         ┌───────┐ ┌───────┐ ┌───────┐                          │
│         │Claude │ │ Codex │ │Gemini │  (failover)              │
│         └───────┘ └───────┘ └───────┘                          │
│                       │                                          │
│                       ▼                                          │
│                 ┌─────────┐                                      │
│                 │  JUDGE  │                                      │
│                 └─────────┘                                      │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

## Prerequisites

**Git** must be installed and configured:

```bash
# Check git
git --version  # Must be 2.5+

# Configure git user (if not already)
git config --global user.name "Your Name"
git config --global user.email "your@email.com"
```

**At least one of these CLI tools must be installed:**

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

### Gemini CLI (Google)
```bash
# Install Gemini CLI
npm install -g @anthropic-ai/gemini-cli
```

### GitHub Copilot CLI
```bash
# Install via npm
npm install -g @github/copilot

# Or via Homebrew (macOS/Linux)
brew install copilot-cli

# Requires GitHub Copilot subscription (Individual/Business/Enterprise)
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

| Flag | Claude | Codex | Gemini | Copilot | Use Case |
|------|--------|-------|--------|---------|----------|
| `-f, --fast` | Haiku | Low reasoning | Flash | Haiku 4.5 | Quick iterations |
| `-d, --default` | Sonnet | Medium | Flash | Sonnet 4.5 | Balanced |
| `-m, --max` | Opus | XHigh | Pro | Sonnet 4.5 | Complex tasks |

```bash
# Fast mode - cheaper & faster
orchestra run "Fix typo in README" --fast

# Max mode - most capable
orchestra run "Implement OAuth2 with refresh tokens" --max
```

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

**Gemini:**
- `gemini-3-pro-preview` - Most capable (Preview)
- `gemini-3-flash-preview` - Fast & efficient (Preview)
- `gemini-2.5-pro` - Stable, balanced
- `gemini-2.5-flash` - Stable, quick

**GitHub Copilot:** (no JSON output, uses plain text)
- `claude-sonnet-4.5` - Default, most capable
- `claude-opus-4.5` - Most powerful Claude
- `claude-haiku-4.5` - Fast Claude
- `gpt-5.2-codex` - Latest Codex
- `gpt-5.2` - Latest GPT
- `gemini-3-pro-preview` - Google Gemini (Preview)

### All Options

| Option | Default | Description |
|--------|---------|-------------|
| `-c, --max-cycles <n>` | 20 | Maximum planning cycles |
| `-w, --max-workers <n>` | 3 | Parallel worker count |
| `-d, --default-models` | - | Skip model selection, use defaults |
| `-f, --fast` | - | Fast mode (Haiku, Low, Flash) |
| `-m, --max` | - | Max mode (Opus, XHigh, Pro) |
| `--claude <model>` | sonnet | Claude model |
| `--codex <model>` | gpt-5.2-codex | Codex model |
| `--reasoning <level>` | medium | Codex reasoning level |
| `--gemini <model>` | gemini-3-flash-preview | Gemini model |

## How It Works

### 1. Planner Phase
- Analyzes the goal and codebase
- Creates well-defined tasks for workers
- Assigns relevant files to each task
- Sets `needs_web_search` flag for tasks requiring current information
- **Spawns sub-planners** for large projects (parallel recursive planning)
- Does NOT write code itself

### 2. Sub-Planners (Optional)
For large projects, the main planner can spawn sub-planners:
- Each sub-planner focuses on a specific area (API, UI, Database, etc.)
- Sub-planners run **in parallel** for faster planning
- Each creates up to 5 focused tasks for their area
- Triggered when project has 5+ modules or 15+ estimated tasks

```
Main Planner → 10 tasks + spawn_sub_planners: ["API", "UI"]
                    │
       ┌────────────┴────────────┐
       ▼                         ▼
Sub-Planner:API            Sub-Planner:UI
    5 tasks                    5 tasks
       │                         │
       └────────────┬────────────┘
                    ▼
            Total: 20 tasks
```

### 3. Worker Phase
- Workers claim tasks from queue (index-based, no locks)
- Execute tasks using available CLI tools (Claude/Codex/Gemini)
- Run in parallel (up to `maxWorkers`)
- Each worker commits only its task's files
- **Web search enabled** for tasks flagged with `needs_web_search`

### 4. Judge Phase
- Evaluates cycle progress
- Decides: `CONTINUE`, `COMPLETE`, or `ABORT`
- Provides recommendations for next cycle

## Web Search Integration

Planner decides when tasks need current/recent information:

| Agent | Web Search Method |
|-------|-------------------|
| Claude | WebSearch tool (built-in) |
| Codex | `--search` flag |
| Gemini | `--grounding` (Google Search) |

**When web search is enabled:**
- Latest library versions or API changes (2025-2026)
- Current best practices
- New framework features or syntax
- Recent security advisories
- Up-to-date documentation

**When NOT enabled:**
- Standard coding tasks
- Tasks using established patterns
- Internal codebase work

## Git Workflow

Orchestra uses a simple git workflow for parallel workers:

```
┌────────────────────────────────────────────────────────┐
│                   Single Branch                         │
│                                                         │
│   Worker-1: git pull --rebase → work → git add <files> │
│   Worker-2: git pull --rebase → work → git add <files> │
│   Worker-3: git pull --rebase → work → git add <files> │
│                                                         │
│   Each worker commits only its task's specific files    │
│   Conflicts? Agent resolves them                        │
└────────────────────────────────────────────────────────┘
```

**Key features:**
- **Single branch**: All workers work on the same branch
- **Task-specific commits**: Each task commits only its relevant files (`git add <files>`)
- **Pull before commit**: `git pull --rebase` before each commit
- **Auto gitignore**: `.orchestra/` is automatically added to `.gitignore`

## Project Structure

```
.orchestra/                 # Orchestra state (in your project)
├── agents.json            # Agent pool state
├── tasks.json             # Task queue
├── state.json             # Session state
├── logs/                  # Log files
└── prompts/               # Saved prompts & responses
    ├── claude-*-prompt.txt
    ├── claude-*-raw.txt
    ├── claude-*-response.txt
    ├── codex-*-prompt.txt
    ├── gemini-*-prompt.txt
    ├── copilot-*-prompt.txt
    └── ...

orchestra/                  # Orchestra source code
├── src/
│   ├── agents/            # Agent executors
│   │   ├── base.ts        # Base executor class
│   │   ├── claude.ts      # Claude CLI executor
│   │   ├── codex.ts       # Codex CLI executor
│   │   ├── gemini.ts      # Gemini CLI executor
│   │   ├── copilot.ts     # GitHub Copilot CLI executor
│   │   ├── executor.ts    # Agent manager & failover
│   │   └── prompts.ts     # Prompt templates
│   ├── core/
│   │   ├── orchestrator.ts # Main orchestration loop
│   │   ├── planner.ts     # Planner & sub-planner runner
│   │   ├── judge.ts       # Judge runner
│   │   ├── tasks.ts       # Task management
│   │   ├── state.ts       # State management
│   │   ├── agents.ts      # Agent pool management
│   │   ├── events.ts      # Event bus & wake-up
│   │   └── errors.ts      # Error handling
│   ├── utils/
│   │   ├── cli.ts         # CLI execution utilities
│   │   ├── git.ts         # Git utilities
│   │   ├── paths.ts       # Path management
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

Priority: `claude` → `codex` → `gemini` → `copilot`

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

Based on learnings from [Cursor's scaling-agents research](https://cursor.com/blog/scaling-agents):
- **Sub-planners**: Parallel recursive planning for large codebases
- **Anti-laziness prompts**: Aggressive task completion requirements
- **Planner wake-up**: Re-plan every N completed tasks

## License

MIT
