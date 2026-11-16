import { createHighlighter } from "shiki";
import type { ContentBlock, DocArticle, HighlightedCode } from "./content";

const languageAliases = {
  powershell: "powershell", ps1: "powershell", toml: "toml", markdown: "markdown", md: "markdown",
  bash: "bash", curl: "bash", shell: "bash", shellscript: "bash", sh: "bash",
  json: "json", javascript: "javascript", js: "javascript", typescript: "typescript", ts: "typescript",
  python: "python", py: "python", http: "http", text: "text", plaintext: "text", txt: "text",
} as const;

let highlighterPromise: ReturnType<typeof createHighlighter> | undefined;

function getHighlighter() {
  highlighterPromise ??= createHighlighter({ themes: ["dark-plus"], langs: ["bash", "json", "javascript", "typescript", "python", "http", "powershell", "toml", "markdown"] });
  return highlighterPromise;
}

function resolveLanguage(language: string | undefined) {
  const name = language?.toLowerCase().trim();
  if (name && name in languageAliases) return languageAliases[name as keyof typeof languageAliases];
  return "text";
}

export async function highlightCode(code: string, language?: string): Promise<HighlightedCode> {
  const highlighter = await getHighlighter();
  const { tokens } = highlighter.codeToTokens(code.replace(/\n$/, ""), { lang: resolveLanguage(language), theme: "dark-plus" });
  return tokens.map(line => line.map(({ content, color, fontStyle }) => ({ content, color, fontStyle })));
}

export async function highlightArticleCode(article: DocArticle): Promise<DocArticle> {
  return {
    ...article,
    sections: await Promise.all(article.sections.map(async section => ({
      ...section,
      blocks: await Promise.all(section.blocks.map(async (block): Promise<ContentBlock> => {
        if (block.type === "code") return { ...block, highlightedCode: await highlightCode(block.code, block.language) };
        return block;
      })),
    }))),
  };
}
