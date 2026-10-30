import assert from "node:assert/strict";
import { test } from "node:test";
import { applyMentions, markdownToHtml, sendRequest } from "./teams-graph.js";

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
  const html = markdownToHtml("@[Jane Doe] two things.\n");
  const { content, mentions } = applyMentions(html, [{ id: "u1", displayName: "Jane Doe" }]);
  assert.equal(content, '<p><at id="0">Jane Doe</at> two things.</p>');
  assert.equal(mentions.length, 1);
});

test("no reply-to is a plain post; a reply-to quotes that message the way the client's Reply does", () => {
  const payload = { body: { contentType: "html", content: "<p>hi</p>" } };
  assert.deepEqual(sendRequest("19:a@thread.v2", payload), {
    path: "/chats/19%3Aa%40thread.v2/messages",
    body: payload,
  });
  assert.deepEqual(sendRequest("19:a@thread.v2", payload, "1761762492000"), {
    path: "/chats/19%3Aa%40thread.v2/messages/replyWithQuote",
    body: { messageIds: ["1761762492000"], replyMessage: payload },
  });
});
