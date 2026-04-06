import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import { promisify } from "node:util";
import { HimalayaClient } from "../src/himalaya/client.js";

// Mock node:child_process - we use execFile (safe, no shell injection)
// and spawn (for stdin piping). Must preserve util.promisify.custom
// so promisify(execFile) returns {stdout, stderr}.
vi.mock("node:child_process", async () => {
  const { promisify: realPromisify } = await import("node:util");
  const fn: any = vi.fn();
  const promisified = vi.fn();
  fn[realPromisify.custom] = promisified;
  return { execFile: fn, spawn: vi.fn() };
});

import { execFile, spawn } from "node:child_process";

const mockExecFile = vi.mocked(execFile);
// Access the promisified version that client.ts actually calls
const mockExecFileAsync = (execFile as any)[promisify.custom] as ReturnType<typeof vi.fn>;
const mockSpawn = vi.mocked(spawn);

function setupMock(stdout: string, stderr = "") {
  mockExecFileAsync.mockResolvedValue({ stdout, stderr });
}

function setupErrorMock(error: Error) {
  mockExecFileAsync.mockRejectedValue(error);
}

describe("HimalayaClient", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("constructor", () => {
    it("uses default options", () => {
      const client = new HimalayaClient();
      expect(client).toBeDefined();
    });

    it("accepts custom options", () => {
      const client = new HimalayaClient({
        binary: "/usr/local/bin/himalaya",
        account: "work",
        folder: "Sent Items",
        timeout: 60_000,
      });
      expect(client).toBeDefined();
    });
  });

  describe("exec", () => {
    it("passes --output json flag", async () => {
      setupMock("[]");
      const client = new HimalayaClient();
      await client.exec(["envelope", "list"]);

      expect(mockExecFileAsync).toHaveBeenCalledWith(
        "himalaya",
        expect.arrayContaining(["--output", "json"]),
        expect.any(Object),
      );
    });

    it("passes --account flag when set", async () => {
      setupMock("[]");
      const client = new HimalayaClient({ account: "work" });
      await client.exec(["envelope", "list"]);

      expect(mockExecFileAsync).toHaveBeenCalledWith(
        "himalaya",
        expect.arrayContaining(["--account", "work"]),
        expect.any(Object),
      );
    });

    it("returns stdout", async () => {
      setupMock('[{"id":"1"}]');
      const client = new HimalayaClient();
      const result = await client.exec(["envelope", "list"]);
      expect(result).toBe('[{"id":"1"}]');
    });
  });

  describe("error handling", () => {
    it("wraps ENOENT as CLI not found", async () => {
      const err = Object.assign(new Error("spawn himalaya ENOENT"), { code: "ENOENT" });
      setupErrorMock(err);
      const client = new HimalayaClient();

      await expect(client.exec(["envelope", "list"]))
        .rejects.toThrow("himalaya CLI not found");
    });

    it("wraps killed process as timeout", async () => {
      const err = Object.assign(new Error("killed"), { killed: true });
      setupErrorMock(err);
      const client = new HimalayaClient();

      await expect(client.exec(["envelope", "list"]))
        .rejects.toThrow("timed out");
    });

    it("wraps auth errors", async () => {
      const err = new Error("authentication failed: bad credentials");
      setupErrorMock(err);
      const client = new HimalayaClient();

      await expect(client.exec(["envelope", "list"]))
        .rejects.toThrow("authentication failed");
    });
  });

  describe("convenience methods", () => {
    it("listEnvelopes builds correct args", async () => {
      setupMock("[]");
      const client = new HimalayaClient();
      await client.listEnvelopes("Sent Items", 10, 2);

      expect(mockExecFileAsync).toHaveBeenCalledWith(
        "himalaya",
        expect.arrayContaining(["envelope", "list", "--folder", "Sent Items", "--page-size", "10", "--page", "2"]),
        expect.any(Object),
      );
    });

    it("searchEnvelopes passes query as positional args", async () => {
      setupMock("[]");
      const client = new HimalayaClient();
      await client.searchEnvelopes("subject invoice", "INBOX");

      expect(mockExecFileAsync).toHaveBeenCalledWith(
        "himalaya",
        expect.arrayContaining(["envelope", "list", "subject", "invoice"]),
        expect.any(Object),
      );
    });

    it("readMessage passes id", async () => {
      setupMock('""');
      const client = new HimalayaClient();
      await client.readMessage("12345");

      expect(mockExecFileAsync).toHaveBeenCalledWith(
        "himalaya",
        expect.arrayContaining(["message", "read", "12345"]),
        expect.any(Object),
      );
    });

    it("listFolders calls folder list", async () => {
      setupMock("[]");
      const client = new HimalayaClient();
      await client.listFolders();

      expect(mockExecFileAsync).toHaveBeenCalledWith(
        "himalaya",
        expect.arrayContaining(["folder", "list"]),
        expect.any(Object),
      );
    });
  });

  describe("execWithStdin (spawn path)", () => {
    /** Create a fake child process with stdin/stdout/stderr as EventEmitters. */
    function createMockChild() {
      const child = new EventEmitter() as EventEmitter & {
        stdin: { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
        stdout: EventEmitter;
        stderr: EventEmitter;
        kill: ReturnType<typeof vi.fn>;
      };
      child.stdin = { write: vi.fn(), end: vi.fn() };
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = vi.fn();
      return child;
    }

    function setupSpawnMock(child: ReturnType<typeof createMockChild>) {
      mockSpawn.mockReturnValue(child as any);
    }

    it("sendTemplate pipes template via stdin and returns stdout", async () => {
      const child = createMockChild();
      setupSpawnMock(child);
      const client = new HimalayaClient();
      const template = "From: a@b.com\nTo: c@d.com\nSubject: Hi\n\nHello!";

      const promise = client.sendTemplate(template);

      // Simulate successful completion
      child.stdout.emit("data", Buffer.from("{}"));
      child.emit("close", 0);

      const result = await promise;
      expect(result).toBe("{}");
      expect(child.stdin.write).toHaveBeenCalledWith(template);
      expect(child.stdin.end).toHaveBeenCalled();
    });

    it("passes --account flag via spawn args", async () => {
      const child = createMockChild();
      setupSpawnMock(child);
      const client = new HimalayaClient();

      const promise = client.sendTemplate("test", "gmail");

      child.emit("close", 0);
      await promise;

      expect(mockSpawn).toHaveBeenCalledWith(
        "himalaya",
        expect.arrayContaining(["template", "send", "--account", "gmail", "--output", "json"]),
        expect.any(Object),
      );
    });

    it("rejects on non-zero exit code", async () => {
      const child = createMockChild();
      setupSpawnMock(child);
      const client = new HimalayaClient();

      const promise = client.sendTemplate("test");

      child.stderr.emit("data", Buffer.from("SMTP error: connection refused"));
      child.emit("close", 1);

      await expect(promise).rejects.toThrow("SMTP error");
    });

    it("rejects on spawn error (e.g. ENOENT)", async () => {
      const child = createMockChild();
      setupSpawnMock(child);
      const client = new HimalayaClient();

      const promise = client.sendTemplate("test");

      const err = Object.assign(new Error("spawn himalaya ENOENT"), { code: "ENOENT" });
      child.emit("error", err);

      await expect(promise).rejects.toThrow("himalaya CLI not found");
    });

    it("does not double-reject when error fires before close", async () => {
      const child = createMockChild();
      setupSpawnMock(child);
      const client = new HimalayaClient();

      const promise = client.sendTemplate("test");

      // error fires first, then close — settled guard prevents double-reject
      const err = Object.assign(new Error("spawn himalaya ENOENT"), { code: "ENOENT" });
      child.emit("error", err);
      child.emit("close", 1);

      await expect(promise).rejects.toThrow("himalaya CLI not found");
    });

    it("rejects on timeout and kills child process", async () => {
      const child = createMockChild();
      setupSpawnMock(child);
      const client = new HimalayaClient({ timeout: 50 });

      const promise = client.sendTemplate("test");

      // Let the timeout fire (50ms)
      await expect(promise).rejects.toThrow("timed out after 50ms");
      expect(child.kill).toHaveBeenCalled();
    });
  });
});
