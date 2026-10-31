import { chromium, expect } from "@playwright/test";
import { networkInterfaces } from "node:os";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fixture, ADMIN, root, work } from "./helpers.mjs";

const addresses = Object.values(networkInterfaces())
  .flat()
  .filter((a) => a?.family === "IPv4" && !a.internal)
  .map((a) => a.address);
const lan =
  addresses.find((a) => a.startsWith("192.168.")) ||
  addresses.find((a) => a.startsWith("10.")) ||
  addresses[0] ||
  "127.0.0.1";
const executablePath =
  process.env.WHITEBOARD_CHROME ||
  [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  ].find(existsSync);
const f = await fixture({ host: "0.0.0.0" });
let browser, pageForDebug;
try {
  const url = `http://${lan}:${f.server.address().port}`;
  expect((await fetch(`${url}/api/health`)).status).toBe(200);
  browser = await chromium.launch({
    headless: true,
    ...(executablePath ? { executablePath } : {}),
    args: ["--no-proxy-server"],
  });
  const context = await browser.newContext({
      viewport: { width: 1500, height: 1000 },
    }),
    page = await context.newPage(),
    errors = [];
  pageForDebug = page;
  page.setDefaultTimeout(12000);
  page.on("pageerror", (e) => errors.push(e.message));
  const login = async (p, token) => {
    await p.goto(url);
    await p.getByLabel("访问密钥").fill(token);
    await p.getByRole("button", { name: "进入白板 →" }).click();
    await expect(p.getByText("团队此刻，进行到哪里。")).toBeVisible();
  };
  await login(page, ADMIN);
  const localContext = await browser.newContext();
  const localPage = await localContext.newPage();
  await localPage.goto(f.url);
  await localPage.getByLabel("访问密钥").fill(ADMIN);
  await localPage.getByRole("button", { name: "进入白板 →" }).click();
  await localPage
    .getByRole("button", { name: "Agent 接入", exact: true })
    .click();
  const connection = await (
    await fetch(`${f.url}/api/connection`, {
      headers: { Authorization: `Bearer ${ADMIN}` },
    })
  ).json();
  if (connection.lan_urls.length)
    await expect(
      localPage.getByLabel("Agent 连接地址（跨机器请选择局域网地址）", {
        exact: true,
      }),
    ).toHaveValue(connection.lan_urls[0]);
  await localContext.close();
  if (lan !== "127.0.0.1")
    expect(await page.evaluate(() => window.isSecureContext)).toBe(false);
  const humanTopic = await f.topicFor("Whiteboard");
  await expect
    .poll(async () => await page.locator(".board-card.topic").count())
    .toBeGreaterThan(0);
  await page.getByRole("button", { name: "＋ 工作", exact: true }).click();
  let dialog = page.getByRole("dialog", { name: "添加工作" });
  await dialog
    .getByLabel("标题", { exact: true })
    .fill("HASHI Whiteboard · 第一版");
  await dialog.getByLabel("项目", { exact: true }).fill("Whiteboard");
  await dialog.getByLabel("所属主题", { exact: true }).selectOption(humanTopic);
  await dialog
    .getByLabel("固定工作编号", { exact: false })
    .fill("whiteboard/v1/acceptance");
  await dialog
    .getByLabel("要做什么 / 已有进展", { exact: true })
    .fill("共享画布、逐卡更新和 Agent 接入已接通。");
  await dialog.getByRole("button", { name: "添加到白板" }).click();
  await expect(
    page
      .locator(".board-card h3")
      .filter({ hasText: "HASHI Whiteboard · 第一版" }),
  ).toBeVisible();
  let inspector = page.locator(".inspector");
  await inspector
    .getByLabel("工作状态", { exact: true })
    .selectOption("in_progress");
  await inspector
    .getByLabel("进展 / 已完成的结果", { exact: true })
    .fill("HTTP / MCP 与十位 Agent 并行更新验证通过。");
  await inspector
    .getByLabel("下一步 / 接手须知", { exact: true })
    .fill("完成浏览器协作验收。");
  await inspector.getByText("开发信息（论文等工作可留空）").click();
  await inspector
    .getByLabel("分支", { exact: true })
    .fill("feature/whiteboard-v1");
  await inspector
    .getByLabel("HASHI 实例 / 工作位置", { exact: true })
    .fill("独立本机服务");
  await inspector
    .getByRole("button", { name: "保存内容", exact: true })
    .click();
  await expect
    .poll(
      async () =>
        (await f.call("/api/board")).body.cards.find((c) => c.kind === "work")
          ?.revision,
    )
    .toBe(2);
  const humanCard = (await f.call("/api/board")).body.cards.find(
    (c) => c.kind === "work",
  );
  const agent = await f.addActor("玉环 · HASHI3");
  const agentCard = (
    await f.call("/api/cards", {
      method: "POST",
      token: agent.token,
      body: await f.work("hashi/settings/fc-contract", {
        project: "HASHI",
        title: "HASHI Settings · FC 接口",
        status: "in_progress",
        body: "配置读写已完成，等待前端联调。",
        branch: "feature-settings",
        instance: "HASHI3",
        next_step: "检查多实例选择与保存冲突。",
        merge_status: "not_opened",
      }),
    })
  ).body.card;
  await expect(
    page.locator(".board-card h3").filter({ hasText: agentCard.title }),
  ).toBeAttached();
  const agentContext = await browser.newContext({
      viewport: { width: 1400, height: 950 },
    }),
    agentPage = await agentContext.newPage();
  await login(agentPage, agent.token);
  await agentPage
    .getByRole("button")
    .filter({ hasText: "HASHI Whiteboard · 第一版" })
    .click();
  await expect(
    agentPage
      .locator(".inspector")
      .getByLabel("进展 / 已完成的结果", { exact: true }),
  ).toBeDisabled();
  await agentPage
    .getByLabel("添加一条评论", { exact: true })
    .fill("Agent 已读取：接口已完成，可以接着验证协作。");
  await agentPage
    .getByRole("button", { name: "发送评论", exact: true })
    .click();
  await expect(
    page.locator(".comment").filter({ hasText: "Agent 已读取" }),
  ).toBeVisible();
  // Another writer changes this exact card while the human has an unsaved draft.
  const draft = inspector.getByLabel("进展 / 已完成的结果", { exact: true });
  await draft.fill("这段未保存草稿必须保留。");
  await inspector
    .getByLabel("添加一条评论", { exact: true })
    .fill("先留言，不应丢失我的进展草稿。");
  await inspector
    .getByRole("button", { name: "发送评论", exact: true })
    .click();
  await expect(
    inspector.locator(".comment").filter({ hasText: "先留言" }),
  ).toBeVisible();
  await expect(draft).toHaveValue("这段未保存草稿必须保留。");
  page.once("dialog", (d) => d.dismiss());
  await page.locator(".list-item").filter({ hasText: agentCard.title }).click();
  await expect(draft).toHaveValue("这段未保存草稿必须保留。");
  await f.call(`/api/cards/${humanCard.id}`, {
    method: "PATCH",
    body: {
      expected_revision: 2,
      changes: { body: "外部已验证：并发写入完成，正在检查白板交互。" },
    },
  });
  await expect(inspector.getByText("有更新，当前草稿已保留。")).toBeVisible();
  await expect(draft).toHaveValue("这段未保存草稿必须保留。");
  await expect(
    inspector.getByRole("button", { name: "保存内容", exact: true }),
  ).toBeDisabled();
  page.once("dialog", (d) => d.accept());
  await inspector
    .getByRole("button", { name: "重新读取", exact: true })
    .click();
  await expect(draft).toHaveValue(
    "外部已验证：并发写入完成，正在检查白板交互。",
  );
  await page.getByRole("button", { name: "关闭详情", exact: true }).click();
  await page.getByRole("button", { name: "✎ 画笔", exact: true }).click();
  const layer = page.getByTestId("drawing-layer"),
    rect = await layer.boundingBox();
  await page.mouse.move(rect.x + 130, rect.y + 390);
  await page.mouse.down();
  for (let i = 0; i < 18; i++)
    await page.mouse.move(
      rect.x + 130 + i * 14,
      rect.y + 390 + Math.sin(i / 3) * 30,
    );
  await page.mouse.up();
  await expect
    .poll(async () => (await f.call("/api/board")).body.strokes.length)
    .toBe(1);
  await page.getByRole("button", { name: "↖ 选择", exact: true }).click();
  await page.getByRole("button", { name: "＋ 便签", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "添加便签" });
  await dialog.getByLabel("标题", { exact: true }).fill("PhD · Chapter 3");
  await f.call(`/api/cards/${humanCard.id}/comments`, {
    method: "POST",
    token: agent.token,
    body: { body: "同步刷新期间保持输入焦点。" },
  });
  await page.waitForTimeout(150);
  await expect(dialog.getByLabel("标题", { exact: true })).toBeFocused();
  await dialog.getByLabel("项目", { exact: true }).fill("PhD");
  await dialog
    .getByLabel("内容", { exact: true })
    .fill("敏感性分析已有初步结果。\n下一步：核对假设与引用，再更新论文段落。");
  await dialog.getByRole("button", { name: "添加到白板" }).click();
  await page.getByRole("button", { name: "关闭详情", exact: true }).click();
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jN0cAAAAASUVORK5CYII=",
    "base64",
  );
  await page
    .locator("input[type=file]")
    .setInputFiles({ name: "示意图.png", mimeType: "image/png", buffer: png });
  await expect(page.locator(".board-card.image")).toBeAttached();
  await expect(page.locator(".board-card.image img")).toHaveJSProperty(
    "naturalWidth",
    1,
  );
  if (await page.getByRole("button", { name: "关闭详情", exact: true }).count())
    await page.getByRole("button", { name: "关闭详情", exact: true }).click();
  await page.getByRole("button", { name: "全览", exact: true }).click();
  await page.waitForTimeout(350);
  const source = page.locator(
      `.react-flow__node[data-id="${humanCard.id}"] .react-flow__handle.source`,
    ),
    target = page.locator(
      `.react-flow__node[data-id="${agentCard.id}"] .react-flow__handle.target.react-flow__handle-left`,
    );
  await source.dragTo(target);
  const linkDialog = page.getByRole("dialog", { name: "连接卡片" });
  await linkDialog.getByLabel("连线含义").selectOption("related");
  await linkDialog
    .getByLabel("具体原因")
    .fill("两项工作共同验证同一个接入界面");
  await linkDialog.getByRole("button", { name: "保存连接" }).click();
  await expect
    .poll(
      async () =>
        (await f.call("/api/board")).body.edges.filter(
          (e) => e.relation === "related",
        ).length,
    )
    .toBe(1);
  const note = (await f.call("/api/board")).body.cards.find(
    (c) => c.title === "PhD · Chapter 3",
  );
  const head = page.locator(`.react-flow__node[data-id="${note.id}"] h3`),
    box = await head.boundingBox();
  await page.mouse.move(box.x + 50, box.y + 8);
  await page.mouse.down();
  await page.mouse.move(box.x + 100, box.y + 68, { steps: 10 });
  await page.mouse.up();
  await expect
    .poll(
      async () =>
        (await f.call(`/api/cards/${note.id}`)).body.card.layout_revision,
    )
    .toBe(2);
  expect((await f.call(`/api/cards/${note.id}`)).body.card.revision).toBe(1);
  if (await page.getByRole("button", { name: "关闭详情", exact: true }).count())
    await page.getByRole("button", { name: "关闭详情", exact: true }).click();
  await page.reload();
  await expect(page.locator(".board-card")).toHaveCount(6);
  await page.getByRole("button", { name: "全览", exact: true }).click();
  await page.waitForTimeout(350);
  await expect(page.getByText("实时连接", { exact: true })).toBeVisible();
  mkdirSync(path.join(root, "artifacts"), { recursive: true });
  await page.screenshot({
    path: path.join(root, "artifacts", "whiteboard-v1.png"),
    fullPage: true,
  });
  expect(errors).toEqual([]);
  console.log(
    JSON.stringify({
      passed: true,
      browser: "Chrome",
      lanOrigin: url,
      insecureLanTest: lan !== "127.0.0.1",
      checks: [
        "human create/edit",
        "agent read/comment ownership",
        "SSE without reload",
        "draft conflict preserved",
        "freehand drawing",
        "image upload",
        "handle connection",
        "independent layout revision",
        "reload persistence",
      ],
      screenshot: path.join(root, "artifacts", "whiteboard-v1.png"),
    }),
  );
} catch (error) {
  if (pageForDebug) {
    await pageForDebug.screenshot({
      path: path.join(root, "artifacts", "browser-failure.png"),
      fullPage: true,
    });
    console.error(
      (await pageForDebug.locator("body").innerText()).slice(-6000),
    );
  }
  throw error;
} finally {
  await browser?.close();
  await f.close();
}
