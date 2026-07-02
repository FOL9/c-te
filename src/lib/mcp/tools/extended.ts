import { defineTool } from "mcp-tanstack-start";
import { z } from "zod";
import {
  absPath,
  DEFAULT_WORKDIR,
  getOrCreate,
  newId,
  type BackgroundProcess,
  type PtySession,
} from "../e2b-registry";

const ok = (obj: unknown) => JSON.stringify(obj, null, 2);
const err = (e: unknown) =>
  JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }, null, 2);
const nowIso = () => new Date().toISOString();
const trunc = (s: string, n = 8000) =>
  s.length > n ? s.slice(0, n) + `\n... (truncated ${s.length - n} chars)` : s;

async function sh(project_id: string, cmd: string, timeoutMs = 30_000, cwd = DEFAULT_WORKDIR) {
  const { record } = await getOrCreate(project_id);
  const r = await record.sandbox.commands.run(cmd, { timeoutMs, cwd });
  return { record, r };
}

// ─── PROCESS MANAGEMENT ─────────────────────────────────────────────────────

export const runCommand = defineTool({
  name: "run_command",
  description:
    "Execute a shell command. If background=true returns a process_id; poll get_process_logs/get_process_status. Auto-creates sandbox.",
  parameters: z.object({
    project_id: z.string(),
    command: z.string(),
    working_directory: z.string().optional(),
    environment_variables: z.record(z.string(), z.string()).optional(),
    timeout: z.number().int().positive().default(60),
    background: z.boolean().default(false),
  }),
  execute: async ({ project_id, command, working_directory, environment_variables, timeout, background }) => {
    try {
      const { record, isNew, reconnected } = await getOrCreate(project_id);
      const cwd = working_directory ? absPath(working_directory) : DEFAULT_WORKDIR;
      const envs = { ...record.envOverrides, ...(environment_variables ?? {}) };

      if (background) {
        const id = newId();
        const rec: BackgroundProcess = {
          id,
          pid: 0,
          command,
          cwd,
          startedAt: Date.now(),
          status: "running",
          stdout: "",
          stderr: "",
          handle: null,
        };
        const handle = await record.sandbox.commands.run(command, {
          cwd,
          envs,
          background: true,
          onStdout: (data: string) => {
            rec.stdout += data;
            const m = data.match(/(?:localhost|127\.0\.0\.1|0\.0\.0\.0)[:\s]+(\d{2,5})|port[:\s]+(\d{2,5})/i);
            if (m && !rec.detectedPort) rec.detectedPort = parseInt(m[1] ?? m[2], 10);
          },
          onStderr: (data: string) => {
            rec.stderr += data;
          },
        });
        rec.handle = handle;
        rec.pid = handle.pid;
        record.bgProcesses.set(id, rec);
        // Track exit asynchronously
        handle
          .wait()
          .then((res: any) => {
            rec.exitCode = res?.exitCode ?? 0;
            rec.status = rec.exitCode === 0 ? "completed" : "failed";
            rec.finishedAt = Date.now();
          })
          .catch((e: any) => {
            rec.stderr += `\n[wait error] ${e?.message ?? e}`;
            rec.status = "failed";
            rec.finishedAt = Date.now();
          });
        return ok({
          ok: true,
          process_id: id,
          pid: rec.pid,
          status: "running",
          started_at: new Date(rec.startedAt).toISOString(),
          sandbox_id: record.sandboxId,
          is_new: isNew,
          reconnected,
        });
      }

      const res = await record.sandbox.commands.run(command, {
        cwd,
        envs,
        timeoutMs: timeout * 1000,
      });
      return ok({
        ok: res.exitCode === 0,
        exit_code: res.exitCode,
        stdout: trunc(res.stdout ?? "", 6000),
        stderr: trunc(res.stderr ?? "", 3000),
        status: res.exitCode === 0 ? "completed" : "failed",
        sandbox_id: record.sandboxId,
        is_new: isNew,
        reconnected,
        finished_at: nowIso(),
      });
    } catch (e) {
      return err(e);
    }
  },
});

export const getProcessStatus = defineTool({
  name: "get_process_status",
  description: "Get status/cpu/mem of a background process started via run_command.",
  parameters: z.object({ project_id: z.string(), process_id: z.string() }),
  execute: async ({ project_id, process_id }) => {
    try {
      const { record } = await getOrCreate(project_id);
      const p = record.bgProcesses.get(process_id);
      if (!p) return ok({ ok: false, error: "process_id not found" });
      let cpu: number | null = null;
      let mem: number | null = null;
      try {
        const stat = await record.sandbox.commands.run(
          `ps -p ${p.pid} -o %cpu=,%mem= 2>/dev/null || true`,
          { timeoutMs: 5000 },
        );
        const parts = (stat.stdout ?? "").trim().split(/\s+/);
        if (parts.length >= 2) {
          cpu = parseFloat(parts[0]);
          mem = parseFloat(parts[1]);
        }
      } catch {}
      return ok({
        ok: true,
        process_id,
        pid: p.pid,
        command: p.command,
        running: p.status === "running",
        completed: p.status === "completed",
        failed: p.status === "failed",
        exit_code: p.exitCode ?? null,
        started_at: new Date(p.startedAt).toISOString(),
        finished_at: p.finishedAt ? new Date(p.finishedAt).toISOString() : null,
        cpu_usage: cpu,
        memory_usage: mem,
        detected_port: p.detectedPort ?? null,
      });
    } catch (e) {
      return err(e);
    }
  },
});

