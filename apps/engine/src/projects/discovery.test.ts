import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeRepositoryFixture } from "../../test/repository-fixture.ts";
import {
  discoverRepository,
  requireRepositoryDirectory,
  slugify,
} from "./discovery.ts";

describe("slugify", () => {
  it("produces ids the Project Config schema accepts", () => {
    const pattern = /^[a-z0-9][a-z0-9._-]*$/;
    for (const [input, expected] of [
      ["Token Warehouse", "token-warehouse"],
      ["My.Repo_v2", "my.repo_v2"],
      ["  spaced  ", "spaced"],
      ["--leading", "leading"],
    ] as const) {
      expect(slugify(input)).toBe(expected);
      expect(slugify(input)).toMatch(pattern);
    }
  });

  it("keeps an id valid when the name starts with a symbol", () => {
    expect(slugify("@scope/pkg")).toMatch(/^[a-z0-9][a-z0-9._-]*$/);
  });
});

describe("requireRepositoryDirectory", () => {
  it("refuses anything that is not an existing absolute directory", () => {
    for (const value of [
      "",
      "   ",
      "relative/path",
      "/definitely/not/here",
      42,
      null,
    ]) {
      expect(() => requireRepositoryDirectory(value)).toThrow();
    }
  });
});

describe("discoverRepository", () => {
  const roots: string[] = [];

  function fixture(...args: Parameters<typeof makeRepositoryFixture>): string {
    const root = makeRepositoryFixture(...args);
    roots.push(root);
    return root;
  }

  afterEach(() => {
    for (const root of roots.splice(0))
      rmSync(root, { recursive: true, force: true });
  });

  it("prefers the origin remote over other remotes", () => {
    const root = fixture();
    writeFileSync(
      join(root, ".git", "config"),
      [
        '[remote "upstream"]',
        "\turl = git@github.com:upstream/repo.git",
        '[remote "origin"]',
        "\turl = git@github.com:mine/repo.git",
        "",
      ].join("\n"),
      "utf8",
    );
    expect(discoverRepository(root).remoteUrl).toBe(
      "git@github.com:mine/repo.git",
    );
  });

  it("falls back to the only remote when there is no origin", () => {
    const root = fixture();
    writeFileSync(
      join(root, ".git", "config"),
      ['[remote "fork"]', "\turl = https://gitlab.com/team/repo.git", ""].join(
        "\n",
      ),
      "utf8",
    );
    const discovery = discoverRepository(root);
    expect(discovery.remoteUrl).toBe("https://gitlab.com/team/repo.git");
    expect(discovery.provider).toBe("gitlab");
  });

  it("reports no branch for a detached HEAD", () => {
    const root = fixture();
    writeFileSync(join(root, ".git", "HEAD"), "9fceb02b4f2e1e0c\n", "utf8");
    expect(discoverRepository(root).defaultBranch).toBeNull();
  });

  it("prefers the pnpm lockfile when several are present", () => {
    const root = fixture({
      lockfile: "pnpm-lock.yaml",
      packageJson: { name: "x" },
    });
    writeFileSync(join(root, "package-lock.json"), "", "utf8");
    expect(discoverRepository(root).packageManager).toBe("pnpm");
  });

  it("assumes npm when a manifest exists with no lockfile", () => {
    const root = fixture({ packageJson: { name: "x" } });
    expect(discoverRepository(root).packageManager).toBe("npm");
  });

  it("ignores non-string script entries and malformed manifests", () => {
    const root = fixture({
      packageJson: { scripts: { test: "vitest", broken: 12 } },
    });
    expect(discoverRepository(root).scripts).toEqual({ test: "vitest" });

    const broken = fixture();
    writeFileSync(join(broken, "package.json"), "{ not json", "utf8");
    expect(discoverRepository(broken).scripts).toEqual({});
  });

  it("suggests commands only for scripts the project actually declares", () => {
    const root = fixture({
      lockfile: "pnpm-lock.yaml",
      packageJson: { scripts: { test: "vitest", lint: "eslint ." } },
    });
    const suggested = discoverRepository(root).suggested as {
      commands: Record<string, string>;
    };
    expect(suggested.commands).toEqual({
      install: "pnpm install --frozen-lockfile",
      lint: "pnpm lint",
      test: "pnpm test",
    });
  });

  it("never suggests an absolute path as a repository root", () => {
    const root = fixture();
    const suggested = discoverRepository(root).suggested as {
      repositories: { root: string }[];
    };
    expect(suggested.repositories[0]?.root).toBe(".");
  });

  it("describes a plain directory without inventing git details", () => {
    const bare = mkdtempSync(join(tmpdir(), "jarvis-plain-"));
    roots.push(bare);
    const discovery = discoverRepository(bare);
    expect(discovery).toMatchObject({
      isGitRepository: false,
      remoteUrl: null,
      provider: null,
      defaultBranch: null,
    });
  });
});
