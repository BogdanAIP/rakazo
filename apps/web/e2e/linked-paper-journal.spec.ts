import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, signup } from "./helpers";

test("main login opens linked journal and returns to existing chats", async ({
  page,
}, testInfo) => {
  await page.route("**/linked-paper/status", (route) =>
    route.fulfill({ json: { available: true } }),
  );
  // Financial UI remains the existing separately reviewed journal bundle.
  // This fixture tests only its host route, account menu and return path.
  await page.route("**/linked-paper/view", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><html lang='ru'><body><h2>Фьючерсы · PAPER</h2><p>Проверочный журнал</p></body></html>",
    }),
  );
  await signup(page, `linked-journal-${Date.now()}@example.test`, "password12", "Journal Owner");
  await completeOnboarding(page);
  await expect(page.getByPlaceholder("Message Chief")).toBeVisible();
  await page.getByTestId("user-menu-trigger").click();
  await page.getByRole("button", { name: "Журнал PAPER", exact: true }).click();
  await expect(page).toHaveURL(/\/app\/linked-paper-journal$/);
  await expect(page.getByRole("heading", { name: "Журнал PAPER", exact: true })).toBeVisible();
  await expect(
    page
      .frameLocator('iframe[title="Журнал виртуальной торговли"]')
      .getByRole("heading", { name: "Фьючерсы · PAPER" }),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "Sign in to Rakazo" })).toHaveCount(0);
  await captureScreenshot(page, testInfo, "linked-paper-primary-session");
  await page.getByRole("link", { name: "← Rakazo" }).click();
  await expect(page.getByPlaceholder("Message Chief")).toBeVisible();
  await expect(page.getByTestId("user-menu-trigger")).toContainText("Journal Owner");
});

test("unavailable journal is hidden from account menu and fails closed on deep link", async ({
  page,
}) => {
  await page.route("**/linked-paper/status", (route) =>
    route.fulfill({ status: 403, json: { error: "Denied" } }),
  );
  await signup(
    page,
    `linked-unavailable-${Date.now()}@example.test`,
    "password12",
    "Unlinked Owner",
  );
  await completeOnboarding(page);
  await page.getByTestId("user-menu-trigger").click();
  await expect(page.getByRole("button", { name: "Журнал PAPER", exact: true })).toHaveCount(0);
  await page.goto("/app/linked-paper-journal");
  await expect(page.getByRole("status")).toHaveText("Журнал сейчас недоступен.");
  await expect(page.locator("iframe")).toHaveCount(0);
});

test("journal deep link returns through the primary sign-in page", async ({ page }) => {
  await page.route("**/linked-paper/status", (route) =>
    route.fulfill({ json: { available: true } }),
  );
  await page.route("**/linked-paper/view", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><html><body><h2>Проверочный журнал</h2></body></html>",
    }),
  );
  const email = "linked-signin-" + Date.now() + "@example.test";
  await signup(page, email, "password12", "Returning Owner");
  await completeOnboarding(page);
  await page.getByTestId("user-menu-trigger").click();
  await Promise.all([
    page.waitForResponse(
      (response) =>
        response.url().includes("/api/auth/sign-out") && response.request().method() === "POST",
    ),
    page.getByRole("button", { name: "Log out", exact: true }).click(),
  ]);
  await page.goto("/app/linked-paper-journal");
  await expect(page).toHaveURL(/\/sign-in\?next=\/app\/linked-paper-journal$/);
  await expect(page.getByRole("heading", { name: "Sign in to Rakazo" })).toBeVisible();
  await expect(page.locator("iframe")).toHaveCount(0);
  await page.getByPlaceholder("Your email address").fill(email);
  await page.getByPlaceholder("Password").fill("password12");
  await page.getByRole("button", { name: "Continue with email", exact: true }).click();
  await expect(page).toHaveURL(/\/app\/linked-paper-journal$/);
  await expect(
    page
      .frameLocator('iframe[title="Журнал виртуальной торговли"]')
      .getByRole("heading", { name: "Проверочный журнал" }),
  ).toBeVisible();
});
