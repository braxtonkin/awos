import type { Measured } from './gates.ts';

type Rect = { readonly left: number; readonly top: number; readonly right: number; readonly bottom: number; readonly width: number; readonly height: number };

type Style = {
  getPropertyValue(name: string): string;
  readonly backgroundColor: string;
  readonly color: string;
  readonly fontSize: string;
  readonly fontWeight: string;
  readonly opacity: string;
  readonly position: string;
  readonly overflowX: string;
  readonly overflowY: string;
  readonly visibility: string;
  readonly display: string;
  readonly flexWrap: string;
  readonly flexDirection: string;
  readonly rowGap: string;
  readonly columnGap: string;
};

type Element = {
  readonly tagName: string;
  readonly parentElement: Element | null;
  readonly textContent: string | null;
  readonly innerText?: string;
  readonly style: Style;
  readonly type?: string;
  readonly value?: string;
  readonly placeholder?: string;
  readonly selectedOptions?: ArrayLike<Element>;
  getBoundingClientRect(): Rect;
  closest(selector: string): Element | null;
  matches(selector: string): boolean;
  querySelector(selector: string): Element | null;
  querySelectorAll(selector: string): Iterable<Element>;
  getAttribute(name: string): string | null;
  contains(other: Element): boolean;
};

type Text = { readonly nodeValue: string | null; readonly parentElement: Element | null };

type Rule = { readonly cssRules?: Iterable<Rule>; readonly style?: Style; readonly selectorText?: string };

type Page = {
  readonly document: {
    readonly body: Element;
    readonly documentElement: Element & { readonly scrollHeight: number };
    readonly fonts: { readonly ready: Promise<unknown> };
    readonly styleSheets: Iterable<{ readonly cssRules: Iterable<Rule> }>;
    querySelectorAll(selector: string): Iterable<Element>;
    createTreeWalker(root: Element, show: number): { nextNode(): Text | null };
    createRange(): { selectNodeContents(node: Text): void; getClientRects(): Iterable<Rect> };
  };
  readonly innerWidth: number;
  readonly innerHeight: number;
  readonly scrollY: number;
  getComputedStyle(element: Element, pseudo?: string): Style;
};

export type MeasureConfig = {
  readonly fold: number;
  readonly greyChroma: number;
  readonly greenHue: readonly [number, number];
  readonly labelGap: number;
  readonly minRegion: number;
  readonly spacingScale: readonly number[];
  readonly typeScale: readonly number[];
  readonly maxButtonWords: number;
  readonly internalTerms: readonly string[];
  readonly properNouns: readonly string[];
  readonly contrast: { readonly body: number; readonly large: number; readonly icon: number };
};

