import { statSync } from "node:fs";

/** Engine adapter for local repository availability checks. */
export interface RepositoryAccessibilityPort {
  isAccessibleDirectory(path: string): boolean;
}

export class LocalRepositoryAccessibility implements RepositoryAccessibilityPort {
  public isAccessibleDirectory(path: string): boolean {
    try {
      return statSync(path).isDirectory();
    } catch {
      return false;
    }
  }
}