export const getProcessLogs = defineTool({
  name: "get_process_logs",
  description: "Get stdout/stderr from a background process. offset in bytes to stream incrementally.",
  parameters: z.object({
    project_id: z.string(),
    process_id: z.string(),
    offset: z.number().int().nonnegative().default(0),
  }),
  execute: async ({ project_id, process_id, offset }) => {
    try {
      const { record } = await getOrCreate(project_id);
      const p = record.bgProcesses.get(process_id);
      if (!p) return ok({ ok: false, error: "process_id not found" });
      const combined = p.stdout;
      const slice = combined.slice(offset);
      return ok({
        ok: true,
        process_id,
        stdout: trunc(slice, 8000),
        stderr: trunc(p.stderr, 4000),
        next_offset: combined.length,
        status: p.status,
      });
    } catch (e) {
      return err(e);
    }
  },
});

export const stopProcess = defineTool({
  name: "stop_process",
  description: "Kill a background process by process_id.",
  parameters: z.object({ project_id: z.string(), process_id: z.string() }),
  execute: async ({ project_id, process_id }) => {
    try {
      const { record } = await getOrCreate(project_id);
      const p = record.bgProcesses.get(process_id);
      if (!p) return ok({ ok: false, success: false, error: "process_id not found" });
      try {
        await p.handle?.kill?.();
      } catch {}
      p.status = "failed";
      p.finishedAt = Date.now();
      return ok({ ok: true, success: true, process_id, pid: p.pid });
    } catch (e) {
      return err(e);
    }
  },
});

export const listProcesses = defineTool({
  name: "list_processes",
  description: "List active background processes tracked for the project + live process table snapshot.",
  parameters: z.object({ project_id: z.string() }),
  execute: async ({ project_id }) => {
    try {
      const { record } = await getOrCreate(project_id);
      const tracked = Array.from(record.bgProcesses.values()).map((p) => ({
        process_id: p.id,
        pid: p.pid,
        command: p.command,
        status: p.status,
        started_at: new Date(p.startedAt).toISOString(),
        detected_port: p.detectedPort ?? null,
      }));
      let live: any[] = [];
      try {
        const l = await record.sandbox.commands.list();
        live = l.map((c: any) => ({ pid: c.pid, cmd: c.cmd ?? c.command ?? null, args: c.args ?? null }));
      } catch {}
      return ok({ ok: true, tracked, live });
    } catch (e) {
      return err(e);
    }
  },
});

// ─── NETWORKING ─────────────────────────────────────────────────────────────

