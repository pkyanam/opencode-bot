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
const text = (description) => ({ type: 'string', description });
const stringArray = (description) => ({ type: 'array', items: { type: 'string' }, description });
const memoryId = text('Memory item ID returned by a memory tool');
const revision = { type: 'integer', minimum: 0, description: 'Revision returned by the last read or write' };
const memoryVisibility = { type: 'string', enum: ['private', 'shared', 'workspace'], description: 'Who can read this memory; private by default' };
const memoryKind = { type: 'string', enum: ['fact', 'preference', 'decision', 'lesson', 'procedure', 'note'], description: 'Optional category; use fact for project context and links' };
const memoryBudget = { type: 'string', enum: ['low', 'mid', 'high'], description: 'Provider work budget' };

// Memory actions are deliberately sent through the authenticated runner
// capability endpoint. The coordinator uses the run ID carried by that
// endpoint to derive the requesting bot; no source bot ID is accepted here.
const memoryTools = [
  { name: 'memory_search', description: 'Search shared workspace memory relevant to the current task.', inputSchema: { type: 'object', properties: { query: text('Search query'), limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Maximum number of results (default is server-defined)' } }, required: ['query'], additionalProperties: false } },
  { name: 'memory_read', description: 'Read one shared workspace memory item by ID.', inputSchema: { type: 'object', properties: { id: memoryId }, required: ['id'], additionalProperties: false } },
  { name: 'memory_remember', description: 'Remember durable information in shared workspace memory.', inputSchema: { type: 'object', properties: { content: text('Memory content'), title: text('Optional short title'), kind: memoryKind, tags: stringArray('Optional search tags'), visibility: memoryVisibility, sharedBotIds: stringArray('Optional bot IDs to share with') }, required: ['content'], additionalProperties: false } },
  { name: 'memory_update', description: 'Update a shared workspace memory item using optimistic concurrency.', inputSchema: { type: 'object', properties: { id: memoryId, content: text('Replacement memory content'), title: text('Replacement title'), kind: memoryKind, tags: stringArray('Replacement search tags'), revision }, required: ['id', 'revision'], additionalProperties: false } },
  { name: 'memory_forget', description: 'Forget a shared workspace memory item using optimistic concurrency.', inputSchema: { type: 'object', properties: { id: memoryId, revision }, required: ['id', 'revision'], additionalProperties: false } },
  { name: 'memory_share', description: 'Change which workspace bots can read a memory item using optimistic concurrency.', inputSchema: { type: 'object', properties: { id: memoryId, botIds: stringArray('Bot IDs allowed to read this memory'), visibility: memoryVisibility, revision }, required: ['id', 'revision'], additionalProperties: false } },
  { name: 'memory_retain', description: 'Retain durable information through the configured memory provider. This is an alias for remembering a workspace memory.', inputSchema: { type: 'object', properties: { content: text('Memory content'), title: text('Optional short title'), kind: memoryKind, tags: stringArray('Optional search tags'), visibility: memoryVisibility, sharedBotIds: stringArray('Optional bot IDs to share with') }, required: ['content'], additionalProperties: false } },
  { name: 'memory_recall', description: 'Recall provider memories relevant to the current task.', inputSchema: { type: 'object', properties: { query: text('Recall query'), budget: memoryBudget }, required: ['query'], additionalProperties: false } },
  { name: 'memory_reflect', description: 'Reflect on provider memories and return a bounded synthesis for the current task.', inputSchema: { type: 'object', properties: { query: text('Reflection question'), budget: memoryBudget }, required: ['query'], additionalProperties: false } },
  { name: 'memory_observations', description: 'Inspect provider observations for the current task.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'memory_mental_models', description: 'List provider mental models for the current task.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'memory_mental_model_create', description: 'Create a provider mental model from a name and description.', inputSchema: { type: 'object', properties: { name: text('Mental model name'), query: text('Description or source query') }, required: ['name', 'query'], additionalProperties: false } },
  { name: 'memory_mental_model_delete', description: 'Delete a provider mental model by ID.', inputSchema: { type: 'object', properties: { id: text('Mental model ID') }, required: ['id'], additionalProperties: false } },
  { name: 'memory_mental_model_refresh', description: 'Refresh a provider mental model by ID.', inputSchema: { type: 'object', properties: { id: text('Mental model ID') }, required: ['id'], additionalProperties: false } },
];
const memoryNames = new Set(memoryTools.map(tool => tool.name));
const runCapability = { type: 'string', minLength: 32, description: 'Opaque capability for this conversation; supplied in the system instructions.' };
const scopeTool = (tool) => {
  const schema = tool.inputSchema ?? empty;
  const properties = { ...(schema.properties ?? {}), _run: runCapability };
  const required = [...new Set([...(schema.required ?? []), '_run'])];
  return { ...tool, inputSchema: { ...schema, properties, required, additionalProperties: false } };
};
const memoryToolTimeoutMs = (name) => name === 'create_bot' ? 35_000 : (name === 'memory_reflect' ? 330_000 : (['memory_recall', 'memory_mental_model_create', 'memory_mental_model_refresh'].includes(name) ? 120_000 : 15_000));
const tools = [
  { name: 'list_bots', description: 'List the other persistent bots in this workspace. These are independent bots with their own settings, not OpenCode subagents.', inputSchema: empty },
  { name: 'send_message', description: 'Send a task or message to another workspace bot. The recipient can run concurrently while you continue working. Read progress with get_replies at useful checkpoints; if you finish first, its reply resumes this conversation. Do not claim a response before it arrives.', inputSchema: { type: 'object', properties: { targetBotId: { type: 'string', description: 'Exact bot ID returned by list_bots' }, prompt: { type: 'string', description: 'Message or task with the context the recipient needs' } }, required: ['targetBotId','prompt'], additionalProperties: false } },
  { name: 'send_file', description: 'Queue a verified workspace file transfer to another persistent bot on its assigned node.', inputSchema: { type: 'object', properties: { targetBotId: { type: 'string' }, sourcePath: { type: 'string' }, targetPath: { type: 'string' }, name: { type: 'string' }, size: { type: 'integer' }, sha256: { type: 'string' } }, required: ['targetBotId','sourcePath','targetPath','name','size','sha256'], additionalProperties: false } },
  { name: 'get_replies', description: 'Read bot message receipts and replies already available to this conversation. Peers can work concurrently; read their latest status and results without repeatedly polling.', inputSchema: empty },
  { name: 'create_bot', description: 'Create a new persistent workspace bot. Waits for creation and returns the new bot ID for immediate messaging, with its own settings and conversations; this is not an OpenCode subagent.', inputSchema: { type: 'object', properties: { name: { type: 'string', description: 'Unique display name for the new bot (1–160 characters)' }, instructions: { type: 'string', description: 'The new bot role and operating instructions' }, model: { type: 'string', description: 'Optional provider/model identifier available to this workspace' }, agent: { type: 'string', description: 'Optional OpenCode agent name' } }, required: ['name'], additionalProperties: false } },
  {name:'inspect_self',description:'Inspect this bot’s actual identity, node, deployment version, and source repository. Load only when asked about this app or its own environment.',inputSchema:{type:'object',properties:{topic:{type:'string',enum:['all','identity','deployment','source','capabilities']}},additionalProperties:false}},
  {name:'self_docs',description:'Read a bounded opencode-bot reference on demand before configuring or modifying this app. Topics: overview, setup, memory, nodes, security, development.',inputSchema:{type:'object',properties:{topic:{type:'string',enum:['overview','setup','memory','nodes','security','development']}},required:['topic'],additionalProperties:false}},
  ...memoryTools,
] .map(scopeTool);
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
  if (!['inspect_self','self_docs','list_bots','send_message','send_file','get_replies','create_bot'].includes(params.name) && !memoryNames.has(params.name)) return { isError: true, content: [{ type:'text', text:'Unknown bot tool' }] };
  try {
    const response = await fetch(endpoint, { method:'POST', headers:{ authorization:`Bearer ${token}`, 'content-type':'application/json' }, body:JSON.stringify({ name:params.name, arguments:params.arguments ?? {} }), signal:AbortSignal.timeout(memoryToolTimeoutMs(params.name)) });
    const value = await response.json();
    return { ...(response.ok ? {} : {isError:true}), content:[{type:'text',text:JSON.stringify(value)}] };
  } catch { return { isError:true, content:[{type:'text',text:'Bot messaging is temporarily unavailable. No delivery was confirmed.'}] }; }
});
await server.connect(new StdioServerTransport());
