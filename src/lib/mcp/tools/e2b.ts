import { defineTool } from "mcp-tanstack-start";
import { z } from "zod";
import {
  absPath,
  DEFAULT_WORKDIR,
  getOrCreate,
  listAll,
  peek,
  probeAlive,
  remove,
  uptimeSeconds,
} from "../e2b-registry";

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

export const runCommandTool = defineTool({
  name: "run_command",
  description: "Run a bash command inside the project's E2B sandbox. Auto-creates the sandbox if missing.",
  parameters: z.object({
    project_id: z.string(),
    command: z.string(),
    timeout_s: z.number().int().positive().default(60),
    background: z.boolean().default(false),
  }),
  execute: async ({ project_id, command, timeout_s, background }) => {
    try {
      const { record, isNew, reconnected } = await getOrCreate(project_id);
      const sb = record.sandbox;
      if (background) {
        await sb.commands.run(command, { background: true, cwd: DEFAULT_WORKDIR });
        return ok({
          ok: true,
          sandbox_id: record.sandboxId,
          is_new: isNew,
          reconnected,
          background: true,
          command,
        });
      }
      const result = await sb.commands.run(command, {
        timeoutMs: timeout_s * 1000,
        cwd: DEFAULT_WORKDIR,
      });
      let stdout = result.stdout ?? "";
      let stderr = result.stderr ?? "";
      if (stdout.length > 6000) stdout = stdout.slice(0, 6000) + "\n... (truncated)";
      if (stderr.length > 2000) stderr = stderr.slice(0, 2000) + "\n... (truncated)";
      return ok({
        ok: result.exitCode === 0,
        sandbox_id: record.sandboxId,
        is_new: isNew,
        reconnected,
        exit_code: result.exitCode,
        stdout,
        stderr,
      });
    } catch (e) {
      return err(e);
    }
  },
});

export const writeFileTool = defineTool({
  name: "write_file",
  description: "Write (create/overwrite) a file in the project's sandbox workspace.",
  parameters: z.object({
    project_id: z.string(),
    file_path: z.string(),
    content: z.string(),
  }),
  execute: async ({ project_id, file_path, content }) => {
    try {
      const { record, isNew, reconnected } = await getOrCreate(project_id);
      const target = absPath(file_path);
      const parent = target.slice(0, target.lastIndexOf("/")) || "/";
      await record.sandbox.commands.run(`mkdir -p ${parent}`, { timeoutMs: 10_000 });
      await record.sandbox.files.write(target, content);
      return ok({
        ok: true,
        sandbox_id: record.sandboxId,
        is_new: isNew,
        reconnected,
        file_path,
        bytes: content.length,
      });
    } catch (e) {
      return err(e);
    }
  },
});

export const readFileTool = defineTool({
  name: "read_file",
  description: "Read a file's content from the project's sandbox workspace.",
  parameters: z.object({ project_id: z.string(), file_path: z.string() }),
  execute: async ({ project_id, file_path }) => {
    try {
      const { record, isNew, reconnected } = await getOrCreate(project_id);
      let content: string;
      try {
        content = await record.sandbox.files.read(absPath(file_path));
      } catch {
        return ok({ ok: false, sandbox_id: record.sandboxId, error: `File not found: ${file_path}` });
      }
      const truncated = content.length > 8000;
      return ok({
        ok: true,
        sandbox_id: record.sandboxId,
        is_new: isNew,
        reconnected,
        file_path,
        content: content.slice(0, 8000),
        truncated,
      });
    } catch (e) {
      return err(e);
    }
  },
});

export const deleteFileTool = defineTool({
  name: "delete_file",
  description: "Delete a file from the project's sandbox workspace.",
  parameters: z.object({ project_id: z.string(), file_path: z.string() }),
  execute: async ({ project_id, file_path }) => {
    try {
      const { record, isNew, reconnected } = await getOrCreate(project_id);
      await record.sandbox.files.remove(absPath(file_path));
      return ok({
        ok: true,
        sandbox_id: record.sandboxId,
        is_new: isNew,
        reconnected,
        file_path,
      });
    } catch (e) {
      return err(e);
    }
  },
});

export const listDirectoryTool = defineTool({
  name: "list_directory",
  description: "List files/dirs inside the project's sandbox workspace (up to 200 entries).",
  parameters: z.object({ project_id: z.string(), path: z.string().default(".") }),
  execute: async ({ project_id, path }) => {
    try {
      const { record, isNew, reconnected } = await getOrCreate(project_id);
      const target = absPath(path);
      const res = await record.sandbox.commands.run(
        `find ${target} -not -path '*/node_modules/*' -not -path '*/.git/*' 2>/dev/null | head -200`,
        { timeoutMs: 15_000 },
      );
      return ok({
        ok: true,
        sandbox_id: record.sandboxId,
        is_new: isNew,
        reconnected,
        path,
        listing: res.stdout ?? "",
      });
    } catch (e) {
      return err(e);
    }
  },
});

export const allE2bTools = [
  getOrCreateSandboxTool,
  getSandboxStatusTool,
  listActiveSandboxesTool,
  killSandboxTool,
  runCommandTool,
  writeFileTool,
  readFileTool,
  deleteFileTool,
  listDirectoryTool,
];