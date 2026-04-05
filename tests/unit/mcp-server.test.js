import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock browser-factory before importing McpServer
vi.mock("../../src/utils/browser-factory.js", () => ({
  createBrowser: vi.fn(),
  createContext: vi.fn(),
  extractPageText: () => "mock text",
}));

// Mock a11y module for accessibility tree tests
vi.mock("../../src/a11y.js", () => ({
  buildA11yTree: vi.fn().mockResolvedValue({
    tree: '- heading "Test" [level=1]\n- button "Click Me" [ref=e1]',
    refs: { e1: { role: "button", name: "Click Me", tag: "button" } },
    totalRefs: 1,
  }),
  clickByRef: vi.fn().mockResolvedValue(undefined),
  typeByRef: vi.fn().mockResolvedValue(undefined),
}));

import { McpServer } from "../../src/mcp-server.js";
import {
  createBrowser,
  createContext,
} from "../../src/utils/browser-factory.js";

function setupMockBrowser() {
  const mockPage = {
    goto: vi.fn().mockResolvedValue(undefined),
    url: vi.fn().mockReturnValue("https://example.com/"),
    title: vi.fn().mockResolvedValue("Example"),
    evaluate: vi.fn().mockImplementation((arg) => {
      // If called with a function (extractPageText), return mock text
      if (typeof arg === "function") return Promise.resolve("mock page text");
      // If called with string expression
      return Promise.resolve("eval result");
    }),
    screenshot: vi.fn().mockResolvedValue(Buffer.from("fake-png")),
    click: vi.fn().mockResolvedValue(undefined),
    fill: vi.fn().mockResolvedValue(undefined),
    keyboard: { press: vi.fn().mockResolvedValue(undefined) },
    waitForLoadState: vi.fn().mockResolvedValue(undefined),
    waitForTimeout: vi.fn().mockResolvedValue(undefined),
    locator: vi.fn().mockReturnValue({
      ariaSnapshot: vi.fn().mockResolvedValue('- heading "Test"'),
    }),
  };
  const mockContext = {
    newPage: vi.fn().mockResolvedValue(mockPage),
    close: vi.fn(),
  };
  const mockBrowser = {
    isConnected: vi.fn().mockReturnValue(true),
    newContext: vi.fn().mockResolvedValue(mockContext),
    close: vi.fn(),
  };
  createBrowser.mockResolvedValue(mockBrowser);
  createContext.mockResolvedValue(mockContext);
  return { mockBrowser, mockContext, mockPage };
}

