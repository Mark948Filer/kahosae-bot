const { chromium } = require('playwright');
const fetch = require('node-fetch');
const fs = require('fs');

// ===== 從環境變數讀取 =====
const API = process.env.API_URL;
const LINE_TOKEN = (process.env.LINE_TOKEN || '').replace(/\s+/g, '');

// ===== 訂單頁 =====
const ORDER_URL = "https://sitegiant.co/orders?channel_id=store&status=shipped&status_id=3&tabActive=store";

(async () => {
  try {
    console.log("🚀 開始執行");

    // ===== 檢查必要參數 =====
    if (!API || !LINE_TOKEN) {
      console.log("❌ 缺少 API_URL 或 LINE_TOKEN");
      process.exit(1);
    }

    if (!fs.existsSync('auth.json')) {
      console.log("❌ 找不到 auth.json");
      process.exit(1);
    }

    console.log("✅ 環境正常");

    // ===== 啟動瀏覽器 =====
    const browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    const context = await browser.newContext({
      storageState: 'auth.json'
    });

    const page = await context.newPage();

    console.log("🌐 準備進入訂單頁");

    // ===== 重試機制 =====
    let success = false;

    for (let i = 0; i < 3; i++) {
      try {
        console.log(`👉 第 ${i + 1} 次嘗試`);

        await page.goto(ORDER_URL, {
          timeout: 120000,
          waitUntil: 'domcontentloaded'
        });

        await page.waitForTimeout(8000);

        success = true;
        break;

      } catch (err) {
        console.log("⚠️ 進入失敗，重試中...");
      }
    }

    if (!success) {
      console.log("❌ 無法進入 Sitegiant（可能被擋）");
      await browser.close();
      process.exit(1);
    }

    // ===== 檢查是否被導回登入 =====
    if (page.url().includes("login")) {
      console.log("❌ 登入失效（auth.json 過期）");
      await browser.close();
      process.exit(1);
    }

    console.log("✅ 登入正常");

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

    // ===== 處理每筆訂單 =====
    for (const link of validLinks) {

      try {
        const orderId = link.match(/\/orders\/(\d+)\/view/)?.[1];

        console.log("➡️ 處理訂單:", orderId);

        const orderPage = await context.newPage();

        await orderPage.goto(link, {
          timeout: 120000,
          waitUntil: 'domcontentloaded'
        });

        await orderPage.waitForTimeout(3000);

        // ===== 抓 email + tracking =====
        const data = await orderPage.evaluate(() => {

          let email = null;

          document.querySelectorAll("div, span").forEach(el => {
            const text = el.innerText || "";

            if (text.includes("@") && text.length < 100) {
              const match = text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-z]{2,}/);
              if (match && !email) email = match[0];
            }
          });

          const body = document.body.innerText;
          const tracking = body.match(/\d{8,12}/)?.[0];

          return { email, tracking };
        });

        console.log("📄 抓到:", data);

        if (!data.email || !data.tracking) {
          console.log("❌ 資料不完整");
          await orderPage.close();
          continue;
        }

        // ===== 防重複 =====
        const check = await fetch(API, {
          method: "POST",
          headers: { "Content-Type": "text/plain" },
          body: JSON.stringify({
            type: "checkOrder",
            email: data.email,
            orderId
          })
        }).then(r => r.json());

        if (check.sent) {
          console.log("⛔ 已通知過");
          await orderPage.close();
          continue;
        }

        // ===== 找 LINE user =====
        const user = await fetch(API, {
          method: "POST",
          headers: { "Content-Type": "text/plain" },
          body: JSON.stringify({
            type: "findEmail",
            email: data.email
          })
        }).then(r => r.json());

        if (!user.userId) {
          console.log("❌ 找不到 LINE user");
          await orderPage.close();
          continue;
        }

        // ===== 發 LINE =====
        const res = await fetch("https://api.line.me/v2/bot/message/push", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${LINE_TOKEN}`
          },
          body: JSON.stringify({
            to: user.userId,
            messages: [{
              type: "text",
              text: `📦 Kahosae 出貨通知\n物流單號：${data.tracking}`
            }]
          })
        });

        console.log("📨 LINE狀態:", res.status);

        if (res.status !== 200) {
          console.log("❌ LINE 發送失敗");
          await orderPage.close();
          continue;
        }

        console.log("✅ 發送成功");

        // ===== 記錄 =====
        await fetch(API, {
          method: "POST",
          headers: { "Content-Type": "text/plain" },
          body: JSON.stringify({
            type: "markOrder",
            row: check.row,
            orderId
          })
        });

        await orderPage.close();

      } catch (err) {
        console.log("🔥 單筆錯誤:", err.message);
      }
    }

    console.log("🎉 全部完成");

    await browser.close();

  } catch (err) {
    console.log("🔥 系統錯誤:", err);
    process.exit(1);
  }
})();