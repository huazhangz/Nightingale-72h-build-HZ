"use client";

import type { FormEvent } from "react";

export function selectionOffsets(root: HTMLElement): { start: number; end: number; text: string } | null {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
    return null;
  }
  const range = selection.getRangeAt(0);
  if (!root.contains(range.commonAncestorContainer)) {
    return null;
  }
  const prefix = document.createRange();
  prefix.selectNodeContents(root);
  prefix.setEnd(range.startContainer, range.startOffset);
  const start = prefix.toString().length;
  const end = start + range.toString().length;
  const text = range.toString().trim();
  if (!text || end - start < 2) {
    return null;
  }
  return { start, end, text };
}

export function HighlightComposer({
  entryId,
  label,
  saving,
  onLabelChange,
  onSave,
  onCancel,
  labelCaption,
  saveCaption,
  cancelCaption,
}: {
  entryId: string;
  label: string;
  saving: boolean;
  onLabelChange: (label: string) => void;
  onSave: () => void;
  onCancel: () => void;
  labelCaption: string;
  saveCaption: string;
  cancelCaption: string;
}) {
  return (
    <form
      className="highlight-draft"
      onSubmit={(event: FormEvent) => {
        event.preventDefault();
        onSave();
      }}
    >
      <label htmlFor={`hl-label-${entryId}`}>{labelCaption}</label>
      <select
        id={`hl-label-${entryId}`}
        value={label}
        onChange={(event) => onLabelChange(event.target.value)}
      >
        <option value="PATIENT_INSIGHT">PATIENT_INSIGHT</option>
        <option value="UNRESOLVED_ACTION">UNRESOLVED_ACTION</option>
        <option value="CRITICAL">CRITICAL</option>
        <option value="MEDIUM">MEDIUM</option>
        <option value="LOW">LOW</option>
      </select>
      <button type="submit" className="btn" disabled={saving}>
        {saveCaption}
      </button>
      <button type="button" className="btn secondary" onClick={onCancel}>
        {cancelCaption}
      </button>
    </form>
  );
}
