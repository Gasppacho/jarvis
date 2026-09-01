import type Database from "better-sqlite3";
import type { PortableProjectConfig, ProjectStatus } from "./types.js";

/**
 * Persistence for the Project Registry: the `projects` and `project_bindings`
 * tables (PERSISTENCE.md: owned by the Project Runtime, project-scoped).
 * Everything the engine knows about a project is in exactly one row pair.
 */

export interface ProjectRow {
  readonly id: string;
  readonly name: string;
  readonly status: ProjectStatus;
  readonly portableConfig: PortableProjectConfig;
  readonly repositoryPath: string;
  readonly bookmarkRef: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface NewProject {
  readonly id: string;
  readonly name: string;
  readonly status: ProjectStatus;
  readonly portableConfig: PortableProjectConfig;
  /** Canonical absolute path of the repository on this machine. */
  readonly repositoryPath: string;
  readonly bookmarkRef?: string | null;
}

interface ProjectRecord {
  id: string;
  name: string;
  status: string;
  portable_config: string;
  created_at: string;
  updated_at: string;
}

interface BindingRecord {
  project_id: string;
  repository_path: string;
  bookmark_ref: string | null;
}

export class ProjectStore {
  constructor(private readonly db: Database.Database) {}

  /**
   * Inserts the row pair in one transaction. Uniqueness violations surface as
   * the driver's `SqliteError` (`SQLITE_CONSTRAINT_UNIQUE`); the service turns
   * those into stable API codes.
   */
  createProject(project: NewProject): ProjectRow {
    const now = new Date().toISOString();
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO projects (id, name, status, portable_config, created_at, updated_at)
             VALUES (@id, @name, @status, @portableConfig, @now, @now)`,
        )
        .run({
          id: project.id,
          name: project.name,
          status: project.status,
          portableConfig: JSON.stringify(project.portableConfig),
          now,
        });
      this.db
        .prepare(
          `INSERT INTO project_bindings (project_id, repository_path, bookmark_ref)
             VALUES (@id, @path, @bookmark)`,
        )
        .run({
          id: project.id,
          path: project.repositoryPath,
          bookmark: project.bookmarkRef ?? null,
        });
    })();
    return {
      id: project.id,
      name: project.name,
      status: project.status,
      portableConfig: project.portableConfig,
      repositoryPath: project.repositoryPath,
      bookmarkRef: project.bookmarkRef ?? null,
      createdAt: now,
      updatedAt: now,
    };
  }

  findById(id: string): ProjectRow | undefined {
    const record = this.db
      .prepare(
        `SELECT p.id, p.name, p.status, p.portable_config, p.created_at, p.updated_at,
                b.repository_path, b.bookmark_ref
         FROM projects p
         JOIN project_bindings b ON b.project_id = p.id
         WHERE p.id = ?`,
      )
      .get(id) as (ProjectRecord & BindingRecord) | undefined;
    return record === undefined ? undefined : toRow(record);
  }

  /** The unique index on the canonical path is what catches re-imports. */
  findByRepositoryPath(repositoryPath: string): ProjectRow | undefined {
    const record = this.db
      .prepare(
        `SELECT p.id, p.name, p.status, p.portable_config, p.created_at, p.updated_at,
                b.repository_path, b.bookmark_ref
         FROM projects p
         JOIN project_bindings b ON b.project_id = p.id
         WHERE b.repository_path = ?`,
      )
      .get(repositoryPath) as (ProjectRecord & BindingRecord) | undefined;
    return record === undefined ? undefined : toRow(record);
  }

  existsById(id: string): boolean {
    return this.db.prepare("SELECT 1 FROM projects WHERE id = ?").get(id) !== undefined;
  }

  updateRepositoryBinding(
    projectId: string,
    repositoryPath: string,
    bookmarkRef: string,
  ): ProjectRow | undefined {
    const result = this.db
      .prepare(
        `UPDATE project_bindings
         SET repository_path = ?, bookmark_ref = ?
         WHERE project_id = ?`,
      )
      .run(repositoryPath, bookmarkRef, projectId);
    if (result.changes === 0) return undefined;
    return this.findById(projectId);
  }

  list(): ProjectRow[] {
    const records = this.db
      .prepare(
        `SELECT p.id, p.name, p.status, p.portable_config, p.created_at, p.updated_at,
                b.repository_path, b.bookmark_ref
         FROM projects p
         JOIN project_bindings b ON b.project_id = p.id
         ORDER BY p.name COLLATE NOCASE, p.id`,
      )
      .all() as (ProjectRecord & BindingRecord)[];
    return records.map(toRow);
  }
}

function toRow(record: ProjectRecord & BindingRecord): ProjectRow {
  return {
    id: record.id,
    name: record.name,
    status: record.status as ProjectStatus,
    portableConfig: JSON.parse(record.portable_config) as PortableProjectConfig,
    repositoryPath: record.repository_path,
    bookmarkRef: record.bookmark_ref,
    createdAt: record.created_at,
    updatedAt: record.updated_at,
  };
}
