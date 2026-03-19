---
description: Add Ollama MCP server so the container agent can call local models for cheaper/faster tasks like summarization, translation, or general queries.
---

# Add Ollama Integration

This workflow adds a stdio-based MCP server that exposes Ollama models as tools for the container agent. The primary LLM (OpenRouter/Claude) remains the orchestrator but can offload work to Ollama models.

Tools added:
- `ollama_list_models` — lists installed Ollama models
- `ollama_generate` — sends a prompt to a specified model and returns the response

## Phase 1: Pre-flight

### Check if already applied

Check if `container/agent-runner/src/ollama-mcp-stdio.ts` exists. If it does, skip to Phase 3 (Configure).

### Check prerequisites

Verify Ollama is accessible:

```bash
curl -s http://your-ollama-host:11434/api/tags
```

For remote Ollama instances, ensure the endpoint is reachable from your network.

## Phase 2: Apply Code Changes

### Ensure upstream remote

```bash
git remote -v
```

If `upstream` is missing, add it:

```bash
git remote add upstream https://github.com/qwibitai/nanoclaw.git
```

### Merge the workflow branch

```bash
git fetch upstream skill/ollama-tool
git merge upstream/skill/ollama-tool
```

This merges in:
- `container/agent-runner/src/ollama-mcp-stdio.ts` (Ollama MCP server)
- `scripts/ollama-watch.sh` (macOS notification watcher)
- Ollama MCP config in `container/agent-runner/src/index.ts` (allowedTools + mcpServers)
- `[OLLAMA]` log surfacing in `src/container-runner.ts`
- `OLLAMA_HOST` in `.env.example`

If the merge reports conflicts, resolve them by reading the conflicted files and understanding the intent of both sides.

### Copy to per-group agent-runner

Existing groups have a cached copy of the agent-runner source. Copy the new files:

```bash
for dir in data/sessions/*/agent-runner-src; do
  cp container/agent-runner/src/ollama-mcp-stdio.ts "$dir/"
  cp container/agent-runner/src/index.ts "$dir/"
done
```

### Validate code changes

```bash
npm run build
./container/build.sh
```

Build must be clean before proceeding.

## Phase 3: Configure

### Set Ollama host

Add to `.env`:

```bash
OLLAMA_HOST=http://your-ollama-host:11434
```

For remote Ollama instances (e.g., tailnet), use the full URL:

```bash
OLLAMA_HOST=http://100.81.118.18:8080
```

Sync to container environment:

```bash
mkdir -p data/env && cp .env data/env/env
```

### Restart the service

```bash
# macOS
launchctl kickstart -k gui/$(id -u)/com.nanoclaw

# Linux
systemctl --user restart nanoclaw
```

## Phase 4: Verify

### Test via messaging

Send a message like: "use ollama to tell me the capital of France"

The agent should use `ollama_list_models` to find available models, then `ollama_generate` to get a response.

### Monitor activity (optional)

Run the watcher script for macOS notifications when Ollama is used:

```bash
./scripts/ollama-watch.sh
```

### Check logs if needed

```bash
tail -f logs/nanoclaw.log | grep -i ollama
```

Look for:
- `Agent output: ... Ollama ...` — agent used Ollama successfully
- `[OLLAMA] >>> Generating` — generation started
- `[OLLAMA] <<< Done` — generation completed

## Usage Patterns

The agent will intelligently choose between the primary LLM and Ollama based on task complexity:

**Good for Ollama (cost-effective):**
- Summarization
- Translation
- Simple Q&A
- Data extraction
- Format conversion

**Better for primary LLM (complex reasoning):**
- Multi-step planning
- Code generation
- Complex analysis
- Tool orchestration

You can explicitly request Ollama: "use ollama to summarize this document"

## Troubleshooting

### Agent says "Ollama is not installed"

The agent is trying to run `ollama` CLI inside the container instead of using the MCP tools. This means:
1. The MCP server wasn't registered — check `container/agent-runner/src/index.ts` has the `ollama` entry in `mcpServers`
2. The per-group source wasn't updated — re-copy files (see Phase 2)
3. The container wasn't rebuilt — run `./container/build.sh`

### "Failed to connect to Ollama"

1. Verify Ollama is running: `curl -s http://your-ollama-host:11434/api/tags`
2. Check the endpoint is reachable from Docker containers
3. Verify `OLLAMA_HOST` in `.env` matches your Ollama endpoint
4. For remote hosts, ensure firewall allows connections

### Agent doesn't use Ollama tools

The agent may not know about the tools. Try being explicit: "use the ollama_generate tool with llama3.3:70b to answer: ..."

## Model Selection

Your Ollama instance has:
- **GLM4.7** - Good for general tasks
- **LLAMA3.3:70b** - Better for complex reasoning, still cheaper than cloud APIs

The agent will see both models via `ollama_list_models` and can choose based on task requirements.
