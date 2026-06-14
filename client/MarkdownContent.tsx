import React from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import CodeHighlighter from "@ant-design/x/es/code-highlighter";
import type { Components } from "react-markdown";

const components: Components = {
  code({ className, children, ...props }) {
    const codeText = String(children).replace(/\n$/, "");
    const match = /language-(\w+)/.exec(className ?? "");
    const lang = match?.[1];

    // Multi-line code → code block → use CodeHighlighter
    if (lang || codeText.includes("\n")) {
      return (
        <CodeHighlighter lang={lang} prismLightMode>
          {codeText}
        </CodeHighlighter>
      );
    }

    // Single-line → inline code
    return (
      <code className={className} {...props}>
        {children}
      </code>
    );
  },
  // CodeHighlighter already provides its own wrapper, strip outer <pre>
  pre({ children }) {
    return <>{children}</>;
  }
};

function MarkdownContent({ content }: { content: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={components}
    >
      {content}
    </ReactMarkdown>
  );
}

export default MarkdownContent;
