import { chromium, expect } from "@playwright/test";
import { networkInterfaces } from "node:os";
import { fixture, ADMIN, work } from "./helpers.mjs";

const lan =
  Object.values(networkInterfaces())
    .flat()
    .find((a) => a?.family === "IPv4" && a.address.startsWith("192.168."))
    ?.address || "127.0.0.1";
const f = await fixture({
  host: "0.0.0.0",
  accessMode: "lan",
  allowedSubnets: ["127.0.0.0/8", `${lan}/32`],
});
let browser;
try {
  const url = `http://${lan}:${f.server.address().port}`;
  const card = (
    await f.call("/api/cards", {
      method: "POST",
      body: await f.work("lan/browser", {
        title: "Shared LAN work",
        body: "Owner's original note",
      }),
    })
  ).body.card;
  browser = await chromium.launch({
    channel: "chrome",
    headless: true,
    args: ["--no-proxy-server"],
  });
  const a = await browser.newContext({
    viewport: { width: 1500, height: 1000 },
  });
  const b = await browser.newContext({
    viewport: { width: 1500, height: 1000 },
  });
  const pa = await a.newPage(),
    pb = await b.newPage(),
    errors = [];
  for (const p of [pa, pb]) {
    p.setDefaultTimeout(12000);
    p.on("pageerror", (e) => errors.push(e.message));
    await p.goto(url);
    await expect(
      p.getByText("局域网共享 · 全员可编辑", { exact: true }),
    ).toBeVisible();
    await expect(p.getByLabel("访问密钥", { exact: true })).toHaveCount(0);
  }
  const select = async (p) => {
    await p
      .locator(".card-list button")
      .filter({ hasText: "Shared LAN work" })
      .click();
    await expect(
      p
        .locator(".inspector")
        .getByLabel("进展 / 已完成的结果", { exact: true }),
    ).toBeEnabled();
  };
  await select(pa);
  await select(pb);
  await pb
    .locator(".inspector")
    .getByLabel("进展 / 已完成的结果", { exact: true })
    .fill("Peer B's unsaved draft");
  await pa
    .locator(".inspector")
    .getByLabel("进展 / 已完成的结果", { exact: true })
    .fill("Peer A updated the owner's card without a key");
  await pa.getByRole("button", { name: "保存内容", exact: true }).click();
  await expect(
    pb.locator(".inspector").getByLabel("进展 / 已完成的结果", { exact: true }),
  ).toHaveValue("Peer B's unsaved draft");
  await expect(
    pb.getByRole("button", { name: "保存内容", exact: true }),
  ).toBeDisabled();
  expect((await f.call(`/api/cards/${card.id}`)).body.card.body).toBe(
    "Peer A updated the owner's card without a key",
  );
  pb.once("dialog", (dialog) => dialog.accept());
  await pb.reload();
  await select(pb);
  await pb
    .locator(".inspector")
    .getByLabel("进展 / 已完成的结果", { exact: true })
    .fill("Peer B re-read and deliberately composed this update");
  await pb.getByRole("button", { name: "保存内容", exact: true }).click();
  await expect
    .poll(
      async () => (await f.call(`/api/cards/${card.id}`)).body.card.revision,
    )
    .toBe(3);
  await pa.getByRole("button", { name: "关闭详情", exact: true }).click();
  await pa.getByRole("button", { name: "管理员登录", exact: true }).click();
  await pa.getByLabel("管理员密钥", { exact: true }).fill(ADMIN);
  await pa.getByRole("button", { name: "登录管理", exact: true }).click();
  await expect(
    pa.getByRole("button", { name: "退出独立身份", exact: true }),
  ).toBeVisible();
  await pa.getByRole("button", { name: "退出独立身份", exact: true }).click();
  await expect(
    pa.getByRole("button", { name: "管理员登录", exact: true }),
  ).toBeVisible();
  await pa.getByRole("button", { name: "Agent 接入", exact: true }).click();
  await expect(
    pa.getByText("局域网内的 Agent 可直接读写，无需密钥。", { exact: false }),
  ).toBeVisible();
  expect(errors).toEqual([]);
  console.log(
    JSON.stringify({
      passed: true,
      lanOrigin: url,
      checks: [
        "two independent browsers without keys",
        "edit an owner's existing card",
        "SSE conflict preserves draft",
        "fresh deliberate second update",
        "optional admin login and return to shared editing",
      ],
    }),
  );
} finally {
  await browser?.close();
  await f.close();
}
