/**
 * NanoClaw Agent Runner - Ollama Edition
 * Uses Ollama's OpenAI-compatible API for local, ZDR-compliant LLM
 * 
 * This is a simplified version for testing the architecture with local models
 * before setting up AWS Bedrock.
 */

import fs from 'fs';
import path from 'path';

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
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp?: number;
}

interface OllamaMessage {
  role: string;
  content: string;
}

interface OllamaChatRequest {
  model: string;
  messages: OllamaMessage[];
  stream?: boolean;
  options?: {
    temperature?: number;
    num_predict?: number;
  };
}

interface OllamaChatResponse {
  model: string;
  created_at: string;
  message: {
    role: string;
    content: string;
  };
  done: boolean;
}

const IPC_INPUT_DIR = '/workspace/ipc/input';
const IPC_INPUT_CLOSE_SENTINEL = path.join(IPC_INPUT_DIR, '_close');
const IPC_POLL_MS = 500;
const CONVERSATION_HISTORY_FILE = '/workspace/group/conversation-history.json';
const MAX_HISTORY_MESSAGES = 20;

const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

function writeOutput(output: ContainerOutput): void {
  console.log(OUTPUT_START_MARKER);
  console.log(JSON.stringify(output));
  console.log(OUTPUT_END_MARKER);
}

function log(message: string): void {
  console.error(`[ollama-agent] ${message}`);
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

function saveConversationHistory(messages: ConversationMessage[]): void {
  try {
    const trimmed = messages.slice(-MAX_HISTORY_MESSAGES);
    fs.writeFileSync(CONVERSATION_HISTORY_FILE, JSON.stringify(trimmed, null, 2));
  } catch (err) {
    log(`Failed to save conversation history: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function shouldClose(): boolean {
  if (fs.existsSync(IPC_INPUT_CLOSE_SENTINEL)) {
    try { fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL); } catch { /* ignore */ }
    return true;
  }
  return false;
}

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

function buildSystemPrompt(containerInput: ContainerInput): string {
  const assistantName = containerInput.assistantName || 'Assistant';
  
  let systemPrompt = `You are ${assistantName}, an AI assistant helping users with various tasks.

Current context:
- Group: ${containerInput.groupFolder}
- Chat: ${containerInput.chatJid}
- Main channel: ${containerInput.isMain ? 'yes' : 'no'}

Guidelines:
- Be helpful, concise, and accurate
- Provide clear explanations
- If you're unsure about something, say so
- For technical questions, provide practical solutions
`;

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

async function callOllama(
  messages: OllamaMessage[],
  model: string,
  ollamaHost: string,
): Promise<string> {
  const url = `${ollamaHost}/api/chat`;
  
  const requestBody: OllamaChatRequest = {
    model,
    messages,
    stream: false,
    options: {
      temperature: 0.7,
      num_predict: 4096,
    },
  };

  log(`Calling Ollama: ${url} (model: ${model})`);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Ollama API error: ${response.status} ${response.statusText} - ${errorText}`);
    }

    const data = await response.json() as OllamaChatResponse;
    
    if (!data.message || !data.message.content) {
      throw new Error('Invalid response from Ollama: missing message content');
    }

    return data.message.content;
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    log(`Ollama error: ${errorMsg}`);
    throw new Error(`Failed to call Ollama: ${errorMsg}`);
  }
}

async function runConversation(
  userMessage: string,
  containerInput: ContainerInput,
): Promise<string> {
  const ollamaHost = process.env.OLLAMA_HOST || 'http://localhost:11434';
  const model = process.env.OLLAMA_MODEL || 'glm4:latest';
  
  const history = loadConversationHistory();
  
  history.push({
    role: 'user',
    content: userMessage,
    timestamp: Date.now(),
  });
  
  const systemPrompt = buildSystemPrompt(containerInput);
  
  const ollamaMessages: OllamaMessage[] = [
    { role: 'system', content: systemPrompt },
  ];
  
  for (const msg of history) {
    if (msg.role === 'system') continue;
    ollamaMessages.push({
      role: msg.role,
      content: msg.content,
    });
  }
  
  log(`Conversation history: ${history.length} messages`);
  log(`Sending ${ollamaMessages.length} messages to Ollama`);
  
  const response = await callOllama(ollamaMessages, model, ollamaHost);
  
  history.push({
    role: 'assistant',
    content: response,
    timestamp: Date.now(),
  });
  
  saveConversationHistory(history);
  
  return response;
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
  
  fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
  try { fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL); } catch { /* ignore */ }
  
  let prompt = containerInput.prompt;
  if (containerInput.isScheduledTask) {
    prompt = `[SCHEDULED TASK - The following message was sent automatically and is not coming directly from the user or group.]\n\n${prompt}`;
  }
  
  const pending = drainIpcInput();
  if (pending.length > 0) {
    log(`Draining ${pending.length} pending IPC messages into initial prompt`);
    prompt += '\n' + pending.join('\n');
  }
  
  try {
    while (true) {
      log(`Processing message (${prompt.length} chars)`);
      
      const response = await runConversation(prompt, containerInput);
      
      writeOutput({
        status: 'success',
        result: response,
        newSessionId: containerInput.sessionId || `ollama-${Date.now()}`,
      });
      
      log('Waiting for next IPC message...');
      
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
