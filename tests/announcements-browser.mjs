import { chromium, expect } from "@playwright/test";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fixture, root } from "./helpers.mjs";

const executablePath =
  process.env.WHITEBOARD_CHROME ||
  [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  ].find(existsSync);
const f = await fixture({ accessMode: "lan" });
let browser;
try {
  await f.call("/api/cards", {
    method: "POST",
    body: await f.work("announcement-ui/task", { project: "Other" }),
  });
  browser = await chromium.launch({
    headless: true,
    ...(executablePath ? { executablePath } : {}),
    args: ["--no-proxy-server"],
  });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(f.url);
  const bar = page.getByRole("region", { name: "公告栏" });
  await expect(bar).toBeVisible();
  await bar.getByRole("button", { name: "＋ 发布公告", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "发布公告", exact: true });
  await dialog.getByLabel("标题", { exact: true }).fill("Shared tool notice");
  await dialog.getByLabel("项目", { exact: true }).fill("Operations");
  await dialog
    .getByLabel("适用实例 / 对象", { exact: true })
    .fill("All Agents");
  await dialog
    .getByLabel("内容", { exact: true })
    .fill("Read the current shared tool entry before work.");
  await dialog
    .getByRole("button", { name: "发布到公告栏", exact: true })
    .click();
  await expect(
    bar.getByRole("button", {
      name: "查看公告：Shared tool notice",
      exact: true,
    }),
  ).toBeVisible();
  let cards = (await f.call("/api/board")).body.cards;
  const notice = cards.find((c) => c.announcement);
  expect(notice.kind).toBe("note");
  expect(notice.instance).toBe("All Agents");
  await expect(
    page.locator(`.react-flow__node[data-id="${notice.id}"]`),
  ).toHaveCount(0);
  await expect(
    page.locator(".card-list").getByText("Shared tool notice"),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "关闭详情", exact: true }).click();
  await page.getByLabel("筛选项目", { exact: true }).selectOption("Other");
  await page.getByLabel("搜索白板", { exact: true }).fill("unmatched search");
  await expect(
    bar.getByRole("button", {
      name: "查看公告：Shared tool notice",
      exact: true,
    }),
  ).toBeVisible();
  await page.getByLabel("搜索白板", { exact: true }).fill("");

  const peer = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  peer.on("pageerror", (error) => errors.push(error.message));
  await peer.goto(f.url);
  await bar
    .getByRole("button", { name: "查看公告：Shared tool notice", exact: true })
    .click();
  const inspector = page.locator(".inspector");
  await expect(
    inspector.getByRole("heading", { name: "公告详情", exact: true }),
  ).toBeVisible();
  await inspector
    .getByLabel("标题", { exact: true })
    .fill("Shared tool notice updated");
  await inspector
    .getByRole("button", { name: "保存内容", exact: true })
    .click();
  await expect(
    peer.getByRole("button", {
      name: "查看公告：Shared tool notice updated",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    inspector.getByRole("button", { name: "撤下公告", exact: true }),
  ).toBeEnabled();
  const directory = path.join(root, "artifacts", "announcements-20261112");
  mkdirSync(directory, { recursive: true });
  await page.getByRole("button", { name: "关闭详情", exact: true }).click();
  await page.screenshot({ path: path.join(directory, "desktop.png") });

  const mobile = await browser.newPage({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  mobile.on("pageerror", (error) => errors.push(error.message));
  await mobile.goto(f.url);
  await expect(mobile.getByRole("region", { name: "公告栏" })).toBeVisible();
  await mobile
    .getByRole("button", {
      name: "查看公告：Shared tool notice updated",
      exact: true,
    })
    .click();
  await expect(
    mobile.locator(".inspector").getByLabel("内容", { exact: true }),
  ).toHaveValue("Read the current shared tool entry before work.");
  const boundary = await mobile.locator(".inspector").boundingBox();
  const barBoundary = await mobile
    .getByRole("region", { name: "公告栏" })
    .boundingBox();
  expect(boundary.y).toBeGreaterThanOrEqual(
    barBoundary.y + barBoundary.height - 1,
  );
  expect(
    await mobile.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await mobile.screenshot({ path: path.join(directory, "mobile.png") });

  await bar
    .getByRole("button", {
      name: "查看公告：Shared tool notice updated",
      exact: true,
    })
    .click();
  page.once("dialog", (dialog) => dialog.accept());
  await inspector
    .getByRole("button", { name: "撤下公告", exact: true })
    .click();
  await expect(
    bar.getByRole("button", {
      name: "查看公告：Shared tool notice updated",
      exact: true,
    }),
  ).toHaveCount(0);
  await expect(
    peer.getByRole("button", {
      name: "查看公告：Shared tool notice updated",
      exact: true,
    }),
  ).toHaveCount(0);
  await inspector
    .getByRole("button", { name: "恢复公告", exact: true })
    .click();
  await expect(
    bar.getByRole("button", {
      name: "查看公告：Shared tool notice updated",
      exact: true,
    }),
  ).toBeVisible();
  await inspector.getByLabel("显示在公告栏", { exact: true }).uncheck();
  await inspector
    .getByRole("button", { name: "保存内容", exact: true })
    .click();
  await expect(
    bar.getByRole("button", {
      name: "查看公告：Shared tool notice updated",
      exact: true,
    }),
  ).toHaveCount(0);
  await inspector.getByLabel("显示在公告栏", { exact: true }).check();
  await inspector
    .getByRole("button", { name: "保存内容", exact: true })
    .click();
  await expect(
    bar.getByRole("button", {
      name: "查看公告：Shared tool notice updated",
      exact: true,
    }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("button", {
      name: "查看公告：Shared tool notice updated",
      exact: true,
    }),
  ).toBeVisible();
  cards = (await f.call("/api/board")).body.cards;
  expect(cards.filter((c) => c.announcement).map((c) => c.id)).toEqual([
    notice.id,
  ]);
  expect(cards.filter((c) => c.kind === "work")).toHaveLength(1);
  expect(errors).toEqual([]);
  console.log(
    JSON.stringify({
      passed: true,
      checks: [
        "publish and edit",
        "cross-project discovery",
        "live updates in another browser",
        "mobile discovery and reading",
        "withdraw and restore",
        "promote same note without duplication",
        "reload persistence",
      ],
    }),
  );
} finally {
  await browser?.close();
  await f.close();
}
