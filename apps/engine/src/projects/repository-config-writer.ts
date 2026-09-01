import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
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

export interface ProjectConfigurationCompensation {
  restore(): void;
}

export interface ProjectConfigurationWriter {
  write(
    repositoryPath: string,
    configuration: StoredPortableProjectConfiguration,
  ): ProjectConfigurationCompensation;
}

/** Filesystem adapter for an atomic private sibling write followed by rename. */
export class AtomicProjectConfigurationWriter implements ProjectConfigurationWriter {
  write(
    repositoryPath: string,
    configuration: StoredPortableProjectConfiguration,
  ): ProjectConfigurationCompensation {
    const destination = join(repositoryPath, ".jarvis", "project.yaml");
    const previous = readDurableConfiguration(repositoryPath, destination);
    replaceFile(repositoryPath, destination, stringifyYaml(configuration));
    return {
      restore: () => {
        if (previous === undefined) {
          rmSync(destination, { force: true });
          return;
        }
        replaceFile(repositoryPath, destination, previous);
      },
    };
  }
}

function readDurableConfiguration(repositoryPath: string, destination: string): Buffer | undefined {
  ensurePrivateProjectDirectory(repositoryPath, dirname(destination));
  try {
    const stats = lstatSync(destination);
    if (stats.isSymbolicLink() || !stats.isFile()) throw writeFailure();
    return readFileSync(destination);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    if (error instanceof EngineError) throw error;
    throw writeFailure();
  }
}

function replaceFile(repositoryPath: string, destination: string, content: string | Buffer): void {
  const directory = dirname(destination);
  const temporary = join(directory, `.project.yaml.${randomUUID()}.tmp`);
  try {
    ensurePrivateProjectDirectory(repositoryPath, directory);
    writeFileSync(temporary, content, { mode: 0o600, flag: "wx" });
    chmodSync(temporary, 0o600);
    renameSync(temporary, destination);
  } catch (error) {
    rmSync(temporary, { force: true });
    if (error instanceof EngineError) throw error;
    throw writeFailure();
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
