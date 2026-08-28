import type { Database } from "better-sqlite3";

export interface RepositoryBinding {
  readonly repositoryId: string;
  readonly path: string;
  readonly bookmarkRef: string | null;
}

export interface ProjectRecord {
  readonly id: string;
  readonly name: string;
  readonly status: string;
  readonly portableConfig: Record<string, unknown>;
  readonly repositories: readonly RepositoryBinding[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface ProjectRow {
  id: string;
  name: string;
  status: string;
  portable_config: string;
  created_at: string;
  updated_at: string;
}

interface BindingRow {
  repository_id: string;
  path: string;
  bookmark_ref: string | null;
}

/** SQLite access for the `projects` and `project_bindings` tables. */
export class ProjectStore {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  insert(record: ProjectRecord): void {
    const insertProject = this.db.prepare(
      `INSERT INTO projects (id, name, status, portable_config, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const insertBinding = this.db.prepare(
      `INSERT INTO project_bindings (project_id, repository_id, path, bookmark_ref)
       VALUES (?, ?, ?, ?)`,
    );

    this.db.transaction(() => {
      insertProject.run(
        record.id,
        record.name,
        record.status,
        JSON.stringify(record.portableConfig),
        record.createdAt,
        record.updatedAt,
      );
      for (const repository of record.repositories) {
        insertBinding.run(
          record.id,
          repository.repositoryId,
          repository.path,
          repository.bookmarkRef,
        );
      }
    })();
  }

  list(): ProjectRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM projects ORDER BY created_at, id")
      .all() as ProjectRow[];
    return rows.map((row) => this.hydrate(row));
  }

  find(id: string): ProjectRecord | null {
    const row = this.db
      .prepare("SELECT * FROM projects WHERE id = ?")
      .get(id) as ProjectRow | undefined;
    return row === undefined ? null : this.hydrate(row);
  }

  existsWithId(id: string): boolean {
    return (
      this.db.prepare("SELECT 1 FROM projects WHERE id = ?").get(id) !==
      undefined
    );
  }

  findByRepositoryPath(path: string): string | null {
    const row = this.db
      .prepare("SELECT project_id FROM project_bindings WHERE path = ?")
      .get(path) as { project_id: string } | undefined;
    return row?.project_id ?? null;
  }

  private hydrate(row: ProjectRow): ProjectRecord {
    const bindings = this.db
      .prepare(
        "SELECT repository_id, path, bookmark_ref FROM project_bindings WHERE project_id = ?",
      )
      .all(row.id) as BindingRow[];

    return {
      id: row.id,
      name: row.name,
      status: row.status,
      portableConfig: JSON.parse(row.portable_config) as Record<
        string,
        unknown
      >,
      repositories: bindings.map((binding) => ({
        repositoryId: binding.repository_id,
        path: binding.path,
        bookmarkRef: binding.bookmark_ref,
      })),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
