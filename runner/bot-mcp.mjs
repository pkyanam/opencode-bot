import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

// This credential grants only the current run's bot messaging capabilities.
// It is deliberately different from the runner/control-server credentials.
const endpoint = process.env.BOT_TOOLS_URL;
const token = process.env.BOT_TOOLS_TOKEN;
if (!endpoint || !token || !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(endpoint).hostname)) throw new Error('Bot tools require a loopback endpoint and capability token');
const server = new Server({ name: 'opencode-bot', version: '0.1.0' }, { capabilities: { tools: {} } });
const empty = { type: 'object', properties: {}, additionalProperties: false };
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [
  { name: 'list_bots', description: 'List the other persistent bots in this workspace. These are independent bots with their own settings, not OpenCode subagents.', inputSchema: empty },
  { name: 'send_message', description: 'Send a task or message to another workspace bot. The recipient runs after your current turn ends; its reply automatically resumes this conversation. Do not poll or claim a response before it arrives.', inputSchema: { type: 'object', properties: { targetBotId: { type: 'string', description: 'Exact bot ID returned by list_bots' }, prompt: { type: 'string', description: 'Message or task with the context the recipient needs' } }, required: ['targetBotId','prompt'], additionalProperties: false } },
  { name: 'get_replies', description: 'Read bot message receipts and replies already available to this conversation. Pending work only starts after this turn ends.', inputSchema: empty },
  { name: 'create_bot', description: 'Create a new persistent workspace bot. The bot is created after this turn ends and becomes available with its own settings and conversations; this is not an OpenCode subagent.', inputSchema: { type: 'object', properties: { name: { type: 'string', description: 'Unique display name for the new bot (1–160 characters)' }, instructions: { type: 'string', description: 'The new bot role and operating instructions' }, model: { type: 'string', description: 'Optional provider/model identifier available to this workspace' }, agent: { type: 'string', description: 'Optional OpenCode agent name' } }, required: ['name'], additionalProperties: false } },
] }));
server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
  if (!['list_bots','send_message','get_replies','create_bot'].includes(params.name)) return { isError: true, content: [{ type:'text', text:'Unknown bot tool' }] };
  try {
    const response = await fetch(endpoint, { method:'POST', headers:{ authorization:`Bearer ${token}`, 'content-type':'application/json' }, body:JSON.stringify({ name:params.name, arguments:params.arguments ?? {} }), signal:AbortSignal.timeout(10_000) });
    const value = await response.json();
    return { ...(response.ok ? {} : {isError:true}), content:[{type:'text',text:JSON.stringify(value)}] };
  } catch { return { isError:true, content:[{type:'text',text:'Bot messaging is temporarily unavailable. No delivery was confirmed.'}] }; }
});
await server.connect(new StdioServerTransport());
