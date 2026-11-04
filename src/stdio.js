// Mode stdio untuk Claude Desktop / Claude Code: node src/stdio.js
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { buildMcpServer } from './mcp.js';
import { init } from './store.js';

await init();
await buildMcpServer().connect(new StdioServerTransport());
console.error('teman-seller-studio MCP (stdio) siap');
