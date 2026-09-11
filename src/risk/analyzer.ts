import path from "node:path";
import type { StructuredCommand } from "../command/model.js";

export type RiskLevel = "low" | "medium" | "high" | "critical";
export type RiskCategory = "inspect" | "workspace-write" | "workspace-exec" | "network" | "external-write" | "destructive" | "privileged";

export interface RiskAssessment {
  level: RiskLevel;
  categories: RiskCategory[];
  reasons: string[];
  hardDeny: boolean;
}

const INSPECT_PROGRAMS = new Set(["pwd", "ls", "dir", "cat", "head", "tail", "find", "rg", "grep", "which", "where", "type"]);
const EXECUTABLE_PROGRAMS = new Set(["node", "nodejs", "python", "python3", "pytest", "ruby", "php", "perl", "deno", "tsx", "ts-node", "cargo", "go", "make", "gradle", "mvn", "dotnet", "java", "docker"]);
const NETWORK_PROGRAMS = new Set(["curl", "wget", "ssh", "scp", "sftp", "nc", "ncat", "telnet"]);
const WRITE_PROGRAMS = new Set(["touch", "mkdir", "cp", "mv", "install", "chmod", "chown", "truncate"]);
const INLINE_CODE_FLAGS = new Map<string, string[]>([
  ["node", ["-e", "--eval", "-p", "--print"]],
  ["nodejs", ["-e", "--eval", "-p", "--print"]],
  ["python", ["-c"]],
  ["python3", ["-c"]],
  ["pypy", ["-c"]],
  ["pypy3", ["-c"]],
  ["ruby", ["-e"]],
  ["perl", ["-e"]],
  ["php", ["-r"]],
  ["bun", ["-e", "--eval"]]
]);

function addCategory(categories: Set<RiskCategory>, category: RiskCategory): void {
  categories.add(category);
}

function hasAnyArg(args: string[], values: RegExp): boolean {
  return args.some((arg) => values.test(arg.toLowerCase()));
}

function hasInlineCode(command: StructuredCommand, program: string): boolean {
  if (program === "deno" && command.args[0]?.toLowerCase() === "eval") return true;
  const flags = INLINE_CODE_FLAGS.get(program);
  if (!flags) return false;
  return command.args.some((argument) => flags.some((flag) => argument === flag || argument.startsWith(`${flag}=`) || (!flag.startsWith("--") && argument.startsWith(flag) && argument.length > flag.length)));
}

