const { chromium } = require('playwright');
const fetch = require('node-fetch');
const fs = require('fs');

// ===== 設定 =====
const API = "https://script.google.com/macros/s/AKfycbyRj-4Q8VQN_4CGsWPmC_neuzvAkeIQSYnvm79BdADkaf3YY2TYjLlZ0JtuJ5V5OfhYxA/exec";

// 🔥 自動移除空格（避免 token 壞掉）
const LINE_TOKEN = "LsCmEOppEws3IcGNy76VzyJMbgiIbVKTweryWFVV9NIgdUkZ8zB6GFqOu8PkGL3yuG7P2/aGBEYpQnUH3um0+y nTBqsaIrKnYkGD389THNAEYIo40yvP9w94kzAn5B/dBIdknfbiU/rCXqzC1hi5bQdB04t89/1O/w1cDnyilFU="
  .replace(/\s+/g, '');

const ORDER_URL = "https://sitegiant.co/orders?channel_id=store&status=shipped&status_id=3&tabActive=store";

// ===== 主程式 =====
(async () => {

  try {

    console.log("🚀 開始執行");

    // ===== 檢查 auth.json =====
    if (!fs.existsSync('auth.json')) {
      console.log("❌ 找不到 auth.json");
      process.exit(1);
    }

    console.log("✅ auth.json 存在");

    // ===== 啟動瀏覽器 =====
    const browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    const context = await browser.newContext({
      storageState: 'auth.json'
    });

    console.log("✅ 已載入登入狀態");

    const page = await context.newPage();

    console.log("👉 前往訂單頁");

    await page.goto(ORDER_URL, { timeout: 60000 });
    await page.waitForTimeout(5000);

    // ===== 🔥 驗證登入狀態 =====
    const currentUrl = page.url();

    if (currentUrl.includes("login")) {
      console.log("❌ auth.json 已失效（被導回登入頁）");
      await browser.close();
      process.exit(1);
    }

    console.log("✅ 登入狀態正常");

    // ===== 抓訂單連結 =====
    const links = await page.evaluate(() => {
      const arr = [];
      document.querySelectorAll("a").forEach(a => {
        if (a.href.includes("/orders/") && a.href.includes("/view")) {
          arr.push(a.href);
        }
      });
      return [...new Set(arr)];
    });

    const validLinks = links.filter(link => link.match(/\/orders\/\d+\/view/));

    console.log("📦 訂單數量:", validLinks.length);

    // ===== 逐筆處理 =====
    for (const link of validLinks) {

      try {

        const orderIdMatch = link.match(/\/orders\/(\d+)\/view/);
        const orderId = orderIdMatch ? orderIdMatch[1] : null;

        console.log("➡️ 處理訂單:", orderId);

        const orderPage = await context.newPage();
        await orderPage.goto(link, { timeout: 60000 });

        await orderPage.waitForLoadState('networkidle');
        await orderPage.waitForTimeout(3000);

        // ===== 抓資料 =====
        const data = await orderPage.evaluate(() => {

          let email = null;

          const elements = document.querySelectorAll("div, span");

          elements.forEach(el => {
            const text = el.innerText || "";

            if (text.includes("@") && text.length < 100) {
              const match = text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-z]{2,}/);
              if (match && !email) {
                email = match[0];
              }
            }
          });

          const bodyText = document.body.innerText;
          const trackingMatch = bodyText.match(/\d{8,12}/);

          return {
            email,
            tracking: trackingMatch ? trackingMatch[0] : null
          };
        });

        console.log("📄 抓到資料:", data);

        if (!data.email || !data.tracking) {
          console.log("❌ 資料不完整");
          await orderPage.close();
          continue;
        }

        // ===== 防重複 =====
        const checkRes = await fetch(API, {
          method: "POST",
          headers: { "Content-Type": "text/plain" },
          body: JSON.stringify({
            type: "checkOrder",
            email: data.email,
            orderId
          })
        });

        const checkData = await checkRes.json();

        if (checkData.sent) {
          console.log("⛔ 已發過:", orderId);
          await orderPage.close();
          continue;
        }

        // ===== 查 userId =====
        const res = await fetch(API, {
          method: "POST",
          headers: { "Content-Type": "text/plain" },
          body: JSON.stringify({
            type: "findEmail",
            email: data.email
          })
        });

        const user = await res.json();

        if (!user.userId) {
          console.log("❌ 找不到 userId");
          await orderPage.close();
          continue;
        }

        // ===== 發 LINE =====
        const lineRes = await fetch("https://api.line.me/v2/bot/message/push", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": "Bearer " + LINE_TOKEN
          },
          body: JSON.stringify({
            to: user.userId,
            messages: [{
              type: "text",
              text: `📦 Kahosae 出貨通知\n物流單號：${data.tracking}`
            }]
          })
        });

        console.log("📨 LINE狀態:", lineRes.status);

        if (lineRes.status !== 200) {
          console.log("❌ LINE 發送失敗");
          await orderPage.close();
          continue;
        }

        console.log("✅ 已發送:", orderId);

        // ===== 記錄 =====
        await fetch(API, {
          method: "POST",
          headers: { "Content-Type": "text/plain" },
          body: JSON.stringify({
            type: "markOrder",
            row: checkData.row,
            orderId
          })
        });

        await orderPage.waitForTimeout(2000);
        await orderPage.close();

      } catch (err) {
        console.log("🔥 單筆錯誤:", err.message);
      }
    }

    console.log("🎉 全部完成");

    await browser.close();

  } catch (err) {
    console.log("🔥 系統錯誤:", err);
  }

})();