// 字体异步加载器：替代 HTML 中的 onload 内联事件
// 通过 media="print" + load 事件切换为 "all"，实现非阻塞首屏渲染
//
// 与原 HTML 内联写法等价：
//   <link rel="stylesheet" href="..." media="print" onload="this.media='all'" />
//
// 该模块不导出任何内容，import 即执行；如需在 <noscript> 场景下生效，
// HTML 中已保留 <noscript><link rel="stylesheet" .../></noscript> 兜底。

const FONT_HREF = "https://fonts.font.im/css2?family=LXGW+WenKai&display=swap";

function loadFontAsync(href) {
  // 服务端渲染或非浏览器环境直接跳过
  if (typeof document === "undefined") return;

  // 防止重复注入（HMR / 多次 import）
  const existing = document.querySelector(`link[data-async-font="${href}"]`);
  if (existing) return;

  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = href;
  link.media = "print";
  link.dataset.asyncFont = href;
  link.addEventListener(
    "load",
    () => {
      link.media = "all";
    },
    { once: true }
  );
  document.head.appendChild(link);
}

loadFontAsync(FONT_HREF);
