import { Command, Option } from "commander";
import {
  addWorkspaceCommand,
  approveCommand,
  configShowCommand,
  denyCommand,
  doctorCommand,
  endpointCommand,
  listCommand,
  removeWorkspaceCommand,
  restartCommand,
  rotateEndpointCommand,
  serveCommand,
  startCommand,
  statusCommand,
  stopCommand,
  trustStatusCommand,
  trustWorkspaceCommand,
  policyListCommand,
  policyRemoveCommand,
  workspacesCommand
} from "./cli/commands.js";
import { authLogoutCommand, authOpenAiCommand, authStatusCommand, configPolicyCommand, configTransportCommand, setupCommand } from "./cli/setup.js";
import type { TransportPreference } from "./runtime/state.js";

const program = new Command();
program
  .name("coderelay")
  .description("Turn ChatGPT into a local coding agent with secure MCP access.")
  .version("0.2.0");

program
  .command("start")
  .description("Start the single CodeRelay daemon and tunnel")
  .argument("[workspace]", "optionally register this workspace before starting")
  .option("--workspace <path>", "workspace directory (legacy alias)")
  .option("--name <name>", "instance name")
  .option("--tunnel-id <id>", "OpenAI Secure MCP Tunnel ID")
  .addOption(new Option("--transport <transport>", "transport preference").choices(["auto", "openai", "cloudflare-named", "cloudflare-quick", "cloudflare", "local"]))
  .option("--port <number>", "preferred local port", (value) => Number.parseInt(value, 10))
  .option("--no-tunnel", "start locally without a public tunnel")
  .action(async (workspace: string | undefined, options: { workspace?: string; name?: string; tunnelId?: string; transport?: TransportPreference | "cloudflare"; port?: number; tunnel?: boolean }) => startCommand({ ...options, workspace: options.workspace ?? workspace }));

program
  .command("setup")
  .description("Choose and save a transport configuration")
  .action(setupCommand);

const auth = program
  .command("auth")
  .description("Manage OpenAI Secure MCP Tunnel credentials");
auth.command("openai").description("Save an OpenAI API key locally").action(authOpenAiCommand);
auth.command("status").description("Show OpenAI credential status without revealing the key").action(authStatusCommand);
auth.command("logout").description("Remove the locally stored OpenAI API key").action(authLogoutCommand);

program
  .command("serve", { hidden: true })
  .requiredOption("--registry-home <path>", "CodeRelay state directory")
  .requiredOption("--instance-name <name>", "instance name")
  .requiredOption("--host <host>", "bind host")
  .requiredOption("--port <number>", "local port", (value) => Number.parseInt(value, 10))
  .option("--token <token>", "endpoint token (legacy; normally passed through the environment)")
  .action(async (options: { registryHome: string; instanceName: string; host: string; port: number; token?: string }) => serveCommand({
    ...options,
    token: options.token ?? process.env.CODERELAY_MCP_ENDPOINT_TOKEN ?? ""
  }));

program
  .command("add")
  .description("Register a workspace with the CodeRelay daemon")
  .argument("<workspace>", "workspace directory")
  .option("--name <name>", "workspace name")
  .action(async (workspace: string, options: { name?: string }) => addWorkspaceCommand(workspace, options.name));

program
  .command("remove")
  .description("Remove a workspace from the registry")
  .argument("<name>", "registered workspace name")
  .action(async (name: string) => removeWorkspaceCommand(name));

program
  .command("workspaces")
  .description("List registered workspaces")
  .action(workspacesCommand);

program
  .command("stop")
  .description("Stop CodeRelay and its tunnel")
  .argument("[name]", "accepted for compatibility; CodeRelay now has one daemon")
  .action(async () => stopCommand());

program
  .command("status")
  .description("Show server and tunnel status")
  .argument("[name]", "accepted for compatibility; CodeRelay now has one daemon")
  .action(async () => statusCommand());

