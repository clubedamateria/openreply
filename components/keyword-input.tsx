"use client";

/**
 * Keyword Input
 *
 * Tag-style input for adding/removing keywords.
 */

import { useState, type KeyboardEvent } from "react";
import { X } from "lucide-react";

interface KeywordInputProps {
  keywords: string[];
  onChange: (keywords: string[]) => void;
  max?: number;
}

export default function KeywordInput({ keywords, onChange, max = 10 }: KeywordInputProps) {
  const [input, setInput] = useState("");

  function addKeyword(value: string) {
    const trimmed = value.trim().toUpperCase();
    if (!trimmed) return;
    if (keywords.includes(trimmed)) return;
    if (keywords.length >= max) return;
    onChange([...keywords, trimmed]);
    setInput("");
  }

  function removeKeyword(keyword: string) {
    onChange(keywords.filter((k) => k !== keyword));
  }

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      addKeyword(input);
    }
    if (e.key === "Backspace" && !input && keywords.length > 0) {
      removeKeyword(keywords[keywords.length - 1]);
    }
  }

  return (
    <div className="space-y-2">
      {keywords.length > 0 && (
        <ul className="flex flex-wrap gap-2" aria-label="Palavras-chave adicionadas">
          {keywords.map((keyword) => (
            <li key={keyword} className="badge badge-accent pr-1">
              {keyword}
              <button
                type="button"
                onClick={() => removeKeyword(keyword)}
                aria-label={`Remover ${keyword}`}
                className="inline-flex h-5 w-5 items-center justify-center rounded-full text-accent-hover transition-colors hover:bg-accent hover:text-white"
              >
                <X size={12} strokeWidth={3} aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <input
        type="text"
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Digite a palavra-chave e pressione Enter..."
        aria-label="Nova palavra-chave"
        className="field"
      />
      <p className="helper">
        {keywords.length}/{max} palavras-chave · Pressione Enter ou vírgula para adicionar
      </p>
    </div>
  );
}
