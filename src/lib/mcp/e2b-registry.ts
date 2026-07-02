import { Sandbox } from "e2b";

export const DEFAULT_WORKDIR = "/home/user/workspace";
const SANDBOX_TIMEOUT_MS = 60 * 60 * 1000; // 1 hour

export interface SandboxRecord {
  sandbox: Sandbox;
  sandboxId: string;
  createdAt: number;
  lastUsedAt: number;
  recreateCount: number;
}

const registry = new Map<string, SandboxRecord>();

function requireApiKey(): string {
  const key = process.env.E2B_API_KEY;
  if (!key) throw new Error("E2B_API_KEY is not configured");
  return key;
}

async function probeAlive(sb: Sandbox): Promise<boolean> {
  try {
    return await sb.isRunning();
  } catch {
    return false;
  }
}

async function newSandbox(): Promise<Sandbox> {
  const apiKey = requireApiKey();
  const template = process.env.E2B_TEMPLATE_ID;
  const sb = template
    ? await Sandbox.create(template, { apiKey, timeoutMs: SANDBOX_TIMEOUT_MS })
    : await Sandbox.create({ apiKey, timeoutMs: SANDBOX_TIMEOUT_MS });
  try {
    await sb.commands.run(`mkdir -p ${DEFAULT_WORKDIR}`, { timeoutMs: 10_000 });
  } catch {
    // ignore
  }
  return sb;
}

export interface GetOrCreateResult {
  record: SandboxRecord;
  isNew: boolean;
  reconnected: boolean;
}

export async function getOrCreate(projectId: string): Promise<GetOrCreateResult> {
  const existing = registry.get(projectId);
  if (!existing) {
    const sb = await newSandbox();
    const rec: SandboxRecord = {
      sandbox: sb,
      sandboxId: sb.sandboxId,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      recreateCount: 0,
    };
    registry.set(projectId, rec);
    return { record: rec, isNew: true, reconnected: false };
  }

  if (await probeAlive(existing.sandbox)) {
    existing.lastUsedAt = Date.now();
    return { record: existing, isNew: false, reconnected: false };
  }

  const sb = await newSandbox();
  existing.sandbox = sb;
  existing.sandboxId = sb.sandboxId;
  existing.createdAt = Date.now();
  existing.lastUsedAt = Date.now();
  existing.recreateCount += 1;
  return { record: existing, isNew: false, reconnected: true };
}

export function peek(projectId: string): SandboxRecord | undefined {
  return registry.get(projectId);
}

export function remove(projectId: string): SandboxRecord | undefined {
  const rec = registry.get(projectId);
  if (rec) registry.delete(projectId);
  return rec;
}

export function listAll(): Array<{ projectId: string; record: SandboxRecord }> {
  return Array.from(registry.entries()).map(([projectId, record]) => ({ projectId, record }));
}

export function uptimeSeconds(rec: SandboxRecord): number {
  return Math.round((Date.now() - rec.createdAt) / 100) / 10;
}

export function absPath(rel: string): string {
  const trimmed = (rel || ".").replace(/^\/+/, "");
  return trimmed === "" || trimmed === "." ? DEFAULT_WORKDIR : `${DEFAULT_WORKDIR}/${trimmed}`;
}

export { probeAlive };