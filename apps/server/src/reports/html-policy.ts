import { parse as parseCss, walk as walkCss } from "css-tree";
import {
  parse as parseHtml,
  type DefaultTreeAdapterMap,
  type ParserError,
} from "parse5";
import { SAXParser } from "parse5-sax-parser";

import { DOCUMENT_LIMITS } from "@yaaps/contracts";

const MAXIMUM_NESTING_DEPTH = 100;

const BLOCKED_ELEMENTS = new Set([
  "applet",
  "base",
  "embed",
  "form",
  "iframe",
  "link",
  "object",
  "script",
]);

const BLOCKED_RESOURCE_ATTRIBUTES = new Set([
  "action",
  "background",
  "cite",
  "data",
  "formaction",
  "manifest",
  "ping",
  "poster",
  "srcset",
]);

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

const ALLOWED_EMBEDDED_RESOURCE =
  /^data:(?:image\/(?:avif|gif|jpeg|png|webp)|font\/(?:otf|ttf|woff|woff2));base64,[a-z0-9+/]+=*$/i;

type HtmlChildNode = DefaultTreeAdapterMap["childNode"];
type HtmlDocumentType = DefaultTreeAdapterMap["documentType"];
type HtmlElement = DefaultTreeAdapterMap["element"];
type HtmlTemplate = DefaultTreeAdapterMap["template"];
type HtmlTextNode = DefaultTreeAdapterMap["textNode"];

export type HtmlPolicyViolationCode =
  | "CSS_INVALID"
  | "CSS_NETWORK_RESOURCE"
  | "DOCUMENT_INCOMPLETE"
  | "DOCUMENT_TOO_DEEP"
  | "DOCUMENT_TOO_LARGE"
  | "DOCUMENT_UTF8_INVALID"
  | "ELEMENT_BLOCKED"
  | "EVENT_HANDLER_BLOCKED"
  | "META_REFRESH_BLOCKED"
  | "RESOURCE_BLOCKED"
  | "SRCDOC_BLOCKED";

export class HtmlPolicyError extends Error {
  constructor(
    readonly code: HtmlPolicyViolationCode,
    message: string,
  ) {
    super(message);
    this.name = "HtmlPolicyError";
  }
}

function fail(code: HtmlPolicyViolationCode, message: string): never {
  throw new HtmlPolicyError(code, message);
}

function validateCss(
  css: string,
  context: "declarationList" | "stylesheet" | "value",
) {
  let parseFailed = false;
  let tree;
  try {
    tree = parseCss(css, {
      context,
      onParseError: () => {
        parseFailed = true;
      },
      parseCustomProperty: true,
    });
  } catch {
    fail("CSS_INVALID", "The document contains invalid CSS.");
  }

  if (parseFailed) {
    fail("CSS_INVALID", "The document contains invalid CSS.");
  }

  walkCss(tree, (node) => {
    if (node.type === "Atrule" && node.name.toLowerCase() === "import") {
      fail("CSS_NETWORK_RESOURCE", "CSS imports are not allowed.");
    }
    if (
      node.type === "Function" &&
      ["-webkit-image-set", "image-set", "local"].includes(
        node.name.toLowerCase(),
      )
    ) {
      fail(
        "CSS_NETWORK_RESOURCE",
        "The document contains a blocked CSS resource function.",
      );
    }
    if (
      node.type === "Declaration" &&
      ["-moz-binding", "behavior"].includes(node.property.toLowerCase())
    ) {
      fail("CSS_NETWORK_RESOURCE", "The CSS property is not allowed.");
    }
    if (
      node.type === "Url" &&
      node.value !== "" &&
      !node.value.startsWith("#") &&
      !ALLOWED_EMBEDDED_RESOURCE.test(node.value)
    ) {
      fail(
        "CSS_NETWORK_RESOURCE",
        "CSS may reference only embedded bitmap images or fonts.",
      );
    }
  });
}

function isElement(node: HtmlChildNode): node is HtmlElement {
  return "tagName" in node;
}

function isDocumentType(node: HtmlChildNode): node is HtmlDocumentType {
  return node.nodeName === "#documentType";
}

function isTextNode(node: HtmlChildNode): node is HtmlTextNode {
  return node.nodeName === "#text";
}

function textContent(element: HtmlElement): string {
  return element.childNodes
    .filter(isTextNode)
    .map((child) => child.value)
    .join("");
}

