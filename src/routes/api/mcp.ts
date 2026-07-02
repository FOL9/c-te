import { createFileRoute } from "@tanstack/react-router";
import { createMcpServer } from "mcp-tanstack-start";
import { allE2bTools } from "@/lib/mcp/tools/e2b";

const mcp = createMcpServer({
  name: "e2b-headless-sandbox",
  version: "1.0.0",
  instructions:
    "Headless E2B sandbox execution. ALWAYS call get_or_create_sandbox(project_id) first for a given project_id and inspect is_new/reconnected before running commands or reading/writing files — if either is true, the filesystem is empty and any prior state is gone. Same project_id reuses the same sandbox across calls until it dies or is killed.",
  tools: allE2bTools,
});

const methodNotAllowed = () =>
  new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed." },
      id: null,
    }),
    {
      status: 405,
      headers: { "Content-Type": "application/json", Allow: "POST, OPTIONS" },
    },
  );

export const Route = createFileRoute("/api/mcp")({
  server: {
    handlers: {
      POST: async ({ request }) => mcp.handleRequest(request),
      GET: async () => methodNotAllowed(),
      DELETE: async () => methodNotAllowed(),
    },
  },
});