export const listPorts = defineTool({
  name: "list_ports",
  description: "Return listening ports in the sandbox with process info (uses ss/lsof).",
  parameters: z.object({ project_id: z.string() }),
  execute: async ({ project_id }) => {
    try {
      const { r } = await sh(
        project_id,
        `ss -ltnp 2>/dev/null || netstat -ltnp 2>/dev/null || true`,
        10_000,
      );
      const lines = (r.stdout ?? "").split("\n").slice(1).filter(Boolean);
      const ports = lines.map((line) => {
        const m = line.match(/:(\d+)\s.*?users:\(\("([^"]+)",pid=(\d+)/);
        return m
          ? { port: parseInt(m[1], 10), protocol: "tcp", process_name: m[2], process_id: parseInt(m[3], 10) }
          : { raw: line.trim() };
      });
      return ok({ ok: true, ports });
    } catch (e) {
      return err(e);
    }
  },
});

export const getPublicUrl = defineTool({
  name: "get_public_url",
  description: "Return the public https URL that maps to a sandbox port. E2B exposes any port automatically.",
  parameters: z.object({ project_id: z.string(), port: z.number().int().positive() }),
  execute: async ({ project_id, port }) => {
    try {
      const { record } = await getOrCreate(project_id);
      const host = record.sandbox.getHost(port);
      record.tunnels.add(port);
      return ok({ ok: true, port, public_url: `https://${host}`, sandbox_id: record.sandboxId });
    } catch (e) {
      return err(e);
    }
  },
});

export const closePublicUrl = defineTool({
  name: "close_public_url",
  description: "Remove tunnel bookkeeping for a port (E2B ports are auto-exposed; this just clears tracking).",
  parameters: z.object({ project_id: z.string(), port: z.number().int().positive() }),
  execute: async ({ project_id, port }) => {
    const { record } = await getOrCreate(project_id);
    record.tunnels.delete(port);
    return ok({ ok: true, success: true, port });
  },
});

// ─── FILESYSTEM ─────────────────────────────────────────────────────────────

export const readFile = defineTool({
  name: "read_file",
  description: "Read a file from the sandbox workspace.",
  parameters: z.object({ project_id: z.string(), path: z.string() }),
  execute: async ({ project_id, path }) => {
    try {
      const { record } = await getOrCreate(project_id);
      const content = await record.sandbox.files.read(absPath(path));
      return ok({ ok: true, path, encoding: "utf-8", content: trunc(content, 12000), truncated: content.length > 12000 });
    } catch (e) {
      return err(e);
    }
  },
});

export const writeFile = defineTool({
  name: "write_file",
  description: "Write (create/overwrite) a file in the sandbox workspace.",
  parameters: z.object({ project_id: z.string(), path: z.string(), content: z.string() }),
  execute: async ({ project_id, path, content }) => {
    try {
      const { record } = await getOrCreate(project_id);
      const target = absPath(path);
      const parent = target.slice(0, target.lastIndexOf("/")) || "/";
      await record.sandbox.commands.run(`mkdir -p ${parent}`, { timeoutMs: 10_000 });
      await record.sandbox.files.write(target, content);
      return ok({ ok: true, path, bytes: content.length });
    } catch (e) {
      return err(e);
    }
  },
});

export const editFile = defineTool({
  name: "edit_file",
  description: "Precise edit: replace the first exact occurrence of `search` with `replace` in a file. Avoids full rewrite.",
  parameters: z.object({
    project_id: z.string(),
    path: z.string(),
    search: z.string(),
    replace: z.string(),
    replace_all: z.boolean().default(false),
  }),
  execute: async ({ project_id, path, search, replace, replace_all }) => {
    try {
      const { record } = await getOrCreate(project_id);
      const target = absPath(path);
      const original = await record.sandbox.files.read(target);
      if (!original.includes(search)) {
        return ok({ ok: false, error: "search string not found", path });
      }
      const updated = replace_all ? original.split(search).join(replace) : original.replace(search, replace);
      await record.sandbox.files.write(target, updated);
      return ok({
        ok: true,
        path,
        replacements: replace_all ? original.split(search).length - 1 : 1,
        bytes_before: original.length,
        bytes_after: updated.length,
      });
    } catch (e) {
      return err(e);
    }
  },
});

export const deleteFile = defineTool({
  name: "delete_file",
  description: "Delete a file or directory (recursive).",
  parameters: z.object({ project_id: z.string(), path: z.string() }),
  execute: async ({ project_id, path }) => {
    try {
      const { r } = await sh(project_id, `rm -rf ${JSON.stringify(absPath(path))}`, 15_000);
      return ok({ ok: r.exitCode === 0, path, stderr: r.stderr });
    } catch (e) {
      return err(e);
    }
  },
});

export const moveFile = defineTool({
  name: "move_file",
  description: "Move/rename a file or directory.",
  parameters: z.object({ project_id: z.string(), source: z.string(), destination: z.string() }),
  execute: async ({ project_id, source, destination }) => {
    try {
      const dst = absPath(destination);
      const parent = dst.slice(0, dst.lastIndexOf("/")) || "/";
      await sh(project_id, `mkdir -p ${parent}`, 10_000);
      const { r } = await sh(project_id, `mv ${JSON.stringify(absPath(source))} ${JSON.stringify(dst)}`, 15_000);
      return ok({ ok: r.exitCode === 0, source, destination, stderr: r.stderr });
    } catch (e) {
      return err(e);
    }
  },
});

export const copyFile = defineTool({
  name: "copy_file",
  description: "Copy a file or directory (recursive).",
  parameters: z.object({ project_id: z.string(), source: z.string(), destination: z.string() }),
  execute: async ({ project_id, source, destination }) => {
    try {
      const dst = absPath(destination);
      const parent = dst.slice(0, dst.lastIndexOf("/")) || "/";
      await sh(project_id, `mkdir -p ${parent}`, 10_000);
      const { r } = await sh(project_id, `cp -r ${JSON.stringify(absPath(source))} ${JSON.stringify(dst)}`, 30_000);
      return ok({ ok: r.exitCode === 0, source, destination, stderr: r.stderr });
    } catch (e) {
      return err(e);
    }
  },
});

export const listDirectory = defineTool({
  name: "list_directory",
  description: "List directory entries with size and modified_at.",
  parameters: z.object({ project_id: z.string(), path: z.string().default(".") }),
  execute: async ({ project_id, path }) => {
    try {
      const target = absPath(path);
      const { r } = await sh(
        project_id,
        `ls -lA --time-style=full-iso ${JSON.stringify(target)} 2>/dev/null`,
        10_000,
      );
      const files: any[] = [];
      const folders: any[] = [];
      for (const line of (r.stdout ?? "").split("\n")) {
        const m = line.match(/^([-dl])\S+\s+\d+\s+\S+\s+\S+\s+(\d+)\s+(\S+\s+\S+\s+\S+)\s+(.+)$/);
        if (!m) continue;
        const entry = { name: m[4], size: parseInt(m[2], 10), modified_at: m[3] };
        if (m[1] === "d") folders.push(entry);
        else files.push(entry);
      }
      return ok({ ok: true, path, files, folders });
    } catch (e) {
      return err(e);
    }
  },
});

export const searchFiles = defineTool({
  name: "search_files",
  description: "Search files by filename glob (up to 200 results).",
  parameters: z.object({
    project_id: z.string(),
    pattern: z.string(),
    path: z.string().default("."),
  }),
  execute: async ({ project_id, pattern, path }) => {
    try {
      const { r } = await sh(
        project_id,
        `find ${JSON.stringify(absPath(path))} -not -path '*/node_modules/*' -not -path '*/.git/*' -name ${JSON.stringify(pattern)} 2>/dev/null | head -200`,
        20_000,
      );
      const matches = (r.stdout ?? "").split("\n").filter(Boolean);
      return ok({ ok: true, pattern, count: matches.length, matches });
    } catch (e) {
      return err(e);
    }
  },
});

export const grep = defineTool({
  name: "grep",
  description: "Search text inside files (uses grep -RIn). Returns filename, line_number, preview.",
  parameters: z.object({
    project_id: z.string(),
    query: z.string(),
    path: z.string().default("."),
    max_results: z.number().int().positive().default(200),
  }),
  execute: async ({ project_id, query, path, max_results }) => {
    try {
      const { r } = await sh(
        project_id,
        `grep -RIn --exclude-dir=node_modules --exclude-dir=.git -F ${JSON.stringify(query)} ${JSON.stringify(absPath(path))} 2>/dev/null | head -${max_results}`,
        30_000,
      );
      const matches = (r.stdout ?? "")
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const m = line.match(/^([^:]+):(\d+):(.*)$/);
          return m
            ? { filename: m[1], line_number: parseInt(m[2], 10), preview: m[3] }
            : { raw: line };
        });
      return ok({ ok: true, query, count: matches.length, matches });
    } catch (e) {
      return err(e);
    }
  },
});

