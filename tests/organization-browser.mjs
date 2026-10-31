import { chromium, expect } from "@playwright/test";
import { fixture } from "./helpers.mjs";

const f = await fixture({ accessMode: "lan" });
let browser;
try {
  browser = await chromium.launch({
    channel: "chrome",
    headless: true,
    args: ["--no-proxy-server"],
  });
  const page = await browser.newPage({
    viewport: { width: 1600, height: 1050 },
  });
  page.setDefaultTimeout(12000);
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(f.url);
  await page.getByRole("button", { name: "＋ 主题", exact: true }).click();
  let dialog = page.getByRole("dialog", { name: "添加主题" });
  await dialog.getByLabel("标题", { exact: true }).fill("会话与消息");
  await dialog.getByLabel("项目", { exact: true }).fill("Workbench");
  await dialog
    .getByLabel("固定主题编号", { exact: true })
    .fill("topic/workbench/session");
  await dialog
    .getByLabel("内容", { exact: true })
    .fill(
      "更新者：test@headless｜时间：2026-10-30T23:00:00+11:00\n集中跟进会话与消息问题",
    );
  await dialog.getByRole("button", { name: "添加到白板", exact: true }).click();
  await expect(page.locator(".board-card.topic")).toHaveCount(1);
  await page.getByRole("button", { name: "关闭详情", exact: true }).click();
  const initial = (await f.call("/api/board")).body,
    topic = initial.cards.find((c) => c.kind === "topic");

  await page.getByRole("button", { name: "＋ 工作", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "添加工作" });
  await dialog.getByLabel("标题", { exact: true }).fill("消息恢复验收");
  await dialog.getByLabel("项目", { exact: true }).fill("Workbench");
  await dialog.getByLabel("所属主题", { exact: true }).selectOption(topic.id);
  await dialog
    .getByLabel("固定工作编号", { exact: false })
    .fill("workbench/session/acceptance");
  await dialog
    .getByLabel("要做什么 / 已有进展", { exact: true })
    .fill(
      "更新者：test@headless｜时间：2026-10-30T23:00:00+11:00\n已验证的报告",
    );
  await dialog.getByRole("button", { name: "添加到白板", exact: true }).click();
  await expect(page.locator(".board-card.work")).toHaveCount(1);
  await expect(page.locator(".inspector .relation-editor")).toContainText(
    "会话与消息",
  );
  await page.getByRole("button", { name: "关闭详情", exact: true }).click();

  const dependent = (await f.call("/api/board")).body.cards.find(
    (c) => c.kind === "work",
  );
  const prerequisite = (
    await f.call("/api/cards", {
      method: "POST",
      body: await f.work("workbench/session/api", {
        project: "Workbench",
        topic_id: topic.id,
        title: "会话接口修复",
        body: "接口验证",
      }),
    })
  ).body.card;
  const otherTopic = (
    await f.call("/api/cards", {
      method: "POST",
      body: {
        kind: "topic",
        work_key: "topic/workbench/other",
        project: "Workbench",
        title: "另一主题",
      },
    })
  ).body.card;
  const third = (
    await f.call("/api/cards", {
      method: "POST",
      body: await f.work("workbench/other", {
        project: "Workbench",
        topic_id: otherTopic.id,
        title: "另一个主题的工作",
      }),
    })
  ).body.card;
  const dependency = await f.call("/api/edges", {
    method: "POST",
    body: {
      source: dependent.id,
      target: prerequisite.id,
      relation: "depends_on",
      label: "接口修复完成后才能验收",
    },
  });
  expect(dependency.status).toBe(200);
  await f.call("/api/edges", {
    method: "POST",
    body: {
      source: third.id,
      target: dependent.id,
      relation: "related",
      label: "两处都需要检查消息恢复结果",
    },
  });
  await expect(page.locator(".board-card")).toHaveCount(5);
  await page.getByRole("button", { name: "项目总览", exact: true }).click();
  await expect(page.locator(".react-flow__edge")).toHaveCount(3);
  await page.getByRole("button", { name: "全部连线", exact: true }).click();
  await expect(page.locator(".react-flow__edge")).toHaveCount(5);
  await page.getByRole("button", { name: "收起额外连线", exact: true }).click();
  await expect(page.locator(".react-flow__edge")).toHaveCount(3);

  const before = (await f.call("/api/board")).body;
  await page.getByRole("button", { name: "一键整理", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "撤销整理", exact: true }),
  ).toBeEnabled();
  const after = (await f.call("/api/board")).body;
  expect(
    after.cards.some(
      (c) =>
        c.layout_revision >
        before.cards.find((v) => v.id === c.id).layout_revision,
    ),
  ).toBe(true);
  for (const c of after.cards)
    expect(c.revision).toBe(before.cards.find((v) => v.id === c.id).revision);
  await page.reload();
  await expect
    .poll(
      async () =>
        (
          await page
            .locator(`.react-flow__node[data-id="${topic.id}"]`)
            .boundingBox()
        )?.width || 0,
    )
    .toBeGreaterThan(180);
  await page.getByLabel("筛选项目", { exact: true }).selectOption("Workbench");
  await expect
    .poll(
      async () =>
        (
          await page
            .locator(`.react-flow__node[data-id="${topic.id}"]`)
            .boundingBox()
        )?.width || 0,
    )
    .toBeGreaterThan(280);
  await page.getByLabel("筛选项目", { exact: true }).selectOption("");
  await expect(
    page.getByRole("button", { name: "撤销整理", exact: true }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "撤销整理", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "撤销整理", exact: true }),
  ).toBeDisabled();
  const undone = (await f.call("/api/board")).body;
  for (const c of undone.cards)
    expect(c.position).toEqual(
      before.cards.find((v) => v.id === c.id).position,
    );

  await page.getByRole("button", { name: "一键整理", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "撤销整理", exact: true }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "全览", exact: true }).click();
  await page.waitForTimeout(400);
  const rects = await page.locator(".board-card").evaluateAll((nodes) =>
    nodes.map((n) => {
      const r = n.getBoundingClientRect();
      return { id: n.dataset.cardId, x: r.x, y: r.y, w: r.width, h: r.height };
    }),
  );
  for (const a of rects)
    for (const b of rects.filter((b) => b.id !== a.id))
      expect(
        a.x < b.x + b.w &&
          a.x + a.w > b.x &&
          a.y < b.y + b.h &&
          a.y + a.h > b.y,
      ).toBe(false);
  await page
    .locator(".card-list button")
    .filter({ hasText: "消息恢复验收" })
    .click();
  await expect(page.locator(".inspector .relation-editor")).toContainText(
    "前置任务",
  );
  await expect(page.locator(".react-flow__edge")).toHaveCount(5);
  await page
    .locator(".inspector")
    .getByLabel("调整所属主题")
    .selectOption(otherTopic.id);
  await page
    .locator(".inspector")
    .getByRole("button", { name: "归入主题" })
    .click();
  await expect(page.locator(".inspector .relation-editor")).toContainText(
    "所属主题：另一主题",
  );
  const moved = (await f.call("/api/cards/" + dependent.id)).body.card;
  expect(moved.revision).toBe(dependent.revision);
  const reassigned = (await f.call("/api/board")).body;
  expect(reassigned.edges.filter((e) => e.relation === "related")).toHaveLength(
    0,
  );
  expect(errors).toEqual([]);
  expect((await fetch(f.url + "/AGENT_INSTRUCTIONS.md")).status).toBe(200);
  console.log(
    JSON.stringify({
      passed: true,
      checks: [
        "create topic and work through UI",
        "readable default overview and automatic project focus",
        "atomic automatic membership",
        "default sparse edge display",
        "show all links",
        "real arrange and persistent undo buttons",
        "measured cards do not overlap",
        "reassign topic without changing content",
        "headless with no personal browser access",
      ],
      cards: rects.length,
    }),
  );
} finally {
  await browser?.close();
  await f.close();
}
