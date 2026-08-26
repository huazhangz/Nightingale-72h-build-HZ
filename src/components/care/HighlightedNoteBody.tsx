"use client";

import type { ReactNode } from "react";
import { riskTone } from "../../lib/care-note/risk-tone";
import { useI18n } from "../../lib/i18n/I18nContext";

export type HighlightSpan = {
  id: string;
  startOffset: number;
  endOffset: number;
  label: string | null;
  source?: string;
  createdByRole?: string;
};

function clip(start: number, end: number, length: number): [number, number] | null {
  const from = Math.max(0, Math.min(start, length));
  const to = Math.max(0, Math.min(end, length));
  if (to <= from) {
    return null;
  }
  return [from, to];
}

export function HighlightedNoteBody({
  entryId,
  text,
  highlights,
  focusStart,
  focusEnd,
}: {
  entryId: string;
  text: string;
  highlights: HighlightSpan[];
  focusStart?: number;
  focusEnd?: number;
}): ReactNode {
  const { t } = useI18n();
  const length = text.length;
  const ranges = highlights
    .map((highlight) => {
      const clipped = clip(highlight.startOffset, highlight.endOffset, length);
      if (!clipped) {
        return null;
      }
      return {
        id: highlight.id,
        start: clipped[0],
        end: clipped[1],
        tone: riskTone(highlight.label),
        source: highlight.source ?? "MODEL",
        createdByRole: highlight.createdByRole,
      };
    })
    .filter((range): range is NonNullable<typeof range> => range !== null)
    .sort((left, right) => left.start - right.start || right.end - left.end);

  const focus =
    focusStart !== undefined && focusEnd !== undefined ? clip(focusStart, focusEnd, length) : null;

  if (ranges.length === 0 && !focus) {
    return text;
  }

  const points = new Set<number>([0, length]);
  for (const range of ranges) {
    points.add(range.start);
    points.add(range.end);
  }
  if (focus) {
    points.add(focus[0]);
    points.add(focus[1]);
  }
  const cuts = [...points].sort((left, right) => left - right);
  const parts: ReactNode[] = [];
  const rank = { critical: 5, action: 4, medium: 3, insight: 2, low: 1 };

  for (let index = 0; index < cuts.length - 1; index += 1) {
    const start = cuts[index]!;
    const end = cuts[index + 1]!;
    const slice = text.slice(start, end);
    if (!slice) {
      continue;
    }
    const covering = ranges.filter((range) => range.start <= start && range.end >= end);
    const focused = Boolean(focus && focus[0] <= start && focus[1] >= end);
    if (covering.length === 0 && !focused) {
      parts.push(<span key={`${entryId}-plain-${start}`}>{slice}</span>);
      continue;
    }
    const primary = covering.sort((left, right) => {
      if ((left.source === "HUMAN") !== (right.source === "HUMAN")) {
        return left.source === "HUMAN" ? -1 : 1;
      }
      return rank[right.tone] - rank[left.tone];
    })[0];
    const tone = primary?.tone ?? "medium";
    const origin =
      primary?.source === "HUMAN"
        ? primary.createdByRole === "STAFF"
          ? "staff"
          : "clinician"
        : "model";
    const markId = primary && start === primary.start ? `hl-${entryId}-${primary.start}-${primary.end}` : undefined;
    const tooltip =
      origin === "model" ? t("highlight.tooltipModel") : t("highlight.tooltipManual");
    parts.push(
      <mark
        key={`${entryId}-mark-${start}`}
        id={markId}
        title={tooltip}
        data-testid={focused ? "provenance-mark" : undefined}
        className={`inline-risk inline-risk-${tone} inline-origin-${origin}${focused ? " provenance-mark" : ""}`}
      >
        {slice}
      </mark>,
    );
  }

  return <>{parts}</>;
}
