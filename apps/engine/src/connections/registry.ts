import type Database from "better-sqlite3";

export type ConnectionStatus = "available" | "unauthenticated" | "unavailable" | "revoked";

export interface ConnectionDescriptor {
  readonly id: string;
  readonly provider: string;
  readonly accountLabel: string;
  readonly capabilities: string[];
  readonly status: ConnectionStatus;
  /** Opaque Keychain reference; never the credential itself. */
  readonly secretRef: string;
}

export type ConnectionRegistration = Omit<ConnectionDescriptor, "status">;

interface ConnectionDescriptorRow {
  id: string;
  provider: string;
  account_label: string;
  capabilities: string;
  status: ConnectionStatus;
  secret_ref: string;
}

/** Durable engine-local storage for global Connection Descriptors. */
export class ConnectionDescriptorStore {
  public constructor(private readonly db: Database.Database) {}

  public upsert(descriptor: ConnectionDescriptor): void {
    this.db
      .prepare(
        `INSERT INTO connections
           (id, provider, account_label, capabilities, status, secret_ref)
         VALUES (@id, @provider, @accountLabel, @capabilities, @status, @secretRef)
         ON CONFLICT(id) DO UPDATE SET
           provider = excluded.provider,
           account_label = excluded.account_label,
           capabilities = excluded.capabilities,
           status = excluded.status,
           secret_ref = excluded.secret_ref`,
      )
      .run(toParameters(descriptor));
  }

  public find(id: string): ConnectionDescriptor | undefined {
    const row = this.db
      .prepare(
        `SELECT id, provider, account_label, capabilities, status, secret_ref
         FROM connections
         WHERE id = ?`,
      )
      .get(id) as ConnectionDescriptorRow | undefined;
    return row === undefined ? undefined : toDescriptor(row);
  }

  public list(): ConnectionDescriptor[] {
    const rows = this.db
      .prepare(
        `SELECT id, provider, account_label, capabilities, status, secret_ref
         FROM connections
         ORDER BY id COLLATE BINARY ASC`,
      )
      .all() as ConnectionDescriptorRow[];
    return rows.map(toDescriptor);
  }
}

/** Global connection inventory; registration starts a descriptor unauthenticated. */
export class ConnectionRegistry {
  private readonly store: ConnectionDescriptorStore;

  public constructor(db: Database.Database) {
    this.store = new ConnectionDescriptorStore(db);
  }

  public register(registration: ConnectionRegistration): ConnectionDescriptor {
    const descriptor: ConnectionDescriptor = {
      ...registration,
      capabilities: [...registration.capabilities],
      status: "unauthenticated",
    };
    this.store.upsert(descriptor);
    return this.store.find(descriptor.id) ?? descriptor;
  }

  public upsert(descriptor: ConnectionDescriptor): void {
    this.store.upsert(descriptor);
  }

  public find(id: string): ConnectionDescriptor | undefined {
    return this.store.find(id);
  }

  public list(): ConnectionDescriptor[] {
    return this.store.list();
  }
}

function toParameters(descriptor: ConnectionDescriptor): {
  id: string;
  provider: string;
  accountLabel: string;
  capabilities: string;
  status: ConnectionStatus;
  secretRef: string;
} {
  return {
    id: descriptor.id,
    provider: descriptor.provider,
    accountLabel: descriptor.accountLabel,
    capabilities: JSON.stringify(descriptor.capabilities),
    status: descriptor.status,
    secretRef: descriptor.secretRef,
  };
}

function toDescriptor(row: ConnectionDescriptorRow): ConnectionDescriptor {
  const capabilities = JSON.parse(row.capabilities) as unknown;
  if (!Array.isArray(capabilities) || !capabilities.every((value) => typeof value === "string")) {
    throw new Error(`Connection descriptor ${row.id} has invalid capabilities.`);
  }

  return {
    id: row.id,
    provider: row.provider,
    accountLabel: row.account_label,
    capabilities: [...capabilities],
    status: row.status,
    secretRef: row.secret_ref,
  };
}
