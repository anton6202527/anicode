import React, { useEffect, useMemo, useState } from "react";
import { t } from "@anicode/core";
import type { ModelRow } from "../../../shared/api.js";

interface Props {
  rows: readonly ModelRow[];
  currentSpec: string | null;
  onPick: (spec: string) => void;
  onClose: () => void;
}

export function ModelPicker({ rows, currentSpec, onPick, onClose }: Props) {
  const [query, setQuery] = useState("");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const sorted = useMemo(
    () =>
      [...rows]
        .map((row, i) => ({
          row,
          i,
          score: (row.ready !== false ? 2 : 0) + (row.recommended ? 1 : 0),
        }))
        .sort((a, b) => b.score - a.score || a.i - b.i)
        .map((x) => x.row),
    [rows],
  );

  const q = query.trim().toLowerCase();
  const filtered = q
    ? sorted.filter(
        (r) => r.spec.toLowerCase().includes(q) || (r.label ?? "").toLowerCase().includes(q),
      )
    : sorted;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal picker" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>{t("Select model", "选择模型")}</h2>
          <button className="modal-close" onClick={onClose}>
            ✕
          </button>
        </div>
        <input
          className="picker-search"
          autoFocus
          placeholder={t("Search model / provider…", "搜索模型 / provider…")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="picker-list">
          {filtered.map((r) => {
            const tags = [
              r.free ? t("Free", "免费") : "",
              r.openWeight ? t("Open-weight", "开源") : "",
              r.local ? t("Local", "本地") : "",
              r.recommended ? t("Recommended", "推荐") : "",
            ].filter(Boolean);
            return (
              <button
                key={r.spec}
                className={`picker-row ${r.spec === currentSpec ? "current" : ""}`}
                onClick={() => onPick(r.spec)}
              >
                <span className={`ready ${r.ready === false ? "no" : r.ready ? "yes" : "unknown"}`}>
                  {r.ready === false ? "✖" : r.ready ? "✔" : "·"}
                </span>
                <span className="picker-label">{r.label ?? r.model}</span>
                {r.source === "user" ? (
                  <span className="picker-source">{t("Custom", "自定义")}</span>
                ) : null}
                {tags.map((tag) => (
                  <span key={tag} className="tag">
                    {tag}
                  </span>
                ))}
                <span className="picker-spec">{r.spec}</span>
                <span className="picker-hint">{r.readyHint}</span>
              </button>
            );
          })}
          {filtered.length === 0 ? (
            <div className="picker-empty">{t("No matching models", "无匹配模型")}</div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
