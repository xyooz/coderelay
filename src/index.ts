import { Command } from "commander";
import {
  configShowCommand,
  doctorCommand,
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
  .option("--workspace <path>", "workspace directory", process.cwd())
  .option("--port <number>", "preferred local port", (value) => Number.parseInt(value, 10))
  .option("--no-tunnel", "start locally without a public tunnel")
  .action(async (options: { workspace: string; port?: number; tunnel?: boolean }) => startCommand(options));

program
  .command("serve", { hidden: true })
  .requiredOption("--workspace <path>", "workspace directory")
  .requiredOption("--host <host>", "bind host")
  .requiredOption("--port <number>", "local port", (value) => Number.parseInt(value, 10))
  .requiredOption("--token <token>", "endpoint token")
  .action(async (options: { workspace: string; host: string; port: number; token: string }) => serveCommand(options));

program
  .command("stop")
  .description("Stop CodeRelay and its tunnel")
  .action(stopCommand);

program
  .command("status")
  .description("Show server and tunnel status")
  .action(statusCommand);

program
  .command("doctor")
  .description("Diagnose local setup and connectivity")
  .option("--workspace <path>", "workspace directory", process.cwd())
  .action(async (options: { workspace: string }) => doctorCommand(options.workspace));

program
  .command("restart")
  .description("Restart CodeRelay")
  .option("--workspace <path>", "workspace directory", process.cwd())
  .option("--port <number>", "preferred local port", (value) => Number.parseInt(value, 10))
  .option("--no-tunnel", "restart locally without a public tunnel")
  .action(async (options: { workspace: string; port?: number; tunnel?: boolean }) => restartCommand(options));

program
  .command("config")
  .description("Inspect generated workspace configuration")
  .command("show")
  .option("--workspace <path>", "workspace directory", process.cwd())
  .action(async (options: { workspace: string }) => configShowCommand(options.workspace));

const args = process.argv.slice(2);
if (args.length === 0) args.push("start");

program.parseAsync([process.argv[0], process.argv[1], ...args]).catch((error: unknown) => {
  console.error(`CodeRelay error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
