function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function getMentionContext(value, caret) {
  const match = /(^|[^A-Za-z0-9_@])@([^@\n]*)$/.exec(value.slice(0, caret));
  if (!match) return null;
  const query = match[2];
  return {
    start: match.index + match[1].length,
    end: caret,
    query
  };
}

export function getMentionSuggestions(members, currentUserId, query) {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  return members
    .filter((member) =>
      member.id !== currentUserId &&
      (normalizedQuery === "" ||
        member.full_name.toLocaleLowerCase().startsWith(normalizedQuery) ||
        member.full_name.toLocaleLowerCase().split(/\s+/).some((part) => part.startsWith(normalizedQuery)) ||
        member.employee_id?.toLocaleLowerCase().startsWith(normalizedQuery))
    )
    .slice(0, 6);
}

export function containsMention(body, fullName) {
  const expression = new RegExp(
    `(^|\\s)@${escapeRegExp(fullName)}(?=$|[\\s.,!?;:)\\]])`,
    "i"
  );
  return expression.test(body);
}

export function splitMessageBody(body, mentions) {
  const namedMentions = mentions.filter((mention) => mention?.full_name);
  const patterns = namedMentions
    .map((mention) => escapeRegExp(mention.full_name))
    .sort((first, second) => second.length - first.length);
  const expression = patterns.length
    ? new RegExp(`(https?:\\/\\/[^\\s]+|@(?:${patterns.join("|")})(?=$|[\\s.,!?;:)\\]]))`, "gi")
    : /(https?:\/\/[^\s]+)/gi;
  const parts = [];
  let previousIndex = 0;

  for (const match of body.matchAll(expression)) {
    if (match.index > previousIndex) parts.push({ type: "text", value: body.slice(previousIndex, match.index) });
    const value = match[0];
    if (/^https?:\/\//i.test(value)) {
      parts.push({ type: "link", value });
    } else {
      const fullName = value.slice(1);
      const mention = namedMentions.find((entry) => entry.full_name.toLocaleLowerCase() === fullName.toLocaleLowerCase());
      parts.push(mention
        ? { type: "mention", value, id: mention.id }
        : { type: "text", value });
    }
    previousIndex = match.index + value.length;
  }
  if (previousIndex < body.length) parts.push({ type: "text", value: body.slice(previousIndex) });
  return parts;
}

export function getChannelMentionNotification(message, currentUserId, channel) {
  if (message.sender_id === currentUserId) return null;
  const isMentioned = (message.mentioned_user_ids || []).includes(currentUserId);
  if (channel?.muted && !isMentioned) return null;
  return {
    title: isMentioned
      ? `${message.sender_name} mentioned you in #${channel?.name || "group"}`
      : `${message.sender_name} in #${channel?.name || "group"}`,
    body: message.body || `Shared ${message.file_name || "a file"}`,
    tag: `channel-${message.channel_id}`,
    sound: "message",
    view: "chat"
  };
}

export function isDirectMessageMention(message, currentUserId) {
  return message.sender_id !== currentUserId &&
    (message.mentioned_user_ids || []).includes(currentUserId);
}
