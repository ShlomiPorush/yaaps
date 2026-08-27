import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { HtmlNormalizationError, normalizeHtmlFile } from "./normalize.js";

const temporaryPaths: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "yaaps-cli-normalize-"));
  temporaryPaths.push(directory);
  return directory;
}

function document(body: string, head = "<title>Report</title>"): string {
  return `<!doctype html><html><head>${head}</head><body>${body}</body></html>`;
}

afterEach(async () => {
  await Promise.all(
    temporaryPaths
      .splice(0)
      .map((entry) => rm(entry, { force: true, recursive: true })),
  );
});

describe("CLI HTML normalization", () => {
  it("embeds bitmap elements and CSS backgrounds without modifying the source", async () => {
    const directory = await temporaryDirectory();
    const htmlPath = path.join(directory, "report.html");
    const source = document(
      '<img alt="Chart" src="assets/chart.png"><section style="background:url(assets/background.webp)">Report</section>',
      '<title>Report</title><style>.hero{background-image:url("assets/chart.png")}</style>',
    );
    await writeFile(htmlPath, source, "utf8");
    await mkdir(path.join(directory, "assets"), { recursive: true });
    await writeFile(
      path.join(directory, "assets", "chart.png"),
      Buffer.from("89504e470d0a1a0a00000000", "hex"),
    );
    await writeFile(
      path.join(directory, "assets", "background.webp"),
      Buffer.concat([
        Buffer.from("RIFF"),
        Buffer.alloc(4),
        Buffer.from("WEBP"),
      ]),
    );

    const normalized = (await normalizeHtmlFile(htmlPath)).toString("utf8");

    expect(normalized).toContain("data:image/png;base64,");
    expect(normalized).toContain("data:image/webp;base64,");
    expect(normalized).not.toContain("assets/chart.png");
    expect(await readFile(htmlPath, "utf8")).toBe(source);
  });

  it.each([
    ["external image", '<img src="https://example.com/pixel.png">', undefined],
    [
      "network CSS",
      '<p style="background:url(https://example.com/x.png)">x</p>',
      undefined,
    ],
    [
      "external stylesheet",
      "",
      '<title>Report</title><link rel="stylesheet" href="https://example.com/report.css">',
    ],
  ])(
    "rejects %s in isolated mode with an actionable error",
    async (_name, body, head) => {
      const directory = await temporaryDirectory();
      const htmlPath = path.join(directory, "report.html");
      await writeFile(htmlPath, document(body, head), "utf8");

      await expect(normalizeHtmlFile(htmlPath, "isolated")).rejects.toThrow(
        "--mode connected",
      );
    },
  );

  it.each([
    ["script", "<script>alert(1)</script>"],
    ["form", "<form><button>Send</button></form>"],
    ["iframe", '<iframe src="https://example.com"></iframe>'],
    ["HTTP image", '<img src="http://example.com/pixel.png">'],
    [
      "HTTP CSS resource",
      '<p style="background:url(http://example.com/x.png)">x</p>',
    ],
  ])("rejects %s even in connected mode", async (_name, body) => {
    const directory = await temporaryDirectory();
    const htmlPath = path.join(directory, "report.html");
    await writeFile(htmlPath, document(body), "utf8");

    await expect(
      normalizeHtmlFile(htmlPath, "connected"),
    ).rejects.toBeInstanceOf(HtmlNormalizationError);
  });

  it.each(["isolated", "connected"] as const)(
    "preserves HTTPS hyperlinks in %s mode",
    async (resourcePolicy) => {
      const directory = await temporaryDirectory();
      const htmlPath = path.join(directory, "report.html");
      await writeFile(
        htmlPath,
        document('<a href="https://example.com/source?q=1#result">Source</a>'),
        "utf8",
      );

      const normalized = (
        await normalizeHtmlFile(htmlPath, resourcePolicy)
      ).toString("utf8");

      expect(normalized).toContain(
        'href="https://example.com/source?q=1#result"',
      );
    },
  );

  it("preserves HTTPS images, stylesheets, and CSS resources in the default connected mode", async () => {
    const directory = await temporaryDirectory();
    const htmlPath = path.join(directory, "report.html");
    await writeFile(
      htmlPath,
      document(
        '<img src="https://cdn.example.com/chart.png"><section style="background:url(https://cdn.example.com/background.webp)">Report</section>',
        '<title>Report</title><link rel="stylesheet" href="https://cdn.example.com/report.css"><style>@font-face{font-family:Report;src:url(https://cdn.example.com/report.woff2)}.hero{background-image:url(https://cdn.example.com/hero.png)}</style>',
      ),
      "utf8",
    );

    const normalized = (await normalizeHtmlFile(htmlPath)).toString("utf8");

    expect(normalized).toContain("https://cdn.example.com/chart.png");
    expect(normalized).toContain("https://cdn.example.com/background.webp");
    expect(normalized).toContain("https://cdn.example.com/report.css");
    expect(normalized).toContain("https://cdn.example.com/report.woff2");
    expect(normalized).toContain("https://cdn.example.com/hero.png");
  });

  it.each([
    '<link rel="preload" href="https://example.com/font.woff2">',
    '<link rel="stylesheet" href="http://example.com/report.css">',
    '<link rel="stylesheet alternate" href="https://example.com/report.css">',
  ])("rejects unsafe link resources in connected mode", async (headLink) => {
    const directory = await temporaryDirectory();
    const htmlPath = path.join(directory, "report.html");
    await writeFile(
      htmlPath,
      document("<p>Report</p>", `<title>Report</title>${headLink}`),
      "utf8",
    );

    await expect(normalizeHtmlFile(htmlPath, "connected")).rejects.toThrow(
      HtmlNormalizationError,
    );
  });

  it("continues to embed local bitmap resources in connected mode", async () => {
    const directory = await temporaryDirectory();
    const htmlPath = path.join(directory, "report.html");
    await writeFile(htmlPath, document('<img src="chart.png">'), "utf8");
    await writeFile(
      path.join(directory, "chart.png"),
      Buffer.from("89504e470d0a1a0a00000000", "hex"),
    );

    const normalized = (
      await normalizeHtmlFile(htmlPath, "connected")
    ).toString("utf8");

    expect(normalized).toContain("data:image/png;base64,");
    expect(normalized).not.toContain("chart.png");
  });

  it("reports the exact missing or unsupported local asset reference", async () => {
    const directory = await temporaryDirectory();
    const missingPath = path.join(directory, "missing.html");
    await writeFile(
      missingPath,
      document('<img src="charts/missing.png">'),
      "utf8",
    );
    await expect(normalizeHtmlFile(missingPath)).rejects.toThrow(
      "charts/missing.png",
    );

    const unsupportedPath = path.join(directory, "unsupported.html");
    await writeFile(
      unsupportedPath,
      document('<img src="vector.svg">'),
      "utf8",
    );
    await writeFile(path.join(directory, "vector.svg"), "<svg></svg>", "utf8");
    await expect(normalizeHtmlFile(unsupportedPath)).rejects.toThrow(
      "vector.svg",
    );
  });

  it("rejects local asset references that escape the document directory", async () => {
    const directory = await temporaryDirectory();
    const documentDirectory = path.join(directory, "report");
    await mkdir(documentDirectory, { recursive: true });
    const htmlPath = path.join(documentDirectory, "report.html");
    await writeFile(
      htmlPath,
      document('<img alt="Secret" src="../secret.png">'),
      "utf8",
    );
    // A genuine PNG one level above the document: it would be embedded if the
    // traversal guard were missing, so this test fails on the pre-fix behavior.
    await writeFile(
      path.join(directory, "secret.png"),
      Buffer.from("89504e470d0a1a0a00000000", "hex"),
    );

    await expect(normalizeHtmlFile(htmlPath)).rejects.toBeInstanceOf(
      HtmlNormalizationError,
    );
    await expect(normalizeHtmlFile(htmlPath)).rejects.toThrow(
      "escape the document directory",
    );
  });

  it("requires an explicit complete UTF-8 document", async () => {
    const directory = await temporaryDirectory();
    const fragmentPath = path.join(directory, "fragment.html");
    await writeFile(fragmentPath, "<p>fragment</p>", "utf8");
    await expect(normalizeHtmlFile(fragmentPath)).rejects.toThrow(
      "complete HTML document",
    );

    const invalidPath = path.join(directory, "invalid.html");
    await writeFile(invalidPath, Uint8Array.from([0xc3, 0x28]));
    await expect(normalizeHtmlFile(invalidPath)).rejects.toThrow("valid UTF-8");
  });
});