// ─── PROJECT UTILITIES ──────────────────────────────────────────────────────

export const detectProject = defineTool({
  name: "detect_project",
  description: "Detect frameworks, languages, and package managers in the workspace.",
  parameters: z.object({ project_id: z.string(), path: z.string().default(".") }),
  execute: async ({ project_id, path }) => {
    try {
      const { record } = await getOrCreate(project_id);
      const base = absPath(path);
      const detected: string[] = [];
      const pms: string[] = [];
      const check = async (rel: string) => {
        try {
          await record.sandbox.files.read(`${base}/${rel}`);
          return true;
        } catch {
          return false;
        }
      };
      let pkg: any = null;
      if (await check("package.json")) {
        pms.push("npm");
        try {
          pkg = JSON.parse(await record.sandbox.files.read(`${base}/package.json`));
          const d = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
          if (d.next) detected.push("Next.js");
          if (d.react && !d.next) detected.push("React");
          if (d.vue) detected.push("Vue");
          if (d.svelte) detected.push("Svelte");
          if (d["@tanstack/react-start"]) detected.push("TanStack Start");
          if (d.express || d.fastify || d.koa) detected.push("Node backend");
        } catch {}
      }
      if (await check("pnpm-lock.yaml")) pms.push("pnpm");
      if (await check("yarn.lock")) pms.push("yarn");
      if (await check("bun.lock") || (await check("bun.lockb"))) pms.push("bun");
      if (await check("requirements.txt") || (await check("pyproject.toml"))) {
        detected.push("Python");
        pms.push("pip");
      }
      if (await check("manage.py")) detected.push("Django");
      if (await check("main.py")) {
        const c = await record.sandbox.files.read(`${base}/main.py`).catch(() => "");
        if (/fastapi/i.test(c)) detected.push("FastAPI");
      }
      if (await check("composer.json")) {
        detected.push("Laravel/PHP");
        pms.push("composer");
      }
      if (await check("Cargo.toml")) {
        detected.push("Rust");
        pms.push("cargo");
      }
      if (await check("go.mod")) {
        detected.push("Go");
        pms.push("go");
      }
      return ok({ ok: true, path, frameworks: Array.from(new Set(detected)), package_managers: Array.from(new Set(pms)), scripts: pkg?.scripts ?? null });
    } catch (e) {
      return err(e);
    }
  },
});

async function installCmd(project_id: string): Promise<string> {
  const { record } = await getOrCreate(project_id);
  const base = DEFAULT_WORKDIR;
  const has = async (f: string) => {
    try {
      await record.sandbox.files.read(`${base}/${f}`);
      return true;
    } catch {
      return false;
    }
  };
  if (await has("pnpm-lock.yaml")) return "pnpm install";
  if (await has("bun.lock")) return "bun install";
  if (await has("yarn.lock")) return "yarn install";
  if (await has("package.json")) return "npm install";
  if (await has("requirements.txt")) return "pip install -r requirements.txt";
  if (await has("pyproject.toml")) return "pip install .";
  if (await has("composer.json")) return "composer install";
  if (await has("Cargo.toml")) return "cargo build";
  if (await has("go.mod")) return "go mod download";
  return "true";
}

export const installDependencies = defineTool({
  name: "install_dependencies",
  description: "Detect and run the correct package manager install (npm/pnpm/bun/yarn/pip/composer/cargo/go).",
  parameters: z.object({ project_id: z.string() }),
  execute: async ({ project_id }) => {
    try {
      const cmd = await installCmd(project_id);
      const { r } = await sh(project_id, cmd, 300_000);
      return ok({
        ok: r.exitCode === 0,
        command: cmd,
        exit_code: r.exitCode,
        stdout: trunc(r.stdout ?? "", 4000),
        stderr: trunc(r.stderr ?? "", 4000),
      });
    } catch (e) {
      return err(e);
    }
  },
});

