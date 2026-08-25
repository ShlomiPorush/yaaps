import { readFile } from "node:fs/promises";
import path from "node:path";

import { DOCUMENT_LIMITS } from "@yaaps/contracts";
import {
  generate as generateCss,
  parse as parseCss,
  walk as walkCss,
  type Url as CssUrl,
} from "css-tree";
import {
  parse as parseHtml,
  serialize,
  type DefaultTreeAdapterMap,
  type ParserError,
} from "parse5";
import { SAXParser } from "parse5-sax-parser";

type HtmlChildNode = DefaultTreeAdapterMap["childNode"];
type HtmlElement = DefaultTreeAdapterMap["element"];
type HtmlTemplate = DefaultTreeAdapterMap["template"];
type HtmlTextNode = DefaultTreeAdapterMap["textNode"];

const EMBEDDED_BITMAP =
  /^data:image\/(?:avif|gif|jpeg|png|webp);base64,[a-z0-9+/]+=*$/i;
const EMBEDDED_CSS_RESOURCE =
  /^data:(?:image\/(?:avif|gif|jpeg|png|webp)|font\/(?:otf|ttf|woff|woff2));base64,[a-z0-9+/]+=*$/i;
const CSS_VALUE_ATTRIBUTES = new Set([
  "clip-path",
  "fill",
  "filter",
  "marker",
  "marker-end",
  "marker-mid",
  "marker-start",
  "mask",
  "stroke",
]);

export class HtmlNormalizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HtmlNormalizationError";
  }
}

function isElement(node: HtmlChildNode): node is HtmlElement {
  return "tagName" in node;
}

function isTextNode(node: HtmlChildNode): node is HtmlTextNode {
  return node.nodeName === "#text";
}

function bitmapMime(bytes: Uint8Array): string | undefined {
  const ascii = (start: number, end: number) =>
    Buffer.from(bytes.subarray(start, end)).toString("ascii");
  const hex = (start: number, end: number) =>
    Buffer.from(bytes.subarray(start, end)).toString("hex");
  if (hex(0, 8) === "89504e470d0a1a0a") return "image/png";
  if (hex(0, 3) === "ffd8ff") return "image/jpeg";
  if (["GIF87a", "GIF89a"].includes(ascii(0, 6))) return "image/gif";
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") {
    return "image/webp";
  }
  if (ascii(4, 8) === "ftyp" && ["avif", "avis"].includes(ascii(8, 12))) {
    return "image/avif";
  }
  return undefined;
}

async function embedLocalBitmap(value: string, htmlDirectory: string) {
  if (
    // The scheme test also rejects Windows drive paths ("C:\...") since any
    // single-letter-plus-colon prefix matches it.
    /^[A-Za-z][A-Za-z0-9+.-]*:/.test(value) ||
    value.startsWith("//") ||
    path.isAbsolute(value)
  ) {
    throw new HtmlNormalizationError(
      `External or absolute asset reference is not allowed: ${value}`,
    );
  }
  if (value.includes("?") || value.includes("#")) {
    throw new HtmlNormalizationError(
      `Local asset references may not contain a query or fragment: ${value}`,
    );
  }

  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    throw new HtmlNormalizationError(`The asset path is invalid: ${value}`);
  }
  const assetPath = path.resolve(
    htmlDirectory,
    decoded.replaceAll("/", path.sep),
  );
  const baseDirectory = path.resolve(htmlDirectory);
  const relativeToBase = path.relative(baseDirectory, assetPath);
  if (
    relativeToBase === ".." ||
    relativeToBase.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeToBase)
  ) {
    throw new HtmlNormalizationError(
      `Local asset references may not escape the document directory: ${value}`,
    );
  }
  let bytes: Buffer;
  try {
    bytes = await readFile(assetPath);
  } catch {
    throw new HtmlNormalizationError(
      `The local asset could not be read: ${value}`,
    );
  }
  const mime = bitmapMime(bytes);
  if (!mime) {
    throw new HtmlNormalizationError(
      `The local asset is not a supported bitmap image: ${value}`,
    );
  }
  return `data:${mime};base64,${bytes.toString("base64")}`;
}

async function normalizeResourceUrl(
  value: string,
  htmlDirectory: string,
  context: "bitmap" | "css",
): Promise<string> {
  const normalized = value.trim();
  if (normalized.startsWith("#")) return normalized;
  if (
    (context === "bitmap" && EMBEDDED_BITMAP.test(normalized)) ||
    (context === "css" && EMBEDDED_CSS_RESOURCE.test(normalized))
  ) {
    return normalized;
  }
  if (normalized.startsWith("data:")) {
    throw new HtmlNormalizationError(
      `The embedded asset uses an unsupported media type: ${value}`,
    );
  }
  return embedLocalBitmap(normalized, htmlDirectory);
}

async function normalizeCss(
  source: string,
  htmlDirectory: string,
  context: "declarationList" | "stylesheet" | "value",
): Promise<string> {
  let parseFailed = false;
  let tree;
  try {
    tree = parseCss(source, {
      context,
      onParseError: () => {
        parseFailed = true;
      },
      parseCustomProperty: true,
    });
  } catch {
    throw new HtmlNormalizationError("The report contains invalid CSS.");
  }
  if (parseFailed) {
    throw new HtmlNormalizationError("The report contains invalid CSS.");
  }

  const urls: CssUrl[] = [];
  walkCss(tree, (node) => {
    if (node.type === "Atrule" && node.name.toLowerCase() === "import") {
      throw new HtmlNormalizationError("CSS imports are not allowed.");
    }
    if (
      node.type === "Function" &&
      ["-webkit-image-set", "image-set", "local"].includes(
        node.name.toLowerCase(),
      )
    ) {
      throw new HtmlNormalizationError(
        `The CSS ${node.name}() resource function is not allowed.`,
      );
    }
    if (node.type === "Url") urls.push(node);
  });

  for (const url of urls) {
    url.value = await normalizeResourceUrl(url.value, htmlDirectory, "css");
  }
  return generateCss(tree);
}

