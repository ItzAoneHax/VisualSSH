import MarkdownIt from "markdown-it";

/**
 * Markdown 渲染（编辑抽屉与预览窗格共用）：html:false 转义内嵌 HTML
 * （远程文件内容不可信，防 XSS），链接强制新窗口 + noopener。
 */
const md = new MarkdownIt({ html: false, linkify: true, breaks: false });
const defaultLinkOpen =
  md.renderer.rules.link_open ??
  ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  tokens[idx].attrSet("target", "_blank");
  tokens[idx].attrSet("rel", "noopener noreferrer");
  return defaultLinkOpen(tokens, idx, options, env, self);
};

export function renderMarkdown(source: string): string {
  return md.render(source);
}
