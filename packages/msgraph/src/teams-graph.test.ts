import { test } from "node:test";
import assert from "node:assert/strict";
import { applyMentions, markdownToHtml } from "./teams-graph.js";

test("a blank line between paragraphs is one Teams spacer paragraph, not a <br>", () => {
  assert.equal(markdownToHtml("one\n\ntwo"), "<p>one</p><p>&nbsp;</p><p>two</p>");
});

test("the body's final newline and leading blank lines add nothing", () => {
  assert.equal(markdownToHtml("\n\none\n\ntwo\n"), "<p>one</p><p>&nbsp;</p><p>two</p>");
  assert.equal(markdownToHtml("one\r\n\r\n\r\ntwo\r\n\r\n"), "<p>one</p><p>&nbsp;</p><p>two</p>");
});

test("lists close on a blank line, and a spacer only goes between blocks", () => {
  assert.equal(
    markdownToHtml("Plan:\n- a\n- b\n\n1. c\n2. d\n"),
    "<p>Plan:</p><ul><li>a</li><li>b</li></ul><p>&nbsp;</p><ol><li>c</li><li>d</li></ol>",
  );
  assert.equal(markdownToHtml("- a\n1. b"), "<ul><li>a</li></ul><ol><li>b</li></ol>");
});

test("text is escaped; links, bold and code still render", () => {
  assert.equal(
    markdownToHtml("if a < b **ok** `x<y>` [AB#1](https://h/e?a=1&b=2)"),
    '<p>if a &lt; b <strong>ok</strong> <code>x&lt;y&gt;</code> <a href="https://h/e?a=1&amp;b=2">AB#1</a></p>',
  );
});

test("@[Name] survives the conversion and becomes a mention", () => {
  const html = markdownToHtml("@[Anthony Haxby] two things.\n");
  const { content, mentions } = applyMentions(html, [{ id: "u1", displayName: "Anthony Haxby" }]);
  assert.equal(content, '<p><at id="0">Anthony Haxby</at> two things.</p>');
  assert.equal(mentions.length, 1);
});
