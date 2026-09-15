import Database from "better-sqlite3";
import { join } from "node:path";
import { SystemClock } from "../../../packages/kernel/src/clock.js";
import type { ProjectValidationReport } from "../../../packages/project-runtime/src/project-types.js";
import { ProjectRepositoryResolver } from "../src/projects/repository-resolution.js";
import { ProjectStore } from "../src/projects/store.js";
import type { Harness } from "./harness.js";

/** Downstream consumer fixture only: not evidence of public activation/preflight.
 * Some scenarios intentionally start with unavailable tools or no GitHub module.
 * Keep real persistence, routing and modules; freeze the structurally validated setup.
 */
export async function seedActivatedConsumerProject(
  engine: Harness,
  projectId: string,
): Promise<void> {
  const response = await engine.call(`/v1/projects/${projectId}/validation-report`, {
    method: "POST",
  });
  const report = (await response.json()) as ProjectValidationReport;
  if (response.status !== 200 || !report.valid || !report.compositionFingerprint) {
    throw new Error(`Invalid consumer fixture: ${JSON.stringify(report)}`);
  }
  const database = new Database(join(engine.dataRoot, "jarvis.sqlite"));
  try {
    const store = new ProjectStore(database, new SystemClock());
    const project = store.findById(projectId);
    if (!project) throw new Error(`Missing consumer fixture: ${projectId}`);
    const { repositoryIdentities } = new ProjectRepositoryResolver().validate(
      project.portableConfig,
      project.repositoryPath,
    );
    store.activateProject(projectId, report.compositionFingerprint, {
      composition: project.portableConfig,
      moduleInstances: project.portableConfig.modules,
      bindings: {
        slots: project.slotBindings,
        repository: { path: project.repositoryPath, bookmarkRef: project.bookmarkRef },
      },
      requestRoutes: report.requestRoutes,
      ...(repositoryIdentities.length ? { repositoryIdentities } : {}),
    });
  } finally {
    database.close();
  }
}
