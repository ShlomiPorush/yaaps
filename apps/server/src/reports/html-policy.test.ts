import { DOCUMENT_LIMITS } from "@yaaps/contracts";
import { describe, expect, it } from "vitest";

import { HtmlPolicyError, validateHtmlDocument } from "./html-policy.js";

function document(body: string, head = "<title>Report</title>"): Buffer {
  return Buffer.from(
    `<!doctype html><html lang="en"><head>${head}</head><body>${body}</body></html>`,
  );
}

describe("server HTML policy", () => {
  it("accepts a complete inert report with embedded bitmap assets", () => {
    const source = document(
      [
        '<a href="#details">Details</a>',
        '<img alt="Chart" src="data:image/png;base64,iVBORw0KGgo=">',
        '<svg><defs><linearGradient id="paint"></linearGradient></defs><rect fill="url(#paint)"></rect></svg>',
        '<section id="details" style="background-image:url(data:image/webp;base64,UklGRg==)">Safe</section>',
      ].join(""),
      "<title>Report</title><style>@font-face{font-family:Report;src:url(data:font/woff2;base64,d09GMg==)}body{color:#123}</style>",
    );

    expect(validateHtmlDocument(source)).toContain("<title>Report</title>");
  });

  it.each([
    ["script", "<script>alert(1)</script>", "ELEMENT_BLOCKED"],
    ["module script", '<script type="module"></script>', "ELEMENT_BLOCKED"],
    [
      "event handler",
      '<p onclick="alert(1)">Unsafe</p>',
      "EVENT_HANDLER_BLOCKED",
    ],
    [
      "javascript URL",
      '<a href="javascript:alert(1)">Unsafe</a>',
      "RESOURCE_BLOCKED",
    ],
    [
      "external link",
      '<a href="https://example.com">Unsafe</a>',
      "RESOURCE_BLOCKED",
    ],
    [
      "form",
      '<form action="/"><button>Send</button></form>',
      "ELEMENT_BLOCKED",
    ],
    [
      "iframe",
      '<iframe src="data:text/html,unsafe"></iframe>',
      "ELEMENT_BLOCKED",
    ],
    ["embed", '<embed src="data:text/html,unsafe">', "ELEMENT_BLOCKED"],
    [
      "object",
      '<object data="data:text/html,unsafe"></object>',
      "ELEMENT_BLOCKED",
    ],
    ["applet", "<applet></applet>", "ELEMENT_BLOCKED"],
    ["srcdoc", '<div srcdoc="<p>unsafe</p>"></div>', "SRCDOC_BLOCKED"],
    ["meta refresh", "<p>body</p>", "META_REFRESH_BLOCKED"],
    [
      "external image",
      '<img src="https://example.com/pixel.png">',
      "RESOURCE_BLOCKED",
    ],
    [
      "SVG data image",
      '<img src="data:image/svg+xml;base64,PHN2Zz4=">',
      "RESOURCE_BLOCKED",
    ],
    [
      "srcset",
      '<img srcset="https://example.com/pixel.png 1x">',
      "RESOURCE_BLOCKED",
    ],
    [
      "external CSS URL",
      '<p style="background:url(https://example.com/x.png)">x</p>',
      "CSS_NETWORK_RESOURCE",
    ],
    [
      "escaped CSS URL",
      '<p style="background:u\\72l(https://example.com/x.png)">x</p>',
      "CSS_INVALID",
    ],
    [
      "CSS image-set",
      `<p style='background:image-set("https://example.com/x.png" 1x)'>x</p>`,
      "CSS_NETWORK_RESOURCE",
    ],
    [
      "blocked element inside template content",
      "<template><script>alert(1)</script></template>",
      "ELEMENT_BLOCKED",
    ],
    [
      "external URL in SVG presentation attribute",
      '<svg><rect fill="url(https://example.com/x.png)"></rect></svg>',
      "CSS_NETWORK_RESOURCE",
    ],
    [
      "-moz-binding declaration",
      `<p style="-moz-binding:url('data:text/xml,x')">x</p>`,
      "CSS_NETWORK_RESOURCE",
    ],
    [
      "behavior declaration",
      '<p style="behavior:url(#default#userData)">x</p>',
      "CSS_NETWORK_RESOURCE",
    ],
  ])("rejects %s", (_name, body, code) => {
    const head =
      _name === "meta refresh"
        ? '<meta http-equiv="refresh" content="0;url=https://example.com">'
        : "<title>Report</title>";

    expect(() => validateHtmlDocument(document(body, head))).toThrowError(
      expect.objectContaining({ code }),
    );
  });

  it("rejects CSS imports even when their URL is a string", () => {
    expect(() =>
      validateHtmlDocument(
        document(
          "<p>Unsafe</p>",
          '<style>@import "https://example.com/report.css";</style>',
        ),
      ),
    ).toThrowError(expect.objectContaining({ code: "CSS_NETWORK_RESOURCE" }));
  });

  it("requires valid UTF-8 and one explicitly complete HTML document", () => {
    expect(() =>
      validateHtmlDocument(Uint8Array.from([0xc3, 0x28])),
    ).toThrowError(expect.objectContaining({ code: "DOCUMENT_UTF8_INVALID" }));
    expect(() =>
      validateHtmlDocument(Buffer.from("<p>fragment</p>")),
    ).toThrowError(expect.objectContaining({ code: "DOCUMENT_INCOMPLETE" }));
    expect(() =>
      validateHtmlDocument(
        Buffer.from(
          "<!doctype html><html><head></head><body></body></html><html></html>",
        ),
      ),
    ).toThrowError(expect.objectContaining({ code: "DOCUMENT_INCOMPLETE" }));
  });

  it("enforces byte and nesting limits", () => {
    expect(() =>
      validateHtmlDocument(
        Buffer.alloc(DOCUMENT_LIMITS.maximumHtmlBytes + 1, 0x20),
      ),
    ).toThrowError(expect.objectContaining({ code: "DOCUMENT_TOO_LARGE" }));

    const nested = `${"<div>".repeat(101)}deep${"</div>".repeat(101)}`;
    expect(() => validateHtmlDocument(document(nested))).toThrowError(
      expect.objectContaining({ code: "DOCUMENT_TOO_DEEP" }),
    );
  });

  it("exposes a stable policy error type", () => {
    expect(() => validateHtmlDocument(document("<script></script>"))).toThrow(
      HtmlPolicyError,
    );
  });
});