async function runCmd(project_id: string): Promise<string> {
  const { record } = await getOrCreate(project_id);
  const base = DEFAULT_WORKDIR;
  const has = async (f: string) => {
    try {
      await record.sandbox.files.read(`${base}/${f}`);
      return true;
    } catch {
      return false;
    }
  };
  if (await has("package.json")) {
    try {
      const pkg = JSON.parse(await record.sandbox.files.read(`${base}/package.json`));
      if (pkg.scripts?.dev) return "npm run dev";
      if (pkg.scripts?.start) return "npm start";
    } catch {}
  }
  if (await has("manage.py")) return "python manage.py runserver 0.0.0.0:8000";
  if (await has("main.py")) {
    const c = await record.sandbox.files.read(`${base}/main.py`).catch(() => "");
    if (/fastapi/i.test(c)) return "uvicorn main:app --host 0.0.0.0 --port 8000";
    return "python main.py";
  }
  if (await has("Cargo.toml")) return "cargo run";
  if (await has("go.mod")) return "go run .";
  return "";
}

export const runProject = defineTool({
  name: "run_project",
  description: "Auto-detect and start the project in background. Returns process_id, detected_port, public_url.",
  parameters: z.object({ project_id: z.string(), port_hint: z.number().int().positive().optional() }),
  execute: async ({ project_id, port_hint }) => {
    try {
      const cmd = await runCmd(project_id);
      if (!cmd) return ok({ ok: false, error: "No startup command detected. Add scripts.dev or provide one." });
      const { record } = await getOrCreate(project_id);
      const id = newId();
      const rec: BackgroundProcess = {
        id, pid: 0, command: cmd, cwd: DEFAULT_WORKDIR, startedAt: Date.now(),
        status: "running", stdout: "", stderr: "", handle: null, detectedPort: port_hint,
      };
      const handle = await record.sandbox.commands.run(cmd, {
        cwd: DEFAULT_WORKDIR, background: true,
        onStdout: (d: string) => {
          rec.stdout += d;
          const m = d.match(/(?:localhost|127\.0\.0\.1|0\.0\.0\.0)[:\s]+(\d{2,5})/i);
          if (m && !rec.detectedPort) rec.detectedPort = parseInt(m[1], 10);
        },
        onStderr: (d: string) => { rec.stderr += d; },
      });
      rec.handle = handle;
      rec.pid = handle.pid;
      record.bgProcesses.set(id, rec);
      handle.wait().then((res: any) => {
        rec.exitCode = res?.exitCode ?? 0;
        rec.status = rec.exitCode === 0 ? "completed" : "failed";
        rec.finishedAt = Date.now();
      }).catch(() => { rec.status = "failed"; rec.finishedAt = Date.now(); });
      await new Promise((r) => setTimeout(r, 2500));
      const port = rec.detectedPort ?? port_hint ?? null;
      const public_url = port ? `https://${record.sandbox.getHost(port)}` : null;
      if (port) record.tunnels.add(port);
      return ok({
        ok: true, process_id: id, command: cmd,
        detected_port: port, public_url, initial_stdout: trunc(rec.stdout, 2000),
      });
    } catch (e) { return err(e); }
  },
});

export const buildProject = defineTool({
  name: "build_project",
  description: "Detect and run the project build command (npm run build / cargo build / go build).",
  parameters: z.object({ project_id: z.string() }),
  execute: async ({ project_id }) => {
    try {
      const { record } = await getOrCreate(project_id);
      let cmd = "";
      try {
        const pkg = JSON.parse(await record.sandbox.files.read(`${DEFAULT_WORKDIR}/package.json`));
        if (pkg.scripts?.build) cmd = "npm run build";
      } catch {}
      if (!cmd) {
        const has = async (f: string) => { try { await record.sandbox.files.read(`${DEFAULT_WORKDIR}/${f}`); return true; } catch { return false; } };
        if (await has("Cargo.toml")) cmd = "cargo build --release";
        else if (await has("go.mod")) cmd = "go build ./...";
      }
      if (!cmd) return ok({ ok: false, error: "No build command detected." });
      const { r } = await sh(project_id, cmd, 300_000);
      return ok({ ok: r.exitCode === 0, command: cmd, exit_code: r.exitCode, stdout: trunc(r.stdout ?? "", 4000), stderr: trunc(r.stderr ?? "", 4000) });
    } catch (e) { return err(e); }
  },
});

