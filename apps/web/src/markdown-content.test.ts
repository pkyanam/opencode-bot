import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MarkdownContent } from "./components/markdown-content";

describe("conversation Markdown", () => {
  it("renders headings, lists, code and GFM tables with safe links", () => {
    const html = renderToStaticMarkup(createElement(MarkdownContent, {children: '# Tools\n\n- **Read** a file with `read`\n\n```js\nconsole.log("hello")\n```\n\n| Bot | Result |\n| --- | --- |\n| Scout | Ready |\n\n[Docs](https://example.com/docs)'}));
    expect(html).toContain('<h1>Tools</h1>');
    expect(html).toContain('<strong>Read</strong>');
    expect(html).toContain('<code>read</code>');
    expect(html).toContain('class="markdown-table-wrap"');
    expect(html).toContain('<th>Bot</th>');
    expect(html).toContain('class="language-js"');
    expect(html).toContain('rel="noopener noreferrer"');
  });
  it("does not execute model-provided HTML or script URLs", () => {
    const html = renderToStaticMarkup(createElement(MarkdownContent, {children: '<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n[bad](javascript:alert)\n\n**Safe text**'}));
    expect(html).not.toContain('<script');
    expect(html).not.toContain('onerror');
    expect(html).not.toContain('href="javascript:');
    expect(html).toContain('<strong>Safe text</strong>');
  });
});
