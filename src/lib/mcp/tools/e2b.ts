import { defineTool } from "mcp-tanstack-start";
import { z } from "zod";
import {
  getOrCreate,
  listAll,
  peek,
  probeAlive,
  remove,
  uptimeSeconds,
} from "../e2b-registry";
import { allExtendedTools } from "./extended";

const ok = (obj: unknown) => JSON.stringify(obj, null, 2);
const err = (e: unknown) => JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }, null, 2);

export const getOrCreateSandboxTool = defineTool({
  name: "get_or_create_sandbox",
  description:
    "Get the E2B sandbox for a project_id, creating it if needed. ALWAYS call first — check is_new/reconnected to know if filesystem/state is fresh.",
  parameters: z.object({ project_id: z.string() }),
  execute: async ({ project_id }) => {
    try {
      const { record, isNew, reconnected } = await getOrCreate(project_id);
      return ok({
        ok: true,
        project_id,
        sandbox_id: record.sandboxId,
        is_new: isNew,
        reconnected,
        recreate_count: record.recreateCount,
        uptime_seconds: uptimeSeconds(record),
        note: isNew
          ? "Fresh sandbox, empty filesystem."
          : reconnected
            ? "Previous sandbox died — NEW sandbox_id under same project_id. Old files/processes are GONE."
            : "Same sandbox as before, state preserved.",
      });
    } catch (e) {
      return err(e);
    }
  },
});

export const getSandboxStatusTool = defineTool({
  name: "get_sandbox_status",
  description: "Check if a sandbox exists for project_id and whether it's alive, without creating one.",
  parameters: z.object({ project_id: z.string() }),
  execute: async ({ project_id }) => {
    const rec = peek(project_id);
    if (!rec) return ok({ ok: true, exists: false, project_id });
    const alive = await probeAlive(rec.sandbox);
    return ok({
      ok: true,
      exists: true,
      project_id,
      sandbox_id: rec.sandboxId,
      alive,
      uptime_seconds: uptimeSeconds(rec),
      recreate_count: rec.recreateCount,
      last_used_at: new Date(rec.lastUsedAt).toISOString(),
    });
  },
});

export const listActiveSandboxesTool = defineTool({
  name: "list_active_sandboxes",
  description: "List all tracked project_id -> sandbox_id mappings in this server process.",
  parameters: z.object({}),
  execute: async () => {
    const items = listAll().map(({ projectId, record }) => ({
      project_id: projectId,
      sandbox_id: record.sandboxId,
      uptime_seconds: uptimeSeconds(record),
      recreate_count: record.recreateCount,
    }));
    return ok({ ok: true, count: items.length, sandboxes: items });
  },
});

export const killSandboxTool = defineTool({
  name: "kill_sandbox",
  description: "Explicitly destroy the sandbox for project_id and remove it from the registry.",
  parameters: z.object({ project_id: z.string() }),
  execute: async ({ project_id }) => {
    const rec = remove(project_id);
    if (!rec) return ok({ ok: true, killed: false, reason: "no such project_id" });
    const oldId = rec.sandboxId;
    try {
      await rec.sandbox.kill();
    } catch {
      // ignore
    }
    return ok({ ok: true, killed: true, project_id, sandbox_id: oldId });
  },
});

export const allE2bTools = [
  getOrCreateSandboxTool,
  getSandboxStatusTool,
  listActiveSandboxesTool,
  killSandboxTool,
  ...allExtendedTools,
];