import { createPinia } from "pinia";
import { createApp } from "vue";

import App from "./App.vue";
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

createApp(App).use(createPinia()).mount("#app");
