import type { Request } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { completeOnboarding, createBotFromPicker, signup } from "./helpers";

test("a roster response captured before creation cannot switch the new chat's message target", async ({
  page,
}) => {
  await signup(page, "stale-roster-" + Date.now() + "@rakazo.test", "password12", "Roster Race");
  await completeOnboarding(page);
  await expect(page.getByText("What do you want me on first?", { exact: true })).toBeVisible();
  let releaseStale!: () => void,
    captured!: () => void,
    releaseStartup!: () => void,
    startupCaptured!: () => void;
  const staleHeld = new Promise<void>((r) => {
    releaseStale = r;
  });
  const staleCaptured = new Promise<void>((r) => {
    captured = r;
  });
  const startupHeld = new Promise<void>((r) => {
    releaseStartup = r;
  });
  const startupReady = new Promise<void>((r) => {
    startupCaptured = r;
  });
  let staleRequest: Request | null = null;
  await page.route("**/rpc/spaces/list", async (route) => {
    const response = await route.fetch();
    if (staleRequest === null) {
      staleRequest = route.request();
      captured();
      await staleHeld;
    }
    await route.fulfill({ response });
  });
  await page.route("**/rpc/onboarding/start", async (route) => {
    const response = await route.fetch();
    startupCaptured();
    await startupHeld;
    await route.fulfill({ response });
  });
  try {
    await page.clock.install();
    await page.clock.fastForward(3500);
    await staleCaptured;
    const created = page.waitForResponse((r) => r.url().includes("/rpc/bots/create") && r.ok());
    await createBotFromPicker(page, { name: "Target Bot" });
    const botId = (await (await created).json()).json.id as string;
    await expect(page.getByPlaceholder("Message Target Bot")).toBeVisible();
    await startupReady;
    const stale = page.waitForResponse((r) => r.request() === staleRequest);
    releaseStale();
    await (await stale).finished();
    await page.clock.runFor(100);
    const fresh = page.waitForResponse(
      (r) => r.url().includes("/rpc/spaces/list") && r.request() !== staleRequest,
    );
    releaseStartup();
    await (await fresh).finished();
    await page.clock.runFor(100);
    await expect(page).toHaveURL(new RegExp("/app/" + botId + "$"));
    const composer = page.getByPlaceholder("Message Target Bot");
    await composer.fill("Keep this message on its selected bot");
    const sent = page.waitForResponse((r) => r.url().includes("/rpc/threads/send") && r.ok());
    await page.keyboard.press("Enter");
    expect((await sent).request().postDataJSON().json.botId).toBe(botId);
  } finally {
    releaseStale();
    releaseStartup();
  }
});
