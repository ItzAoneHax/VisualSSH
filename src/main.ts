import { createPinia } from "pinia";
import { createApp } from "vue";

import App from "./App.vue";
import { useTransferStore } from "./stores/transfer";
import "./assets/styles/main.css";

// 屏蔽 WebView2 原生右键菜单（老式 Win32 样式）；文本输入框保留系统菜单
window.addEventListener("contextmenu", (e) => {
  const target = e.target as HTMLElement | null;
  if (
    target &&
    (target.tagName === "INPUT" ||
      target.tagName === "TEXTAREA" ||
      target.isContentEditable)
  ) {
    return;
  }
  e.preventDefault();
});

const app = createApp(App).use(createPinia());
// 传输中心事件订阅（浏览器预览环境自动跳过）
void useTransferStore(app.config.globalProperties.$pinia).bindEvents();
app.mount("#app");
