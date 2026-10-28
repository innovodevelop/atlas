/**
 * Sections in a Writing document (`Atlas School Tools Beta.dc.html`,
 * "Skrivning") — pure and tested here (betaSchoolSections.test.ts).
 *
 * A document stays one plain string, so nothing about how it is stored or
 * copied changes. Headings split it into sections: a line that starts with
 * one to three "#" and a space is a heading, and everything up to the next
 * heading is its section. The editor draws each section as its own field
 * under its heading, and every edit goes back into the one string by offset,
 * so typing "# " on a new line starts a new section and removing a heading
 * merges its section into the one above.
 *
 * Margin notes are anchored to a section by its heading text, which survives
 * the student adding or moving other sections; a heading that is renamed
 * leaves its notes unanchored rather than pinned to the wrong place.
 */

import type { MarginNote } from './betaSchool';

export interface Section {
  index: number;
  /** null for the text before the first heading (or the whole document when it has none). */
  heading: string | null;
  level: number;
  /** The heading line, [headStart, headEnd); both equal textStart for the untitled first section. */
  headStart: number;
  headEnd: number;
  /** The section's text, [textStart, textEnd), without the line break before the next heading. */
  textStart: number;
  textEnd: number;
  text: string;
}

const HEADING = /^(#{1,3})[ \t]+(.*)$/;

export function parseSections(body: string): Section[] {
  const heads: { start: number; end: number; level: number; text: string }[] = [];
  let pos = 0;
  for (const line of body.split('\n')) {
    const m = HEADING.exec(line);
    if (m) heads.push({ start: pos, end: pos + line.length, level: m[1].length, text: m[2].trim() });
    pos += line.length + 1;
  }
  const out: Section[] = [];
  // The text before the first heading is a section of its own when there is any,
  // and the whole document is one untitled section when there are no headings.
  const firstHead = heads.length ? heads[0].start : body.length;
  if (!heads.length || firstHead > 0) {
    const textEnd = heads.length ? Math.max(0, firstHead - 1) : body.length;
    out.push({ index: 0, heading: null, level: 0, headStart: 0, headEnd: 0, textStart: 0, textEnd, text: body.slice(0, textEnd) });
  }
  heads.forEach((h, i) => {
    const textStart = Math.min(body.length, h.end + 1);
    const next = heads[i + 1];
    const textEnd = next ? Math.max(textStart, next.start - 1) : body.length;
    out.push({ index: out.length, heading: h.text, level: h.level, headStart: h.start, headEnd: h.end, textStart, textEnd, text: body.slice(textStart, textEnd) });
  });
  return out;
}

/**
 * The body with one section's text replaced. An empty section has no line of
 * its own yet: text written into one between two headings gets a line break
 * after it, and text under a final heading with no line break gets one
 * before it, so the next heading stays a heading.
 */
export function replaceSectionText(body: string, s: Section, text: string): string {
  if (s.heading !== null && s.textStart === s.headEnd) return text ? `${body}\n${text}` : body;
  // Empty, and the next heading's line starts right here (not after a blank line).
  const nextHeadAt = s.textEnd === s.textStart && s.textStart < body.length && body[s.textStart] !== '\n';
  if (nextHeadAt) return text ? body.slice(0, s.textStart) + text + '\n' + body.slice(s.textStart) : body;
  return body.slice(0, s.textStart) + text + body.slice(s.textEnd);
}

/** The body with a section's heading renamed; a line break in the new name is not allowed to split it. */
export function renameHeading(body: string, s: Section, heading: string): string {
  if (s.heading === null) return body;
  const line = `${'#'.repeat(s.level || 1)} ${heading.replace(/[\r\n]+/g, ' ')}`;
  return body.slice(0, s.headStart) + line + body.slice(s.headEnd);
}

/** The body without a section's heading line: its text joins the section above. */
export function removeHeading(body: string, s: Section): string {
  if (s.heading === null) return body;
  const after = s.headEnd < body.length ? s.headEnd + 1 : s.headEnd;
  const before = s.headStart > 0 && after === s.headEnd ? s.headStart - 1 : s.headStart;
  return body.slice(0, before) + body.slice(after);
}

/** The body with a new, empty section at the end. */
export function appendSection(body: string, heading = ''): string {
  const sep = body === '' ? '' : body.endsWith('\n') ? '' : '\n';
  return `${body}${sep}# ${heading}`;
}

/** Which section a global offset falls in: in a heading line, or in a section's text. */
export function sectionAt(sections: readonly Section[], offset: number): { section: Section; inHeading: boolean } | null {
  for (let i = sections.length - 1; i >= 0; i--) {
    const s = sections[i];
    if (s.heading !== null && offset >= s.headStart && offset <= s.headEnd) return { section: s, inHeading: true };
    if (offset >= s.textStart && offset <= s.textEnd) return { section: s, inHeading: false };
  }
  return null;
}

const norm = (h: string) => h.trim().toLowerCase();

/** The section a note belongs to, or null when its heading is gone. */
export function noteSection(note: Pick<MarginNote, 'anchor'>, sections: readonly Section[]): Section | null {
  if (note.anchor === null) return null;
  if (note.anchor === '') return sections.find((s) => s.heading === null) ?? null;
  return sections.find((s) => s.heading !== null && norm(s.heading) === norm(note.anchor ?? '')) ?? null;
}

export interface PlacedNote { note: MarginNote; n: number; section: Section | null }

/**
 * Notes numbered in reading order: by the section they are anchored to, then
 * as Atlas wrote them, with unanchored notes last. The numbers are what the
 * margin and the section labels show.
 */
export function placeNotes(notes: readonly MarginNote[], sections: readonly Section[]): PlacedNote[] {
  return notes
    .map((note, i) => ({ note, i, section: noteSection(note, sections) }))
    .sort((a, b) => (a.section?.index ?? Infinity) - (b.section?.index ?? Infinity) || a.i - b.i)
    .map((x, k) => ({ note: x.note, n: k + 1, section: x.section }));
}

/** The document as Atlas reads it for margin notes: each section numbered under its heading. */
export function sectionsForPrompt(sections: readonly Section[]): string {
  return sections
    .map((s, i) => `[${i + 1}] ${s.heading === null ? '(before the first heading)' : s.heading || '(untitled section)'}\n${s.text.trim() || '(empty)'}`)
    .join('\n\n');
}
