---
description: Debug container agent issues. Use when things aren't working, container fails, authentication problems, or to understand how the container system works. Covers logs, environment variables, mounts, and common issues.
---

# NanoClaw Container Debugging

This workflow covers debugging the containerized agent execution system.

## Architecture Overview

```
Host (macOS)                          Container (Linux VM)
─────────────────────────────────────────────────────────────
src/container-runner.ts               container/agent-runner/
    │                                      │
    │ spawns container                      │ runs Claude Agent SDK
    │ with volume mounts                   │ with MCP servers
    │                                      │
    ├── data/env/env ──────────────> /workspace/env-dir/env
    ├── groups/{folder} ───────────> /workspace/group
    ├── data/ipc/{folder} ────────> /workspace/ipc
    ├── data/sessions/{folder}/.claude/ ──> /home/node/.claude/ (isolated per-group)
    └── (main only) project root ──> /workspace/project
```

**Important:** The container runs as user `node` with `HOME=/home/node`. Session files must be mounted to `/home/node/.claude/` (not `/root/.claude/`) for session resumption to work.

## Log Locations

| Log | Location | Content |
|-----|----------|---------|
| **Main app logs** | `logs/nanoclaw.log` | Host-side WhatsApp, routing, container spawning |
| **Main app errors** | `logs/nanoclaw.error.log` | Host-side errors |
| **Container run logs** | `groups/{folder}/logs/container-*.log` | Per-run: input, mounts, stderr, stdout |
| **Claude sessions** | `~/.claude/projects/` | Claude Code session history |

## Enabling Debug Logging

Set `LOG_LEVEL=debug` for verbose output:

```bash
# For development
LOG_LEVEL=debug npm run dev

# For launchd service (macOS), add to plist EnvironmentVariables:
<key>LOG_LEVEL</key>
<string>debug</string>
# For systemd service (Linux), add to unit [Service] section:
# Environment=LOG_LEVEL=debug
```

## Common Debugging Commands

### Check if service is running

```bash
# macOS
launchctl list | grep nanoclaw

# Linux
systemctl --user status nanoclaw
```

### Check recent logs

```bash
# Main logs
tail -50 logs/nanoclaw.log

# Error logs
tail -50 logs/nanoclaw.error.log

# Container logs for a specific group
tail -50 groups/main/logs/container-*.log
```

### Check environment variables

```bash
# Check what's mounted into containers
cat data/env/env

# Check if .env exists and has required keys
cat .env | grep -E "(OPENROUTER|ANTHROPIC|TELEGRAM|SLACK|WHATSAPP)"
```

### Check database state

```bash
# Check registered groups
sqlite3 store/messages.db "SELECT jid, name, folder, channel FROM registered_groups"

# Check recent messages
sqlite3 store/messages.db "SELECT jid, content, timestamp FROM messages ORDER BY timestamp DESC LIMIT 10"
```

### Check container runtime

```bash
# Docker
docker info
docker images | grep nanoclaw

# Apple Container
container system info
container images | grep nanoclaw
```

## Common Issues and Solutions

### Container fails to start

**Symptoms:** "Container failed to start" in logs, no response to messages

**Debug steps:**
1. Check container runtime is running: `docker info` or `container system info`
2. Check image exists: `docker images | grep nanoclaw`
3. Check container logs: `groups/main/logs/container-*.log`
4. Rebuild image: `npm run build`

**Common causes:**
- Container runtime not started
- Image doesn't exist or is corrupted
- Volume mount permissions issues
- Environment variables missing

### Authentication issues

**Symptoms:** "Authentication failed", missing credentials

**Debug steps:**
1. Check `.env` has required API keys
2. Check environment is synced: `cat data/env/env`
3. Check service has been restarted after `.env` changes
4. For WhatsApp: check `store/auth/creds.json` exists

**Common causes:**
- Missing or invalid API keys
- Environment not synced to containers
- Service not restarted after credential changes

### No response to messages

**Symptoms:** Messages received but no agent response

**Debug steps:**
1. Check message was received: `tail logs/nanoclaw.log | grep "New message"`
2. Check container was spawned: look for "Spawning container" in logs
3. Check container logs for errors: `groups/main/logs/container-*.log`
4. Check trigger pattern is correct

**Common causes:**
- Incorrect trigger pattern
- Container runtime issues
- LLM API problems
- Mount permission issues

### Permission issues

**Symptoms:** "Permission denied", mount errors

**Debug steps:**
1. Check mount allowlist: `cat ~/.config/nanoclaw/mount-allowlist.json`
2. Check directory permissions
3. Check if paths exist and are accessible

**Common causes:**
- Directory not in mount allowlist
- Permission denied on mounted paths
- Paths don't exist

### LLM API issues

**Symptoms:** "LLM process exited with code 1", API errors

**Debug steps:**
1. Check API key is valid
2. Check API endpoint is reachable
3. Check credential proxy logs: `logs/nanoclaw.log`
4. Test API manually with curl

**Common causes:**
- Invalid API key
- Network connectivity issues
- API endpoint changes
- Rate limiting

## Performance Debugging

### Slow container startup

**Debug steps:**
1. Check container runtime performance
2. Check available disk space
3. Check image size: `docker images | grep nanoclaw`
4. Monitor startup time in logs

### High memory usage

**Debug steps:**
1. Check container memory usage: `docker stats` or `container stats`
2. Check Node.js process memory
3. Check for memory leaks in logs

## Development Debugging

### Running in development mode

```bash
# Stop service first
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist  # macOS
systemctl --user stop nanoclaw  # Linux

# Run in development
LOG_LEVEL=debug npm run dev
```

### Testing specific components

```bash
# Test container runtime
npx tsx setup/index.ts --step container -- --runtime docker

# Test environment
npx tsx setup/index.ts --step environment

# Test registration
npx tsx setup/index.ts --step register -- --help
```

## Getting Help

When asking for help, provide:
1. Error messages from logs
2. Output of debugging commands
3. Your platform (macOS/Linux) and container runtime
4. What you were trying to do
5. What you expected to happen vs what actually happened

Use this workflow to systematically check each component of the system before escalating issues.