function validateElement(element: HtmlElement, depth: number): void {
  if (depth > MAXIMUM_NESTING_DEPTH) {
    fail(
      "DOCUMENT_TOO_DEEP",
      `HTML nesting may not exceed ${MAXIMUM_NESTING_DEPTH} elements.`,
    );
  }

  const tagName = element.tagName.toLowerCase();
  if (BLOCKED_ELEMENTS.has(tagName)) {
    fail("ELEMENT_BLOCKED", `The <${tagName}> element is not allowed.`);
  }

  for (const attribute of element.attrs) {
    const name = attribute.name.toLowerCase();
    const value = attribute.value.trim();

    if (name.startsWith("on")) {
      fail(
        "EVENT_HANDLER_BLOCKED",
        "Event-handler attributes are not allowed.",
      );
    }
    if (name === "srcdoc") {
      fail("SRCDOC_BLOCKED", "The srcdoc attribute is not allowed.");
    }
    if (BLOCKED_RESOURCE_ATTRIBUTES.has(name)) {
      fail(
        "RESOURCE_BLOCKED",
        `The ${name} resource attribute is not allowed.`,
      );
    }
    if (name === "src") {
      if (
        !["image", "img"].includes(tagName) ||
        !ALLOWED_EMBEDDED_RESOURCE.test(value)
      ) {
        fail(
          "RESOURCE_BLOCKED",
          "Image sources must be embedded bitmap data URLs.",
        );
      }
    }
    if (name === "href") {
      const embeddedImage =
        tagName === "image" && ALLOWED_EMBEDDED_RESOURCE.test(value);
      if (!value.startsWith("#") && !embeddedImage) {
        fail(
          "RESOURCE_BLOCKED",
          "Links may reference only locations inside the document.",
        );
      }
    }
    if (name === "style") {
      validateCss(value, "declarationList");
    }
    if (CSS_VALUE_ATTRIBUTES.has(name)) {
      validateCss(value, "value");
    }
  }

  if (
    tagName === "meta" &&
    element.attrs.some(
      (attribute) =>
        attribute.name.toLowerCase() === "http-equiv" &&
        attribute.value.trim().toLowerCase() === "refresh",
    )
  ) {
    fail("META_REFRESH_BLOCKED", "Meta refresh is not allowed.");
  }

  if (tagName === "style") {
    validateCss(textContent(element), "stylesheet");
  }

  for (const child of element.childNodes) {
    if (isElement(child)) {
      validateElement(child, depth + 1);
    }
  }

  if (tagName === "template" && "content" in element) {
    const template = element as HtmlTemplate;
    for (const child of template.content.childNodes) {
      if (isElement(child)) {
        validateElement(child, depth + 1);
      }
    }
  }
}

function validateSingleDocumentTokenStructure(source: string): void {
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
    if (count) {
      count.start += 1;
    }
  });
  parser.on("endTag", ({ tagName }) => {
    const count = counts.get(tagName);
    if (count) {
      count.end += 1;
    }
  });
  parser.resume();
  parser.end(source);

  if (
    doctypes !== 1 ||
    [...counts.values()].some((count) => count.start !== 1 || count.end !== 1)
  ) {
    fail(
      "DOCUMENT_INCOMPLETE",
      "The upload must contain exactly one doctype, html, head, and body element.",
    );
  }
}

export function validateHtmlDocument(bytes: Uint8Array): string {
  if (
    bytes.byteLength === 0 ||
    bytes.byteLength > DOCUMENT_LIMITS.maximumHtmlBytes
  ) {
    fail(
      "DOCUMENT_TOO_LARGE",
      `HTML documents must contain between 1 and ${DOCUMENT_LIMITS.maximumHtmlBytes} bytes.`,
    );
  }

  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail("DOCUMENT_UTF8_INVALID", "The document must be valid UTF-8.");
  }

  validateSingleDocumentTokenStructure(source);

  const parseErrors: ParserError[] = [];
  const document = parseHtml(source, {
    onParseError: (error) => parseErrors.push(error),
    sourceCodeLocationInfo: true,
  });
  if (parseErrors.length > 0) {
    fail("DOCUMENT_INCOMPLETE", "The document is not valid complete HTML.");
  }

  const doctypes = document.childNodes.filter(isDocumentType);
  const roots = document.childNodes.filter(isElement);
  const root = roots[0];
  const head = root?.childNodes.find(
    (child): child is HtmlElement =>
      isElement(child) && child.tagName === "head",
  );
  const body = root?.childNodes.find(
    (child): child is HtmlElement =>
      isElement(child) && child.tagName === "body",
  );
  if (
    doctypes.length !== 1 ||
    doctypes[0]?.name.toLowerCase() !== "html" ||
    doctypes[0].publicId !== "" ||
    doctypes[0].systemId !== "" ||
    roots.length !== 1 ||
    root?.tagName !== "html" ||
    !root.sourceCodeLocation ||
    !head?.sourceCodeLocation ||
    !body?.sourceCodeLocation
  ) {
    fail(
      "DOCUMENT_INCOMPLETE",
      "The upload must be one complete HTML document with doctype, html, head, and body elements.",
    );
  }

  validateElement(root, 1);
  return source;
}
