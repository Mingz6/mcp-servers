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

test("lists close on a blank line; no spacer next to a list, its own margin is the gap", () => {
  assert.equal(
    markdownToHtml("Plan:\n- a\n- b\n\n1. c\n2. d\n"),
    "<p>Plan:</p><ul><li>a</li><li>b</li></ul><ol><li>c</li><li>d</li></ol>",
  );
  assert.equal(markdownToHtml("- a\n1. b"), "<ul><li>a</li></ul><ol><li>b</li></ol>");
});

// Outbox #519 (2026-11-23) showed two blank lines above and below its list. Messages typed in the Teams
// client put a list straight after the paragraph (<p>x</p><ol>, Anthony 11-06 and 11-19, Limin 10-05).
test("a blank line around a list adds no spacer, between paragraphs it still does", () => {
  assert.equal(
    markdownToHtml("Done.\n\n- @[A] one\n- @[B] two\n\nUpdated today.\n"),
    "<p>Done.</p><ul><li>@[A] one</li><li>@[B] two</li></ul><p>Updated today.</p>",
  );
  assert.equal(
    markdownToHtml("- a\n\none\n\ntwo"),
    "<ul><li>a</li></ul><p>one</p><p>&nbsp;</p><p>two</p>",
  );
  assert.equal(markdownToHtml("one\n\n\n- a"), "<p>one</p><ul><li>a</li></ul>");
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