export const testProject = defineTool({
  name: "test_project",
  description: "Detect and run the project test command.",
  parameters: z.object({ project_id: z.string() }),
  execute: async ({ project_id }) => {
    try {
      const { record } = await getOrCreate(project_id);
      let cmd = "";
      try {
        const pkg = JSON.parse(await record.sandbox.files.read(`${DEFAULT_WORKDIR}/package.json`));
        if (pkg.scripts?.test) cmd = "npm test --silent";
      } catch {}
      if (!cmd) {
        const has = async (f: string) => { try { await record.sandbox.files.read(`${DEFAULT_WORKDIR}/${f}`); return true; } catch { return false; } };
        if (await has("pytest.ini") || await has("pyproject.toml")) cmd = "pytest -q";
        else if (await has("Cargo.toml")) cmd = "cargo test";
        else if (await has("go.mod")) cmd = "go test ./...";
      }
      if (!cmd) return ok({ ok: false, error: "No test command detected." });
      const { r } = await sh(project_id, cmd, 300_000);
      return ok({ ok: r.exitCode === 0, command: cmd, exit_code: r.exitCode, stdout: trunc(r.stdout ?? "", 6000), stderr: trunc(r.stderr ?? "", 4000) });
    } catch (e) { return err(e); }
  },
});

// ─── ENVIRONMENT ────────────────────────────────────────────────────────────

export const systemInfo = defineTool({
  name: "system_info",
  description: "Return sandbox OS/arch/cpu/mem/disk + versions of common runtimes.",
  parameters: z.object({ project_id: z.string() }),
  execute: async ({ project_id }) => {
    try {
      const script = `
echo "==OS=="; uname -a
echo "==ARCH=="; uname -m
echo "==CPU=="; nproc; grep 'model name' /proc/cpuinfo | head -1
echo "==MEM=="; free -h | head -2
echo "==DISK=="; df -h / | tail -1
echo "==HOST=="; hostname
echo "==PY=="; python3 --version 2>&1 || echo none
echo "==NODE=="; node --version 2>&1 || echo none
echo "==DOCKER=="; docker --version 2>&1 || echo none
echo "==GIT=="; git --version 2>&1 || echo none
`;
      const { r } = await sh(project_id, script, 15_000);
      return ok({ ok: true, info: r.stdout });
    } catch (e) { return err(e); }
  },
});

export const listEnvironmentVariables = defineTool({
  name: "list_environment_variables",
  description: "List env vars visible inside the sandbox (secrets may be masked upstream).",
  parameters: z.object({ project_id: z.string() }),
  execute: async ({ project_id }) => {
    try {
      const { r } = await sh(project_id, `env | sort`, 10_000);
      const overrides = (await getOrCreate(project_id)).record.envOverrides;
      return ok({ ok: true, env: r.stdout, overrides });
    } catch (e) { return err(e); }
  },
});

export const setEnvironmentVariable = defineTool({
  name: "set_environment_variable",
  description: "Set a persistent env override applied to future run_command calls in this project.",
  parameters: z.object({ project_id: z.string(), name: z.string(), value: z.string() }),
  execute: async ({ project_id, name, value }) => {
    const { record } = await getOrCreate(project_id);
    record.envOverrides[name] = value;
    return ok({ ok: true, name, set: true });
  },
});

// ─── GIT ────────────────────────────────────────────────────────────────────

const git = (name: string, desc: string, cmdFn: (a: any) => string, extra: z.ZodRawShape = {}) =>
  defineTool({
    name,
    description: desc,
    parameters: z.object({ project_id: z.string(), ...extra }),
    execute: async (args: any) => {
      try {
        const { r } = await sh(args.project_id, `cd ${DEFAULT_WORKDIR} && ${cmdFn(args)}`, 60_000);
        return ok({ ok: r.exitCode === 0, exit_code: r.exitCode, stdout: trunc(r.stdout ?? "", 6000), stderr: trunc(r.stderr ?? "", 3000) });
      } catch (e) { return err(e); }
    },
  });

export const gitStatus = git("git_status", "Run git status in workspace.", () => "git status --porcelain=v1 -b");
export const gitDiff = git("git_diff", "Run git diff (staged=true for --cached).", (a) => `git diff ${a.staged ? "--cached" : ""} ${a.path ?? ""}`, { staged: z.boolean().default(false), path: z.string().optional() });
export const gitCommit = git("git_commit", "Stage all and commit with message.", (a) => `git add -A && git -c user.email=agent@sandbox -c user.name=agent commit -m ${JSON.stringify(a.message)}`, { message: z.string() });
export const gitBranch = git("git_branch", "List branches, or create one if name provided.", (a) => a.name ? `git checkout -b ${JSON.stringify(a.name)}` : `git branch -a`, { name: z.string().optional() });
export const gitCheckout = git("git_checkout", "Checkout a branch or ref.", (a) => `git checkout ${JSON.stringify(a.ref)}`, { ref: z.string() });
export const gitClone = git("git_clone", "Clone a repo into workspace path.", (a) => `git clone ${JSON.stringify(a.url)} ${JSON.stringify(a.path ?? ".")}`, { url: z.string().url(), path: z.string().optional() });

// ─── INTERACTIVE TERMINAL (PTY) ─────────────────────────────────────────────