export async function measure(window: Page, cfg: MeasureConfig): Promise<Measured> {
  type Color = readonly [number, number, number, number];
  type Box = { readonly x: number; readonly y: number; readonly w: number; readonly h: number };
  type Entry = { readonly el: Element; readonly rect: Rect; readonly box: Box; readonly style: Style; readonly pinned: boolean; readonly inHeader: boolean };
  type Run = { readonly el: Element; readonly text: string; readonly rects: readonly Box[]; readonly box: Box; readonly pinned: boolean; readonly placeholder: boolean };
  type Item = { readonly box: readonly [number, number, number, number]; readonly what: string };
  type Model = { readonly root: Element; readonly header: Element | undefined; readonly entries: readonly Entry[]; readonly runs: readonly Run[] };
  type Paint = { readonly e: Entry; readonly color: Color; readonly kind: string };

  const { document } = window;
  await document.fonts.ready;

  const sides = ['top', 'right', 'bottom', 'left'] as const;
  const logical = { top: 'block-start', right: 'inline-end', bottom: 'block-end', left: 'inline-start' } as const;
  const buttonSelector = 'button, [role="button"], [role="tab"], a[href], input[type="button"], input[type="submit"], input[type="reset"]';
  const choiceSelector = '[role="switch"], [role="radio"], [role="checkbox"], [role="menuitemradio"], [role="menuitemcheckbox"], [role="option"]';
  const controlSelector =
    'button, a[href], input:not([type="hidden"]), select, textarea, summary, [role="button"], [role="link"], [role="tab"], [role="switch"], [role="radio"], [role="checkbox"], [role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"], [role="option"], [role="slider"], [role="combobox"], [tabindex]:not([tabindex="-1"]), [data-go], [data-act]';
  const headingSelector = 'h1, h2, h3, h4, h5, h6, [role="heading"]';
  const answerSelector = 'button, input:not([type="hidden"]), select, textarea, [contenteditable="true"], [role="button"], [role="radio"], [role="checkbox"], [role="option"], [role="textbox"], [role="switch"], [data-act]';
  const deliveryStates = new Set(['sent', 'received', 'acted']);
  const rawJson = [/[{[]\s*"[^"\n]*"\s*[:,]/, /"[^"\n]{1,60}"\s*:\s*(?:"|-?\d|\{|\[|true\b|false\b|null\b)/];
  const stackTrace = [/\bat\s+(?:async\s+)?[^\s()]+\s+\([^()\n]*[./\\][^()\n]*:\d+(?::\d+)?\)/, /\bat\s+(?:async\s+)?[^\s()]*[./\\][^\s()]*:\d+:\d+/];
  const textInputs = new Set(['text', 'search', 'email', 'url', 'tel', 'number', 'password', 'date', 'time', 'datetime-local', 'month', 'week', 'button', 'submit', 'reset']);
  const smallWords = new Set(['a', 'an', 'the', 'and', 'but', 'or', 'nor', 'for', 'so', 'yet', 'of', 'in', 'on', 'at', 'to', 'by', 'up', 'as', 'is', 'it', 'its', 'via', 'per', 'vs', 'with', 'from', 'into', 'onto', 'over', 'than', 'then', 'off', 'out']);
  const white: Color = [255, 255, 255, 1];
  const showText = 4;

  const styles = new Map<Element, Style>();
  const css = (el: Element): Style => {
    const known = styles.get(el);
    if (known !== undefined) return known;
    const style = window.getComputedStyle(el);
    styles.set(el, style);
    return style;
  };
  const collapse = (text: string | null | undefined): string => (text ?? '').replace(/\s+/g, ' ').trim();
  const wordCount = (text: string): number => collapse(text).split(' ').filter(w => /[\p{L}\p{N}]/u.test(w)).length;
  const round2 = (n: number): number => Math.round(n * 100) / 100;
  const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  function parseColor(value: string): Color | undefined {
    const m = /^rgba?\(([^)]*)\)$/.exec(value.trim());
    if (m === null) return undefined;
    const [r = 0, g = 0, b = 0, a = 1] = (m[1] ?? '').split(/[\s,/]+/).filter(Boolean).map(Number);
    return [r, g, b, a];
  }
  const over = (top: Color, bottom: Color): Color => [top[0] * top[3] + bottom[0] * (1 - top[3]), top[1] * top[3] + bottom[1] * (1 - top[3]), top[2] * top[3] + bottom[2] * (1 - top[3]), 1];
  const toward = (from: Color, to: Color, t: number): Color => [from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t, from[2] + (to[2] - from[2]) * t, 1];
  const hex = (c: Color): string => `#${[c[0], c[1], c[2]].map(v => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
  const chroma = (c: Color): number => Math.max(c[0], c[1], c[2]) - Math.min(c[0], c[1], c[2]);
  const differs = (a: Color, b: Color): boolean => [0, 1, 2].some(i => Math.abs((a[i] ?? 0) - (b[i] ?? 0)) >= 3);
  const nonGrey = (c: Color): boolean => chroma(c) >= cfg.greyChroma;
  function hue(c: Color): number {
    const [r, g, b] = [c[0] / 255, c[1] / 255, c[2] / 255];
    const max = Math.max(r, g, b);
    const d = max - Math.min(r, g, b);
    if (d === 0) return 0;
    const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return (h * 60 + 360) % 360;
  }
  const isGreen = (c: Color): boolean => nonGrey(c) && hue(c) >= cfg.greenHue[0] && hue(c) <= cfg.greenHue[1];
  const channel = (v: number): number => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const luminance = (c: Color): number => 0.2126 * channel(c[0]) + 0.7152 * channel(c[1]) + 0.0722 * channel(c[2]);
  const ratio = (a: Color, b: Color): number => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
  };

  function backdrop(el: Element | null): Color {
    const layers: Color[] = [];
    for (let n = el; n !== null; n = n.parentElement) {
      const c = parseColor(css(n).backgroundColor);
      if (c !== undefined && c[3] > 0) {
        layers.push(c);
        if (c[3] >= 1) break;
      }
    }
    return layers.reduceRight((acc, c) => over(c, acc), white);
  }

  function opacityOf(el: Element): number {
    let o = 1;
    for (let n: Element | null = el; n !== null; n = n.parentElement) o *= Number(css(n).opacity);
    return o;
  }

  function isPinned(el: Element): boolean {
    for (let n: Element | null = el; n !== null; n = n.parentElement) if (css(n).position === 'fixed') return true;
    return false;
  }

  function clip(rect: Rect, from: Element | null): Box | undefined {
    let { left, top, right, bottom } = rect;
    for (let n = from; n !== null && n !== document.documentElement; n = n.parentElement) {
      const s = css(n);
      if (s.overflowX !== 'visible' || s.overflowY !== 'visible') {
        const b = n.getBoundingClientRect();
        if (s.overflowX !== 'visible') {
          left = Math.max(left, b.left);
          right = Math.min(right, b.right);
        }
        if (s.overflowY !== 'visible') {
          top = Math.max(top, b.top);
          bottom = Math.min(bottom, b.bottom);
        }
      }
      if (s.position === 'fixed') break;
    }
    left = Math.max(left, 0);
    top = Math.max(top, 0);
    right = Math.min(right, window.innerWidth);
    bottom = Math.min(bottom, window.innerHeight);
    return right - left >= 1 && bottom - top >= 1 ? { x: left, y: top, w: right - left, h: bottom - top } : undefined;
  }

  const union = (boxes: readonly Box[]): Box => {
    const x = Math.min(...boxes.map(b => b.x));
    const y = Math.min(...boxes.map(b => b.y));
    return { x, y, w: Math.max(...boxes.map(b => b.x + b.w)) - x, h: Math.max(...boxes.map(b => b.y + b.h)) - y };
  };
  const item = (b: Box, what: string): Item => ({ box: [Math.round(b.x), Math.round(b.y), Math.round(b.w), Math.round(b.h)], what });
  function summarize(items: readonly Item[]): { readonly count: number; readonly items: readonly Item[] } {
    const seen = new Map<string, Item>();
    for (const it of items) if (!seen.has(it.what)) seen.set(it.what, it);
    return { count: items.length, items: [...seen.values()].slice(0, 40) };
  }
  function describe(el: Element): string {
    const role = el.getAttribute('role');
    const text = collapse(el.textContent).slice(0, 24);
    return `${el.tagName.toLowerCase()}${role === null ? '' : `[${role}]`}${text === '' ? '' : ` "${text}"`}`;
  }
  const disabled = (el: Element): boolean => el.closest(':disabled, [aria-disabled="true"]') !== null;
  const closedDetails = 'details:not([open])';
  function folded(el: Element): boolean {
    for (let fold = el.parentElement?.closest(closedDetails) ?? null; fold !== null; fold = fold.parentElement?.closest(closedDetails) ?? null) {
      const summary = fold.querySelector(':scope > summary');
      if (summary === null || !summary.contains(el)) return true;
    }
    return false;
  }
  const visible = (el: Element): boolean => !folded(el) && css(el).visibility === 'visible' && opacityOf(el) >= 0.05;

  function banner(root: Element): Element | undefined {
    for (const header of root.querySelectorAll('header')) if (header.closest('main, article, aside, nav, section') === null) return header;
    return undefined;
  }

  function textRuns(root: Element): readonly Run[] {
    const runs: Run[] = [];
    const walker = document.createTreeWalker(root, showText);
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      const text = collapse(node.nodeValue);
      const el = node.parentElement;
      if (text === '' || el === null || el.closest('script, style, noscript, template, textarea, select, option') !== null || el.matches(closedDetails) || !visible(el)) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      const rects = [...range.getClientRects()].map(r => clip(r, el)).filter(r => r !== undefined);
      if (rects.length > 0) runs.push({ el, text, rects, box: union(rects), pinned: isPinned(el), placeholder: false });
    }
    for (const el of root.querySelectorAll('input, textarea, select')) {
      if ((el.tagName === 'INPUT' && !textInputs.has(el.type ?? '')) || !visible(el)) continue;
      const value = el.tagName === 'SELECT' ? (el.selectedOptions?.[0]?.textContent ?? '') : (el.value ?? '');
      const text = collapse(value === '' ? el.placeholder : el.type === 'password' ? '' : value);
      const box = clip(el.getBoundingClientRect(), el.parentElement);
      if (text !== '' && box !== undefined) runs.push({ el, text, rects: [box], box, pinned: isPinned(el), placeholder: value === '' });
    }
    return runs;
  }

  function pageModel(): Model {
    styles.clear();
    const root = document.body;
    const header = banner(root);
    const entries: Entry[] = [];
    for (const el of root.querySelectorAll('*')) {
      if (el.closest('svg') !== null && el.tagName.toLowerCase() !== 'svg') continue;
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 && rect.height <= 0) continue;
      if (!visible(el)) continue;
      const box = clip(rect, el.parentElement);
      if (box === undefined) continue;
      entries.push({ el, rect, box, style: css(el), pinned: isPinned(el), inHeader: header?.contains(el) ?? false });
    }
    return { root, header, entries, runs: textRuns(root) };
  }

  const inFold = (x: { readonly pinned: boolean; readonly box: Box }): boolean => x.pinned || x.box.y < cfg.fold;

  const sideColor = (e: Entry, side: (typeof sides)[number]): Color | undefined => {
    const width = parseFloat(e.style.getPropertyValue(`border-${side}-width`));
    const style = e.style.getPropertyValue(`border-${side}-style`);
    const color = parseColor(e.style.getPropertyValue(`border-${side}-color`));
    return width > 0 && style !== 'none' && style !== 'hidden' && color !== undefined && color[3] > 0 ? color : undefined;
  };

  const fourBorders = (e: Entry): boolean => sides.every(side => sideColor(e, side) !== undefined);

  function fill(e: Entry): Color | undefined {
    const c = parseColor(e.style.backgroundColor);
    if (c === undefined || c[3] === 0) return undefined;
    const behind = backdrop(e.el.parentElement);
    const painted = over(c, behind);
    return differs(painted, behind) ? painted : undefined;
  }

  function borderColors(e: Entry): readonly Color[] {
    const under = over(parseColor(e.style.backgroundColor) ?? [0, 0, 0, 0], backdrop(e.el.parentElement));
    return sides.flatMap(side => {
      const color = sideColor(e, side);
      return color === undefined ? [] : [over(color, under)];
    });
  }

  function iconColor(svg: Element): Color | undefined {
    const shape = svg.querySelector('path, rect, circle, ellipse, line, polyline, polygon') ?? svg;
    const s = window.getComputedStyle(shape);
    for (const prop of ['stroke', 'fill']) {
      const c = parseColor(s.getPropertyValue(prop));
      if (c !== undefined && c[3] > 0) return c;
    }
    return parseColor(css(svg).color);
  }

  function paints(entries: readonly Entry[]): readonly Paint[] {
    const out: Paint[] = [];
    for (const e of entries) {
      const f = fill(e);
      if (f !== undefined) out.push({ e, color: f, kind: 'fill' });
      for (const b of borderColors(e)) out.push({ e, color: b, kind: 'border' });
      if (e.el.tagName.toLowerCase() === 'svg') {
        const c = iconColor(e.el);
        if (c !== undefined) out.push({ e, color: over(c, backdrop(e.el)), kind: 'icon' });
      }
    }
    return out;
  }

  const rawText = (r: Run): Color | undefined => parseColor(r.placeholder ? window.getComputedStyle(r.el, '::placeholder').color : css(r.el).color);

  function textColor(r: Run): Color | undefined {
    const raw = rawText(r);
    return raw === undefined ? undefined : over(raw, backdrop(r.el));
  }

  function clutter(page: Model): Pick<Measured, 'clutter' | 'clutterDetail'> {
    const entries = page.entries.filter(inFold);
    const runs = page.runs.filter(inFold);
    const boxed = entries.filter(e => e.rect.width >= cfg.minRegion && e.rect.height >= cfg.minRegion && (fourBorders(e) || fill(e) !== undefined));
    const sizes = new Set(runs.map(r => round2(parseFloat(css(r.el).fontSize))));
    const weights = new Set(runs.map(r => Number(css(r.el).fontWeight)));
    const colors = new Set<string>();
    for (const p of paints(entries)) if (nonGrey(p.color)) colors.add(hex(p.color));
    for (const r of runs) {
      const c = textColor(r);
      if (c !== undefined && nonGrey(c)) colors.add(hex(c));
    }
    const controls = entries.filter(e => !e.inHeader && e.el.matches(controlSelector));
    let words = 0;
    for (const r of runs) {
      const above = r.pinned ? 1 : r.rects.reduce((sum, b) => sum + Math.min(1, Math.max(0, (cfg.fold - b.y) / b.h)), 0) / r.rects.length;
      words += wordCount(r.text) * above;
    }
    return {
      clutter: { boxes: boxed.length, fontSizes: sizes.size, fontWeights: weights.size, colors: colors.size, controls: controls.length, words: Math.round(words) },
      clutterDetail: {
        fontSizes: [...sizes].sort((a, b) => a - b),
        fontWeights: [...weights].sort((a, b) => a - b),
        colors: [...colors].sort(),
        boxes: boxed.map(e => item(e.box, describe(e.el))),
        controls: controls.map(e => item(e.box, describe(e.el))),
      },
    };
  }

  const label = (el: Element): string => collapse(el.tagName === 'INPUT' ? el.value : el.innerText) || collapse(el.getAttribute('aria-label'));

  function primaryButtons(page: Model): Measured['primaryButtons'] {
    const out: Item[] = [];
    for (const e of page.entries) {
      if (!e.el.matches(buttonSelector) || e.el.matches(choiceSelector) || e.rect.height < 24) continue;
      const c = parseColor(e.style.backgroundColor);
      if (c === undefined || c[3] < 0.9) continue;
      const behind = backdrop(e.el.parentElement);
      if (ratio(over(c, behind), behind) >= 3) out.push(item(e.box, `"${label(e.el).slice(0, 40)}" filled ${hex(over(c, behind))}`));
    }
    return summarize(out);
  }

  function near(a: Box, b: Box): boolean {
    const dx = Math.max(0, a.x - (b.x + b.w), b.x - (a.x + a.w));
    const dy = Math.max(0, a.y - (b.y + b.h), b.y - (a.y + a.h));
    return (dy === 0 && dx <= cfg.labelGap) || (dx === 0 && dy <= cfg.labelGap);
  }
  const ownText = (el: Element): string => collapse(el.innerText);

  function markGroup(e: Entry): readonly Box[] {
    const boxes: Box[] = [e.box];
    for (let n = e.el.parentElement; n !== null && ownText(n) === ''; n = n.parentElement) {
      const r = n.getBoundingClientRect();
      if (r.height > 24) break;
      boxes.push({ x: r.left, y: r.top, w: r.width, h: r.height });
    }
    return boxes;
  }

  const neighbours = (page: Model, e: Entry): readonly Run[] => {
    const group = markGroup(e);
    return page.runs.filter(r => !e.el.contains(r.el) && r.rects.some(b => group.some(g => near(b, g))));
  };

  function rowText(el: Element): string {
    for (let n: Element | null = el; n !== null; n = n.parentElement) {
      const text = ownText(n);
      if (text !== '') return n.getBoundingClientRect().height <= 80 ? text : '';
    }
    return '';
  }

  function unlabelledState(page: Model): Measured['unlabelledState'] {
    const marks = new Map<Entry, Paint>();
    for (const p of paints(page.entries)) if (nonGrey(p.color) && !marks.has(p.e)) marks.set(p.e, p);
    const out: Item[] = [];
    for (const [e, p] of marks) {
      if (ownText(e.el) === '' && neighbours(page, e).length === 0) out.push(item(e.box, `${p.kind} ${hex(p.color)} on ${describe(e.el)} with no text within ${String(cfg.labelGap)}px`));
    }
    return summarize(out);
  }

  function greenOutsideLanded(page: Model): Measured['greenOutsideLanded'] {
    const green = new Map<Entry, Paint>();
    for (const p of paints(page.entries)) if (isGreen(p.color) && !green.has(p.e)) green.set(p.e, p);
    const byEl = new Map(page.entries.map(e => [e.el, e]));
    for (const r of page.runs) {
      const c = textColor(r);
      const e = byEl.get(r.el);
      if (c !== undefined && e !== undefined && isGreen(c) && !green.has(e)) green.set(e, { e, color: c, kind: 'text' });
    }
    const out: Item[] = [];
    for (const [e, p] of green) {
      const said = [rowText(e.el), ...neighbours(page, e).map(r => r.text)].join(' ');
      if (e.rect.height > 24 || !/\blanded\b/i.test(said)) out.push(item(e.box, `${p.kind} ${hex(p.color)} on ${describe(e.el)}`));
    }
    return summarize(out);
  }

  function isTitleCase(text: string, proper: ReadonlySet<string>): boolean {
    const words = text.split(' ').map(w => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '').replace(/['’]s$/u, ''));
    const candidates = words.slice(1).filter(w => /^[\p{L}'’]+$/u.test(w) && !smallWords.has(w.toLowerCase()) && !proper.has(w) && !(w.length > 1 && w === w.toUpperCase()));
    return candidates.length > 0 && candidates.every(w => /^\p{Lu}/u.test(w));
  }

  function titleCaseHeadings(page: Model): Measured['titleCaseHeadings'] {
    const proper = new Set(cfg.properNouns.flatMap(name => name.split(/\s+/)));
    const out: Item[] = [];
    for (const e of page.entries) {
      if (!e.el.matches(headingSelector)) continue;
      const text = collapse(e.el.textContent);
      if (isTitleCase(text, proper)) out.push(item(e.box, `"${text.slice(0, 60)}"`));
    }
    return summarize(out);
  }

  function longButtonLabels(page: Model): Measured['longButtonLabels'] {
    const out: Item[] = [];
    for (const e of page.entries) {
      if (!e.el.matches(buttonSelector) || e.el.matches(choiceSelector)) continue;
      if (e.el.tagName === 'A' && !(fourBorders(e) || fill(e) !== undefined)) continue;
      const inner = page.runs.filter(r => e.el.contains(r.el));
      if (new Set(inner.map(r => r.el)).size > 1) continue;
      const text = inner.map(r => r.text).join(' ');
      const words = wordCount(text);
      if (words > cfg.maxButtonWords) out.push(item(e.box, `${String(words)} words "${text.slice(0, 60)}"`));
    }
    return summarize(out);
  }

  function internalTerms(page: Model): Measured['internalTerms'] {
    const terms = cfg.internalTerms.map(t => [t, new RegExp(`\\b${t.split(/\s+/).map(escapeRe).join('\\s+')}s?\\b`, 'i')] as const);
    const out: Item[] = [];
    for (const r of page.runs) for (const [t, re] of terms) if (re.test(r.text)) out.push(item(r.box, `"${t}" in "${r.text.slice(0, 60)}"`));
    return summarize(out);
  }

  function autoMarginRules(): readonly (readonly [string, string])[] {
    const found: (readonly [string, string])[] = [];
    const walk = (rules: Iterable<Rule>): void => {
      for (const rule of rules) {
        if (rule.cssRules !== undefined) walk(rule.cssRules);
        const { style, selectorText } = rule;
        if (style === undefined || selectorText === undefined) continue;
        for (const side of sides) {
          if (style.getPropertyValue(`margin-${side}`) === 'auto' || style.getPropertyValue(`margin-${logical[side]}`) === 'auto') found.push([selectorText, side]);
        }
      }
    };
    for (const sheet of document.styleSheets) {
      try {
        walk(sheet.cssRules);
      } catch {
        continue;
      }
    }
    return found;
  }

  function spacingOffScale(page: Model): Measured['spacingOffScale'] {
    const scale = new Set(cfg.spacingScale);
    const autoRules = autoMarginRules();
    const isAuto = (el: Element, side: (typeof sides)[number]): boolean =>
      el.style.getPropertyValue(`margin-${side}`) === 'auto' || el.style.getPropertyValue(`margin-${logical[side]}`) === 'auto' || autoRules.some(([selector, s]) => s === side && el.matches(selector));
    const out: Item[] = [];
    for (const e of page.entries) {
      const checks: (readonly [string, string])[] = [];
      for (const side of sides) {
        if (!isAuto(e.el, side)) checks.push([`margin-${side}`, e.style.getPropertyValue(`margin-${side}`)]);
        checks.push([`padding-${side}`, e.style.getPropertyValue(`padding-${side}`)]);
      }
      const grid = e.style.display.includes('grid');
      const flex = e.style.display.includes('flex');
      const wraps = flex && e.style.flexWrap !== 'nowrap';
      const column = flex && e.style.flexDirection.startsWith('column');
      if (grid || (flex && (column || wraps))) checks.push(['row-gap', e.style.rowGap]);
      if (grid || (flex && (!column || wraps))) checks.push(['column-gap', e.style.columnGap]);
      for (const [prop, raw] of checks) {
        const px = Math.abs(parseFloat(raw));
        if (Number.isNaN(px)) continue;
        const v = round2(px);
        if (!scale.has(v)) out.push(item(e.box, `${prop} ${String(v)}px on ${describe(e.el)}`));
      }
    }
    return summarize(out);
  }

  function typeOffScale(page: Model): Measured['typeOffScale'] {
    const scale = new Set(cfg.typeScale);
    const out: Item[] = [];
    for (const r of page.runs) {
      const size = round2(parseFloat(css(r.el).fontSize));
      if (!scale.has(size)) out.push(item(r.box, `${String(size)}px "${r.text.slice(0, 40)}"`));
    }
    return summarize(out);
  }

  function boxOf(el: Element): Box {
    const r = el.getBoundingClientRect();
    return clip(r, el.parentElement) ?? { x: r.left, y: r.top, w: r.width, h: r.height };
  }

  function undeliveredMessages(page: Model): Measured['undeliveredMessages'] {
    const messages = [...page.root.querySelectorAll('[data-msg="person"]')];
    const out: Item[] = [];
    for (const el of messages) {
      const state = el.getAttribute('data-delivery');
      if (state === null || !deliveryStates.has(state)) out.push(item(boxOf(el), `${state === null ? 'no data-delivery' : `data-delivery="${state}"`} on ${describe(el)}`));
    }
    return { checked: messages.length, ...summarize(out) };
  }

  function blockOf(el: Element): Element {
    for (let n: Element | null = el; n !== null && n !== document.body; n = n.parentElement) if (!/^inline|^contents$/.test(css(n).display)) return n;
    return el;
  }

  function rawData(page: Model): Measured['rawData'] {
    const blocks = new Map<Element, { texts: string[]; boxes: Box[] }>();
    for (const r of page.runs) {
      if (r.el.matches('input, textarea, select')) continue;
      const block = blockOf(r.el);
      const entry = blocks.get(block) ?? { texts: [], boxes: [] };
      entry.texts.push(r.text);
      entry.boxes.push(r.box);
      blocks.set(block, entry);
    }
    const out: Item[] = [];
    for (const { texts, boxes } of blocks.values()) {
      const text = texts.join(' ');
      const stack = stackTrace.some(re => re.test(text));
      if (stack || rawJson.some(re => re.test(text))) out.push(item(union(boxes), `${stack ? 'stack trace' : 'raw JSON'} in "${text.slice(0, 60)}"`));
    }
    return summarize(out);
  }

  function unansweredQuestions(page: Model): Measured['unansweredQuestions'] {
    const inView = new Set(page.entries.map(e => e.el));
    const questions = [...page.root.querySelectorAll('[data-question="open"]')];
    const out: Item[] = [];
    for (const el of questions) {
      if (![...el.querySelectorAll(answerSelector)].some(c => inView.has(c))) out.push(item(boxOf(el), `open question with no answer control in view: ${describe(el)}`));
    }
    return { checked: questions.length, ...summarize(out) };
  }

  function contrastFailures(page: Model): Measured['contrast'] {
    const out: Item[] = [];
    let checked = 0;
    let min = Infinity;
    for (const r of page.runs) {
      if (disabled(r.el)) continue;
      const raw = rawText(r);
      if (raw === undefined) continue;
      const bg = backdrop(r.el);
      const fg = toward(bg, over(raw, bg), opacityOf(r.el));
      const size = parseFloat(css(r.el).fontSize);
      const need = size >= 24 || (size >= 18.66 && Number(css(r.el).fontWeight) >= 700) ? cfg.contrast.large : cfg.contrast.body;
      const got = ratio(fg, bg);
      checked += 1;
      min = Math.min(min, got);
      if (got + 1e-6 < need) out.push(item(r.box, `${got.toFixed(2)}:1 < ${String(need)} "${r.text.slice(0, 40)}" ${hex(fg)} on ${hex(bg)} at ${String(round2(size))}px`));
    }
    for (const e of page.entries) {
      if (e.el.tagName.toLowerCase() !== 'svg' || disabled(e.el)) continue;
      const raw = iconColor(e.el);
      if (raw === undefined) continue;
      const bg = backdrop(e.el);
      const fg = toward(bg, over(raw, bg), opacityOf(e.el));
      const got = ratio(fg, bg);
      checked += 1;
      min = Math.min(min, got);
      if (got + 1e-6 < cfg.contrast.icon) out.push(item(e.box, `icon ${got.toFixed(2)}:1 < ${String(cfg.contrast.icon)} ${hex(fg)} on ${hex(bg)} in ${e.el.parentElement === null ? 'the page' : describe(e.el.parentElement)}`));
    }
    return { checked, min: Number.isFinite(min) ? round2(min) : null, ...summarize(out) };
  }

  const page = pageModel();
  return {
    viewport: { w: window.innerWidth, h: window.innerHeight, scrollY: Math.round(window.scrollY), pageHeight: document.documentElement.scrollHeight },
    topbar: page.header !== undefined,
    ...clutter(page),
    primaryButtons: primaryButtons(page),
    unlabelledState: unlabelledState(page),
    greenOutsideLanded: greenOutsideLanded(page),
    titleCaseHeadings: titleCaseHeadings(page),
    longButtonLabels: longButtonLabels(page),
    internalTerms: internalTerms(page),
    spacingOffScale: spacingOffScale(page),
    typeOffScale: typeOffScale(page),
    undeliveredMessages: undeliveredMessages(page),
    rawData: rawData(page),
    unansweredQuestions: unansweredQuestions(page),
    contrast: contrastFailures(page),
  };
}
