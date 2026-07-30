import React from "react";
import { Box, Text } from "ink";
import { sanitizeTerminalText } from "./terminal-text.js";

function inline(text: string): React.ReactNode[] {
  const tokens = text.split(/(`[^`\n]+`|\*\*[^*\n]+\*\*|\*[^*\n]+\*|\[[^\]\n]+\]\([^)\n]+\))/g);
  return tokens.flatMap((token, index): React.ReactNode[] => {
    if (!token) return [];
    if (token.startsWith("`") && token.endsWith("`")) {
      return [
        <Text key={index} color="cyan" backgroundColor="#262626">
          {token.slice(1, -1)}
        </Text>,
      ];
    }
    if (token.startsWith("**") && token.endsWith("**")) {
      return [
        <Text key={index} bold>
          {token.slice(2, -2)}
        </Text>,
      ];
    }
    if (token.startsWith("*") && token.endsWith("*")) {
      return [
        <Text key={index} italic>
          {token.slice(1, -1)}
        </Text>,
      ];
    }
    const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token);
    if (link) {
      return [
        <Text key={index} color="blue" underline>
          {link[1]} ({link[2]})
        </Text>,
      ];
    }
    return [<React.Fragment key={index}>{token}</React.Fragment>];
  });
}

/** Small, dependency-free Markdown renderer for terminal conversation output. */
export function MarkdownText({ text }: { text: string }) {
  const safe = sanitizeTerminalText(text);
  const rows: React.ReactNode[] = [];
  let fenced = false;
  let language = "";
  for (const [index, line] of safe.split("\n").entries()) {
    const fence = /^\s*```\s*([^\s`]*)/.exec(line);
    if (fence) {
      fenced = !fenced;
      language = fenced ? (fence[1] ?? "") : "";
      rows.push(
        <Text key={index} dimColor>
          {fenced ? `┌─ ${language || "code"}` : "└─"}
        </Text>,
      );
      continue;
    }
    if (fenced) {
      rows.push(
        <Text key={index} color="cyan" backgroundColor="#171717">
          │ {line || " "}
        </Text>,
      );
      continue;
    }
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) {
      rows.push(
        <Text key={index} bold {...(heading[1]!.length <= 2 ? { color: "cyan" as const } : {})}>
          {inline(heading[2]!)}
        </Text>,
      );
      continue;
    }
    const quote = /^>\s?(.*)$/.exec(line);
    if (quote) {
      rows.push(
        <Text key={index} dimColor italic>
          │ {inline(quote[1]!)}
        </Text>,
      );
      continue;
    }
    const bullet = /^(\s*)([-*+] |\d+\. )(.*)$/.exec(line);
    if (bullet) {
      rows.push(
        <Text key={index}>
          {bullet[1]}
          <Text color="cyan">{bullet[2]}</Text>
          {inline(bullet[3]!)}
        </Text>,
      );
      continue;
    }
    rows.push(<Text key={index}>{inline(line)}</Text>);
  }
  return <Box flexDirection="column">{rows}</Box>;
}
