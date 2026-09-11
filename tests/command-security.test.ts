import { describe, expect, it } from "vitest";
import { parseCommand, validateCommand, validateStructuredCommand } from "../src/mcp/command-security.js";

describe("command security", () => {
  it("parses ordinary commands without invoking a shell", () => {
    expect(parseCommand("npm run build")).toEqual({ executable: "npm", args: ["run", "build"] });
    expect(parseCommand("git commit -m 'hello world'")).toEqual({ executable: "git", args: ["commit", "-m", "hello world"] });
  });

  it("rejects shell operators", () => {
    expect(() => parseCommand("npm test && cat /etc/passwd")).toThrow("Shell operators");
    expect(() => parseCommand("node -e `whoami`")).toThrow("Shell operators");
  });

  it("leaves risk classification to the shared policy path", () => {
    const workspace = "/tmp/project";
    expect(validateCommand("git push origin main", workspace)).toEqual({ executable: "git", args: ["push", "origin", "main"] });
    expect(validateCommand("git reset --hard", workspace)).toEqual({ executable: "git", args: ["reset", "--hard"] });
    expect(validateCommand("git clean -fd", workspace)).toEqual({ executable: "git", args: ["clean", "-fd"] });
    expect(validateCommand("git checkout -- .", workspace)).toEqual({ executable: "git", args: ["checkout", "--", "."] });
    for (const target of ["dist", "node_modules", "."]) {
      expect(validateCommand(`rm -rf ${target}`, workspace)).toEqual({ executable: "rm", args: ["-rf", target] });
    }
    expect(validateStructuredCommand({ program: "git", args: ["push", "origin", "main"] }, workspace)).toEqual({
      executable: "git",
      args: ["push", "origin", "main"]
    });
    expect(validateStructuredCommand({ program: "rm", args: ["-rf", "dist"] }, workspace)).toEqual({
      executable: "rm",
      args: ["-rf", "dist"]
    });
  });

  it("rejects command path escapes", () => {
    expect(() => validateCommand("cat ../secret.txt", "/tmp/project")).toThrow("escape");
    expect(() => validateCommand("/bin/cat /etc/passwd", "/tmp/project")).toThrow("outside");
  });

  it("applies shell interpreter restrictions to legacy and structured commands", () => {
    const commands: Array<[string, { program: string; args: string[] }]> = [
      ["bash -c 'echo unsafe'", { program: "bash", args: ["-c", "echo unsafe"] }],
      ["sh --command 'echo unsafe'", { program: "sh", args: ["--command", "echo unsafe"] }],
      ["zsh -lc 'echo unsafe'", { program: "zsh", args: ["-lc", "echo unsafe"] }]
    ];
    for (const [legacy, structured] of commands) {
      expect(() => validateCommand(legacy, "/tmp/project")).toThrow("Shell interpreters");
      expect(() => validateStructuredCommand(structured, "/tmp/project")).toThrow("Shell interpreters");
    }
  });

  it("applies null-byte and outside-workspace checks to structured commands", () => {
    expect(() => validateStructuredCommand({ program: "cat", args: ["../secret.txt"] }, "/tmp/project")).toThrow("escape");
    expect(() => validateStructuredCommand({ program: "cat", args: ["/etc/passwd"] }, "/tmp/project")).toThrow("outside");
    expect(() => validateStructuredCommand({ program: "cat", args: ["bad\0path"] }, "/tmp/project")).toThrow("null bytes");
    expect(() => validateStructuredCommand({ program: "cat\0", args: [] }, "/tmp/project")).toThrow("null byte");
  });
});
