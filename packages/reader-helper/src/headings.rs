// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Zotero Fast Reader contributors

//! A table of contents for PDFs that have no outline, found the way Zotero's own reader finds one: headings
//! are lines set in a different font or size than the body text, and the same style repeats through the
//! document. Pure (works on `RawLine`s), so it is unit-tested without a PDF.

use crate::engine::OutlineItem;
use std::collections::HashMap;

/// One line of text with the style of its first character.
#[derive(Debug, Clone)]
pub struct RawLine {
    pub page: u32,
    pub text: String,
    pub font: String,
    pub size: f32,
    /// top of the line, page space (y down)
    pub y: f32,
    pub x0: f32,
    pub x1: f32,
    /// every character of the line is in `font`
    pub uniform: bool,
}

const MAX_DEPTH: usize = 3;

/// A font's name without the `ABCDEF+` subset prefix, which differs per page for the same typeface.
pub fn family_name(name: &str) -> String {
    match name.split_once('+') {
        Some((prefix, rest)) if prefix.len() == 6 && prefix.chars().all(|c| c.is_ascii_uppercase()) => rest.to_string(),
        _ => name.to_string(),
    }
}

/// `3` -> 0, `3.2` -> 1, `3.2.1` -> 2: how deep a numbered heading sits; None if it isn't numbered.
fn number_depth(t: &str) -> Option<usize> {
    let first = t.split_whitespace().next()?;
    let first = first.trim_end_matches('.');
    let parts: Vec<&str> = first.split('.').collect();
    (!parts.is_empty() && parts.len() <= 4 && parts.iter().all(|p| !p.is_empty() && p.len() <= 2 && p.chars().all(|c| c.is_ascii_digit()))).then(|| parts.len() - 1)
}

fn looks_like_caption_item(t: &str) -> bool {
    let l = t.to_lowercase();
    ["fig. ", "fig ", "figure ", "table ", "box ", "scheme "].iter().any(|p| l.starts_with(p))
}

#[derive(Debug, Clone)]
struct Heading {
    page: u32,
    y: f32,
    x0: f32,
    text: String,
    key: (String, i32), // font, size*10
    size: f32,
}

