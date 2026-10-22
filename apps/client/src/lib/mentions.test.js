import test from "node:test";
import assert from "node:assert/strict";
import {
  containsMention,
  getChannelMentionNotification,
  getMentionContext,
  getMentionSuggestions,
  isDirectMessageMention,
  splitMessageBody
} from "./mentions.js";

const members = [
  { id: "current", full_name: "Current User" },
  { id: "one", full_name: "Alex Smith", title: "Designer" },
  { id: "two", full_name: "Alex Stone", title: "Engineer" }
];

test("mention suggestions track the @ query and exclude the current user", () => {
  assert.deepEqual(getMentionContext("@", 1), { start: 0, end: 1, query: "" });
  assert.deepEqual(getMentionContext("Hello @Alex S", 13), {
    start: 6,
    end: 13,
    query: "Alex S"
  });
  assert.deepEqual(getMentionSuggestions(members, "current", "alex s").map((person) => person.id), ["one", "two"]);
  assert.deepEqual(getMentionSuggestions(members, "current", "alex ").map((person) => person.id), ["one", "two"]);
  assert.deepEqual(getMentionSuggestions(members, "current", "smith").map((person) => person.id), ["one"]);
  assert.deepEqual(getMentionSuggestions(members, "current", "").map((person) => person.id), ["one", "two"]);
  assert.deepEqual(getMentionContext("Hello,@", 7), { start: 6, end: 7, query: "" });
  assert.equal(getMentionContext("email@Alex", 10), null);
});

test("selected mentions remain exact message tokens and render highlighted", () => {
  assert.equal(containsMention("Hello @Alex Smith, please review.", "Alex Smith"), true);
  assert.equal(containsMention("Hello @Alex Smithers", "Alex Smith"), false);
  assert.deepEqual(
    splitMessageBody("Hi @Alex Smith, see https://example.com", [{ id: "one", full_name: "Alex Smith" }]),
    [
      { type: "text", value: "Hi " },
      { type: "mention", value: "@Alex Smith", id: "one" },
      { type: "text", value: ", see " },
      { type: "link", value: "https://example.com" }
    ]
  );
});

test("mention notification overrides channel mute but ordinary messages do not", () => {
  const base = { sender_id: "sender", sender_name: "Taylor", channel_id: "channel", body: "Hi" };
  assert.equal(getChannelMentionNotification(base, "one", { name: "general", muted: true }), null);
  const notification = getChannelMentionNotification(
    { ...base, mentioned_user_ids: ["one"] },
    "one",
    { name: "general", muted: true }
  );
  assert.equal(notification.title, "Taylor mentioned you in #general");
  assert.equal(notification.view, "chat");
  assert.equal(getChannelMentionNotification(base, "sender", { name: "general" }), null);
});

test("direct messages only notify the mentioned conversation participant", () => {
  const message = { sender_id: "sender", mentioned_user_ids: ["recipient"] };
  assert.equal(isDirectMessageMention(message, "recipient"), true);
  assert.equal(isDirectMessageMention(message, "sender"), false);
  assert.equal(isDirectMessageMention(message, "other"), false);
});
