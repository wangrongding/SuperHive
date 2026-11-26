// 录屏：起文档站静态服务和宣传片演示 Server，用无头 Chrome 按镜头录下来，帧存到 <out>/clips/<镜头>/。
// 由 make.mjs 用 tsx 拉起（HOME 是临时目录），不单独运行。
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";
import { renderAssets } from "./assets.mjs";
import { Director, launchBrowser } from "./browser.mjs";
import { DOCS_VIEWPORT, heroShot, soloShot, teamShot } from "./docs-shots.mjs";
import { serveDocs } from "./docs-server.mjs";
import { APP_SHOTS, APP_VIEWPORT, appStorage, tildeHome } from "./app-shots.mjs";
import { outroShot } from "./outro-shot.mjs";

const ROOT = path.resolve(import.meta.dirname, "../../../..");

const { values } = parseArgs({
  options: {
    out: { type: "string" },
    only: { type: "string" },
    probe: { type: "boolean", default: false },
  },
});
const out = path.resolve(values.out);
const only = values.only?.split(",").map((name) => name.trim());
const want = (name) => !only || only.includes(name);
const clipDir = (name) => path.join(out, "clips", name);

const docs = await serveDocs(path.join(ROOT, "apps/docs/dist"));
docs.clipDir = clipDir;
let docsBrowser;
let appBrowser;
let demo;
try {
  docsBrowser = await launchBrowser(DOCS_VIEWPORT);
  const d = new Director(docsBrowser.cdp);
  for (const [name, shot] of [
    ["hero", heroShot],
    ["solo", soloShot],
    ["team", teamShot],
    ["outro", outroShot],
  ]) {
    if (!want(name)) continue;
    console.log(`[promo] 录 ${name}`);
    const result = await shot(d, docs);
    console.log(`[promo]   ${result.frames.length} 帧，${result.duration.toFixed(1)} 秒`);
  }
  await docsBrowser.close();
  docsBrowser = undefined;

  const appShots = APP_SHOTS.filter((shot) => want(shot.name));
  if (appShots.length || values.probe) {
    appBrowser = await launchBrowser(APP_VIEWPORT);
    const images = await renderAssets(appBrowser.cdp);
    const { startPromoServer } = await import("./server.mjs");
    demo = await startPromoServer({ images });
    demo.images = images;
    const app = new Director(appBrowser.cdp);
    await app.setup({
      ...APP_VIEWPORT,
      origin: demo.url,
      storage: appStorage(demo.owner),
    });
    // 页面上的临时目录显示成 ~（演示仓库在 ~/work/web）
    await app.cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: tildeHome(demo.home) });
    if (values.probe) {
      await app.goto(`${demo.url}/#web`, `__promo.find(".message-list")`);
      await app.wait(2500);
      const shot = await app.cdp.send("Page.captureScreenshot", { format: "png" });
      fs.mkdirSync(out, { recursive: true });
      fs.writeFileSync(path.join(out, "probe.png"), Buffer.from(shot.data, "base64"));
      console.log(`[promo] 探查截图：${path.join(out, "probe.png")}  ${demo.url}`);
      if (process.env.PROMO_HOLD)
        await new Promise((resolve) => setTimeout(resolve, Number(process.env.PROMO_HOLD)));
    }
    for (const shot of appShots) {
      console.log(`[promo] 录 ${shot.name}`);
      let result;
      try {
        // 卡住（比如等一个永远不出现的状态）时不要一直挂着
        result = await Promise.race([
          shot.run(app, demo, clipDir(shot.name)),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("超过 3 分钟没录完")), 180_000),
          ),
        ]);
      } catch (error) {
        // 留一张出错时的画面，方便看卡在哪
        const shotData = await app.cdp.send("Page.captureScreenshot", { format: "png" });
        fs.mkdirSync(out, { recursive: true });
        fs.writeFileSync(
          path.join(out, `failed-${shot.name}.png`),
          Buffer.from(shotData.data, "base64"),
        );
        await app.cdp.send("Page.stopScreencast").catch(() => undefined);
        throw new Error(`${shot.name}：${error.message}（画面见 failed-${shot.name}.png）`);
      }
      console.log(`[promo]   ${result.frames.length} 帧，${result.duration.toFixed(1)} 秒`);
      const leaks = await app.eval("window.__promoLeaks ?? []");
      if (leaks.length)
        throw new Error(`${shot.name}：画面上出现了本机路径或用户名：\n${leaks.join("\n")}`);
    }
  }
} finally {
  await docsBrowser?.close();
  await appBrowser?.close();
  await demo?.stop();
  await docs.close();
}
process.exit(0);