program
  .command("list")
  .description("List registered workspaces")
  .action(listCommand);

program
  .command("doctor")
  .description("Diagnose local setup and connectivity")
  .action(async () => doctorCommand());

const endpoint = program
  .command("endpoint")
  .description("Show the active MCP endpoint");
endpoint.action(endpointCommand);
endpoint
  .command("rotate")
  .description("Rotate the MCP endpoint token and invalidate the previous endpoint")
  .action(rotateEndpointCommand);

program
  .command("restart")
  .description("Restart CodeRelay")
  .argument("[name]", "accepted for compatibility; CodeRelay now has one daemon")
  .option("--workspace <path>", "optionally register this workspace")
  .option("--name <name>", "instance name override")
  .option("--tunnel-id <id>", "OpenAI Secure MCP Tunnel ID for this workspace")
  .addOption(new Option("--transport <transport>", "transport preference").choices(["auto", "openai", "cloudflare-named", "cloudflare-quick", "cloudflare", "local"]))
  .option("--port <number>", "preferred local port", (value) => Number.parseInt(value, 10))
  .option("--no-tunnel", "restart locally without a public tunnel")
  .action(async (_name: string | undefined, options: { workspace?: string; name?: string; tunnelId?: string; transport?: TransportPreference | "cloudflare"; port?: number; tunnel?: boolean }) => restartCommand(options));

const config = program
  .command("config")
  .description("Inspect and update daemon configuration");
config.command("show").action(async () => configShowCommand());
config.command("transport")
  .argument("<transport>", "auto, openai, cloudflare-named, cloudflare-quick, or local")
  .action(async (transport: string) => configTransportCommand(transport as TransportPreference));
config.command("policy")
  .argument("<mode>", "safe, workspace, or unrestricted")
  .action(async (mode: string) => configPolicyCommand(mode));

const trust = program
  .command("trust")
  .description("Trust a registered workspace for workspace-mode command execution")
  .argument("[name]", "registered workspace name")
  .action(async (name?: string) => {
    if (!name) return trustStatusCommand();
    await trustWorkspaceCommand(name, true);
  });
trust.command("status")
  .description("Show workspace trust status")
  .argument("[name]", "optional registered workspace name")
  .action(async (name?: string) => trustStatusCommand(name));

program
  .command("untrust")
  .description("Remove trust from a registered workspace")
  .argument("<name>", "registered workspace name")
  .action(async (name: string) => trustWorkspaceCommand(name, false));

program
  .command("approve")
  .description("Approve a pending command request locally")
  .argument("<requestId>", "approval request id")
  .option("--once", "approve one execution")
  .option("--workspace", "allow matching commands for this workspace")
  .action(async (requestId: string, options: { once?: boolean; workspace?: boolean }) => {
    if (options.once === options.workspace) throw new Error("Choose exactly one of --once or --workspace.");
    await approveCommand(requestId, options.once ? "once" : "workspace");
  });

program
  .command("deny")
  .description("Deny a pending command request locally")
  .argument("<requestId>", "approval request id")
  .action(async (requestId: string) => denyCommand(requestId));

const policy = program
  .command("policy")
  .description("Inspect or remove persisted command approval rules");
policy.command("list").action(policyListCommand);
policy.command("remove").argument("<id>", "policy rule id").action(policyRemoveCommand);

const args = process.argv.slice(2);
const commands = new Set(["start", "setup", "serve", "auth", "add", "remove", "workspaces", "stop", "status", "list", "doctor", "endpoint", "restart", "config", "trust", "untrust", "approve", "deny", "policy"]);
if (args.length === 0) args.push("start");
else if (!commands.has(args[0]) && !["--help", "-h", "--version", "-V"].includes(args[0])) args.unshift("start");

program.parseAsync([process.argv[0], process.argv[1], ...args]).catch((error: unknown) => {
  console.error(`CodeRelay error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
