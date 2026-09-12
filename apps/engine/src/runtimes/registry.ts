import type Database from "better-sqlite3";
import { CodexRuntime } from "../../../../packages/agent-runtime/src/codex-runtime.js";
import { RuntimeDetector } from "../../../../packages/agent-runtime/src/detector.js";
import type { RuntimeDescriptor } from "../../../../packages/agent-runtime/src/index.js";

/** The deterministic test runtime is a registry candidate without discovery. */
export const FAKE_RUNTIME_DESCRIPTOR: RuntimeDescriptor = {
  id: "runtime/fake-test",
  provider: "fake",
  displayName: "Fake Runtime",
  executablePath: null,
  version: null,
  capabilities: ["agent.execute"],
  status: "available",
};

interface RuntimeDescriptorRow {
  id: string;
  provider: string;
  display_name: string;
  executable_path: string | null;
  version: string | null;
  capabilities: string;
  status: RuntimeDescriptor["status"];
}

/** Durable engine-local storage for global Runtime Descriptors. */
export class RuntimeDescriptorStore {
  public constructor(private readonly db: Database.Database) {
    this.db
      .prepare(
        `INSERT INTO runtime_descriptors
           (id, provider, display_name, executable_path, version, capabilities, status)
         VALUES (@id, @provider, @displayName, @executablePath, @version, @capabilities, @status)
         ON CONFLICT(id) DO NOTHING`,
      )
      .run(toParameters(FAKE_RUNTIME_DESCRIPTOR));
  }

  public upsert(descriptor: RuntimeDescriptor): void {
    this.db
      .prepare(
        `INSERT INTO runtime_descriptors
           (id, provider, display_name, executable_path, version, capabilities, status)
         VALUES (@id, @provider, @displayName, @executablePath, @version, @capabilities, @status)
         ON CONFLICT(id) DO UPDATE SET
           provider = excluded.provider,
           display_name = excluded.display_name,
           executable_path = excluded.executable_path,
           version = excluded.version,
           capabilities = excluded.capabilities,
           status = excluded.status`,
      )
      .run(toParameters(descriptor));
  }

  public list(): RuntimeDescriptor[] {
    const rows = this.db
      .prepare(
        `SELECT id, provider, display_name, executable_path, version, capabilities, status
         FROM runtime_descriptors
         ORDER BY id COLLATE BINARY ASC`,
      )
      .all() as RuntimeDescriptorRow[];
    return rows.map(toDescriptor);
  }
}

export interface RuntimeRegistryOptions {
  /** Injectable detector seam for Application Harness and unit tests. */
  readonly detector?: Pick<RuntimeDetector, "detect">;
  readonly knownCodexExecutablePaths?: readonly string[];
  readonly allowShellProbe?: boolean;
}

/** Global runtime inventory: list persisted descriptors or refresh providers. */
export class RuntimeRegistry {
  private readonly store: RuntimeDescriptorStore;
  private readonly detector: Pick<RuntimeDetector, "detect">;

  public constructor(db: Database.Database, options: RuntimeRegistryOptions = {}) {
    this.store = new RuntimeDescriptorStore(db);
    this.detector =
      options.detector ??
      new RuntimeDetector({
        knownExecutablePaths: options.knownCodexExecutablePaths ?? defaultCodexExecutablePaths(),
        ...(options.allowShellProbe === undefined
          ? {}
          : { allowShellProbe: options.allowShellProbe }),
      });
  }

  public list(): RuntimeDescriptor[] {
    return this.store.list();
  }

  public async discover(): Promise<RuntimeDescriptor[]> {
    const executablePath = await this.detector.detect("codex");
    const descriptor = await new CodexRuntime(executablePath).describe(
      detectedRuntimeEnvironment(),
    );
    this.store.upsert(descriptor);
    return this.store.list();
  }
}

function defaultCodexExecutablePaths(): readonly string[] {
  if (process.platform === "win32") {
    return ["C:\\Program Files\\Codex\\codex.exe"];
  }
  return ["/opt/homebrew/bin/codex", "/usr/local/bin/codex", "/usr/bin/codex", "/bin/codex"];
}

function toParameters(descriptor: RuntimeDescriptor): {
  id: string;
  provider: string;
  displayName: string;
  executablePath: string | null;
  version: string | null;
  capabilities: string;
  status: RuntimeDescriptor["status"];
} {
  return {
    id: descriptor.id,
    provider: descriptor.provider,
    displayName: descriptor.displayName,
    executablePath: descriptor.executablePath,
    version: descriptor.version,
    capabilities: JSON.stringify(descriptor.capabilities),
    status: descriptor.status,
  };
}

function toDescriptor(row: RuntimeDescriptorRow): RuntimeDescriptor {
  const capabilities = JSON.parse(row.capabilities) as unknown;
  if (!Array.isArray(capabilities) || !capabilities.every((value) => typeof value === "string")) {
    throw new Error(`Runtime descriptor ${row.id} has invalid capabilities.`);
  }

  return {
    id: row.id,
    provider: row.provider,
    displayName: row.display_name,
    executablePath: row.executable_path,
    version: row.version,
    capabilities: [...capabilities],
    status: row.status,
  };
}

/** Candidate profile only. A Project must explicitly approve it before use. */
export function detectedRuntimeEnvironment(): Record<string, string> {
  return Object.fromEntries(
    ["PATH", "HOME", "CODEX_HOME"].flatMap((name) => {
      const value = process.env[name];
      return typeof value === "string" && value.trim() !== "" ? [[name, value]] : [];
    }),
  );
}