function validateExplicitDocument(source: string): void {
  const counts = new Map<string, { end: number; start: number }>([
    ["body", { end: 0, start: 0 }],
    ["head", { end: 0, start: 0 }],
    ["html", { end: 0, start: 0 }],
  ]);
  let doctypes = 0;
  const parser = new SAXParser();
  parser.on("doctype", () => {
    doctypes += 1;
  });
  parser.on("startTag", ({ tagName }) => {
    const count = counts.get(tagName);
    if (count) count.start += 1;
  });
  parser.on("endTag", ({ tagName }) => {
    const count = counts.get(tagName);
    if (count) count.end += 1;
  });
  parser.resume();
  parser.end(source);
  if (
    doctypes !== 1 ||
    [...counts.values()].some((count) => count.start !== 1 || count.end !== 1)
  ) {
    throw new HtmlNormalizationError(
      "The upload must be one complete HTML document with explicit doctype, html, head, and body tags.",
    );
  }
}

async function normalizeElement(
  element: HtmlElement,
  htmlDirectory: string,
): Promise<void> {
  const tagName = element.tagName.toLowerCase();
  if (
    [
      "applet",
      "base",
      "embed",
      "form",
      "iframe",
      "link",
      "object",
      "script",
    ].includes(tagName)
  ) {
    throw new HtmlNormalizationError(
      `The <${tagName}> element is not publishable.`,
    );
  }

  for (const attribute of element.attrs) {
    const name = attribute.name.toLowerCase();
    if (name.startsWith("on")) {
      throw new HtmlNormalizationError(
        "Event-handler attributes are not publishable.",
      );
    }
    if (["srcdoc", "srcset"].includes(name)) {
      throw new HtmlNormalizationError(
        `The ${name} attribute is not publishable.`,
      );
    }
    if (name === "src") {
      if (!["image", "img"].includes(tagName)) {
        throw new HtmlNormalizationError(
          `The <${tagName}> element may not load a resource.`,
        );
      }
      attribute.value = await normalizeResourceUrl(
        attribute.value,
        htmlDirectory,
        "bitmap",
      );
    }
    if (name === "href") {
      if (tagName === "image") {
        attribute.value = await normalizeResourceUrl(
          attribute.value,
          htmlDirectory,
          "bitmap",
        );
      } else if (!attribute.value.startsWith("#")) {
        throw new HtmlNormalizationError(
          "Links may reference only locations inside the report.",
        );
      }
    }
    if (name === "style") {
      attribute.value = await normalizeCss(
        attribute.value,
        htmlDirectory,
        "declarationList",
      );
    }
    if (CSS_VALUE_ATTRIBUTES.has(name)) {
      attribute.value = await normalizeCss(
        attribute.value,
        htmlDirectory,
        "value",
      );
    }
  }

  if (tagName === "style") {
    const css = element.childNodes
      .filter(isTextNode)
      .map((node) => node.value)
      .join("");
    const normalized = await normalizeCss(css, htmlDirectory, "stylesheet");
    element.childNodes = [
      {
        nodeName: "#text",
        parentNode: element,
        value: normalized,
      },
    ];
  }

  for (const child of element.childNodes) {
    if (isElement(child)) await normalizeElement(child, htmlDirectory);
  }
  if (tagName === "template" && "content" in element) {
    for (const child of (element as HtmlTemplate).content.childNodes) {
      if (isElement(child)) await normalizeElement(child, htmlDirectory);
    }
  }
}

export async function normalizeHtmlFile(filePath: string): Promise<Buffer> {
  const absolutePath = path.resolve(filePath);
  let input: Buffer;
  try {
    input = await readFile(absolutePath);
  } catch {
    throw new HtmlNormalizationError(
      `The HTML file could not be read: ${filePath}`,
    );
  }
  if (input.byteLength > DOCUMENT_LIMITS.maximumHtmlBytes) {
    throw new HtmlNormalizationError(
      `The HTML file exceeds ${DOCUMENT_LIMITS.maximumHtmlBytes} bytes before embedding.`,
    );
  }
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(input);
  } catch {
    throw new HtmlNormalizationError("The HTML file must be valid UTF-8.");
  }
  validateExplicitDocument(source);

  const parseErrors: ParserError[] = [];
  const document = parseHtml(source, {
    onParseError: (error) => parseErrors.push(error),
  });
  if (parseErrors.length > 0) {
    throw new HtmlNormalizationError(
      "The HTML file is not structurally valid.",
    );
  }
  const root = document.childNodes.find(isElement);
  if (!root || root.tagName !== "html") {
    throw new HtmlNormalizationError("The HTML document root is invalid.");
  }
  await normalizeElement(root, path.dirname(absolutePath));

  const output = Buffer.from(serialize(document), "utf8");
  if (output.byteLength > DOCUMENT_LIMITS.maximumHtmlBytes) {
    throw new HtmlNormalizationError(
      `The HTML file exceeds ${DOCUMENT_LIMITS.maximumHtmlBytes} bytes after embedding.`,
    );
  }
  return output;
}
