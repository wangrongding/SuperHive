/* global document, superhive, localStorage, fetch */
const $ = (id) => document.getElementById(id);

function roll(spec) {
  const match = /^(\d{1,2})d(\d{1,3})$/i.exec(spec.trim() || "1d6");
  if (!match) return undefined;
  const count = Number(match[1]);
  const sides = Number(match[2]);
  const values = Array.from({ length: count }, () => 1 + Math.floor(Math.random() * sides));
  return { values, total: values.reduce((a, b) => a + b, 0) };
}

async function rollAndInsert(spec) {
  const result = roll(spec);
  if (!result) {
    $("result").textContent = "写成 2d6 这样";
    return;
  }
  $("result").textContent = `${result.values.join(" + ")} = ${result.total}`;
  await superhive.call("composer.insert", {
    text: `🎲 ${spec}: ${result.values.join(" + ")} = ${result.total}`,
  });
}

$("form").addEventListener("submit", (event) => {
  event.preventDefault();
  void rollAndInsert($("spec").value);
});

superhive.on("command", ({ name, args }) => {
  if (name !== "roll") return;
  $("spec").value = args || "1d6";
  void rollAndInsert($("spec").value);
});

// 宿主发来主题、语言：面板加载完和切换主题时各一次
superhive.on("context", ({ theme }) => (document.documentElement.dataset.theme = theme));
superhive.call("context.get").then(({ theme }) => (document.documentElement.dataset.theme = theme));

superhive.call("room.members").then(
  (members) => ($("who").textContent = `房间里 ${members.length} 位成员`),
  (error) => ($("who").textContent = `读不到成员：${error.code}`),
);

// 演示隔离：没申请的权限会被拒绝；也拿不到宿主的 localStorage、联不了网
superhive.call("room.messages").then(
  () => ($("probe").textContent += " · room.messages：意外放行"),
  (error) => ($("probe").textContent += ` · room.messages：${error.code}（没申请 room:read）`),
);
try {
  localStorage.getItem("x");
  $("probe").textContent += " · localStorage 可用";
} catch {
  $("probe").textContent += " · localStorage 不可用（不透明源）";
}
fetch("https://example.com").then(
  () => ($("probe").textContent += " · 联网成功（不应该）"),
  () => ($("probe").textContent += " · 联网被 CSP 拦下"),
);