describe("McpServer", () => {
  let server;

  beforeEach(() => {
    vi.clearAllMocks();
    server = new McpServer();
  });

  describe("tool definitions", () => {
    it("should define 8 tools", () => {
      expect(server.tools).toHaveLength(8);
    });

    it("should have correct tool names", () => {
      const names = server.tools.map((t) => t.name);
      expect(names).toContain("stealth_browse");
      expect(names).toContain("stealth_screenshot");
      expect(names).toContain("stealth_search");
      expect(names).toContain("stealth_extract");
      expect(names).toContain("stealth_click");
      expect(names).toContain("stealth_type");
      expect(names).toContain("stealth_evaluate");
      expect(names).toContain("stealth_snapshot");
    });

    it("each tool should have description and inputSchema", () => {
      for (const tool of server.tools) {
        expect(tool.description).toBeTruthy();
        expect(tool.inputSchema).toBeDefined();
        expect(tool.inputSchema.type).toBe("object");
      }
    });

    it("stealth_browse should require url", () => {
      const browse = server.tools.find((t) => t.name === "stealth_browse");
      expect(browse.inputSchema.required).toContain("url");
    });

    it("stealth_search should require engine and query", () => {
      const search = server.tools.find((t) => t.name === "stealth_search");
      expect(search.inputSchema.required).toContain("engine");
      expect(search.inputSchema.required).toContain("query");
    });
  });

  describe("handleToolCall", () => {
    it("stealth_browse should return text content", async () => {
      const { mockPage } = setupMockBrowser();

      const result = await server.handleToolCall("stealth_browse", {
        url: "https://example.com",
      });

      expect(result).toHaveLength(1);
      expect(result[0].type).toBe("text");
      expect(result[0].text).toContain("example.com");
      expect(result[0].text).toContain("mock page text");
      expect(mockPage.goto).toHaveBeenCalledWith(
        "https://example.com",
        expect.objectContaining({ waitUntil: "domcontentloaded" }),
      );
    });

    it("stealth_browse with snapshot format", async () => {
      setupMockBrowser();

      const result = await server.handleToolCall("stealth_browse", {
        url: "https://example.com",
        format: "snapshot",
      });

      expect(result[0].type).toBe("text");
      expect(result[0].text).toContain("heading");
    });

    it("stealth_screenshot should return image", async () => {
      setupMockBrowser();

      const result = await server.handleToolCall("stealth_screenshot", {
        url: "https://example.com",
      });

      expect(result[0].type).toBe("image");
      expect(result[0].mimeType).toBe("image/png");
      expect(result[0].data).toBeTruthy();
    });

    it("stealth_click should click selector", async () => {
      const { mockPage } = setupMockBrowser();
      // Establish page first
      await server.handleToolCall("stealth_browse", {
        url: "https://example.com",
      });

      const result = await server.handleToolCall("stealth_click", {
        selector: "button.submit",
      });

      expect(result[0].text).toContain("Clicked");
      expect(mockPage.click).toHaveBeenCalledWith(
        "button.submit",
        expect.any(Object),
      );
    });

    it("stealth_type should fill text", async () => {
      const { mockPage } = setupMockBrowser();
      await server.handleToolCall("stealth_browse", {
        url: "https://example.com",
      });

      const result = await server.handleToolCall("stealth_type", {
        selector: "input[name=q]",
        text: "hello",
      });

      expect(result[0].text).toContain("Typed");
      expect(mockPage.fill).toHaveBeenCalledWith("input[name=q]", "hello");
    });

    it("stealth_type with pressEnter", async () => {
      const { mockPage } = setupMockBrowser();
      await server.handleToolCall("stealth_browse", {
        url: "https://example.com",
      });

      await server.handleToolCall("stealth_type", {
        selector: "input",
        text: "query",
        pressEnter: true,
      });

      expect(mockPage.keyboard.press).toHaveBeenCalledWith("Enter");
    });

    it("stealth_evaluate should return result", async () => {
      const { mockPage } = setupMockBrowser();
      await server.handleToolCall("stealth_browse", {
        url: "https://example.com",
      });

      // Switch to simple mock for evaluate tool call
      mockPage.evaluate.mockResolvedValue("document title");

      const result = await server.handleToolCall("stealth_evaluate", {
        expression: "document.title",
      });

      expect(result[0].text).toBe("document title");
    });

    it("stealth_evaluate should JSON-stringify non-string results", async () => {
      const { mockPage } = setupMockBrowser();
      await server.handleToolCall("stealth_browse", {
        url: "https://example.com",
      });

      mockPage.evaluate.mockResolvedValue({ foo: "bar" });

      const result = await server.handleToolCall("stealth_evaluate", {
        expression: '({foo: "bar"})',
      });

      expect(result[0].text).toContain('"foo"');
      expect(result[0].text).toContain('"bar"');
    });

    it("unknown tool should return error text", async () => {
      setupMockBrowser();
      const result = await server.handleToolCall("nonexistent_tool", {});
      expect(result[0].text).toContain("Unknown tool");
    });
  });

  describe("send", () => {
    it("should write JSON-RPC to stdout", () => {
      const writeSpy = vi
        .spyOn(process.stdout, "write")
        .mockImplementation(() => true);

      server.send({ jsonrpc: "2.0", id: 1, result: { ok: true } });

      expect(writeSpy).toHaveBeenCalledTimes(1);
      const raw = writeSpy.mock.calls[0][0];
      expect(raw.endsWith("\n")).toBe(true);
      const output = JSON.parse(raw);
      expect(output.jsonrpc).toBe("2.0");
      expect(output.id).toBe(1);
      expect(output.result.ok).toBe(true);

      writeSpy.mockRestore();
    });
  });
});
