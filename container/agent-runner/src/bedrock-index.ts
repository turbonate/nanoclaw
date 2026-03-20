/**
 * NanoClaw Agent Runner - AWS Bedrock Edition
 * Runs inside a container, receives config via stdin, outputs result to stdout
 * Uses AWS Bedrock instead of Claude Agent SDK for ZDR compliance
 *
 * Input protocol:
 *   Stdin: Full ContainerInput JSON (read until EOF)
 *   IPC:   Follow-up messages written as JSON files to /workspace/ipc/input/
 *          Files: {type:"message", text:"..."}.json — polled and consumed
 *          Sentinel: /workspace/ipc/input/_close — signals session end
 *
 * Stdout protocol:
 *   Each result is wrapped in OUTPUT_START_MARKER / OUTPUT_END_MARKER pairs.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  BedrockRuntimeClient,
  ConverseCommand,
  ConverseStreamCommand,
  ContentBlock,
  Message,
  Tool,
  ToolUseBlock,
  ToolResultBlock,
} from '@aws-sdk/client-bedrock-runtime';

interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
}

interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp?: number;
}

const IPC_INPUT_DIR = '/workspace/ipc/input';
const IPC_INPUT_CLOSE_SENTINEL = path.join(IPC_INPUT_DIR, '_close');
const IPC_POLL_MS = 500;
const CONVERSATION_HISTORY_FILE = '/workspace/group/conversation-history.json';
const MAX_HISTORY_MESSAGES = 20; // Keep last 20 messages for context

const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

function writeOutput(output: ContainerOutput): void {
  console.log(OUTPUT_START_MARKER);
  console.log(JSON.stringify(output));
  console.log(OUTPUT_END_MARKER);
}

function log(message: string): void {
  console.error(`[bedrock-agent] ${message}`);
}

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

/**
 * Load conversation history from file
 */
function loadConversationHistory(): ConversationMessage[] {
  try {
    if (fs.existsSync(CONVERSATION_HISTORY_FILE)) {
      const data = fs.readFileSync(CONVERSATION_HISTORY_FILE, 'utf-8');
      return JSON.parse(data);
    }
  } catch (err) {
    log(`Failed to load conversation history: ${err instanceof Error ? err.message : String(err)}`);
  }
  return [];
}

/**
 * Save conversation history to file
 */
