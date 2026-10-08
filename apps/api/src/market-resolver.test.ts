import { describe, expect, it } from "vitest";
import { resolveMarketRoute } from "./market-resolver.js";

const native = (procedure: string, readOnly = false) => [{ procedure, readOnly }];
const seed = (semanticKey: string, implementations: Array<Record<string, unknown>>) => ({
  semanticKey,
  implementations,
});
const browser = {
  name: "Rakazo Browser v2",
  kind: "browser",
  reference: "rakazo:computer/browser",
  priority: 1,
  readOnly: false,
  constraints: ["active lease required"],
  binding: { type: "appContract", procedure: "computer/browser" },
};
const external = {
  name: "Web docs",
  kind: "mcp",
  reference: "docs/provider",
  priority: 2,
  readOnly: true,
  constraints: ["current authorized tool required"],
  binding: {
    type: "connector",
    tool: "docs_search",
    connectorId: "mcp",
    toolName: "search",
  },
};
const tools = [
  {
    name: "docs_search",
    readOnly: true,
    route: { connectorId: "mcp", toolName: "search" },
  },
];

describe("data-driven Market Resolver Engine", () => {
  it("selects live authorized Browser v2 appContract without executing it", () => {
    const result = resolveMarketRoute({
      semanticKey: "browser.semantic",
      content: seed("browser.semantic", [browser]),
      access: "interactive",
      capabilities: [],
      nativeRoutes: native("computer/browser"),
    });
    expect(result.status).toBe("selected");
    expect(result.selected?.binding).toEqual({
      type: "appContract",
      procedure: "computer/browser",
    });
    expect(result.candidates[0]?.status).toBe("eligible");
  });

  it("does not treat an indexed route as an authorized route", () => {
    const result = resolveMarketRoute({
      semanticKey: "browser.semantic",
      content: seed("browser.semantic", [browser]),
      access: "interactive",
      capabilities: [],
      nativeRoutes: [],
    });
    expect(result.status).toBe("unavailable");
    expect(result.candidates[0]?.status).toBe("not_authorized");
  });

  it("adds new semantic keys and providers through data only", () => {
    const result = resolveMarketRoute({
      semanticKey: "future.docs.query",
      content: seed("future.docs.query", [{ ...external, priority: 1 }]),
      access: "read",
      capabilities: tools,
      nativeRoutes: [],
    });
    expect(result.status).toBe("selected");
    expect(result.selected?.binding.type).toBe("connector");
  });

  it("tries next eligible provider after an unauthorized higher-priority option", () => {
    const result = resolveMarketRoute({
      semanticKey: "browser.semantic",
      content: seed("browser.semantic", [browser, external]),
      access: "read",
      capabilities: tools,
      nativeRoutes: native("computer/browser"),
    });
    expect(result.candidates.map((candidate) => candidate.status)).toEqual([
      "access_denied",
      "eligible",
    ]);
    expect(result.selected?.reference).toBe("docs/provider");
  });

  it("fails closed on write-capable tools for read-only intent", () => {
    const result = resolveMarketRoute({
      semanticKey: "future.docs.query",
      content: seed("future.docs.query", [{ ...external, priority: 1 }]),
      access: "read",
      capabilities: [{ ...tools[0], readOnly: false }],
      nativeRoutes: [],
    });
    expect(result.status).toBe("unavailable");
    expect(result.candidates[0]?.status).toBe("access_denied");
  });

  it("fails closed for missing explicit bindings and mismatched keys", () => {
    const unbound = { ...browser, binding: undefined };
    const first = resolveMarketRoute({
      semanticKey: "browser.semantic",
      content: seed("browser.semantic", [unbound]),
      access: "interactive",
      capabilities: [],
      nativeRoutes: native("computer/browser"),
    });
    expect(first.status).toBe("unavailable");
    expect(first.candidates[0]?.status).toBe("missing_binding");
    const second = resolveMarketRoute({
      semanticKey: "future.docs",
      content: seed("browser.semantic", [browser]),
      access: "interactive",
      capabilities: [],
      nativeRoutes: native("computer/browser"),
    });
    expect(second.status).toBe("invalid");
  });

  it("rejects collisions in priorities, bindings and authorized provider matches", () => {
    const duplicatePriority = resolveMarketRoute({
      semanticKey: "browser.semantic",
      content: seed("browser.semantic", [browser, { ...external, priority: 1 }]),
      access: "interactive",
      capabilities: tools,
      natieRoutes: native("computer/browser"),
    });
    expect(duplicatePriority.status).toBe("invalid");
    const duplicateBinding = resolveMarketRoute({
      semanticKey: "browser.semantic",
      content: seed("browser.semantic", [browser, { ...browser, priority: 2 }]),
      access: "interactive",
      capabilities: [],
      nativeRoutes: native("computer/browser"),
    });
    expect(duplicateBinding.status).toBe("invalid");
    const ambiguous = resolveMarketRoute({
      semanticKey: "future.docs",
      content: seed("future.docs", [{ ...external, priority: 1 }]),
      access: "read",
      capabilities: [...tools, ...tools],
      nativeRoutes: [],
    });
    expect(ambiguous.status).toBe("unavailable");
    expect(ambiguous.candidates[0]?.status).toBe("ambiguous");
  });
});
