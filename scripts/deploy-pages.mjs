import { execSync } from "node:child_process";

function parseRepositoryName(remoteUrl) {
  if (!remoteUrl) {
    return "";
  }

  const trimmed = remoteUrl.trim().replace(/\.git$/, "");

  if (trimmed.includes("://")) {
    const parts = trimmed.split("/");
    return parts[parts.length - 1] || "";
  }

  const sshParts = trimmed.split(":");
  if (sshParts.length > 1) {
    const repoPath = sshParts[sshParts.length - 1];
    const parts = repoPath.split("/");
    return parts[parts.length - 1] || "";
  }

  return "";
}

function resolveRepositoryName() {
  if (process.env.GITHUB_REPOSITORY) {
    const name = process.env.GITHUB_REPOSITORY.split("/")[1];
    if (name) {
      return name;
    }
  }

  try {
    const remote = execSync("git config --get remote.origin.url", {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const parsedName = parseRepositoryName(remote);
    if (parsedName) {
      return parsedName;
    }
  } catch {
    // ignore and fallback below
  }

  return process.env.npm_package_name || "friend-guest-book";
}

function runCommand(command, env) {
  execSync(command, {
    stdio: "inherit",
    env,
  });
}

const isDryRun = process.argv.includes("--dry-run");
const repositoryName = resolveRepositoryName();
const basePath = `/${repositoryName}/`;
const env = {
  ...process.env,
  VITE_BASE_PATH: basePath,
};

console.log(`[deploy] repository: ${repositoryName}`);
console.log(`[deploy] VITE_BASE_PATH: ${basePath}`);
console.log("[deploy] building project...");
runCommand("npm run build", env);

if (isDryRun) {
  console.log("[deploy] dry-run mode: build completed, publish step skipped.");
} else {
  const deployCommand = "npx gh-pages -d dist";
  console.log(`[deploy] publishing dist with command: ${deployCommand}`);
  runCommand(deployCommand, env);
}