export const createTerminal = defineTool({
  name: "create_terminal",
  description: "Create a persistent bash PTY session. Returns terminal_id.",
  parameters: z.object({
    project_id: z.string(),
    cols: z.number().int().positive().default(120),
    rows: z.number().int().positive().default(30),
  }),
  execute: async ({ project_id, cols, rows }) => {
    try {
      const { record } = await getOrCreate(project_id);
      const id = newId();
      const session: PtySession = { id, pid: 0, startedAt: Date.now(), buffer: "", handle: null, cols, rows };
      const handle = await record.sandbox.pty.create({
        cols, rows,
        onData: (data: Uint8Array) => {
          session.buffer += new TextDecoder().decode(data);
          if (session.buffer.length > 200_000) session.buffer = session.buffer.slice(-150_000);
        },
      });
      session.handle = handle;
      session.pid = handle.pid;
      record.ptys.set(id, session);
      return ok({ ok: true, terminal_id: id, pid: session.pid, cols, rows });
    } catch (e) { return err(e); }
  },
});

export const sendTerminalInput = defineTool({
  name: "send_terminal_input",
  description: "Send raw input/keystrokes to a PTY. Append '\\n' to submit a command.",
  parameters: z.object({ project_id: z.string(), terminal_id: z.string(), input: z.string() }),
  execute: async ({ project_id, terminal_id, input }) => {
    try {
      const { record } = await getOrCreate(project_id);
      const s = record.ptys.get(terminal_id);
      if (!s) return ok({ ok: false, error: "terminal_id not found" });
      await record.sandbox.pty.sendInput(s.pid, new TextEncoder().encode(input));
      return ok({ ok: true, terminal_id, bytes: input.length });
    } catch (e) { return err(e); }
  },
});

export const readTerminalOutput = defineTool({
  name: "read_terminal_output",
  description: "Read incremental PTY output. offset in bytes.",
  parameters: z.object({ project_id: z.string(), terminal_id: z.string(), offset: z.number().int().nonnegative().default(0) }),
  execute: async ({ project_id, terminal_id, offset }) => {
    try {
      const { record } = await getOrCreate(project_id);
      const s = record.ptys.get(terminal_id);
      if (!s) return ok({ ok: false, error: "terminal_id not found" });
      const slice = s.buffer.slice(offset);
      return ok({ ok: true, terminal_id, output: trunc(slice, 12000), next_offset: s.buffer.length });
    } catch (e) { return err(e); }
  },
});

export const resizeTerminal = defineTool({
  name: "resize_terminal",
  description: "Resize a PTY.",
  parameters: z.object({ project_id: z.string(), terminal_id: z.string(), cols: z.number().int().positive(), rows: z.number().int().positive() }),
  execute: async ({ project_id, terminal_id, cols, rows }) => {
    try {
      const { record } = await getOrCreate(project_id);
      const s = record.ptys.get(terminal_id);
      if (!s) return ok({ ok: false, error: "terminal_id not found" });
      await record.sandbox.pty.resize(s.pid, { cols, rows });
      s.cols = cols; s.rows = rows;
      return ok({ ok: true, terminal_id, cols, rows });
    } catch (e) { return err(e); }
  },
});

export const closeTerminal = defineTool({
  name: "close_terminal",
  description: "Kill a PTY session.",
  parameters: z.object({ project_id: z.string(), terminal_id: z.string() }),
  execute: async ({ project_id, terminal_id }) => {
    try {
      const { record } = await getOrCreate(project_id);
      const s = record.ptys.get(terminal_id);
      if (!s) return ok({ ok: false, error: "terminal_id not found" });
      try { await record.sandbox.pty.kill(s.pid); } catch {}
      record.ptys.delete(terminal_id);
      return ok({ ok: true, success: true, terminal_id });
    } catch (e) { return err(e); }
  },
});

// ─── BROWSER AUTOMATION (headless chromium via puppeteer script) ────────────

const BROWSER_DIR = "/tmp/e2b-browser";
const BROWSER_SCRIPT = `${BROWSER_DIR}/session.js`;

async function ensureBrowser(project_id: string) {
  const { record } = await getOrCreate(project_id);
  const check = await record.sandbox.commands.run(
    `test -d ${BROWSER_DIR}/node_modules/puppeteer && echo ok || echo no`,
    { timeoutMs: 5000 },
  );
  if (!(check.stdout ?? "").includes("ok")) {
    await record.sandbox.commands.run(
      `mkdir -p ${BROWSER_DIR} && cd ${BROWSER_DIR} && npm init -y >/dev/null && npm install puppeteer --no-audit --no-fund 2>&1 | tail -20`,
      { timeoutMs: 300_000 },
    );
  }
  return record;
}

