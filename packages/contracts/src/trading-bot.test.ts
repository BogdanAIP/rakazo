import { describe, expect, it } from "vitest";
import { CreateBotInput } from "./domain.js";
import { buildTradingResearchBotInput, TRADING_RESEARCH_BOT_INSTRUCTIONS } from "./trading-bot.js";

describe("native trading research bot profile (P12-0)", () => {
  it("uses the existing Rakazo bots.create contract without granting trading authority", () => {
    const profile = buildTradingResearchBotInput({ spawnKey: "trading:research:primary" });
    expect(CreateBotInput.parse(profile)).toEqual(profile);
    expect(profile.name).toBe("Trading Bot");
    expect(profile.spawnKey).toBe("trading:research:primary");
    expect(profile.computerMode).toBe("team");
    expect(profile.notifyOnFinish).toBe(true);
    expect(profile).not.toHaveProperty("active");
    expect(profile).not.toHaveProperty("ledgerId");
    expect(profile).not.toHaveProperty("policy");
    expect(profile).not.toHaveProperty("credentials");
  });

  it("requires explicit no-trade, verified evidence and separated paper authority", () => {
    expect(TRADING_RESEARCH_BOT_INSTRUCTIONS).toContain("NO_TRADE");
    expect(TRADING_RESEARCH_BOT_INSTRUCTIONS).toContain("source timestamps");
    expect(TRADING_RESEARCH_BOT_INSTRUCTIONS).toContain("independently verified");
    expect(TRADING_RESEARCH_BOT_INSTRUCTIONS).toContain("owner-approved");
    expect(TRADING_RESEARCH_BOT_INSTRUCTIONS).toContain("live trading and wallet signing disabled");
  });

  it("does not bypass existing Rakazo bot input validation", () => {
    expect(() => buildTradingResearchBotInput({ name: " " })).toThrow();
    expect(() => buildTradingResearchBotInput({ spawnKey: "" })).toThrow();
    expect(() => buildTradingResearchBotInput({ spawnKey: "x".repeat(121) })).toThrow();
    expect(buildTradingResearchBotInput({ name: "Spot Research" }).name).toBe("Spot Research");
  });
});
