import { jsonrepair } from "jsonrepair";

export type JsonRepairOptions = {
  textFieldKeys: string[];
};

export type JsonRepairParseResult = {
  parsed: unknown | null;
  sanitizedCandidate: string;
  parseMode: "raw" | "sanitized" | "failed";
  parseError?: string;
};

export function stripJsonWrapperNoise(text: string): string {
  let source = text.trim();
  source = source.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  source = source.replace(/<thinking>[\s\S]*?<\/thinking>/gi, "").trim();
  source = source.replace(/<reasoning>[\s\S]*?<\/reasoning>/gi, "").trim();
  source = source.replace(/```(?:json)?\s*([\s\S]*?)```/i, "$1").trim();
  return source;
}

export function extractJSONObjectCandidate(text: string): string {
  const source = stripJsonWrapperNoise(text);
  const firstBrace = source.indexOf("{");
  const lastBrace = source.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return source.slice(firstBrace, lastBrace + 1);
  }
  return source;
}

export function normalizeJsonTypography(text: string): string {
  return text
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/，/g, ",")
    .replace(/：/g, ":");
}

export function sanitizeGenericJsonCandidate(text: string, options: JsonRepairOptions): string {
  void options;
  const normalized = normalizeJsonTypography(stripJsonWrapperNoise(text));
  const candidate = extractJSONObjectCandidate(normalized);

  try {
    return jsonrepair(candidate);
  } catch {
    return candidate;
  }
}

export function parseJsonWithRepair(
  text: string,
  options: JsonRepairOptions & { sanitizeCandidate?: (text: string) => string },
): JsonRepairParseResult {
  const rawParsed = extractJSONFromText(text);
  const sanitizedCandidate = extractJSONObjectCandidate(
    options.sanitizeCandidate
      ? options.sanitizeCandidate(text)
      : sanitizeGenericJsonCandidate(text, { textFieldKeys: options.textFieldKeys }),
  );

  if (rawParsed) {
    return {
      parsed: rawParsed,
      sanitizedCandidate,
      parseMode: "raw",
    };
  }

  const sanitizedParsed = extractJSONFromText(sanitizedCandidate);
  if (sanitizedParsed) {
    return {
      parsed: sanitizedParsed,
      sanitizedCandidate,
      parseMode: "sanitized",
    };
  }

  let parseError = "";
  try {
    JSON.parse(sanitizedCandidate);
  } catch (error) {
    parseError = error instanceof Error ? error.message : String(error);
  }

  return {
    parsed: null,
    sanitizedCandidate,
    parseMode: "failed",
    parseError: parseError || undefined,
  };
}

function extractJSONFromText(text: string): unknown | null {
  let source = text.trim();

  try {
    return JSON.parse(source);
  } catch {
    // fall through
  }

  const firstBrace = source.indexOf("{");
  const lastBrace = source.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    source = source.slice(firstBrace, lastBrace + 1);
    try {
      return JSON.parse(source);
    } catch {
      // fall through
    }

    try {
      return JSON.parse(jsonrepair(source));
    } catch {
      // fall through
    }
  }

  return null;
}