pub fn extract_outline(lines: &[RawLine]) -> Vec<OutlineItem> {
    if lines.len() < 20 {
        return Vec::new();
    }
    // the body font: most characters
    let mut chars: HashMap<&str, usize> = HashMap::new();
    for l in lines {
        *chars.entry(l.font.as_str()).or_default() += l.text.chars().count();
    }
    let Some((body_font, _)) = chars.iter().max_by_key(|(f, n)| (**n, std::cmp::Reverse(**f))) else {
        return Vec::new();
    };
    let body_font = body_font.to_string();
    let mut sizes: HashMap<i32, usize> = HashMap::new();
    for l in lines.iter().filter(|l| l.font == body_font) {
        *sizes.entry((l.size * 10.0).round() as i32).or_default() += l.text.chars().count();
    }
    let body_size = sizes.iter().max_by_key(|(s, n)| (**n, **s)).map(|(s, _)| *s as f32 / 10.0).unwrap_or(10.0);

    // candidate lines, merging a heading that wraps onto the next line
    let mut found: Vec<Heading> = Vec::new();
    let mut prev: Option<(usize, f32)> = None; // (index in `found`, y of its last line)
    for l in lines {
        let text = l.text.trim();
        let n = text.chars().count();
        let styled = l.font != body_font || l.size > body_size + 0.9;
        let ok = l.uniform && styled && n >= 2 && n <= 100 && !text.ends_with('.') && l.size >= body_size - 0.6;
        if !ok {
            prev = None;
            continue;
        }
        let key = (l.font.clone(), (l.size * 10.0).round() as i32);
        if let Some((i, y)) = prev {
            let h = &mut found[i];
            if h.page == l.page && h.key == key && l.y > y && l.y - y < l.size * 1.7 {
                h.text.push(' ');
                h.text.push_str(text);
                prev = Some((i, l.y));
                continue;
            }
        }
        // one word of a justified line the extractor split apart, not a heading
        let single = !text.contains(char::is_whitespace);
        let known = ["references", "bibliography", "abstract", "introduction", "conclusion", "conclusions", "methods", "discussion", "results"].contains(&text.to_lowercase().as_str());
        if single && !known {
            let lowercase = text.chars().find(|c| c.is_alphabetic()).is_some_and(|c| c.is_lowercase());
            let has_neighbour = lines.iter().any(|o| {
                o.page == l.page && !std::ptr::eq(o, l) && (o.y - l.y).abs() < 1.5 && ((o.x0 >= l.x1 - 1.0 && o.x0 <= l.x1 + 25.0) || (o.x1 <= l.x0 + 1.0 && o.x1 >= l.x0 - 25.0))
            });
            if lowercase || has_neighbour {
                prev = None;
                continue;
            }
        }
        found.push(Heading { page: l.page, y: l.y, x0: l.x0, text: text.to_string(), key, size: l.size });
        prev = Some((found.len() - 1, l.y));
    }

    // group by style; drop running headers (the same text on several pages)
    let mut by_text: HashMap<&str, std::collections::HashSet<u32>> = HashMap::new();
    for h in &found {
        by_text.entry(h.text.as_str()).or_default().insert(h.page);
    }
    let page_count = lines.iter().map(|l| l.page).max().unwrap_or(0) + 1;
    let mut groups: HashMap<(String, i32), Vec<Heading>> = HashMap::new();
    for h in &found {
        if by_text[h.text.as_str()].len() > 2 {
            continue;
        }
        groups.entry(h.key.clone()).or_default().push(h.clone());
    }
    let looks_like_caption = |t: &str| {
        let l = t.to_lowercase();
        ["fig", "table", "scheme", "box ", "plate"].iter().any(|p| l.starts_with(p))
    };
    let mut groups: Vec<Vec<Heading>> = groups
        .into_values()
        .filter(|g| {
            let pages: std::collections::HashSet<u32> = g.iter().map(|h| h.page).collect();
            let avg_len = g.iter().map(|h| h.text.chars().count()).sum::<usize>() as f32 / g.len() as f32;
            let captions = g.iter().filter(|h| looks_like_caption(&h.text)).count();
            let lower = g.iter().filter(|h| h.text.chars().find(|c| c.is_alphabetic()).is_some_and(|c| c.is_lowercase())).count();
            g.len() >= 3
                && g.len() <= 12 * (page_count as usize).max(1)
                && pages.len() >= 2
                && avg_len < 70.0
                && captions * 2 < g.len()
                && lower * 3 < g.len()
        })
        .collect();
    // biggest type first; a bigger size is a higher level
    groups.sort_by(|a, b| b[0].size.partial_cmp(&a[0].size).unwrap().then(a[0].key.cmp(&b[0].key)));
    groups.truncate(MAX_DEPTH);
    if groups.is_empty() {
        return Vec::new();
    }
    let numbered = |t: &str| number_depth(t).is_some();
    let backmatter = |t: &str| {
        let l = t.to_lowercase();
        ["references", "bibliography", "acknowledg", "conflicts of interest", "author contributions", "data availability", "appendix", "supplementary", "funding", "abstract", "introduction", "conclusion"].iter().any(|p| l.starts_with(p))
    };
    let mut all: Vec<(usize, Heading)> = Vec::new();
    for (rank, g) in groups.into_iter().enumerate() {
        let mostly_numbered = g.iter().filter(|h| numbered(&h.text)).count() * 10 >= g.len() * 6;
        for h in g {
            if looks_like_caption_item(&h.text) {
                continue;
            }
            if mostly_numbered && !numbered(&h.text) && !backmatter(&h.text) {
                continue; // e.g. a name set in the same bold as the section numbers
            }
            let depth = number_depth(&h.text).unwrap_or(rank).min(MAX_DEPTH - 1);
            all.push((depth, h));
        }
    }
    // reading order: page, then left column before right (a heading starting in the right half), then top to bottom
    let mut width = HashMap::new();
    for l in lines {
        let w: &mut f32 = width.entry(l.page).or_insert(0.0);
        *w = w.max(l.x1);
    }
    let column = |h: &Heading| u8::from(h.x0 > width.get(&h.page).copied().unwrap_or(0.0) * 0.5);
    all.sort_by(|a, b| a.1.page.cmp(&b.1.page).then(column(&a.1).cmp(&column(&b.1))).then(a.1.y.partial_cmp(&b.1.y).unwrap()));
    // nothing after the reference list is a heading
    if let Some(i) = all.iter().position(|(_, h)| {
        let t = h.text.to_lowercase();
        t == "references" || t == "bibliography"
    }) {
        all.truncate(i + 1);
    }

    // nest: a heading goes under the nearest earlier, shallower one
    let mut roots: Vec<OutlineItem> = Vec::new();
    let mut path: Vec<usize> = Vec::new(); // child index at each open level
    let mut open_depths: Vec<usize> = Vec::new();
    for (depth, h) in all {
        while open_depths.last().is_some_and(|d| *d >= depth) {
            open_depths.pop();
            path.pop();
        }
        let item = OutlineItem { title: h.text, page: Some(h.page), uri: None, children: Vec::new() };
        let list = {
            let mut cur = &mut roots;
            for &i in &path {
                cur = &mut cur[i].children;
            }
            cur
        };
        list.push(item);
        path.push(list.len() - 1);
        open_depths.push(depth);
    }
    roots
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(page: u32, y: f32, text: &str, font: &str, size: f32) -> RawLine {
        RawLine { page, text: text.into(), font: font.into(), size, y, x0: 50.0, x1: 200.0, uniform: true }
    }

    fn doc() -> Vec<RawLine> {
        let mut v = Vec::new();
        for p in 0..6u32 {
            v.push(line(p, 20.0, "Running Title", "Sans", 8.0)); // running header on every page
            if p % 2 == 0 {
                v.push(line(p, 60.0, &format!("{} Section {}", p / 2 + 1, p / 2 + 1), "Serif-Bold", 14.0));
            }
            if p > 0 {
                v.push(line(p, 200.0, &format!("{}.1 Sub {p}", p / 2 + 1), "Serif-Bold", 10.0));
            }
            for k in 0..8 {
                v.push(line(p, 240.0 + k as f32 * 12.0, "Body text of the paper goes here and goes on for a while.", "Serif", 9.0));
            }
        }
        v
    }

    #[test]
    fn finds_nested_headings_by_font_and_size() {
        let o = extract_outline(&doc());
        assert_eq!(o.iter().map(|i| i.title.as_str()).collect::<Vec<_>>(), vec!["1 Section 1", "2 Section 2", "3 Section 3"]);
        assert!(o[0].children.iter().any(|c| c.title.starts_with("1.1 Sub")));
        assert!(!o.iter().any(|i| i.title == "Running Title"), "a header repeated on every page is not a heading");
    }

    #[test]
    fn a_document_without_repeating_styles_has_no_outline() {
        let mut v = doc();
        v.retain(|l| l.font == "Serif");
        assert!(extract_outline(&v).is_empty());
    }

    #[test]
    fn subset_prefixes_are_dropped() {
        assert_eq!(family_name("GAIKDE+AdvTTaa6301a5.B"), "AdvTTaa6301a5.B");
        assert_eq!(family_name("Times-Bold"), "Times-Bold");
    }

    #[test]
    fn wrapped_headings_are_joined() {
        let mut v = doc();
        let at = v.iter().position(|l| l.text == "1 Section 1").unwrap() + 1;
        v.insert(at, line(0, 76.0, "continued", "Serif-Bold", 14.0));
        let o = extract_outline(&v);
        assert_eq!(o[0].title, "1 Section 1 continued");
    }
}
