import { spawnSync } from "node:child_process";

function runGit(cwd, args) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8"
  });

  if (result.status !== 0) {
    return null;
  }

  return result.stdout.trim();
}

function parseChangedFiles(statusOutput) {
  if (!statusOutput) {
    return [];
  }

  return statusOutput
    .split("\n")
    .map((line) => line.slice(3).trim())
    .filter(Boolean)
    .map((file) => {
      const renameMarker = " -> ";
      if (file.includes(renameMarker)) {
        return file.slice(file.lastIndexOf(renameMarker) + renameMarker.length);
      }
      return file;
    });
}

export function getGitSnapshot(cwd) {
  const gitRoot = runGit(cwd, ["rev-parse", "--show-toplevel"]);

  if (!gitRoot) {
    return {
      git_root: null,
      branch: null,
      head: null,
      changed_files: []
    };
  }

  const branch = runGit(gitRoot, ["branch", "--show-current"]) || runGit(gitRoot, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const head = runGit(gitRoot, ["rev-parse", "HEAD"]);
  const status = runGit(gitRoot, ["status", "--short"]);

  return {
    git_root: gitRoot,
    branch: branch || null,
    head: head || null,
    changed_files: parseChangedFiles(status)
  };
}
