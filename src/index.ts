import { Command, Option } from "commander";
import {
  configShowCommand,
  doctorCommand,
  listCommand,
  restartCommand,
  serveCommand,
  startCommand,
  statusCommand,
  stopCommand
} from "./cli/commands.js";

const program = new Command();
program
  .name("coderelay")
  .description("Turn ChatGPT into a local coding agent with secure MCP access.")
  .version("0.1.0");

program
  .command("start")
  .description("Start the local MCP server and tunnel")
  .argument("[workspace]", "workspace directory", process.cwd())
  .option("--workspace <path>", "workspace directory (legacy alias)")
  .option("--name <name>", "instance name")
  .option("--tunnel-id <id>", "OpenAI Secure MCP Tunnel ID for this workspace")
  .addOption(new Option("--transport <transport>", "transport preference").choices(["auto", "openai", "cloudflare"]))
  .option("--port <number>", "preferred local port", (value) => Number.parseInt(value, 10))
  .option("--no-tunnel", "start locally without a public tunnel")
  .action(async (workspace: string | undefined, options: { workspace?: string; name?: string; tunnelId?: string; transport?: "auto" | "openai" | "cloudflare"; port?: number; tunnel?: boolean }) => startCommand({ ...options, workspace: options.workspace ?? workspace }));

program
  .command("serve", { hidden: true })
  .requiredOption("--workspace <path>", "workspace directory")
  .requiredOption("--instance-name <name>", "instance name")
  .requiredOption("--host <host>", "bind host")
  .requiredOption("--port <number>", "local port", (value) => Number.parseInt(value, 10))
  .requiredOption("--token <token>", "endpoint token")
  .action(async (options: { workspace: string; instanceName: string; host: string; port: number; token: string }) => serveCommand(options));

program
  .command("stop")
  .description("Stop CodeRelay and its tunnel")
  .argument("[instanceName]", "instance name")
  .action(async (instanceName?: string) => stopCommand(instanceName));

program
  .command("status")
  .description("Show server and tunnel status")
  .argument("[instanceName]", "instance name")
  .action(async (instanceName?: string) => statusCommand(instanceName));

program
  .command("list")
  .description("List CodeRelay instances")
  .action(listCommand);

program
  .command("doctor")
  .description("Diagnose local setup and connectivity")
  .argument("[instanceName]", "instance name")
  .option("--workspace <path>", "workspace directory", process.cwd())
  .action(async (instanceName: string | undefined, options: { workspace: string }) => doctorCommand(options.workspace, instanceName));

program
  .command("restart")
  .description("Restart CodeRelay")
  .argument("[instanceName]", "instance name")
  .option("--workspace <path>", "workspace directory")
  .option("--name <name>", "instance name override")
  .option("--tunnel-id <id>", "OpenAI Secure MCP Tunnel ID for this workspace")
  .addOption(new Option("--transport <transport>", "transport preference").choices(["auto", "openai", "cloudflare"]))
  .option("--port <number>", "preferred local port", (value) => Number.parseInt(value, 10))
  .option("--no-tunnel", "restart locally without a public tunnel")
  .action(async (instanceName: string | undefined, options: { workspace?: string; name?: string; tunnelId?: string; transport?: "auto" | "openai" | "cloudflare"; port?: number; tunnel?: boolean }) => restartCommand(instanceName, options));

program
  .command("config")
  .description("Inspect generated workspace configuration")
  .command("show")
  .option("--workspace <path>", "workspace directory", process.cwd())
  .action(async (options: { workspace: string }) => configShowCommand(options.workspace));

const args = process.argv.slice(2);
const commands = new Set(["start", "serve", "stop", "status", "list", "doctor", "restart", "config"]);
if (args.length === 0) args.push("start");
else if (!commands.has(args[0]) && !["--help", "-h", "--version", "-V"].includes(args[0])) args.unshift("start");

program.parseAsync([process.argv[0], process.argv[1], ...args]).catch((error: unknown) => {
  console.error(`CodeRelay error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
