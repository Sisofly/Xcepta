const { chromium } = require('playwright');
require('dotenv').config();

(async () => {
  console.log("🚀 Launching XCEPTA Audit...");

  const browser = await chromium.launch({ headless: false, slowMo: 200 });
  const page = await browser.newPage();
  const baseUrl = process.env.BASE_URL || 'http://localhost:5173';

  try {
    await page.goto(`${baseUrl}/login`);
    console.log("👉 PLEASE LOG IN MANUALLY.");

    await page.waitForFunction(
      () => !window.location.href.includes('/login'),
      { timeout: 0 }
    );

    console.log("✅ Login detected!");
    await page.waitForTimeout(3000);

    console.log("\n--- OPEN PROJECT ---");
    await page.click('text=123');
    await page.waitForTimeout(3000);
    console.log("✅ Project opened");

    console.log("\n--- TOP TAB DISCOVERY ---");

    const buttons = await page.locator('button').allTextContents();
    buttons.forEach((btn, i) => {
      console.log(`${i + 1}. ${btn.trim()}`);
    });

    console.log("\n--- OPEN DEVELOPMENT CASH FLOW ---");

    const devTab = page.locator('button').filter({ hasText: 'Development Cash Flow' }).first();

    await devTab.scrollIntoViewIfNeeded();
    await devTab.click({ force: true });
    await page.waitForTimeout(3000);

    const bodyText = await page.locator('body').innerText();

    if (bodyText.includes('Real Estate Development Cash Flow Engine')) {
      console.log("✅ Development Cash Flow content loaded");
    } else {
      console.log("❌ Development Cash Flow content did not load");

      console.log("\nCurrent visible page text sample:");
      console.log(bodyText.slice(0, 1000));
    }

    console.log("\n--- INNER TAB CHECK ---");

    const innerTabs = ['Inputs', 'KPI Summary', 'Monthly Schedule', 'Sensitivity'];

    for (const tab of innerTabs) {
      try {
        const tabButton = page.locator('button').filter({ hasText: tab }).first();
        await tabButton.click({ force: true });
        await page.waitForTimeout(1000);
        console.log(`✅ ${tab} tab clicked`);
      } catch (err) {
        console.log(`❌ ${tab} tab failed: ${err.message}`);
      }
    }

    console.log("\n--- RUN MODEL CHECK ---");

    try {
      const inputsTab = page.locator('button').filter({ hasText: 'Inputs' }).first();
      await inputsTab.click({ force: true });
      await page.waitForTimeout(1000);

      const runButton = page.locator('button').filter({
        hasText: /run|calculate|model|engine/i
      }).first();

      await runButton.click({ force: true });
      console.log("✅ Run/Model button clicked");

      await page.waitForTimeout(4000);

      const kpiTab = page.locator('button').filter({ hasText: 'KPI Summary' }).first();
      await kpiTab.click({ force: true });
      await page.waitForTimeout(1500);

      const afterRunText = await page.locator('body').innerText();

      if (
        afterRunText.includes('IRR') ||
        afterRunText.includes('NPV') ||
        afterRunText.includes('DSCR')
      ) {
        console.log("✅ KPI Summary contains financial outputs");
      } else {
        console.log("❌ KPI Summary missing outputs");
      }

    } catch (err) {
      console.log("❌ Run Model test failed:", err.message);
    }

  } catch (err) {
    console.error("🚨 Audit Error:", err.message);
  }

  console.log("\n🏁 Audit complete.");
})();