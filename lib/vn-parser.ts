import type { VnFrame, VnOptions, VnParsedResponse } from "./vn-types";

export const VN_PARSER_VERSION = 1;

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function escapeXmlText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeXmlAttribute(value: string): string {
  return escapeXmlText(value)
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Parse AI output in `<scene>` XML format into VnFrames.
 */
export function parseVnResponse(rawText: string): VnParsedResponse {
  // Strip <think>/<thinking> blocks (model reasoning leakage)
  const trimmed = rawText.trim().replace(/<(?:think|thinking)>[\s\S]*?<\/(?:think|thinking)>/gi, "").trim();

  // Extract <content>...</content> or use full text
  const contentMatch = trimmed.match(/<content>([\s\S]*?)<\/content>/i);
  const body = contentMatch ? contentMatch[1].trim() : trimmed;


  // Parse all <scene> tags
  const sceneRegex = /<scene(?:\s+([^>]*))?>([\s\S]*?)<\/scene>/gi;
  const frames: VnFrame[] = [];
  let lastBg: string | undefined;
  let lastSprite: string | undefined;
  let match: RegExpExecArray | null;

  while ((match = sceneRegex.exec(body)) !== null) {
    const attrs = match[1] || "";
    const content = decodeXmlEntities(match[2].trim());

    // Parse bg and sprite attributes
    const bgMatch = attrs.match(/bg\s*=\s*"([^"]*)"/i);
    const spriteMatch = attrs.match(/sprite\s*=\s*"([^"]*)"/i);

    if (bgMatch) lastBg = decodeXmlEntities(bgMatch[1]);
    if (spriteMatch) lastSprite = decodeXmlEntities(spriteMatch[1]);

    if (!content) {
      // Empty scene with bg/sprite change = scene transition frame
      if (bgMatch || spriteMatch) {
        frames.push({ bg: lastBg, sprite: lastSprite, text: "" });
      }
      continue;
    }

    // Parse lines: "角色名|\"台词\"" = dialogue, other = narration
    const lines = content.split("\n").map((l) => l.trim()).filter(Boolean);
    for (const line of lines) {
      const dialogueMatch = line.match(/^(.+?)\|["\u201c\u300c](.+)["\u201d\u300d]$/);
      if (dialogueMatch) {
        frames.push({
          bg: lastBg,
          sprite: lastSprite,
          speaker: dialogueMatch[1].trim(),
          text: dialogueMatch[2].trim(),
        });
      } else {
        // Narration
        frames.push({
          bg: lastBg,
          sprite: lastSprite,
          text: line,
        });
      }
    }
  }

  // If no scenes found, parse lines individually (fallback)
  if (frames.length === 0 && body) {
    const lines = body.split("\n").map((l) => l.trim()).filter(Boolean);
    for (const line of lines) {
      const dialogueMatch = line.match(/^(.+?)\|["\u201c\u300c](.+)["\u201d\u300d]$/);
      if (dialogueMatch) {
        frames.push({ speaker: dialogueMatch[1].trim(), text: decodeXmlEntities(dialogueMatch[2].trim()) });
      } else {
        frames.push({ text: decodeXmlEntities(line) });
      }
    }
  }

  // Parse <options>
  let options: VnOptions | null = null;
  const optionsMatch = body.match(/<options>([\s\S]*?)<\/options>/i);
  if (optionsMatch) {
    const optContent = optionsMatch[1].trim();
    // Split by | and clean quotes
    const choices = optContent
      .split("|")
      .map((c) => decodeXmlEntities(c.trim().replace(/^"|"$/g, "")))
      .filter(Boolean);
    if (choices.length > 0) {
      options = { choices };
    }
  }

  return { frames, options, rawText: trimmed };
}

/**
 * Package user input into the same XML format as AI output.
 */
export function packageUserInput(
  input: string,
  type: "dialogue" | "narration" | "scene_switch" | "choice",
  meta?: { speaker?: string; bg?: string }
): string {
  const speaker = meta?.speaker || "我";

  switch (type) {
    case "dialogue":
      return `<content><scene>${escapeXmlText(speaker)}|"${escapeXmlText(input)}"</scene></content>`;
    case "narration":
      return `<content><scene>${escapeXmlText(input)}</scene></content>`;
    case "scene_switch":
      return `<content><scene bg="${escapeXmlAttribute(meta?.bg || input)}"></scene></content>`;
    case "choice":
      return `<content><scene>${escapeXmlText(speaker)}|"${escapeXmlText(input)}"</scene></content>`;
    default:
      return `<content><scene>${escapeXmlText(speaker)}|"${escapeXmlText(input)}"</scene></content>`;
  }
}

/**
 * Package multiple user actions into a single message.
 */
export function packageMultiActions(
  actions: { type: "dialogue" | "narration" | "scene_switch"; text: string }[],
  speaker?: string
): string {
  const s = speaker || "我";
  const scenes = actions.map((a) => {
    switch (a.type) {
      case "dialogue": return `<scene>${escapeXmlText(s)}|"${escapeXmlText(a.text)}"</scene>`;
      case "narration": return `<scene>${escapeXmlText(a.text)}</scene>`;
      case "scene_switch": return `<scene bg="${escapeXmlAttribute(a.text)}"></scene>`;
    }
  });
  return `<content>\n${scenes.join("\n")}\n</content>`;
}
