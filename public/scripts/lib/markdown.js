function escapeHtml(value) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function sanitiseUrl(value) {
  if (typeof value !== "string") {
    return "";
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  try {
    const url = new URL(trimmed, globalThis.location?.origin || "https://localhost");
    if (url.protocol === "http:" || url.protocol === "https:") {
      return url.href;
    }
  } catch (_error) {
    // ignore invalid URL
  }
  return "";
}

function renderPlainInline(text) {
  return escapeHtml(text)
    .replace(/(\*\*|__)([^*_]+?)\1/g, (_, __, content) => `<strong>${content}</strong>`)
    .replace(/~~([^~]+?)~~/g, (_, content) => `<del>${content}</del>`)
    .replace(/(\*|_)([^*_]+?)\1/g, (_, __, content) => `<em>${content}</em>`);
}

function renderInline(text) {
  // Recognise code and link destinations before emphasis. Never process generated HTML.
  const tokens = /`([^`]+)`|(!?)\[([^\]]*)\]\(([^)\n]+)\)/g;
  let html = "";
  let offset = 0;
  for (const match of text.matchAll(tokens)) {
    html += renderPlainInline(text.slice(offset, match.index));
    if (match[1] !== undefined) html += `<code>${escapeHtml(match[1])}</code>`;
    else {
      const [, , image, label, destination] = match;
      const url = sanitiseUrl(destination);
      if (!url) html += escapeHtml(label);
      else if (image) html += `<img src="${escapeHtml(url)}" alt="${escapeHtml(label)}" loading="lazy" referrerpolicy="no-referrer" />`;
      else html += `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${renderPlainInline(label)}</a>`;
    }
    offset = match.index + match[0].length;
  }
  return html + renderPlainInline(text.slice(offset));
}

export function renderMarkdown(source) {
  const raw = typeof source === "string" ? source : "";
  const normalised = raw.replace(/\r\n?/g, "\n");
  const lines = normalised.split("\n");
  let html = "";
  let currentList = null;

  const closeList = () => {
    if (currentList) {
      html += `</${currentList}>`;
      currentList = null;
    }
  };

  for (const line of lines) {
    const trimmed = line.trim();

    if (!trimmed) {
      closeList();
      continue;
    }

    const headingMatch = line.match(/^(#{1,6})\s+(.*)$/);
    if (headingMatch) {
      closeList();
      const level = headingMatch[1].length;
      const content = headingMatch[2];
      html += `<h${level}>${renderInline(content)}</h${level}>`;
      continue;
    }

    const blockquoteMatch = line.match(/^\s*>\s?(.*)$/);
    if (blockquoteMatch) {
      closeList();
      html += `<blockquote>${renderInline(blockquoteMatch[1])}</blockquote>`;
      continue;
    }

    const unorderedMatch = line.match(/^\s*[-*+]\s+(.*)$/);
    if (unorderedMatch) {
      if (currentList !== "ul") {
        closeList();
        currentList = "ul";
        html += "<ul>";
      }
      html += `<li>${renderInline(unorderedMatch[1])}</li>`;
      continue;
    }

    const orderedMatch = line.match(/^\s*\d+\.\s+(.*)$/);
    if (orderedMatch) {
      if (currentList !== "ol") {
        closeList();
        currentList = "ol";
        html += "<ol>";
      }
      html += `<li>${renderInline(orderedMatch[1])}</li>`;
      continue;
    }

    closeList();
    html += `<p>${renderInline(trimmed)}</p>`;
  }

  closeList();
  return html;
}