function saveConversationHistory(messages: ConversationMessage[]): void {
  try {
    // Keep only the last MAX_HISTORY_MESSAGES
    const trimmed = messages.slice(-MAX_HISTORY_MESSAGES);
    fs.writeFileSync(CONVERSATION_HISTORY_FILE, JSON.stringify(trimmed, null, 2));
  } catch (err) {
    log(`Failed to save conversation history: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Convert conversation history to Bedrock message format
 */
function historyToBedrockMessages(history: ConversationMessage[]): Message[] {
  return history.map(msg => ({
    role: msg.role,
    content: [{ text: msg.content }],
  }));
}

/**
 * Check for _close sentinel
 */
function shouldClose(): boolean {
  if (fs.existsSync(IPC_INPUT_CLOSE_SENTINEL)) {
    try { fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL); } catch { /* ignore */ }
    return true;
  }
  return false;
}

/**
 * Drain all pending IPC input messages
 */
function drainIpcInput(): string[] {
  try {
    fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
    const files = fs.readdirSync(IPC_INPUT_DIR)
      .filter(f => f.endsWith('.json'))
      .sort();

    const messages: string[] = [];
    for (const file of files) {
      const filePath = path.join(IPC_INPUT_DIR, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        fs.unlinkSync(filePath);
        if (data.type === 'message' && data.text) {
          messages.push(data.text);
        }
      } catch (err) {
        log(`Failed to process input file ${file}: ${err instanceof Error ? err.message : String(err)}`);
        try { fs.unlinkSync(filePath); } catch { /* ignore */ }
      }
    }
    return messages;
  } catch (err) {
    log(`IPC drain error: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

/**
 * Wait for a new IPC message or _close sentinel
 */
function waitForIpcMessage(): Promise<string | null> {
  return new Promise((resolve) => {
    const poll = () => {
      if (shouldClose()) {
        resolve(null);
        return;
      }
      const messages = drainIpcInput();
      if (messages.length > 0) {
        resolve(messages.join('\n'));
        return;
      }
      setTimeout(poll, IPC_POLL_MS);
    };
    poll();
  });
}

/**
 * Create Bedrock client with AWS credentials from environment
 */
function createBedrockClient(): BedrockRuntimeClient {
  const region = process.env.AWS_REGION || 'us-east-1';
  
  const config: any = { region };
  
  // Use explicit credentials if provided, otherwise fall back to default credential chain
  if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) {
    config.credentials = {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    };
  }
  
  return new BedrockRuntimeClient(config);
}

/**
 * Build system prompt with context
 */
function buildSystemPrompt(containerInput: ContainerInput): string {
  const assistantName = containerInput.assistantName || 'Assistant';
  
  let systemPrompt = `You are ${assistantName}, an AI assistant running in a containerized environment. You help users with various tasks.

Current context:
- Group: ${containerInput.groupFolder}
- Chat: ${containerInput.chatJid}
- Main channel: ${containerInput.isMain ? 'yes' : 'no'}

You have access to tools for file operations, web search, and task management. Use them when appropriate.

Important guidelines:
- Be helpful, concise, and accurate
- Use tools when they would be beneficial
- For file operations, paths are relative to /workspace/group
- Always verify your work when possible
`;

  // Load global CLAUDE.md if it exists (for non-main channels)
  const globalClaudeMdPath = '/workspace/global/CLAUDE.md';
  if (!containerInput.isMain && fs.existsSync(globalClaudeMdPath)) {
    try {
      const globalContext = fs.readFileSync(globalClaudeMdPath, 'utf-8');
      systemPrompt += `\n\nAdditional context:\n${globalContext}`;
    } catch (err) {
      log(`Failed to load global CLAUDE.md: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return systemPrompt;
}

/**
 * Define available tools for Bedrock
 */
function getAvailableTools(): Tool[] {
  return [
    {
      toolSpec: {
        name: 'read_file',
        description: 'Read the contents of a file',
        inputSchema: {
          json: {
            type: 'object',
            properties: {
              path: {
                type: 'string',
                description: 'Path to the file to read (relative to /workspace/group)',
              },
            },
            required: ['path'],
          },
        },
      },
    },
    {
      toolSpec: {
        name: 'write_file',
        description: 'Write content to a file',
        inputSchema: {
          json: {
            type: 'object',
            properties: {
              path: {
                type: 'string',
                description: 'Path to the file to write (relative to /workspace/group)',
              },
              content: {
                type: 'string',
                description: 'Content to write to the file',
              },
            },
            required: ['path', 'content'],
          },
        },
      },
    },
    {
      toolSpec: {
        name: 'list_directory',
        description: 'List files and directories in a path',
        inputSchema: {
          json: {
            type: 'object',
            properties: {
              path: {
                type: 'string',
                description: 'Path to the directory (relative to /workspace/group)',
              },
            },
            required: ['path'],
          },
        },
      },
    },
    {
      toolSpec: {
        name: 'bash_command',
        description: 'Execute a bash command in the workspace',
        inputSchema: {
          json: {
            type: 'object',
            properties: {
              command: {
                type: 'string',
                description: 'The bash command to execute',
              },
            },
            required: ['command'],
          },
        },
      },
    },
  ];
}

/**
 * Execute a tool call
 */
async function executeTool(toolName: string, toolInput: any): Promise<string> {
  const workspaceBase = '/workspace/group';
  
  try {
    switch (toolName) {
      case 'read_file': {
        const filePath = path.join(workspaceBase, toolInput.path);
        if (!fs.existsSync(filePath)) {
          return `Error: File not found: ${toolInput.path}`;
        }
        const content = fs.readFileSync(filePath, 'utf-8');
        return content;
      }
      
      case 'write_file': {
        const filePath = path.join(workspaceBase, toolInput.path);
        const dir = path.dirname(filePath);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(filePath, toolInput.content);
        return `Successfully wrote to ${toolInput.path}`;
      }
      
      case 'list_directory': {
        const dirPath = path.join(workspaceBase, toolInput.path || '.');
        if (!fs.existsSync(dirPath)) {
          return `Error: Directory not found: ${toolInput.path}`;
        }
        const entries = fs.readdirSync(dirPath, { withFileTypes: true });
        const listing = entries.map(e => 
          `${e.isDirectory() ? '[DIR]' : '[FILE]'} ${e.name}`
        ).join('\n');
        return listing || '(empty directory)';
      }
      
      case 'bash_command': {
        // For now, return a placeholder - full bash execution would require child_process
        return `Bash execution not yet implemented. Command: ${toolInput.command}`;
      }
      
      default:
        return `Error: Unknown tool: ${toolName}`;
    }
  } catch (err) {
    return `Error executing ${toolName}: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/**
 * Run a conversation with Bedrock
 */
async function runConversation(
  client: BedrockRuntimeClient,
  userMessage: string,
  containerInput: ContainerInput,
): Promise<string> {
  const modelId = process.env.BEDROCK_MODEL_ID || 'anthropic.claude-3-5-sonnet-20241022-v2:0';
  
  // Load conversation history
  const history = loadConversationHistory();
  
  // Add user message to history
  history.push({
    role: 'user',
    content: userMessage,
    timestamp: Date.now(),
  });
  
  // Build system prompt
  const systemPrompt = buildSystemPrompt(containerInput);
  
  // Convert history to Bedrock format
  const messages = historyToBedrockMessages(history);
  
  // Get available tools
  const tools = getAvailableTools();
  
  log(`Calling Bedrock model: ${modelId}`);
  log(`Conversation history: ${history.length} messages`);
  
  let assistantResponse = '';
  let toolCalls: ToolUseBlock[] = [];
  let maxIterations = 10; // Prevent infinite tool loops
  let iteration = 0;
  
  while (iteration < maxIterations) {
    iteration++;
    
    try {
      const command = new ConverseCommand({
        modelId,
        messages,
        system: [{ text: systemPrompt }],
        toolConfig: {
          tools,
        },
        inferenceConfig: {
          maxTokens: 4096,
          temperature: 0.7,
        },
      });
      
      const response = await client.send(command);
      
      if (!response.output) {
        throw new Error('No output from Bedrock');
      }
      
      // Extract assistant message
      const output = response.output;
      
      if (output.message) {
        const content = output.message.content || [];
        
        // Check for text content
        const textBlocks = content.filter(block => 'text' in block);
        if (textBlocks.length > 0) {
          assistantResponse = textBlocks.map(block => (block as any).text).join('\n');
        }
        
        // Check for tool use
        const toolUseBlocks = content.filter(block => 'toolUse' in block);
        
        if (toolUseBlocks.length > 0) {
          log(`Model requested ${toolUseBlocks.length} tool calls`);
          
          // Add assistant message with tool use to history
          messages.push({
            role: 'assistant',
            content,
          });
          
          // Execute tools and prepare results
          const toolResults: ContentBlock[] = [];
          
          for (const block of toolUseBlocks) {
            const toolUse = (block as any).toolUse;
            if (!toolUse) continue;
            
            const toolName = toolUse.name;
            const toolInput = toolUse.input;
            const toolUseId = toolUse.toolUseId;
            
            log(`Executing tool: ${toolName}`);
            
            const result = await executeTool(toolName, toolInput);
            
            toolResults.push({
              toolResult: {
                toolUseId,
                content: [{ text: result }],
              },
            });
          }
          
          // Add tool results as user message
          messages.push({
            role: 'user',
            content: toolResults,
          });
          
          // Continue conversation loop
          continue;
        }
        
        // No more tool calls, we're done
        break;
      }
      
      // Stop reason check
      if (response.stopReason === 'end_turn' || response.stopReason === 'stop_sequence') {
        break;
      }
      
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      log(`Bedrock error: ${errorMsg}`);
      throw new Error(`Bedrock API error: ${errorMsg}`);
    }
  }
  
  if (iteration >= maxIterations) {
    log('Warning: Reached maximum tool call iterations');
  }
  
  // Save assistant response to history
  if (assistantResponse) {
    history.push({
      role: 'assistant',
      content: assistantResponse,
      timestamp: Date.now(),
    });
    saveConversationHistory(history);
  }
  
  return assistantResponse || '(No response from model)';
}

async function main(): Promise<void> {
  let containerInput: ContainerInput;
  
  try {
    const stdinData = await readStdin();
    containerInput = JSON.parse(stdinData);
    log(`Received input for group: ${containerInput.groupFolder}`);
  } catch (err) {
    writeOutput({
      status: 'error',
      result: null,
      error: `Failed to parse input: ${err instanceof Error ? err.message : String(err)}`,
    });
    process.exit(1);
  }
  
  // Create Bedrock client
  const client = createBedrockClient();
  
  // Clean up stale _close sentinel
  fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
  try { fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL); } catch { /* ignore */ }
  
  // Build initial prompt
  let prompt = containerInput.prompt;
  if (containerInput.isScheduledTask) {
    prompt = `[SCHEDULED TASK - The following message was sent automatically and is not coming directly from the user or group.]\n\n${prompt}`;
  }
  
  // Drain any pending IPC messages
  const pending = drainIpcInput();
  if (pending.length > 0) {
    log(`Draining ${pending.length} pending IPC messages into initial prompt`);
    prompt += '\n' + pending.join('\n');
  }
  
  // Conversation loop
  try {
    while (true) {
      log(`Processing message (${prompt.length} chars)`);
      
      // Run conversation with Bedrock
      const response = await runConversation(client, prompt, containerInput);
      
      // Output result
      writeOutput({
        status: 'success',
        result: response,
        newSessionId: containerInput.sessionId || `bedrock-${Date.now()}`,
      });
      
      log('Waiting for next IPC message...');
      
      // Wait for next message or close
      const nextMessage = await waitForIpcMessage();
      if (nextMessage === null) {
        log('Close sentinel received, exiting');
        break;
      }
      
      log(`Got new message (${nextMessage.length} chars)`);
      prompt = nextMessage;
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log(`Agent error: ${errorMessage}`);
    writeOutput({
      status: 'error',
      result: null,
      error: errorMessage,
    });
    process.exit(1);
  }
}

main();
