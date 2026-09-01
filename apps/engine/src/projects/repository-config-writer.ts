import {
  chmodSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join, relative } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import type { StoredPortableProjectConfiguration } from "./types.js";
import { EngineError } from "../errors.js";

export interface ProjectConfigurationWriter {
  write(repositoryPath: string, configuration: StoredPortableProjectConfiguration): void;
}

/** Filesystem adapter for an atomic private sibling write followed by rename. */
export class AtomicProjectConfigurationWriter implements ProjectConfigurationWriter {
  write(repositoryPath: string, configuration: StoredPortableProjectConfiguration): void {
    const destination = join(repositoryPath, ".jarvis", "project.yaml");
    const directory = dirname(destination);
    const temporary = join(directory, `.project.yaml.${randomUUID()}.tmp`);
    try {
      ensurePrivateProjectDirectory(repositoryPath, directory);
      writeFileSync(temporary, stringifyYaml(configuration), {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      chmodSync(temporary, 0o600);
      renameSync(temporary, destination);
    } catch (error) {
      rmSync(temporary, { force: true });
      if (error instanceof EngineError) throw error;
      throw writeFailure();
    }
  }
}

function ensurePrivateProjectDirectory(repositoryPath: string, directory: string): void {
  try {
    const stats = lstatSync(directory);
    if (stats.isSymbolicLink() || !stats.isDirectory()) throw writeFailure();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    mkdirSync(directory, { mode: 0o700 });
  }
  const canonicalRepository = realpathSync(repositoryPath);
  const canonicalDirectory = realpathSync(directory);
  const child = relative(canonicalRepository, canonicalDirectory);
  if (child !== ".jarvis" || child.startsWith("..")) throw writeFailure();
}

function writeFailure(): EngineError {
  return new EngineError(
    "project.repository-write-failed",
    500,
    "The portable configuration could not be written; local project state was not changed.",
  );
}