function isRootDestructive(command: StructuredCommand, program: string): boolean {
  if (program === "rm") {
    const recursive = command.args.some((arg) => /^-/u.test(arg) && arg.toLowerCase().includes("r"));
    const targets = command.args.filter((arg) => !arg.startsWith("-"));
    return recursive && targets.some((target) => target === "/" || target === "/*" || target === "~" || target === "~/");
  }
  if (program === "dd") return command.args.some((arg) => /^of=\/dev\//u.test(arg));
  return ["shutdown", "reboot", "mkfs"].includes(program);
}

function gitRisk(command: StructuredCommand, categories: Set<RiskCategory>, reasons: string[]): void {
  const subcommand = command.args.find((arg) => !arg.startsWith("-"))?.toLowerCase() ?? "";
  if (["status", "diff", "log", "show", "branch", "tag", "rev-parse", "ls-files", "describe"].includes(subcommand)) {
    addCategory(categories, "inspect");
    reasons.push(`git ${subcommand} inspects repository state`);
    return;
  }
  if (["commit", "add", "rm", "mv", "apply"].includes(subcommand)) {
    addCategory(categories, "workspace-write");
    reasons.push(`git ${subcommand} changes repository state`);
  }
  if (["reset", "restore", "checkout", "clean"].includes(subcommand)) {
    addCategory(categories, "workspace-write");
    addCategory(categories, "destructive");
    reasons.push(`git ${subcommand} can discard or rewrite workspace changes`);
  }
  if (["fetch", "pull", "clone", "submodule"].includes(subcommand)) {
    addCategory(categories, "network");
    addCategory(categories, "workspace-write");
    reasons.push(`git ${subcommand} accesses a remote and may write the workspace`);
  }
  if (subcommand === "push") {
    addCategory(categories, "network");
    addCategory(categories, "external-write");
    reasons.push("git push writes to an external repository");
  }
}

function packageManagerRisk(command: StructuredCommand, program: string, categories: Set<RiskCategory>, reasons: string[]): void {
  const subcommand = command.args.find((arg) => !arg.startsWith("-"))?.toLowerCase() ?? "";
  if (["install", "ci", "update", "add", "remove", "uninstall", "publish"].includes(subcommand)) {
    addCategory(categories, "workspace-write");
    addCategory(categories, "workspace-exec");
    addCategory(categories, "network");
    reasons.push(`${program} ${subcommand} executes package-manager behavior and may access the network`);
    if (subcommand === "publish") addCategory(categories, "external-write");
    return;
  }
  if (["test", "run", "exec", "build", "start", "lint", "check", "typecheck", "pack"].includes(subcommand)) {
    addCategory(categories, "workspace-exec");
    reasons.push(`${program} ${subcommand} executes project-defined code`);
    return;
  }
  addCategory(categories, "workspace-exec");
  reasons.push(`${program} invokes package-manager behavior`);
}

export function analyzeCommand(command: StructuredCommand): RiskAssessment {
  const categories = new Set<RiskCategory>();
  const reasons: string[] = [];
  const program = path.basename(command.program).toLowerCase();
  let hardDeny = isRootDestructive(command, program);
  const inlineCode = hasInlineCode(command, program);

  if (["sudo", "su", "doas", "runas"].includes(program)) {
    addCategory(categories, "privileged");
    reasons.push("The command requests privileged execution");
  }
  if (["shutdown", "reboot", "mkfs"].includes(program)) {
    addCategory(categories, "destructive");
    hardDeny = true;
    reasons.push("The command can affect the entire machine");
  }
  if (program === "rm") {
    addCategory(categories, "destructive");
    addCategory(categories, "workspace-write");
    reasons.push("rm can delete files");
  }
  if (program === "dd") {
    addCategory(categories, "destructive");
    addCategory(categories, "workspace-write");
    reasons.push("dd can overwrite block devices or files");
  }
  if (program === "git") gitRisk(command, categories, reasons);
  else if (["npm", "npx", "pnpm", "yarn", "bun"].includes(program)) packageManagerRisk(command, program, categories, reasons);
  else if (NETWORK_PROGRAMS.has(program)) {
    addCategory(categories, "network");
    reasons.push(`${program} accesses a network endpoint`);
    if (program !== "ssh" && hasAnyArg(command.args, /(^|-)(d|data|x|request|upload|form)/u)) {
      addCategory(categories, "external-write");
      reasons.push(`${program} arguments indicate an external write`);
    }
  } else if (WRITE_PROGRAMS.has(program)) {
    addCategory(categories, "workspace-write");
    reasons.push(`${program} changes files or permissions`);
  } else if (EXECUTABLE_PROGRAMS.has(program)) {
    addCategory(categories, "workspace-exec");
    reasons.push(`${program} executes project or user-provided code`);
  } else if (INSPECT_PROGRAMS.has(program)) {
    addCategory(categories, "inspect");
    reasons.push(`${program} normally inspects local state`);
  } else if (categories.size === 0) {
    addCategory(categories, "workspace-exec");
    reasons.push(`${program} is not classified as read-only and may execute code`);
  }

  if (program === "curl" || program === "wget") {
    if (hasAnyArg(command.args, /(-x|--request|--upload-file|--data|--form)/u)) {
      addCategory(categories, "external-write");
      reasons.push("The request may write data to an external service");
    }
  }

  if (inlineCode) {
    addCategory(categories, "workspace-exec");
    reasons.push(`${program} executes inline code supplied in command arguments`);
  }

  if (categories.size === 0) {
    addCategory(categories, "inspect");
    reasons.push("The command only inspects local state");
  }

  const categoryList = [...categories];
  const level: RiskLevel = hardDeny || categoryList.includes("privileged")
    ? "critical"
    : inlineCode
      ? "high"
    : categoryList.includes("destructive") || categoryList.includes("external-write")
      ? "high"
      : categoryList.some((category) => ["workspace-write", "workspace-exec", "network"].includes(category))
        ? "medium"
        : "low";
  return { level, categories: categoryList, reasons: [...new Set(reasons)], hardDeny };
}

const RISK_ORDER: Record<RiskLevel, number> = { low: 0, medium: 1, high: 2, critical: 3 };

export function aggregateRisk(assessments: RiskAssessment[]): RiskAssessment {
  if (assessments.length === 0) {
    return { level: "low", categories: ["inspect"], reasons: ["No command was supplied"], hardDeny: false };
  }
  const level = assessments.reduce((current, assessment) => RISK_ORDER[assessment.level] > RISK_ORDER[current] ? assessment.level : current, "low" as RiskLevel);
  return {
    level,
    categories: [...new Set(assessments.flatMap((assessment) => assessment.categories))],
    reasons: [...new Set(assessments.flatMap((assessment) => assessment.reasons))],
    hardDeny: assessments.some((assessment) => assessment.hardDeny)
  };
}
