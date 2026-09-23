// SPDX-License-Identifier: Apache-2.0
let ready;
export function createSafeChatRenderer(MarkdownIt) {
  const parser = new MarkdownIt({ html: false, linkify: false, typographer: false, breaks: false });
  parser.renderer.rules.image = (tokens, index) => parser.utils.escapeHtml(`[Image: ${tokens[index].content}]`);
  const validLink = parser.validateLink.bind(parser);
  parser.validateLink = (url) => /^(https?:|mailto:)/i.test(url) && validLink(url);
  const open =
    parser.renderer.rules.link_open ??
    ((tokens, index, options, _env, self) => self.renderToken(tokens, index, options));
  parser.renderer.rules.link_open = (tokens, index, options, env, self) => {
    tokens[index].attrSet("rel", "noopener noreferrer");
    tokens[index].attrSet("target", "_blank");
    return open(tokens, index, options, env, self);
  };
  return (text) =>
    parser.render(String(text).slice(0, 131072)) +
    (String(text).length > 131072 ? "<p>Display shortened. Export the chat for the complete message.</p>" : "");
}
export function loadChatMarkdown() {
  ready ??= import("./vendor/markdown-it.js").then((module) =>
    createSafeChatRenderer(globalThis.markdownit ?? module.default),
  );
  return ready;
}
