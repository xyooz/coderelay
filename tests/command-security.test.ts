import { describe, expect, it } from "vitest";
import { parseCommand, validateCommand } from "../src/mcp/command-security.js";

describe("command security", () => {
  it("parses ordinary commands without invoking a shell", () => {
    expect(parseCommand("npm run build")).toEqual({ executable: "npm", args: ["run", "build"] });
    expect(parseCommand("git commit -m 'hello world'")).toEqual({ executable: "git", args: ["commit", "-m", "hello world"] });
  });

  it("rejects shell operators", () => {
    expect(() => parseCommand("npm test && cat /etc/passwd")).toThrow("Shell operators");
    expect(() => parseCommand("node -e `whoami`")).toThrow("Shell operators");
  });

  it("blocks destructive and remote-write commands", () => {
    expect(() => validateCommand("sudo npm test", "/tmp/project")).toThrow("blocked");
    expect(() => validateCommand("git push", "/tmp/project")).toThrow("git push");
    expect(() => validateCommand("git reset --hard", "/tmp/project")).toThrow("git reset");
    expect(() => validateCommand("rm -rf build", "/tmp/project")).toThrow("Recursive rm");
  });

  it("rejects command path escapes", () => {
    expect(() => validateCommand("cat ../secret.txt", "/tmp/project")).toThrow("escape");
    expect(() => validateCommand("/bin/cat /etc/passwd", "/tmp/project")).toThrow("outside");
  });
});