async function runBrowserOp(project_id: string, opJson: string, timeoutMs = 60_000) {
  const record = await ensureBrowser(project_id);
  const script = `
const puppeteer = require('puppeteer');
const fs = require('fs');
const STATE = '${BROWSER_DIR}/state.json';
(async () => {
  const op = ${opJson};
  let state = {};
  try { state = JSON.parse(fs.readFileSync(STATE, 'utf-8')); } catch {}
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox','--disable-setuid-sandbox'] });
  try {
    const page = (await browser.pages())[0] || await browser.newPage();
    if (state.url) { try { await page.goto(state.url, { waitUntil: 'domcontentloaded', timeout: 20000 }); } catch {} }
    let result = { ok: true };
    if (op.action === 'navigate') { await page.goto(op.url, { waitUntil: 'domcontentloaded', timeout: 30000 }); state.url = op.url; result.url = page.url(); result.title = await page.title(); }
    else if (op.action === 'click') { await page.click(op.selector); result.clicked = op.selector; }
    else if (op.action === 'type') { await page.type(op.selector, op.text, { delay: 10 }); result.typed = op.selector; }
    else if (op.action === 'screenshot') { const buf = await page.screenshot({ type: 'png', fullPage: !!op.full_page }); fs.writeFileSync(op.path, buf); result.path = op.path; result.bytes = buf.length; }
    else if (op.action === 'evaluate') { result.value = await page.evaluate(new Function('return (' + op.expression + ')')()); }
    else if (op.action === 'download') { const resp = await page.goto(op.url); const buf = await resp.buffer(); fs.writeFileSync(op.path, buf); result.path = op.path; result.bytes = buf.length; }
    else if (op.action === 'open') { result.opened = true; }
    fs.writeFileSync(STATE, JSON.stringify(state));
    console.log('__RESULT__' + JSON.stringify(result));
  } finally { await browser.close(); }
})().catch(e => { console.log('__RESULT__' + JSON.stringify({ ok:false, error: e.message })); process.exit(1); });
`;
  await record.sandbox.files.write(BROWSER_SCRIPT, script);
  const r = await record.sandbox.commands.run(`cd ${BROWSER_DIR} && node session.js`, { timeoutMs });
  const line = (r.stdout ?? "").split("\n").find((l) => l.startsWith("__RESULT__"));
  const parsed = line ? JSON.parse(line.slice("__RESULT__".length)) : { ok: false, error: "no result", raw: r.stdout, stderr: r.stderr };
  return parsed;
}

export const openBrowser = defineTool({
  name: "open_browser",
  description: "Initialise headless chromium session (installs puppeteer on first use). Stateless between calls but persists last URL.",
  parameters: z.object({ project_id: z.string() }),
  execute: async ({ project_id }) => {
    try { const res = await runBrowserOp(project_id, JSON.stringify({ action: "open" }), 300_000); return ok(res); } catch (e) { return err(e); }
  },
});

export const navigate = defineTool({
  name: "navigate",
  description: "Navigate the browser to a URL.",
  parameters: z.object({ project_id: z.string(), url: z.string().url() }),
  execute: async ({ project_id, url }) => {
    try { return ok(await runBrowserOp(project_id, JSON.stringify({ action: "navigate", url }))); } catch (e) { return err(e); }
  },
});

export const clickTool = defineTool({
  name: "click",
  description: "Click an element by CSS selector.",
  parameters: z.object({ project_id: z.string(), selector: z.string() }),
  execute: async ({ project_id, selector }) => {
    try { return ok(await runBrowserOp(project_id, JSON.stringify({ action: "click", selector }))); } catch (e) { return err(e); }
  },
});

export const typeTool = defineTool({
  name: "type",
  description: "Type text into an element by CSS selector.",
  parameters: z.object({ project_id: z.string(), selector: z.string(), text: z.string() }),
  execute: async ({ project_id, selector, text }) => {
    try { return ok(await runBrowserOp(project_id, JSON.stringify({ action: "type", selector, text }))); } catch (e) { return err(e); }
  },
});

export const screenshot = defineTool({
  name: "screenshot",
  description: "Capture a PNG screenshot to sandbox path (default /tmp/screenshot.png).",
  parameters: z.object({ project_id: z.string(), path: z.string().default("/tmp/screenshot.png"), full_page: z.boolean().default(false) }),
  execute: async ({ project_id, path, full_page }) => {
    try { return ok(await runBrowserOp(project_id, JSON.stringify({ action: "screenshot", path, full_page }))); } catch (e) { return err(e); }
  },
});

export const evaluate = defineTool({
  name: "evaluate",
  description: "Evaluate a JavaScript expression in the current page and return its value.",
  parameters: z.object({ project_id: z.string(), expression: z.string() }),
  execute: async ({ project_id, expression }) => {
    try { return ok(await runBrowserOp(project_id, JSON.stringify({ action: "evaluate", expression }))); } catch (e) { return err(e); }
  },
});

export const downloadTool = defineTool({
  name: "download",
  description: "Download a file from a URL to sandbox path via the browser session.",
  parameters: z.object({ project_id: z.string(), url: z.string().url(), path: z.string() }),
  execute: async ({ project_id, url, path }) => {
    try { return ok(await runBrowserOp(project_id, JSON.stringify({ action: "download", url, path }), 120_000)); } catch (e) { return err(e); }
  },
});

export const allExtendedTools = [
  runCommand, getProcessStatus, getProcessLogs, stopProcess, listProcesses,
  listPorts, getPublicUrl, closePublicUrl,
  readFile, writeFile, editFile, deleteFile, moveFile, copyFile, listDirectory, searchFiles, grep,
  detectProject, installDependencies, runProject, buildProject, testProject,
  systemInfo, listEnvironmentVariables, setEnvironmentVariable,
  gitStatus, gitDiff, gitCommit, gitBranch, gitCheckout, gitClone,
  createTerminal, sendTerminalInput, readTerminalOutput, resizeTerminal, closeTerminal,
  openBrowser, navigate, clickTool, typeTool, screenshot, evaluate, downloadTool,
];
