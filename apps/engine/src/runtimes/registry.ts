import type Database from "better-sqlite3";
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

/** Name used by the architecture docs and by later registry consumers. */
export { RuntimeDescriptorStore as RuntimeRegistry };

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
