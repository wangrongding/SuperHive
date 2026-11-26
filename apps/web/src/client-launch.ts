/**
 * 从网页唤起本机客户端（superhive://…）。
 *
 * 不用 window.location.assign：没装客户端时 Safari 会弹「地址无效」、Firefox 会把当前页换成错误页，
 * 邀请页就没了。改成让一个隐藏的 iframe 去打开链接：装了客户端时浏览器照常问「是否打开」，
 * 没装时最多在控制台里报一条错，当前页不动。
 *
 * 网页拿不到「唤起成功没有」的结果，只能看页面有没有失焦或被切到后台（系统弹框、切到客户端都会这样）；
 * 等了 timeoutMs 都没有，就当没唤起，onMissed 里提示人用网页加入。
 */
export function launchClient(
  link: string,
  options: { timeoutMs?: number; onMissed?: () => void } = {},
): () => void {
  const frame = document.createElement("iframe");
  frame.style.display = "none";
  frame.setAttribute("aria-hidden", "true");
  frame.tabIndex = -1;
  let left = false;
  const markLeft = () => {
    left = true;
  };
  const onVisibility = () => {
    if (document.visibilityState === "hidden") left = true;
  };
  window.addEventListener("blur", markLeft);
  window.addEventListener("pagehide", markLeft);
  document.addEventListener("visibilitychange", onVisibility);
  frame.src = link;
  document.body.appendChild(frame);
  const cleanup = () => {
    window.clearTimeout(timer);
    window.removeEventListener("blur", markLeft);
    window.removeEventListener("pagehide", markLeft);
    document.removeEventListener("visibilitychange", onVisibility);
    frame.remove();
  };
  const timer = window.setTimeout(() => {
    const missed = !left && document.hasFocus();
    cleanup();
    if (missed) options.onMissed?.();
  }, options.timeoutMs ?? 2_000);
  return cleanup;
}
