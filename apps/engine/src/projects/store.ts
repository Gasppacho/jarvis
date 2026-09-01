import type Database from "better-sqlite3";
import type { Clock } from "../../../../packages/kernel/src/clock.js";
import type {
  ProjectBindings,
  StoredPortableProjectConfiguration,
} from "../../../../packages/project-runtime/src/project-types.js";
import type { ProjectStatus } from "./types.js";

export interface ProjectRow {
  readonly id: string;
  readonly name: string;
  readonly status: ProjectStatus;
  readonly portableConfig: StoredPortableProjectConfiguration;
  readonly repositoryPath: string;
  readonly bookmarkRef: string | null;
  readonly slotBindings: ProjectBindings["slots"];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface NewProject {
  readonly id: string;
  readonly name: string;
  readonly status: ProjectStatus;
  readonly portableConfig: StoredPortableProjectConfiguration;
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
  slot_bindings: string;
}

const SELECT_PROJECT = `SELECT p.id, p.name, p.status, p.portable_config, p.created_at, p.updated_at,
  b.repository_path, b.bookmark_ref, b.slot_bindings
  FROM projects p JOIN project_bindings b ON b.project_id = p.id`;

export class ProjectStore {
  constructor(
    private readonly db: Database.Database,
    private readonly clock: Clock,
  ) {}

  createProject(project: NewProject): ProjectRow {
    const now = this.clock.now().toISOString();
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
          `INSERT INTO project_bindings (project_id, repository_path, bookmark_ref, slot_bindings)
         VALUES (@id, @path, @bookmark, '{}')`,
        )
        .run({
          id: project.id,
          path: project.repositoryPath,
          bookmark: project.bookmarkRef ?? null,
        });
    })();
    return {
      ...project,
      bookmarkRef: project.bookmarkRef ?? null,
      slotBindings: {},
      createdAt: now,
      updatedAt: now,
    };
  }

  findById(id: string): ProjectRow | undefined {
    const record = this.db.prepare(`${SELECT_PROJECT} WHERE p.id = ?`).get(id) as
      (ProjectRecord & BindingRecord) | undefined;
    return record === undefined ? undefined : toRow(record);
  }

  findByRepositoryPath(repositoryPath: string): ProjectRow | undefined {
    const record = this.db
      .prepare(`${SELECT_PROJECT} WHERE b.repository_path = ?`)
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
        `UPDATE project_bindings SET repository_path = ?, bookmark_ref = ? WHERE project_id = ?`,
      )
      .run(repositoryPath, bookmarkRef, projectId);
    return result.changes === 0 ? undefined : this.findById(projectId);
  }

  transaction<Result>(operation: () => Result): Result {
    return this.db.transaction(operation)();
  }

  replaceConfiguration(
    projectId: string,
    configuration: StoredPortableProjectConfiguration,
    name: string,
  ): ProjectRow | undefined {
    const now = this.clock.now().toISOString();
    const result = this.db
      .prepare(
        `UPDATE projects
       SET portable_config = ?, name = ?, status = 'draft', updated_at = ?
       WHERE id = ?`,
      )
      .run(JSON.stringify(configuration), name, now, projectId);
    return result.changes === 0 ? undefined : this.findById(projectId);
  }

  replaceBindings(
    projectId: string,
    repositoryPath: string,
    bookmarkRef: string | null,
    slots: ProjectBindings["slots"],
  ): ProjectRow | undefined {
    const result = this.db
      .prepare(
        `UPDATE project_bindings
       SET repository_path = ?, bookmark_ref = ?, slot_bindings = ?
       WHERE project_id = ?`,
      )
      .run(repositoryPath, bookmarkRef, JSON.stringify(slots), projectId);
    return result.changes === 0 ? undefined : this.findById(projectId);
  }

  list(): ProjectRow[] {
    const records = this.db
      .prepare(`${SELECT_PROJECT} ORDER BY p.name COLLATE NOCASE, p.id`)
      .all() as (ProjectRecord & BindingRecord)[];
    return records.map(toRow);
  }
}

function toRow(record: ProjectRecord & BindingRecord): ProjectRow {
  return {
    id: record.id,
    name: record.name,
    status: record.status as ProjectStatus,
    portableConfig: JSON.parse(record.portable_config) as StoredPortableProjectConfiguration,
    repositoryPath: record.repository_path,
    bookmarkRef: record.bookmark_ref,
    slotBindings: JSON.parse(record.slot_bindings) as ProjectBindings["slots"],
    createdAt: record.created_at,
    updatedAt: record.updated_at,
  };
}
